import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { archiveWorkflowCharacterAsset } from '../server/character-assets.ts'

const databaseUrl = process.env.CHARACTER_TEST_DATABASE_URL

test('replaying a workflow checkpoint cannot revive superseded, review-pending or approved portraits', { skip: !databaseUrl }, async () => {
  const schema = `portrait_lifecycle_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: databaseUrl })
  await admin.query(`create schema ${schema}`)
  const db = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  try {
    await db.query(`create table character_assets (
      id text primary key, workflow_id text, character_name text not null, asset_type text not null,
      uri text not null, prompt text not null default '', version integer not null default 1,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    )`)
    for (const [id, metadata] of [
      ['old', { portraitLifecycle: { status: 'superseded', replacedByAssetId: 'keeper' }, voiceContinuityKey: 'voice:张飞' }],
      ['keeper', { artisticIdentity: { active: true, version: 'character-artistic-identity-v1' }, portraitRevision: 'handsome' }],
      ['pending-batch', { portraitLifecycle: { status: 'pending-review', reason: 'deferred-batch-interrupted' }, quality: { canProceed: false } }],
      ['pending-unrecoverable', { portraitLifecycle: { status: 'pending-unrecoverable', originalUriFingerprint: 'original-url-hash' }, quality: { canProceed: false } }],
      ['pending-face', { identityConsistency: { status: 'needs_manual_review', distance: 0.7 }, quality: { canProceed: false } }],
      ['approved-batch', { portraitLifecycle: { status: 'pending-review', reason: 'deferred-batch-interrupted' }, quality: { canProceed: false } }],
      ['working', { quality: { status: 'pending' } }],
    ] as const) {
      await db.query(`insert into character_assets(id,workflow_id,character_name,asset_type,uri,prompt,metadata)
        values($1,'wf','张飞','three-view',$2,'original',$3::jsonb)`, [id, `${id}.png`, JSON.stringify(metadata)])
    }
    await db.query(`update character_assets set metadata=jsonb_build_object(
      'portraitLifecycle',jsonb_build_object('status','active'),
      'portraitReviewDecision',jsonb_build_object('version','manual-portrait-review-v1','decision','accept','reviewedContentSha256','abc'),
      'quality',jsonb_build_object('canProceed',true)) where id='approved-batch'`)
    for (const id of ['old', 'keeper', 'pending-batch', 'pending-unrecoverable', 'pending-face', 'approved-batch', 'working']) await archiveWorkflowCharacterAsset(db, {
      id, workflowId: 'wf', characterName: '张飞', uri: `${id}-replay.png`, prompt: 'replayed', metadata: { quality: { status: 'replayed' } },
    })
    const result = (await db.query('select id,uri,prompt,metadata from character_assets order by id')).rows
    assert.equal(result.find(row => row.id === 'old')?.uri, 'old.png')
    assert.equal(result.find(row => row.id === 'old')?.prompt, 'original')
    assert.equal(result.find(row => row.id === 'old')?.metadata.portraitLifecycle.status, 'superseded')
    assert.equal(result.find(row => row.id === 'old')?.metadata.voiceContinuityKey, 'voice:张飞')
    assert.equal(result.find(row => row.id === 'keeper')?.uri, 'keeper.png')
    assert.equal(result.find(row => row.id === 'keeper')?.metadata.artisticIdentity.active, true)
    assert.equal(result.find(row => row.id === 'pending-batch')?.uri, 'pending-batch.png')
    assert.equal(result.find(row => row.id === 'pending-batch')?.metadata.portraitLifecycle.status, 'pending-review')
    assert.equal(result.find(row => row.id === 'pending-unrecoverable')?.uri, 'pending-unrecoverable.png')
    assert.equal(result.find(row => row.id === 'pending-unrecoverable')?.metadata.portraitLifecycle.status, 'pending-unrecoverable')
    assert.equal(result.find(row => row.id === 'pending-face')?.uri, 'pending-face.png')
    assert.equal(result.find(row => row.id === 'pending-face')?.metadata.identityConsistency.status, 'needs_manual_review')
    assert.equal(result.find(row => row.id === 'pending-face')?.metadata.quality.canProceed, false)
    assert.equal(result.find(row => row.id === 'approved-batch')?.uri, 'approved-batch.png')
    assert.equal(result.find(row => row.id === 'approved-batch')?.metadata.portraitReviewDecision.decision, 'accept')
    assert.equal(result.find(row => row.id === 'approved-batch')?.metadata.quality.canProceed, true)
    assert.equal(result.find(row => row.id === 'working')?.uri, 'working-replay.png', 'unapproved attempts still update normally')
  } finally {
    await db.end()
    await admin.query(`drop schema ${schema} cascade`)
    await admin.end()
  }
})
