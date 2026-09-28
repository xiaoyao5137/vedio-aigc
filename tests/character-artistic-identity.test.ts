import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { normalizeCharacterArtisticIdentity } from '../src/character-artistic-identity.ts'
import { mergeCharacterVisualMetadata } from '../src/character-visual-context.ts'
import { characterArtisticIdentityCatalog, characterVisualCatalog, refreshCharacterVisualPrompt } from '../src/character-visual-workflow.ts'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'

const identity = normalizeCharacterArtisticIdentity({ version: 'character-artistic-identity-v1', active: true,
  face: '方阔端正的脸形、浓眉和挺直鼻梁，英俊有威仪', complexion: '健康白净而有自然血色', frame: '肩背骨架宽阔，胸廓厚实' })!
const context = { version: 'character-visual-context-v1', age: { stage: 'mature', basis: 'artistic', asOf: '当前剧情时间' },
  look: { key: 'later-command', description: '本场统兵时的稳定服饰' },
  appearanceConstraints: { hair: 'dark', facialHair: 'dark', build: '宽肩壮实' } }

test('artistic identity crosses episode scope without sending age, look or image URLs to writers', () => {
  const assets = [{ id: 'current-face', workflowId: 'wf', characterName: '张飞', threeViewUrl: '/generated/current.png',
    metadata: { episodeScope: { episodes: [518] }, artisticIdentity: identity,
      visualContext: { ...context, age: { stage: 'mature', basis: 'artistic', years: { min: 32, max: 40 }, asOf: '208年长坂' },
        look: { key: 'changban', description: '旧战袍' } } } }]
  const relevant = { input: { episode_number: 693 }, source: '张飞治兵' }
  assert.deepEqual(characterVisualCatalog(assets, 'wf', relevant), [])
  assert.deepEqual(characterArtisticIdentityCatalog(assets, 'wf', relevant),
    [{ name: '张飞', sourceAssetId: 'current-face', artisticIdentity: identity }])
  const liu = { ...assets[0], id: 'liu-face', characterName: '刘备',
    metadata: { ...assets[0].metadata, artisticIdentity: { ...identity, face: '端正俊朗的长形脸，眉眼沉静' } } }
  const aliasOnly = characterArtisticIdentityCatalog([...assets, liu], 'wf',
    { input: { episode_number: 693, title: '张飞治兵' }, source: '先主常戒之曰' })
  assert.deepEqual(aliasOnly.map(item => item.name), ['张飞', '刘备'])
  const rendered = JSON.stringify(characterArtisticIdentityCatalog(assets, 'wf', relevant))
  assert.doesNotMatch(rendered, /208|changban|旧战袍|generated/)
  assert.match(refreshCharacterVisualPrompt('原大纲', 'outline'), /\$\{characterArtisticIdentityCatalog\}/)
  assert.match(refreshCharacterVisualPrompt('原分镜', 'storyboard'), /\$\{characterArtisticIdentityCatalog\}/)
  assert.throws(() => characterArtisticIdentityCatalog([...assets, { ...assets[0], id: 'second' }], 'wf', relevant), /CHARACTER_ARTISTIC_IDENTITY_CONFLICT/)
  const historical = { ...assets[0], id: 'old-face', metadata: { ...assets[0].metadata,
    portraitLifecycle: { status: 'superseded' } } }
  const pending = { ...assets[0], id: 'pending-face', metadata: { ...assets[0].metadata,
    identityConsistency: { status: 'needs_manual_review' } } }
  const pendingBatch = { ...assets[0], id: 'pending-batch', metadata: { ...assets[0].metadata,
    portraitLifecycle: { status: 'pending-review' } } }
  assert.deepEqual(characterArtisticIdentityCatalog([historical, pending, pendingBatch, ...assets], 'wf', relevant),
    [{ name: '张飞', sourceAssetId: 'current-face', artisticIdentity: identity }])
})

test('identity traits reject episode-specific age and costume text', () => {
  for (const text of ['208年长坂战袍', '视觉年龄32岁', '白须黑袍', '修整的胡须', '八字髭', '束发发型']) {
    assert.throws(() => normalizeCharacterArtisticIdentity({ ...identity, face: text }), /CHARACTER_ARTISTIC_IDENTITY_INVALID/)
  }
})

test('replacing image pixels clears a face-only observation but a description edit does not', () => {
  const metadata = { artisticIdentity: identity, identityVisualProfile: { version: 'actual-facial-identity-v1', sourceFingerprint: 'old' } }
  const replacement = mergeCharacterVisualMetadata(undefined, metadata, { imageChanged: true })
  assert.equal(replacement.identityVisualProfile, undefined)
  assert.equal(replacement.artisticIdentity, undefined)
  assert.equal((replacement.portraitLifecycle as { status: string }).status, 'pending-review')
  assert.deepEqual(mergeCharacterVisualMetadata(undefined, metadata, { descriptionChanged: true }).identityVisualProfile,
    metadata.identityVisualProfile)
})

test('an unreviewed current face blocks a silent fallback to an older verified face', async () => {
  const older = { id: 'old-face', workflow_id: 'wf', character_name: '张飞', asset_type: 'three-view', uri: '/generated/old.png',
    metadata: { visualProfile: { version: 'actual-reference-v1', appearance: '五官端正，黑色胡须，年龄与服装由当前场景决定。',
      sourceFingerprint: createHash('sha256').update('/generated/old.png').digest('hex') } } }
  const current = { ...older, id: 'current-face', uri: '/generated/current.png', metadata: { artisticIdentity: identity } }
  let imageCalls = 0
  const pool = { query: async (sql: string) => ({ rows: sql.includes('from character_assets') ? [older, current] : [] }) }
  await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.ensure',
    params: { workflowId: 'wf', characters: [{ name: '张飞', visualContext: context }], deferArchive: true } },
  async () => { imageCalls++; throw Error('image request must not start') }), /CHARACTER_IDENTITY_REFERENCE_UNREVIEWED/)
  assert.equal(imageCalls, 0)
})

test('a visually reviewed current face wins over an older verified face for a new age sheet', async () => {
  const id = randomUUID(), url = `/generated/identity-test-${id}.png`
  const file = path.join(process.cwd(), 'public', url)
  const snapshot = `/generated/appearance-${createHash('sha256').update(url).digest('hex').slice(0, 24)}.jpg`
  const snapshotFile = path.join(process.cwd(), 'public', snapshot)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, await sharp({ create: { width: 384, height: 216, channels: 3, background: '#999' } }).png().toBuffer())
  await writeFile(snapshotFile, await sharp({ create: { width: 384, height: 216, channels: 3, background: '#999' } }).jpeg().toBuffer())
  const current = { id: 'current-face', workflow_id: 'wf', character_name: '张飞', asset_type: 'three-view', uri: url,
    metadata: { artisticIdentity: identity, visualProfile: { version: 'actual-reference-v2-age-context',
      appearance: '脸形方阔，浓眉挺鼻，肤色白净，三视图是同一人物。',
      sourceFingerprint: createHash('sha256').update(url).digest('hex'), referenceImage: snapshot } } }
  const older = { ...current, id: 'old-face', uri: '/generated/older.png', metadata: { visualProfile: current.metadata.visualProfile } }
  const pool = { query: async (sql: string) => ({ rows: sql.includes('from character_assets') ? [older, current] : [] }) }
  let captured: Record<string, unknown> | undefined
  try {
    await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.ensure',
      model: { id: 'image', provider: 'Kling', capability: 'image', settings: {} },
      params: { workflowId: 'wf', characters: [{ name: '张飞', visualContext: context }], deferArchive: true,
        qualityDisposition: 'manual-review-v1' } }, async request => { captured = request; throw Error('STOP_CAPTURE') },
    { prepareIdentityAnchor: async () => ({ anchorUrl: '/generated/current-upper-face.jpg', sourceAssetId: current.id }) as never }), /STOP_CAPTURE/)
    assert.equal((captured!.params as Record<string, unknown>).identityReferenceAssetId, current.id)
    assert.match(String(captured!.prompt), /方阔端正的脸形/)
    assert.match(String(captured!.prompt), /健康白净而有自然血色/)
    assert.doesNotMatch(String(captured!.prompt), /208年长坂|旧战袍/)
  } finally {
    await rm(file, { force: true }); await rm(snapshotFile, { force: true })
  }
})

test('identity-only observation anchors the current face but cannot certify the mismatched costume', async () => {
  const id = randomUUID(), url = `/generated/identity-only-${id}.png`
  const file = path.join(process.cwd(), 'public', url)
  const snapshot = `/generated/appearance-${createHash('sha256').update(url).digest('hex').slice(0, 24)}.jpg`
  const snapshotFile = path.join(process.cwd(), 'public', snapshot)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, await sharp({ create: { width: 384, height: 216, channels: 3, background: '#999' } }).png().toBuffer())
  await writeFile(snapshotFile, await sharp({ create: { width: 384, height: 216, channels: 3, background: '#999' } }).jpeg().toBuffer())
  const facial = { version: 'actual-facial-identity-v1', scope: 'facial-identity-only', valid: true,
    fullDesignMatched: false, appearance: '脸形偏长，颧颊清瘦，下颌较窄；头部为小冠和横簪。',
    issues: ['头巾与实际小冠不符'], sourceFingerprint: createHash('sha256').update(url).digest('hex'),
    referenceImage: snapshot, observationLedgerId: 'text-ledger-1', observationResponseHash: 'a'.repeat(64) }
  const current = { id: 'current-face', workflow_id: 'wf', character_name: '张飞', asset_type: 'three-view', uri: url,
    metadata: { artisticIdentity: identity, identityVisualProfile: facial } }
  const older = { ...current, id: 'old-face', uri: '/generated/older.png', metadata: { visualProfile: {
    version: 'actual-reference-v1', appearance: '旧版角色脸部身份资料，已完整核验但并非当前所选脸。',
    sourceFingerprint: createHash('sha256').update('/generated/older.png').digest('hex') } } }
  const pool = { query: async (sql: string) => ({ rows: sql.includes('from character_assets') ? [older, current] : [] }) }
  let captured: Record<string, unknown> | undefined
  try {
    await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.ensure',
      model: { id: 'image', provider: 'Kling', capability: 'image', settings: {} },
      params: { workflowId: 'wf', characters: [{ name: '张飞', visualContext: context }], deferArchive: true,
        qualityDisposition: 'manual-review-v1' } }, async request => { captured = request; throw Error('STOP_CAPTURE') },
    { prepareIdentityAnchor: async () => ({ anchorUrl: '/generated/current-upper-face.jpg', sourceAssetId: current.id }) as never }), /STOP_CAPTURE/)
    assert.equal((captured!.params as Record<string, unknown>).identityReferenceAssetId, current.id)
    assert.match(String(captured!.prompt), /方阔端正的脸形/)
    await assert.rejects(executeBuiltinNode({ query: async () => ({ rows: [] }) } as never,
      { operation: 'character.archive', params: { workflowId: 'wf', characters: [{ name: '张飞', visualContext: context }],
        generatedAssets: { items: [{ characterName: '张飞', url, metadata: { visualContext: context,
          identityVisualProfile: facial } }] } } }), /CHARACTER_VISUAL_CONTEXT_PROVENANCE_MISSING/)
  } finally {
    await rm(file, { force: true }); await rm(snapshotFile, { force: true })
  }
})
