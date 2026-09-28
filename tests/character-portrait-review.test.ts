import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import sharp from 'sharp'
import { archiveWorkflowCharacterAsset } from '../server/character-assets.ts'
import { recoverPendingCharacterPortrait, reviewPendingCharacterPortrait } from '../server/character-portrait-review.ts'

const databaseUrl = process.env.CHARACTER_TEST_DATABASE_URL

test('manual portrait decisions bind exact paid-image bytes and survive checkpoint replay', { skip: !databaseUrl }, async () => {
  const schema = `portrait_review_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: databaseUrl })
  await admin.query(`create schema ${schema}`)
  const db = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  const width = 600, height = 300
  const pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = (y * width + x) * 3
    pixels[index] = (x < 200 ? 40 : x < 400 ? 140 : 230) + (y % 13)
    pixels[index + 1] = (y + x % 37) % 256
    pixels[index + 2] = x < 200 ? 180 : x < 400 ? 80 : 15
  }
  const salt = createHash('sha256').update(randomUUID()).digest()
  pixels[0] = salt[0]
  pixels[1] = salt[1]
  const bytes = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer()
  const sha = createHash('sha256').update(bytes).digest('hex')
  const uri = `/generated/character-portrait-${sha.slice(0, 32)}.png`
  const file = path.join(process.cwd(), 'public', uri)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, bytes, { flag: 'wx' })
  try {
    await db.query(`create table character_assets (
      id text primary key, workflow_id text, character_name text not null, asset_type text not null,
      uri text not null, prompt text not null default '', version integer not null default 1,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    )`)
    await db.query(`insert into character_assets(id,workflow_id,character_name,asset_type,uri,prompt,metadata)
      values ('accept','wf','张飞','three-view',$1,'original',$2::jsonb),
        ('reject','wf','张飞','three-view',$1,'original',$3::jsonb)`, [uri,
      JSON.stringify({ identityConsistency: { status: 'needs_manual_review', distance: 0.7, candidateContentSha256: sha } }),
      JSON.stringify({ portraitLifecycle: { status: 'pending-review', candidateContentSha256: sha } })])
    const request = { decision: 'accept' as const, reviewedContentSha256: sha, note: '已对照身份参考图确认可用' }
    await assert.rejects(reviewPendingCharacterPortrait(db, 'accept', { ...request, reviewedContentSha256: '0'.repeat(64) }), /指纹|候选图/)
    assert.equal((await db.query("select metadata from character_assets where id='accept'")).rows[0].metadata.identityConsistency.status, 'needs_manual_review')
    const accepted = await reviewPendingCharacterPortrait(db, 'accept', request)
    assert.equal(accepted.alreadyReviewed, false)
    assert.equal(accepted.portraitReviewDecision.reviewedContentSha256, sha)
    const repeated = await reviewPendingCharacterPortrait(db, 'accept', request)
    assert.equal(repeated.alreadyReviewed, true)
    const rejected = await reviewPendingCharacterPortrait(db, 'reject', { decision: 'reject', reviewedContentSha256: sha, note: '脸部差异明显，拒绝此图' })
    assert.equal(rejected.decision, 'reject')
    await assert.rejects(reviewPendingCharacterPortrait(db, 'reject', request), /已有审核决定/)
    const remoteUri = 'https://example.org/paid-candidate.png'
    const remoteFingerprint = createHash('sha256').update(remoteUri).digest('hex')
    const brokenDataUri = 'data:image/png;base64,broken-paid-result'
    const brokenFingerprint = createHash('sha256').update(brokenDataUri).digest('hex')
    const unrecoverable = { portraitLifecycle: { status: 'pending-unrecoverable', reason: 'candidate-mirror-unavailable',
      originalUri: remoteUri, originalUriFingerprint: remoteFingerprint, candidateTaskId: 'paid-task-1' },
    generationLedger: { taskId: 'paid-task-1' } }
    await db.query(`insert into character_assets(id,workflow_id,character_name,asset_type,uri,prompt,metadata)
      values ('recover','wf','张飞','three-view',$1,'original',$2::jsonb),
        ('abandon','wf','张飞','three-view',$3,'original',$4::jsonb)`, [remoteUri, JSON.stringify(unrecoverable),
      brokenDataUri, JSON.stringify({ ...unrecoverable, portraitLifecycle: { ...unrecoverable.portraitLifecycle,
        originalUri: brokenDataUri, originalUriFingerprint: brokenFingerprint } })])
    let fetchCalls = 0
    const fetchImpl = (async () => { fetchCalls += 1; return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } }) }) as typeof fetch
    const recovered = await recoverPendingCharacterPortrait(db, 'recover', { action: 'retry' }, { fetchImpl })
    assert.equal(fetchCalls, 1)
    assert.equal(recovered.recoveredContentSha256, sha)
    assert.equal((await db.query("select uri,metadata from character_assets where id='recover'")).rows[0].uri, uri)
    await reviewPendingCharacterPortrait(db, 'recover', { ...request, note: '恢复原图后确认三视图可用' })
    const abandoned = await recoverPendingCharacterPortrait(db, 'abandon', { action: 'abandon', note: '供应商原图持续不可读取，人工放弃此候选' })
    assert.equal(abandoned.status, 'superseded')
    assert.equal(fetchCalls, 1, 'abandoning an unrecoverable paid result makes no media request')
    for (const id of ['accept', 'reject', 'recover', 'abandon']) await archiveWorkflowCharacterAsset(db, {
      id, workflowId: 'wf', characterName: '张飞', uri: '/generated/replayed.png', prompt: 'replayed', metadata: {},
    })
    const rows = (await db.query('select id,uri,prompt,metadata from character_assets order by id')).rows
    const byId = (id: string) => rows.find(row => row.id === id)
    assert.equal(byId('accept').uri, uri)
    assert.equal(byId('accept').prompt, 'original')
    assert.equal(byId('accept').metadata.identityConsistency.status, 'needs_manual_review', 'the original comparison is retained')
    assert.equal(byId('accept').metadata.portraitLifecycle.status, 'active')
    assert.equal(byId('accept').metadata.portraitReviewDecision.decision, 'accept')
    assert.equal(byId('accept').metadata.quality.canProceed, true)
    assert.equal(byId('reject').uri, uri)
    assert.equal(byId('reject').metadata.portraitLifecycle.status, 'superseded')
    assert.equal(byId('reject').metadata.portraitReviewDecision.decision, 'reject')
    assert.equal(byId('reject').metadata.quality.canProceed, false)
    assert.equal(byId('recover').uri, uri)
    assert.equal(byId('recover').metadata.portraitReviewDecision.decision, 'accept')
    assert.equal(byId('abandon').uri, brokenDataUri)
    assert.equal(byId('abandon').metadata.portraitReviewDecision.decision, 'abandon')
  } finally {
    await db.end()
    await admin.query(`drop schema ${schema} cascade`)
    await admin.end()
    await unlink(file)
  }
})
