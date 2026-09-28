import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { normalizeCharacterVisualContext, characterVisualContextDesignText, characterVisualContextSignature, characterVisualContextCompatibility, generatedCharacterEpisodeScope, reviewedHairMismatchCanArchive, mergeCharacterVisualMetadata, type CharacterVisualContext } from '../src/character-visual-context.ts'
import { executeBuiltinNode, buildThreeViewGenerationPrompt, buildThreeViewNegativePrompt } from '../server/builtin-nodes.ts'
import { characterVisualCatalog } from '../src/character-visual-workflow.ts'
import { characterVoiceIdentity } from '../server/character-voices.ts'
import { stableVoiceContinuityKey } from '../src/voice-character-input.ts'
import { prepareKlingImageInputs, callKlingImage } from '../server/model-adapters.ts'
import { prepareCharacterIdentityAnchor } from '../server/character-identity-anchor.ts'

const context: CharacterVisualContext = { version: 'character-visual-context-v1', age: { stage: 'mature', basis: 'artistic', asOf: '建安十三年' }, look: { key: 'campaign-cloak', description: '灰袍黑披风，束发，宽腰带' }, appearanceConstraints: { hair: 'dark', facialHair: 'dark', build: '成熟壮实' } }
const character = { name: '张飞', description: '成熟壮实男性，肤色偏白，容貌好看但威武', designPrompt: '东汉电影角色', visualContext: context }
const picture = async () => 'data:image/png;base64,' + (await sharp({ create: { width: 384, height: 216, channels: 3, background: '#777' } }).png().toBuffer()).toString('base64')
const row = (id: string, url: string, visualContext?: CharacterVisualContext) => ({ id, workflow_id: 'wf', character_name: '张飞', asset_type: 'three-view', uri: url, prompt: character.description, version: 1, metadata: { continuityKey: id, ...(visualContext ? { visualContext } : {}) } })
const anchorDependencies = { prepareIdentityAnchor: (input: Parameters<typeof prepareCharacterIdentityAnchor>[0]) => prepareCharacterIdentityAnchor(input, { detect: async () => ({ detector: 'macos-vision-landmarks-v1', faces: [{ confidence: 1, yaw: 0, bounds: { x: 0.3, y: 0.2, width: 0.4, height: 0.4 }, leftEye: [{ x: 0.4, y: 0.35 }, { x: 0.44, y: 0.36 }], rightEye: [{ x: 0.56, y: 0.35 }, { x: 0.6, y: 0.36 }], leftEyebrow: [{ x: 0.39, y: 0.3 }, { x: 0.45, y: 0.31 }], rightEyebrow: [{ x: 0.55, y: 0.31 }, { x: 0.61, y: 0.3 }], nose: [{ x: 0.48, y: 0.42 }, { x: 0.5, y: 0.46 }, { x: 0.52, y: 0.42 }] }] }) }) }

test('age evidence remains explicit and never invents a historical birth year', () => {
  assert.equal(normalizeCharacterVisualContext(undefined), undefined)
  assert.deepEqual(normalizeCharacterVisualContext(context), context)
  for (const basis of ['documented', 'estimated']) assert.throws(() => normalizeCharacterVisualContext({ ...context, age: { ...context.age, basis } }), /保留依据引用/)
  assert.throws(() => normalizeCharacterVisualContext({ ...context, age: { stage: 'mature', basis: 'unknown' } }), /未知年龄/)
  assert.throws(() => normalizeCharacterVisualContext({ ...context, age: { ...context.age, years: { min: 55, max: 30 } } }), /有效整数区间/)
  const documented = normalizeCharacterVisualContext({ ...context, age: { stage: 'mature', basis: 'documented', years: { min: 40, max: 40 }, sourceRefs: ['[史料1]'] } })!
  assert.equal(documented.age.years!.min, 40)
  assert.ok(!JSON.stringify(documented).includes('birthYear'))
})

test('visual design text does not duplicate final punctuation from archived descriptions', () => {
  const punctuated = { ...context, look: { ...context.look, description: `${context.look.description}。` },
    appearanceConstraints: { ...context.appearanceConstraints, build: '肩背宽厚。' } }
  const text = characterVisualContextDesignText(punctuated)
  assert.match(text, /灰袍黑披风，束发，宽腰带。只提取服饰/)
  assert.match(text, /体型：肩背宽厚。$/)
  assert.doesNotMatch(text, /。。/)
})

test('fixed look definitions reuse event dates, while changed definitions require review', () => {
  const later = { ...context, age: { ...context.age, asOf: '另一场同阶段剧情' } }
  assert.equal(characterVisualContextSignature(context), characterVisualContextSignature(later))
  assert.equal(characterVisualContextCompatibility(context, { metadata: { visualContext: later } }).matches, true)
  for (const description of ['同一套灰袍、黑色披风与束发宽腰带', '红袍白披风，束发，宽腰带']) {
    const redefined = { ...context, look: { ...context.look, description } }
    assert.notEqual(characterVisualContextSignature(context), characterVisualContextSignature(redefined))
    assert.match(characterVisualContextCompatibility(context, { metadata: { visualContext: redefined } }).reason, /^CHARACTER_VISUAL_LOOK_DEFINITION_CONFLICT:/)
  }
  for (const variant of [{ ...context, age: { stage: 'elderly', basis: 'artistic' } }, { ...context, look: { ...context.look, key: 'court-robes' } }]) {
    assert.notEqual(characterVisualContextSignature(context), characterVisualContextSignature(variant as CharacterVisualContext))
    assert.equal(characterVisualContextCompatibility(context, { metadata: { visualContext: variant } }).matches, false)
  }
  assert.equal(characterVisualContextCompatibility(context, { metadata: {} }).matches, false)
  assert.equal(characterVisualContextCompatibility(undefined, { metadata: {} }).matches, true)
})

test('superseded portraits remain explicitly selectable but never win automatic lookup', async () => {
  const url = await picture()
  const historical = { ...row('historical', url, context), metadata: { ...row('historical', url, context).metadata,
    portraitLifecycle: { status: 'superseded', replacedByAssetId: 'current', reason: 'identity-drift' } } }
  const current = row('current', url, context)
  const pool = { query: async (sql: string) => ({ rows: sql.includes('from character_assets') ? [historical, current] : [] }) }
  const params = { workflowId: 'wf', characters: [character], qualityDisposition: 'manual-review-v1' }
  const automatic = await executeBuiltinNode(pool as never, { operation: 'character.lookup', params })
  assert.equal(automatic.items[0].id, 'current')
  assert.equal(automatic.rejectedAssets[0].reason.startsWith('CHARACTER_PORTRAIT_SUPERSEDED:'), true)
  const explicit = await executeBuiltinNode(pool as never, { operation: 'character.lookup', params: { ...params, characterAssetSelections: { 张飞: 'historical' } } })
  assert.equal(explicit.items[0].id, 'historical')
  const ensure = await executeBuiltinNode(pool as never, { operation: 'character.ensure', params: { ...params,
    existingAssets: [{ ...historical, characterName: '张飞', url }], characters: [character] } }, async () => { throw Error('must not regenerate') })
  assert.equal(ensure.items[0].id, 'current')
  assert.equal(ensure.generatedCount, 0)
})

test('a historical checkpoint cannot revive a portrait superseded in the current database', async () => {
  const url = await picture(), old = row('old-face', url, context)
  const current = { ...old, metadata: { ...old.metadata,
    portraitLifecycle: { status: 'superseded', replacedByAssetId: 'new-face', reason: 'identity-drift' } } }
  const pool = { query: async (sql: string) => ({ rows: sql.includes('from character_assets') ? [current] : [] }) }
  let imageCalls = 0
  const generated = await executeBuiltinNode(pool as never, { operation: 'character.ensure',
    model: { id: 'image', provider: 'Kling', capability: 'image', settings: {} },
    params: { workflowId: 'wf', characters: [character], existingAssets: [{ ...old, characterName: '张飞', url }],
      qualityDisposition: 'manual-review-v1', deferArchive: true } }, async () => {
    imageCalls++; return { status: 200, body: { images: [{ url }] } }
  })
  assert.equal(imageCalls, 1)
  assert.equal(generated.generatedCount, 1)
  assert.notEqual(generated.items[0].id, old.id)
})

test('controlled portrait regeneration keeps the visual contract and writes a new continuity version', async () => {
  const url = await picture(), signature = createHash('sha256').update(characterVisualContextSignature(context)).digest('hex').slice(0, 24)
  const previousKey = `张飞-eastern-han-v1-visual-${signature}-v2`
  const old = { ...row('prior-revision', url, context), metadata: { ...row('prior-revision', url, context).metadata,
    continuityKey: previousKey, identityConsistency: { status: 'needs_manual_review' },
    portraitLifecycle: { status: 'superseded' },
    portraitReviewDecision: { version: 'manual-portrait-review-v1', decision: 'reject' } } }
  const pool = { query: async (sql: string) => ({ rows: sql.includes('from character_assets') ? [old] : [] }) }
  const actor = { ...character, continuityKey: previousKey.replace(/-v2$/, '-v3') }
  let imageCalls = 0
  const params = { workflowId: 'wf', characters: [actor], existingAssets: [{ ...old, characterName: '张飞', url }],
    qualityDisposition: 'manual-review-v1', deferArchive: true, regenerateAssetId: old.id }
  await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.lookup', params: {
    workflowId: 'wf', characters: [actor] } }), /CHARACTER_PORTRAIT_REVIEW_REJECTED/)
  const revisedLookup = await executeBuiltinNode(pool as never, { operation: 'character.lookup', params: {
    workflowId: 'wf', characters: [actor], regenerateAssetId: old.id } })
  assert.equal(revisedLookup.missingCount, 1)
  const generated = await executeBuiltinNode(pool as never, { operation: 'character.ensure',
    model: { id: 'image', provider: 'Kling', capability: 'image', settings: {} }, params }, async () => {
    imageCalls++; return { status: 200, body: { images: [{ url }] } }
  })
  assert.equal(imageCalls, 1)
  assert.equal(generated.generatedCount, 1)
  assert.equal(generated.items[0].metadata.continuityKey, actor.continuityKey)
  assert.notEqual(generated.items[0].id, old.id)
  await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.ensure', params: { ...params,
    characters: [{ ...actor, continuityKey: previousKey }] } }, async () => {
    imageCalls++; throw Error('must not purchase')
  }), /CHARACTER_PORTRAIT_REGENERATION_INVALID/)
  assert.equal(imageCalls, 1)
})

test('a mirrored provider portrait archives only when local bytes and remote provenance agree', async () => {
  const bytes = await sharp({ create: { width: 384, height: 216, channels: 3, background: '#825d48' } }).png().toBuffer()
  const digest = createHash('sha256').update(bytes).digest('hex')
  const uri = `/generated/character-portrait-${digest.slice(0, 32)}.png`
  const file = path.join(process.cwd(), 'public', uri)
  await writeFile(file, bytes)
  const originalUri = 'https://example.com/generated-person.png?signature=original'
  const sourceMediaProvenance = { version: 'generated-media-mirror-v1', localUri: uri, originalUri,
    originalUriFingerprint: createHash('sha256').update(originalUri).digest('hex'), contentSha256: digest,
    sourceModelExecutionId: 'model-call-1', sourceTaskId: 'provider-task-1' }
  const metadata = { visualContext: context, visualContextSource: 'generation-request-v1',
    visualContextRequestSignature: createHash('sha256').update(characterVisualContextSignature(context)).digest('hex'),
    visualContextImageFingerprint: createHash('sha256').update(uri).digest('hex'), sourceMediaProvenance }
  const saved: unknown[][] = []
  const pool = { query: async (sql: string, values: unknown[]) => {
    if (sql.includes('insert into character_assets')) saved.push(values)
    return { rows: [], rowCount: 1 }
  } }
  try {
    const archived = await executeBuiltinNode(pool as never, { operation: 'character.archive', params: { workflowId: 'wf',
      characters: [character], generatedAssets: { items: [{ characterName: '张飞', url: uri, metadata }] } } })
    assert.equal(archived.items[0].url, uri)
    assert.deepEqual(JSON.parse(String(saved[0][5])).sourceMediaProvenance, sourceMediaProvenance)
    await writeFile(file, Buffer.from('not original pixels'))
    await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.archive', params: { workflowId: 'wf',
      characters: [character], generatedAssets: { items: [{ characterName: '张飞', url: uri, metadata }] } } }), /CHARACTER_MEDIA_PROVENANCE_INVALID/)
    assert.equal(saved.length, 1)
  } finally { await rm(file, { force: true }) }
})

test('same adult stage uses a full-face identity crop while age-stage changes keep upper-face geometry', async () => {
  const url = await picture(), source = row('face-keeper', url, context)
  const fingerprint = createHash('sha256').update(url).digest('hex')
  const snapshot = `/generated/appearance-${fingerprint.slice(0, 24)}.jpg`
  await writeFile(path.join(process.cwd(), 'public', snapshot), await sharp({ create: { width: 384, height: 216, channels: 3, background: '#777' } }).jpeg().toBuffer())
  source.metadata = { ...source.metadata, visualProfile: { version: 'actual-reference-v2-age-context', sourceFingerprint: fingerprint,
    referenceImage: snapshot, appearance: '同一成熟男性，黑发短须、脸形方阔、眉眼清朗，衣袍造型在各角度保持稳定。' } } as typeof source.metadata
  const pool = { query: async (sql: string) => ({ rows: sql.includes('from character_assets') ? [source] : [] }) }
  const modes: string[] = []
  const prompts: string[] = []
  const target = { ...character, visualContext: { ...context, look: { key: 'different-campaign', description: '深褐袍外穿暗色札甲' } } }
  const generate = async (stage: string) => executeBuiltinNode(pool as never, { operation: 'character.ensure',
    model: { id: 'image', provider: 'Kling', capability: 'image', settings: {} },
    params: { workflowId: 'wf', characters: [{ ...target, visualContext: { ...target.visualContext, age: { ...context.age, stage } } }],
      qualityDisposition: 'manual-review-v1', deferArchive: true, identityReferenceAssetId: source.id } },
  async request => { prompts.push(String(request.prompt)); return { status: 200, body: { images: [{ url }] } } }, { prepareIdentityAnchor: async (_input, options) => {
    modes.push(String(options?.mode)); return { anchorUrl: snapshot, scope: options?.mode === 'full-face' ? 'full-face-identity-only' : 'upper-face-identity-only', sourceAssetId: source.id } as never
  } })
  try {
    const adult = await generate('mature')
    assert.equal(modes[0], 'full-face')
    assert.match(String(adult.items[0].metadata.identityReferenceAnchor.scope), /full-face/)
    assert.match(prompts[0], /保留附件所示同一演员的脸形/)
    assert.doesNotMatch(prompts[0], /不继承附件中的年龄、肤色、须发颜色/)
    await generate('elderly')
    assert.equal(modes[1], 'upper-face')
    assert.match(prompts[1], /跨年龄身份参考与造型重设计/)
  } finally { await rm(path.join(process.cwd(), 'public', snapshot), { force: true }) }
})

for (const qualityDisposition of ['manual-review-v1', 'automatic'] as const) test(`a paid same-stage face awaiting review stops the first ${qualityDisposition} run, archives and cannot repurchase`, async () => {
  const url = await picture(), source = row('face-keeper', url, context)
  const fingerprint = createHash('sha256').update(url).digest('hex')
  const snapshot = `/generated/appearance-${fingerprint.slice(0, 24)}.jpg`
  const snapshotFile = path.join(process.cwd(), 'public', snapshot)
  await writeFile(snapshotFile, await sharp({ create: { width: 384, height: 216, channels: 3, background: '#777' } }).jpeg().toBuffer())
  source.metadata = { ...source.metadata, visualProfile: { version: 'actual-reference-v2-age-context', sourceFingerprint: fingerprint,
    referenceImage: snapshot, appearance: '同一成熟男性，黑发短须、脸形方阔、眉眼清朗，人物实际图像已核对。' } } as typeof source.metadata
  const target = { ...character, visualContext: { ...context, look: { key: 'new-armor', description: '暗色札甲和深灰披风' } } }
  const stored = [source]
  let purchases = 0
  const archives: unknown[][] = []
  const pool = { query: async (sql: string, values?: unknown[]) => {
    if (sql.includes('insert into character_assets')) archives.push(values ?? [])
    return { rows: sql.includes('from character_assets') ? stored : [], rowCount: 1 }
  } }
  const pendingEvidence = { version: 'same-stage-face-consistency-v1', status: 'needs_manual_review', reason: 'comparison-unavailable',
    sourceAssetId: source.id, sourceSnapshotUrl: snapshot, sourceSnapshotFingerprint: 'source-digest',
    candidateUriFingerprint: 'candidate-uri-digest', threshold: 0.55, reviewedAt: '2026-09-28T00:00:00Z' }
  const generate = () => executeBuiltinNode(pool as never, { operation: 'character.ensure',
    model: { id: 'image', provider: 'Kling', capability: 'image', settings: {} },
    params: { workflowId: 'wf', characters: [target], qualityDisposition, validateThreeView: true,
      deferArchive: true, identityReferenceAssetId: source.id } }, async () => {
    purchases++; return { status: 200, body: { images: [{ url }] } }
  }, { prepareIdentityAnchor: async () => ({ anchorUrl: snapshot, scope: 'full-face-identity-only',
    sourceSnapshotUrl: snapshot, sourceSnapshotFingerprint: 'source-digest' }) as never,
  compareFaceSheets: async () => pendingEvidence as never })
  try {
    await assert.rejects(generate(), /CHARACTER_IDENTITY_REVIEW_REQUIRED.*已归档待人工核验/)
    assert.equal(purchases, 1)
    assert.equal(archives.length, 1)
    const id = String(archives[0][0]), metadata = JSON.parse(String(archives[0][5]))
    assert.equal(metadata.identityConsistency.status, 'needs_manual_review')
    assert.equal(metadata.quality.canProceed, false)
    stored.unshift({ ...row(id, url, target.visualContext), metadata })
    await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.lookup', params: {
      workflowId: 'wf', characters: [target], qualityDisposition: 'manual-review-v1' } }), /CHARACTER_IDENTITY_REVIEW_REQUIRED/)
    await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.lookup', params: {
      workflowId: 'wf', characters: [target], qualityDisposition: 'manual-review-v1',
      characterAssetSelections: { 张飞: id } } }), /CHARACTER_IDENTITY_REVIEW_REQUIRED/)
    await assert.rejects(generate(), /CHARACTER_IDENTITY_REVIEW_REQUIRED/)
    assert.equal(purchases, 1, 'review-pending image must not start another paid generation')
    const decision = { version: 'manual-portrait-review-v1', decision: 'accept', reviewedAt: '2026-09-28T00:00:00Z',
      reviewedContentSha256: metadata.identityConsistency.candidateContentSha256, note: '人工核对五官与三面服装一致' }
    stored[0] = { ...stored[0], metadata: { ...metadata, portraitLifecycle: { status: 'active' }, portraitReviewDecision: decision } }
    const accepted = await executeBuiltinNode(pool as never, { operation: 'character.lookup', params: {
      workflowId: 'wf', characters: [target], qualityDisposition: 'manual-review-v1' } })
    assert.equal(accepted.items[0].id, id)
    assert.equal(accepted.items[0].metadata.identityConsistency.status, 'needs_manual_review', 'original model score remains auditable')
    stored[0] = { ...stored[0], metadata: { ...metadata, portraitLifecycle: { status: 'superseded' },
      portraitReviewDecision: { ...decision, decision: 'reject' } } }
    await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.lookup', params: {
      workflowId: 'wf', characters: [target], qualityDisposition: 'manual-review-v1',
      characterAssetSelections: { 张飞: id } } }), /CHARACTER_PORTRAIT_REVIEW_REJECTED/)
    await assert.rejects(generate(), /CHARACTER_PORTRAIT_REVIEW_REJECTED/)
    assert.equal(purchases, 1, 'rejected image also needs an explicit new revision before another paid request')
  } finally { await rm(snapshotFile, { force: true }) }
})

test('a later face review failure archives every earlier paid portrait in the same deferred batch', async () => {
  const url = await picture(), source = row('zhang-keeper', url, context)
  const fingerprint = createHash('sha256').update(url).digest('hex')
  const snapshot = `/generated/appearance-${fingerprint.slice(0, 24)}.jpg`
  const snapshotFile = path.join(process.cwd(), 'public', snapshot)
  await writeFile(snapshotFile, await sharp({ create: { width: 384, height: 216, channels: 3, background: '#777' } }).jpeg().toBuffer())
  source.metadata = { ...source.metadata,
    artisticIdentity: { version: 'character-artistic-identity-v1', active: true, face: '五官端正，眉眼有神，脸部轮廓方阔' },
    visualProfile: { version: 'actual-reference-v2-age-context', sourceFingerprint: fingerprint,
      referenceImage: snapshot, appearance: '成熟男性，脸形方阔，五官端正，实际图片清晰可辨。' } } as typeof source.metadata
  const target = { ...character, visualContext: { ...context, look: { key: 'new-armor', description: '暗色札甲和深灰披风' } } }
  const companion = { name: '刘备', description: '东汉男性将领' }
  const writes: unknown[][] = []
  const stored: Record<string, unknown>[] = [source]
  const pool = { query: async (sql: string, values?: unknown[]) => {
    if (sql.includes('insert into character_assets')) writes.push(values ?? [])
    return { rows: sql.includes('from character_assets') ? stored : [], rowCount: 1 }
  } }
  let purchases = 0
  try {
    await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.ensure',
      model: { id: 'image', provider: 'Kling', capability: 'image', settings: {} },
      params: { workflowId: 'wf', characters: [companion, target], qualityDisposition: 'manual-review-v1',
        validateThreeView: true, deferArchive: true } }, async () => {
      purchases++; return { status: 200, body: { images: [{ url }] } }
    }, { prepareIdentityAnchor: async () => ({ anchorUrl: snapshot, scope: 'full-face-identity-only',
      sourceSnapshotUrl: snapshot, sourceSnapshotFingerprint: 'source-digest' }) as never,
    compareFaceSheets: async () => ({ status: 'needs_manual_review', reason: 'comparison-unavailable' }) as never }),
    /CHARACTER_IDENTITY_REVIEW_REQUIRED.*已归档待人工核验/)
    assert.equal(purchases, 2)
    assert.deepEqual(writes.map(values => values[2]), ['刘备', '张飞'])
    const firstMetadata = JSON.parse(String(writes[0][5]))
    assert.equal(firstMetadata.portraitLifecycle.status, 'pending-review')
    assert.match(String(writes[0][3]), /^\/generated\/character-portrait-[a-f0-9]{32}\.png$/)
    assert.match(firstMetadata.portraitLifecycle.candidateContentSha256, /^[a-f0-9]{64}$/)
    assert.equal(firstMetadata.quality.canProceed, false)
    assert.equal(JSON.parse(String(writes[1][5])).identityConsistency.status, 'needs_manual_review')
    stored.unshift({ id: writes[0][0], workflow_id: 'wf', character_name: '刘备', asset_type: 'three-view',
      uri: writes[0][3], prompt: writes[0][4], version: 1, metadata: firstMetadata })
    await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.lookup', params: {
      workflowId: 'wf', characters: [companion], qualityDisposition: 'manual-review-v1' } }), /CHARACTER_PORTRAIT_REVIEW_REQUIRED/)
  } finally { await rm(snapshotFile, { force: true }) }
})

test('an unsafe or expired paid image URL remains a blocked recoverable ledger candidate without another purchase', async () => {
  const sourceUrl = await picture(), source = row('face-keeper', sourceUrl, context)
  const fingerprint = createHash('sha256').update(sourceUrl).digest('hex')
  const snapshot = `/generated/appearance-${fingerprint.slice(0, 24)}.jpg`
  const snapshotFile = path.join(process.cwd(), 'public', snapshot)
  await writeFile(snapshotFile, await sharp({ create: { width: 384, height: 216, channels: 3, background: '#777' } }).jpeg().toBuffer())
  source.metadata = { ...source.metadata, visualProfile: { version: 'actual-reference-v2-age-context', sourceFingerprint: fingerprint,
    referenceImage: snapshot, appearance: '同一成熟男性，黑发短须、脸形方阔、眉眼清朗，人物实际图像已核对。' } } as typeof source.metadata
  const target = { ...character, visualContext: { ...context, look: { key: 'new-armor', description: '暗色札甲和深灰披风' } } }
  const blockedUrl = 'https://127.0.0.1/paid-expired.png'
  const stored = [source]
  const writes: unknown[][] = []
  const pool = { query: async (sql: string, values?: unknown[]) => {
    if (sql.includes('insert into character_assets')) writes.push(values ?? [])
    return { rows: sql.includes('from character_assets') ? stored : [], rowCount: 1 }
  } }
  let purchases = 0
  const generate = () => executeBuiltinNode(pool as never, { operation: 'character.ensure',
    model: { id: 'image', provider: 'Kling', capability: 'image', settings: {} },
    params: { workflowId: 'wf', characters: [target], qualityDisposition: 'automatic', validateThreeView: true,
      identityReferenceAssetId: source.id } }, async () => {
    purchases++; return { status: 200, body: { data: { task_id: 'paid-task-123' }, images: [{ url: blockedUrl }] } }
  }, { prepareIdentityAnchor: async () => ({ anchorUrl: snapshot, scope: 'full-face-identity-only',
    sourceSnapshotUrl: snapshot, sourceSnapshotFingerprint: 'source-digest' }) as never,
  compareFaceSheets: async () => ({ status: 'needs_manual_review', reason: 'comparison-unavailable',
    diagnostic: 'source URL is private' }) as never })
  try {
    await assert.rejects(generate(), /CHARACTER_IDENTITY_REVIEW_REQUIRED.*已归档待人工核验/)
    assert.equal(purchases, 1)
    assert.equal(writes.length, 1)
    assert.equal(writes[0][3], blockedUrl)
    const metadata = JSON.parse(String(writes[0][5]))
    assert.equal(metadata.portraitLifecycle.status, 'pending-unrecoverable')
    assert.equal(metadata.portraitLifecycle.originalUri, blockedUrl)
    assert.equal(metadata.portraitLifecycle.originalUriFingerprint, createHash('sha256').update(blockedUrl).digest('hex'))
    assert.equal(metadata.portraitLifecycle.candidateTaskId, 'paid-task-123')
    stored.unshift({ ...row(String(writes[0][0]), blockedUrl, target.visualContext), metadata })
    await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.lookup', params: {
      workflowId: 'wf', characters: [target] } }), /CHARACTER_IDENTITY_REVIEW_REQUIRED/)
    await assert.rejects(generate(), /CHARACTER_IDENTITY_REVIEW_REQUIRED/)
    assert.equal(purchases, 1)
  } finally { await rm(snapshotFile, { force: true }) }
})

test('new Sanguo three-view carries its episode through generation, archive, catalogue and lookup', async () => {
  const workflowId = 'wf-sanguo-history-drama', url = await picture()
  const writes: unknown[][] = []
  const pool = { async query(sql: string, values?: unknown[]) {
    if (sql.includes('insert into character_assets')) { writes.push(values ?? []); return { rows: [], rowCount: 1 } }
    return { rows: [] }
  } }
  let purchases = 0
  const request = { workflowId, episodeNumber: 610, characters: [character], qualityDisposition: 'manual-review-v1', deferArchive: true }
  const generated = await executeBuiltinNode(pool as never, { operation: 'character.ensure',
    model: { id: 'image', provider: 'Kling', capability: 'image', settings: {} }, params: request }, async () => {
    purchases++; return { status: 200, body: { images: [{ url }] } }
  })
  assert.equal(purchases, 1)
  assert.deepEqual(generated.items[0].metadata.episodeScope, { episodes: [610] })
  const archived = await executeBuiltinNode(pool as never, { operation: 'character.archive', params: {
    workflowId, episodeNumber: 610, characters: [character], generatedAssets: generated } })
  const metadata = JSON.parse(String(writes[0][5]))
  assert.deepEqual(metadata.episodeScope, { episodes: [610] })
  assert.deepEqual(archived.items[0].metadata.episodeScope, { episodes: [610] })
  const sheet = { id: archived.items[0].id, workflowId, characterName: '张飞', assetType: 'three-view',
    url, metadata }
  assert.equal(characterVisualCatalog([sheet], workflowId, { input: { episode_number: 610, episode_title: '张飞释严颜' } }).length, 1)
  for (const episode of [637, 693]) {
    assert.deepEqual(characterVisualCatalog([sheet], workflowId, { input: { episode_number: episode, episode_title: '张飞后续故事' } }), [])
    const lookup = await executeBuiltinNode({ query: async (sql: string) => ({ rows: sql.includes('from character_assets')
      ? [{ id: sheet.id, workflow_id: workflowId, character_name: '张飞', asset_type: 'three-view', uri: url, metadata }]
      : [] }) } as never, { operation: 'character.lookup', params: { workflowId, episodeNumber: episode,
      characters: [character], qualityDisposition: 'manual-review-v1' } })
    assert.equal(lookup.missingCount, 1)
  }
  const wrong = structuredClone(generated)
  wrong.items[0].metadata.episodeScope = { episodes: [637] }
  await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.archive', params: {
    workflowId, episodeNumber: 610, characters: [character], generatedAssets: wrong } }), /CHARACTER_EPISODE_SCOPE_MISMATCH/)
  assert.equal(writes.length, 1)
  await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.ensure',
    model: { id: 'image', provider: 'Kling', capability: 'image', settings: {} }, params: { ...request, episodeNumber: undefined } }, async () => {
    purchases++; return { status: 200, body: { images: [{ url }] } }
  }), /CHARACTER_EPISODE_SCOPE_MISSING/)
  assert.equal(purchases, 1, 'missing scope stops before another paid image request')
  assert.deepEqual(generatedCharacterEpisodeScope('unscoped-workflow', undefined), undefined)
})

test('actual white hair observations contradict a dark hair declaration instead of trusting metadata', () => {
  const asset = { metadata: { visualContext: context, visualProfile: { visualContextEvidence: { ageStage: 'unknown', hair: 'white', facialHair: 'white' } } } }
  assert.equal(characterVisualContextCompatibility(context, asset).matches, false)
  assert.match(characterVisualContextCompatibility(context, asset).reason, /实际图片观察/)
})

test('paid beard-color mismatch can be archived with a review flag but cannot be recalled as matching', () => {
  const asset = { metadata: { visualContext: context,
    visualProfile: { visualContextEvidence: { ageStage: 'unknown', hair: 'dark', facialHair: 'graying' } },
    visualContextAssessment: { decision: 'revise', finding: '正面和侧面下颌可见成束花白须丝。', conflicts: [{ field: 'facialHair', expected: 'dark', actual: 'graying' }] },
    quality: { policy: 'principle-v1', assetDecision: 'revise', automaticRetakeAllowed: false, blockingProblems: [] } } }
  const compatibility = characterVisualContextCompatibility(context, asset)
  assert.equal(compatibility.matches, false, 'future automatic recall must still reject it')
  assert.equal(reviewedHairMismatchCanArchive(asset, compatibility.reason), true)
  assert.equal(reviewedHairMismatchCanArchive({ metadata: { ...asset.metadata, quality: {} } }, compatibility.reason), false)
  assert.equal(reviewedHairMismatchCanArchive({ metadata: { ...asset.metadata,
    visualContextAssessment: { ...asset.metadata.visualContextAssessment, conflicts: [{ field: 'ageStage', expected: 'mature', actual: 'elderly' }] } } }, compatibility.reason), false)
})

test('archive retains the exact paid image and its contradictory beard observation without certifying recall', async () => {
  const url = await picture()
  const metadata = { visualContext: context, visualContextSource: 'generation-request-v1',
    visualContextRequestSignature: createHash('sha256').update(characterVisualContextSignature(context)).digest('hex'),
    visualContextImageFingerprint: createHash('sha256').update(url).digest('hex'),
    visualProfile: { appearance: '实际为成熟男性，黑发花白须。', referenceImage: '/generated/current-review.jpg',
      visualContextEvidence: { ageStage: 'unknown', hair: 'dark', facialHair: 'graying' } },
    visualContextAssessment: { decision: 'revise', finding: '正面和侧面下颌可见成束花白须丝。',
      conflicts: [{ field: 'facialHair', expected: 'dark', actual: 'graying' }] },
    quality: { policy: 'principle-v1', assetDecision: 'revise', automaticRetakeAllowed: false, blockingProblems: [] } }
  const inserts: unknown[][] = []
  const pool = { query: async (sql: string, values: unknown[]) => {
    if (sql.includes('insert into character_assets')) inserts.push(values)
    return { rows: [], rowCount: 1 }
  } }
  const archived = await executeBuiltinNode(pool as never, { operation: 'character.archive', params: { workflowId: 'wf',
    characters: [character], generatedAssets: { items: [{ characterName: '张飞', url, metadata }] } } })
  assert.equal(inserts.length, 1)
  assert.equal(archived.items[0].url, url)
  assert.equal(archived.items[0].metadata.visualContextAssessment.decision, 'revise')
  assert.equal(characterVisualContextCompatibility(context, archived.items[0]).matches, false)
})

test('editing variants preserves sound identity and other metadata but invalidates prior image evidence', () => {
  const previous = { continuityKey: 'original', voiceContinuityKey: 'legacy-voice', originalVoice: { characterId: 'same-actor', voiceId: 'same-voice' }, note: '保留',
    visualContext: context, visualProfile: { appearance: 'old' }, quality: { status: 'passed' },
    identityConsistency: { status: 'passed', distance: 0.2 }, sourceMediaProvenance: { contentSha256: 'old-pixels' },
    visualContextSource: 'generation-request-v1', visualContextRequestSignature: 'old-request', visualContextImageFingerprint: 'old-url',
    identityReferenceAssetId: 'keeper', identityReferenceUrl: '/generated/old.png', identityReferenceTransportUrl: '/generated/old-face.jpg',
    identityReferenceAnchor: { anchorUrl: '/generated/old-face.jpg' }, identityVisualProfile: { appearance: 'old face' } }
  const unchanged = mergeCharacterVisualMetadata({ note: 'updated' }, previous)
  assert.deepEqual(unchanged.originalVoice, previous.originalVoice)
  assert.deepEqual(unchanged.visualProfile, previous.visualProfile)
  const changed = mergeCharacterVisualMetadata({ visualContext: { ...context, age: { stage: 'elderly', basis: 'artistic' } } }, previous)
  assert.equal(changed.voiceContinuityKey, 'legacy-voice')
  assert.equal(changed.visualProfile, undefined)
  assert.equal(changed.quality, undefined)
  assert.deepEqual(changed.originalVoice, previous.originalVoice)
  const replaced = mergeCharacterVisualMetadata({}, previous, { imageChanged: true })
  for (const key of ['visualProfile', 'quality', 'identityVisualProfile', 'identityConsistency', 'sourceMediaProvenance',
    'visualContextSource', 'visualContextRequestSignature', 'visualContextImageFingerprint', 'identityReferenceAssetId',
    'identityReferenceUrl', 'identityReferenceTransportUrl', 'identityReferenceAnchor']) assert.equal(replaced[key], undefined, key)
  assert.deepEqual(replaced.originalVoice, previous.originalVoice)
  assert.equal((replaced.portraitLifecycle as { status: string }).status, 'pending-review')
})

test('lookup never auto-selects an old or unassigned-age sheet for a requested mature variant', async () => {
  const url = await picture()
  const elderly = { ...context, age: { stage: 'elderly', basis: 'artistic' } } as CharacterVisualContext
  const rows = [row('old', url, elderly), row('legacy', url), row('mature', url, context)]
  const pool = { async query() { return { rows } } }
  const found = await executeBuiltinNode(pool as never, { operation: 'character.lookup', params: { workflowId: 'wf', characters: [character], qualityDisposition: 'manual-review-v1' } })
  assert.equal(found.items[0].id, 'mature')
  assert.equal(found.rejectedAssets.length, 2)
  const missing = await executeBuiltinNode({ query: async () => ({ rows: rows.slice(0, 2) }) } as never, { operation: 'character.lookup', params: { workflowId: 'wf', characters: [character], qualityDisposition: 'manual-review-v1' } })
  assert.equal(missing.missingCount, 1)
  assert.match(missing.missingCharacters[0].continuityKey, /-visual-[a-f0-9]{24}-v/)
})

test('automatic lookup and ensure do not reuse a Changban sheet in another episode', async () => {
  const url=await picture()
  const scoped={...row('changban',url,context),metadata:{...row('changban',url,context).metadata,episodeScope:{episodes:[518]}}}
  const ordinary=row('later',url,context)
  const pool={query:async()=>({rows:[scoped,ordinary]})}
  const later=await executeBuiltinNode(pool as never,{operation:'character.lookup',params:{workflowId:'wf',characters:[character],episodeNumber:610,qualityDisposition:'manual-review-v1'}})
  assert.equal(later.items[0].id,'later')
  const changban=await executeBuiltinNode({query:async()=>({rows:[scoped]})} as never,{operation:'character.lookup',params:{workflowId:'wf',characters:[character],episodeNumber:518,qualityDisposition:'manual-review-v1'}})
  assert.equal(changban.items[0].id,'changban')
  const unselected=await executeBuiltinNode({query:async()=>({rows:[]})} as never,{operation:'character.ensure',params:{workflowId:'wf',characters:[],allCharacters:[character],existingAssets:[{...scoped,url,characterName:'张飞'}],episodeNumber:610,allowEmpty:true,qualityDisposition:'manual-review-v1'}})
  assert.equal(unselected.items.length,0)
})

test('ensure reuses a matching fixed variant with zero media calls', async () => {
  const url = await picture(), asset = { ...row('mature', url, context), url, characterName: '张飞' }
  let calls = 0
  const result = await executeBuiltinNode({ query: async () => ({ rows: [] }) } as never, { operation: 'character.ensure', params: { workflowId: 'wf', characters: [character], existingAssets: [asset], qualityDisposition: 'manual-review-v1', deferArchive: true } }, async () => { calls++; throw Error('must not purchase') })
  assert.equal(calls, 0)
  assert.equal(result.cachedCount, 1)
})

test('selected lookup pins the exact sheet despite a newer same-design asset, for object and JSON mappings', async () => {
  const url = await picture(), chosen = row('approved-sheet', url, context), newer = row('newer-same-design', url, context)
  const pool = { query: async () => ({ rows: [newer, chosen] }) }
  for (const characterAssetSelections of [{ '张飞': chosen.id }, JSON.stringify({ '张飞': chosen.id })]) {
    const result = await executeBuiltinNode(pool as never, { operation: 'character.lookup', params: { workflowId: 'wf', characters: [character], characterAssetSelections, qualityDisposition: 'manual-review-v1' } })
    assert.equal(result.items[0].id, chosen.id)
    assert.equal(result.items[0].characterName, '张飞', 'matches the App and reference binding API shape')
    assert.equal(result.items[0].url, chosen.uri)
    assert.equal(result.missingCount, 0)
  }
  const ordinary = await executeBuiltinNode(pool as never, { operation: 'character.lookup', params: { workflowId: 'wf', characters: [character], qualityDisposition: 'manual-review-v1' } })
  assert.equal(ordinary.items[0].id, newer.id, 'unselected actors retain ordinary newest-compatible lookup')
})

test('unusable selected sheets fail lookup instead of substituting a valid same-design asset', async () => {
  const url = await picture(), chosen = row('approved-sheet', url, context), alternate = row('alternate', url, context)
  for (const invalid of [undefined, { ...chosen, workflow_id: 'other' }, { ...chosen, workflow_id: null },
    { ...chosen, character_name: '曹操' }, { ...chosen, asset_type: 'portrait' }, row(chosen.id, url),
    row(chosen.id, url, { ...context, age: { stage: 'elderly', basis: 'artistic' } }), { ...chosen, uri: 'data:image/png;base64,broken' }]) {
    const pool = { query: async () => ({ rows: [alternate, ...(invalid ? [invalid] : [])] }) }
    await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.lookup', params: { workflowId: 'wf', characters: [character], characterAssetSelections: { '张飞': chosen.id }, qualityDisposition: 'manual-review-v1' } }), /CHARACTER_VISUAL_SELECTION_MISMATCH/)
  }
  for (const characterAssetSelections of ['invalid-json', '[]', [], { '张飞': '' }, { ' 张飞': chosen.id }, { '张飞': chosen.id, '曹操': chosen.id }]) {
    await assert.rejects(executeBuiltinNode({ query: async () => { throw Error('must reject before database read') } } as never, { operation: 'character.lookup', params: { characters: [character], characterAssetSelections } }), /CHARACTER_VISUAL_SELECTION_INVALID/)
  }
})

test('direct ensure uses the selected archived original and never regenerates an unavailable selection', async () => {
  const url = await picture(), chosen = row('approved-sheet', url, context), alternate = row('alternate', url, context)
  let mediaCalls = 0, writes = 0
  const pool = { query: async (sql: string) => {
    if (sql.includes('from character_assets')) return { rows: [alternate, chosen] }
    if (sql.includes('from voice_characters')) return { rows: [] }
    writes++; throw Error('no database mutations')
  } }
  const execute = async () => { mediaCalls++; throw Error('must not generate a selected sheet') }
  const params = { workflowId: 'wf', characters: [character], characterAssetSelections: { '张飞': chosen.id }, qualityDisposition: 'manual-review-v1', deferArchive: true }
  const result = await executeBuiltinNode(pool as never, { operation: 'character.ensure', params: { ...params,
    existingAssets: [{ ...alternate, characterName: '张飞', url }, { ...chosen, characterName: '张飞', url: 'data:image/png;base64,substituted' }] } }, execute)
  assert.equal(result.items[0].id, chosen.id)
  assert.equal(result.items[0].url, chosen.uri, 'caller metadata cannot substitute the selected original pixels')
  assert.equal(result.generatedCount, 0)
  await assert.rejects(executeBuiltinNode({ query: async () => ({ rows: [alternate] }) } as never, { operation: 'character.ensure', params }, execute), /CHARACTER_VISUAL_SELECTION_MISMATCH/)
  assert.equal(mediaCalls, 0)
  assert.equal(writes, 0)
})

test('read-only appearance lookup respects the chosen sheet without creating observations or voices', async () => {
  const url = await picture(), chosen = row('approved-sheet', url, context), newer = row('newer-same-design', url, context)
  let calls = 0, writes = 0
  const result = await executeBuiltinNode({ query: async (sql: string) => {
    if (sql.includes('from character_assets')) return { rows: [newer, chosen] }
    writes++; throw Error('no database mutations or voice creation')
  } } as never, { operation: 'character.appearance', params: { workflowId: 'wf', characters: [character], characterAssetSelections: { '张飞': chosen.id }, readOnly: true } }, async () => { calls++; throw Error('must not observe') })
  assert.equal(result.items[0].id, chosen.id)
  assert.equal(result.items[0].url, chosen.uri)
  assert.equal(calls, 0)
  assert.equal(writes, 0)
})

test('selected ensure stops after strict layout rejection instead of falling back to another sheet or purchasing', async () => {
  const url = await picture(), chosen = row('approved-sheet', url, context), alternate = row('alternate', url, context)
  let reads = 0, mediaCalls = 0
  const pool = { query: async () => { reads++; return { rows: [alternate, chosen] } } }
  await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.ensure', params: {
    workflowId: 'wf', characters: [character], characterAssetSelections: { '张飞': chosen.id }, validateThreeView: true, deferArchive: true,
  } }, async () => { mediaCalls++; throw Error('must not regenerate a rejected selected layout') }), /CHARACTER_VISUAL_SELECTION_MISMATCH/)
  assert.equal(reads, 1, 'reject before the normal fallback asset query')
  assert.equal(mediaCalls, 0)
})

test('selected voice-only archive retains the exact image ID even when another row shares its continuity key', async () => {
  const url = await picture(), chosen = row('approved-sheet', url, context), alternate = row('newer-same-key', url, context)
  alternate.metadata.continuityKey = chosen.metadata.continuityKey
  let writes = 0
  const pool = { query: async (sql: string) => {
    if (sql.includes('from character_assets')) return { rows: [alternate, chosen] }
    if (sql.includes('from voice_characters')) return { rows: [] }
    writes++; throw Error('selection must not rewrite an archived image')
  } }
  const params = { workflowId: 'wf', characters: [{ ...character, continuityKey: chosen.metadata.continuityKey }], characterAssetSelections: { '张飞': chosen.id }, voiceAssets: [] }
  const result = await executeBuiltinNode(pool as never, { operation: 'character.archive', params })
  assert.equal(result.items[0].id, chosen.id)
  assert.equal(result.items[0].url, chosen.uri)
  assert.equal(writes, 0)
  await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.archive', params: { ...params,
    generatedAssets: { items: [{ ...alternate, characterName: '张飞', url }] } } }), /CHARACTER_VISUAL_SELECTION_MISMATCH/)
  await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.archive', params: { ...params,
    generatedAssets: { items: [{ ...chosen, characterName: '张飞', url: 'data:image/png;base64,substituted' }] } } }), /CHARACTER_VISUAL_SELECTION_MISMATCH/)
  assert.equal(writes, 0)
})

test('narration-only archive reuses silent cast pictures without requiring or mapping their voices', async () => {
  const url = await picture(), chosen = row('approved-sheet', url, context)
  const liubei = { ...row('liubei-sheet', url, context), character_name: '刘备' }
  const narrator = { contract: 'voice-candidate-v2', workflowId: 'wf', characterName: '旁白', continuityKey: '__narrator__', voiceId: 'narrator-voice', accountScope: 'account' }
  let writes = 0
  const pool = { query: async (sql: string) => {
    if (sql.includes('from character_assets')) return { rows: [liubei, chosen] }
    if (sql.includes('from voice_characters')) return { rows: [] }
    if (sql.includes('from original_character_voices') && sql.includes("__narrator__")) return { rows: [{ character_id: 'narrator-id' }] }
    writes++; throw Error('silent pictures must not trigger voice mapping or image writes')
  } }
  const params = { workflowId: 'wf', characters: [character, { ...character, name: '刘备' }], characterAssetSelections: { '张飞': chosen.id, '刘备': liubei.id },
    voiceAssets: [narrator], videoModelId: 'video-model', shot: { audioType: '旁白', audioText: '刘备与张飞并马。' } }
  const result = await executeBuiltinNode(pool as never, { operation: 'character.archive', params })
  assert.deepEqual(result.items.map((item: { id: string }) => item.id), [chosen.id, liubei.id])
  assert.equal(result.voiceAssets.length, 1)
  assert.equal(result.voiceAssets[0].audioRole, 'narration')
  assert.equal(writes, 0)
  const silent = await executeBuiltinNode(pool as never, { operation: 'character.archive', params: { ...params,
    voiceAssets: [], shot: { audioType: '环境声', audioText: '' } } })
  assert.equal(silent.items.length, 2)
  assert.deepEqual(silent.voiceAssets, [])
  await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.archive', params: { ...params, shot: undefined } }), /VOICE_ARCHIVE_INPUT: 人物 张飞/)
  assert.equal(writes, 0)
})

test('archive requires real dialogue voices despite empty supplied scope and stops before image writes', async () => {
  let calls = 0
  const pool = { query: async () => { calls++; throw Error('must reject missing voice obligations before image writes') } }
  for (const voiceAssets of [undefined, [], [{ workflowId: 'wf', characterName: '旁白', continuityKey: '__narrator__' }]]) {
    await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.archive', params: {
      workflowId: 'wf', characters: [character, { ...character, name: '刘备' }], voiceCharacters: [], voiceAssets,
      generatedAssets: { items: [{ characterName: '张飞', url: '/generated/chosen.png' }] },
      shot: { audioType: '对白', audioText: '刘备：张飞，留下。' },
    } }), /VOICE_ARCHIVE_INPUT: 人物 刘备 缺少已归档音色/)
  }
  await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.archive', params: {
    workflowId: 'wf', characters: [], voiceAssets: [], shot: { audioType: '旁白', audioText: '刘备继续赶路。' },
  } }), /VOICE_ARCHIVE_INPUT: 人物 旁白/)
  assert.equal(calls, 0)
})

test('a conflicting look definition cannot silently reuse or automatically buy another sheet', async () => {
  const url = await picture(), old = row('canonical', url, context)
  const redefined = { ...character, visualContext: { ...context, look: { ...context.look, description: '红袍白披风，束发，宽腰带' } } }
  const pool = { query: async (sql: string) => ({ rows: sql.includes('from character_assets') ? [old] : [] }) }
  const lookup = await executeBuiltinNode(pool as never, { operation: 'character.lookup', params: { workflowId: 'wf', characters: [redefined], qualityDisposition: 'manual-review-v1' } })
  assert.equal(lookup.foundCount, 0)
  assert.equal(lookup.missingCharacters[0].requiresVisualContextReview, true)
  assert.deepEqual(lookup.missingCharacters[0].existingLookDefinitions[0].visualContext.look, context.look)
  let calls = 0
  await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.ensure', params: { workflowId: 'wf', characters: [redefined], qualityDisposition: 'manual-review-v1', deferArchive: true } }, async () => { calls++; throw Error('must not purchase') }), /CHARACTER_VISUAL_LOOK_DEFINITION_CONFLICT/)
  const reused = await executeBuiltinNode(pool as never, { operation: 'character.ensure', params: { workflowId: 'wf', characters: [character], qualityDisposition: 'manual-review-v1', deferArchive: true } }, async () => { calls++; throw Error('must not purchase') })
  assert.equal(reused.cachedCount, 1)
  assert.equal(calls, 0)
})

test('direct ensure preserves the same actor voice without requiring a verified face reference or UI lookup', async () => {
  const url = await picture(), legacy = row('legacy-face', url)
  const voice = { id: 'old-voice', workflow_id: 'wf', character_name: '张飞', continuity_key: 'legacy-voice' }
  let voiceReads = 0, writes = 0
  const pool = { async query(sql: string, values?: unknown[]) {
    if (sql.includes('from character_assets')) return { rows: [legacy] }
    if (sql.includes('from voice_characters')) { voiceReads++; assert.ok(values?.includes('wf')); assert.ok(values?.includes('张飞')); return { rows: [voice] } }
    writes++; throw Error('must not create a voice')
  } }
  let calls = 0
  const generated = await executeBuiltinNode(pool as never, { operation: 'character.ensure', model: { id: 'image', provider: 'Kling', capability: 'image', settings: {} }, params: { workflowId: 'wf', characters: [character], qualityDisposition: 'manual-review-v1', deferArchive: true } }, async request => { calls++; assert.equal((request.params as Record<string, unknown>).referenceImages, undefined); return { status: 200, body: { images: [{ url }] } } })
  assert.equal(generated.items[0].metadata.voiceContinuityKey, 'legacy-voice')
  assert.ok(voiceReads > 0)
  const cached = await executeBuiltinNode(pool as never, { operation: 'character.ensure', params: { workflowId: 'wf', characters: [character], existingAssets: [{ ...row('cached', url, context), characterName: '张飞', url }], qualityDisposition: 'manual-review-v1', deferArchive: true } }, async () => { calls++; throw Error('must not purchase') })
  assert.equal(cached.items[0].metadata.voiceContinuityKey, 'legacy-voice')
  assert.equal(cached.generatedCount, 0)
  assert.equal(calls, 1)
  assert.equal(writes, 0)
})

test('direct archive inherits the existing actor voice, and ambiguous voices stop ensure before generation', async () => {
  const url = await picture(), voice = { id: 'old-voice', workflow_id: 'wf', character_name: '张飞', continuity_key: 'legacy-voice' }
  const metadata = { visualContext: context, visualContextSource: 'generation-request-v1', visualContextRequestSignature: createHash('sha256').update(characterVisualContextSignature(context)).digest('hex'), visualContextImageFingerprint: createHash('sha256').update(url).digest('hex') }
  const saved: Record<string, unknown>[] = []
  const archived = await executeBuiltinNode({ query: async (sql: string, values: unknown[]) => {
    if (sql.includes('from voice_characters')) return { rows: [voice] }
    if (sql.includes('insert into character_assets')) { saved.push(JSON.parse(String(values[5]))); return { rows: [], rowCount: 1 } }
    throw Error('must not create a voice')
  } } as never, { operation: 'character.archive', params: { workflowId: 'wf', characters: [character], generatedAssets: { items: [{ characterName: '张飞', url, metadata }] } } })
  assert.equal(archived.items[0].metadata.voiceContinuityKey, 'legacy-voice')
  assert.equal(saved[0].voiceContinuityKey, 'legacy-voice')
  let calls = 0
  await assert.rejects(executeBuiltinNode({ query: async (sql: string) => ({ rows: sql.includes('from voice_characters') ? [voice, { ...voice, id: 'other-version', continuity_key: 'another-legacy' }] : [] }) } as never, { operation: 'character.ensure', params: { workflowId: 'wf', characters: [character], qualityDisposition: 'manual-review-v1', deferArchive: true } }, async () => { calls++; throw Error('must not purchase') }), /VOICE_IDENTITY_AMBIGUOUS/)
  assert.equal(calls, 0)
})

test('new stage generation carries context and verified same-actor face reference, then archives context', async () => {
  const url = await picture(), old = row('verified-identity', url)
  const snapshot = `/generated/appearance-${createHash('sha256').update(url).digest('hex').slice(0, 24)}.jpg`
  await writeFile(path.join(process.cwd(), 'public', snapshot), await sharp({ create: { width: 384, height: 216, channels: 3, background: '#777' } }).jpeg().toBuffer())
  old.metadata = { ...old.metadata, visualProfile: { version: 'actual-reference-v1', sourceFingerprint: createHash('sha256').update(url).digest('hex'), referenceImage: snapshot, appearance: '同一成熟男性，黑发短须，灰袍黑披风和宽腰带，三视图身份一致。' } } as typeof old.metadata
  const pool = { async query(sql: string) { return { rows: sql.includes('from character_assets') ? [old] : [] } } }
  const requests: Array<Record<string, unknown>> = []
  const generated = await executeBuiltinNode(pool as never, { operation: 'character.ensure', model: { id: 'image', provider: 'Kling', capability: 'image', settings: {} }, params: { workflowId: 'wf', characters: [character], existingAssets: [{ ...old, characterName: '张飞', url }], qualityDisposition: 'manual-review-v1', deferArchive: true, identityReferenceAssetId: old.id } }, async request => { requests.push(request); return { status: 200, body: { images: [{ url }] } } }, anchorDependencies)
  assert.equal(requests.length, 1)
  const params = requests[0].params as Record<string, unknown>
  assert.deepEqual(params.referenceImages, [generated.items[0].metadata.identityReferenceAnchor.anchorUrl])
  assert.notEqual(params.referenceImages[0], url)
  assert.equal(params.imageEdit, true)
  assert.deepEqual(params.visualContext, context)
  assert.match(String(requests[0].prompt), /跨年龄身份参考与造型重设计/)
  assert.match(String(requests[0].prompt), /成熟壮年/)
  assert.match(String(requests[0].prompt), /不是复刻旧整图/)
  assert.match(String(requests[0].prompt), /完全去除所有灰白须丝/)
  assert.match(String(requests[0].prompt), /完整全身正面、侧面、背面/)
  assert.match(String(requests[0].prompt), /输出仍是彩色真人角色/)
  assert.match(String(requests[0].prompt), /不用于输出肤色/)
  assert.equal(generated.items[0].metadata.identityReferenceAnchor.colorPolicy, 'geometry-only-grayscale')
  assert.equal(generated.items[0].metadata.identityReferenceAssetId, old.id)
  assert.equal(generated.items[0].metadata.visualContext.age.basis, 'artistic')
  const inserts: unknown[][] = []
  const archived = await executeBuiltinNode({ query: async (sql: string, values: unknown[]) => { if (sql.includes('insert into character_assets')) inserts.push(values); return { rows: [], rowCount: 1 } } } as never, { operation: 'character.archive', params: { workflowId: 'wf', characters: [character], generatedAssets: generated } })
  assert.equal(archived.items[0].metadata.identityReferenceAssetId, old.id)
  assert.deepEqual(JSON.parse(String(inserts[0][5])).visualContext, context)
  const repeated = await executeBuiltinNode({ query: async () => ({ rows: [] }) } as never, { operation: 'character.ensure', params: { workflowId: 'wf', characters: [character], existingAssets: generated.items, qualityDisposition: 'manual-review-v1', deferArchive: true } }, async () => { throw Error('must not repurchase') })
  assert.equal(repeated.generatedCount, 0)
  await rm(path.join(process.cwd(), 'public', snapshot), { force: true })
  const anchorUrl = generated.items[0].metadata.identityReferenceAnchor.anchorUrl
  await rm(path.join(process.cwd(), 'public', anchorUrl), { force: true })
  await rm(path.join(process.cwd(), 'public', anchorUrl.replace(/\.jpg$/, '.json')), { force: true })
})

test('other actors or workflows cannot be selected as explicit face identity references', async () => {
  const url = await picture(), wrong = { ...row('other', url), workflow_id: 'other-workflow', character_name: '曹操' }
  let calls = 0
  await assert.rejects(executeBuiltinNode({ query: async () => ({ rows: [wrong] }) } as never, { operation: 'character.ensure', params: { workflowId: 'wf', characters: [character], deferArchive: true, identityReferenceAssetId: 'other' } }, async () => { calls++; throw Error('never submit') }), /CHARACTER_IDENTITY_REFERENCE_INVALID/)
  assert.equal(calls, 0)
})

test('verified remote face references use only the server snapshot bound to their original URI', async () => {
  const original = `https://example.com/face-${randomUUID()}.png?signature=original`, fingerprint = createHash('sha256').update(original).digest('hex')
  const snapshot = `/generated/appearance-${fingerprint.slice(0, 24)}.jpg`, file = path.join(process.cwd(), 'public', snapshot)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, await sharp({ create: { width: 384, height: 216, channels: 3, background: '#777' } }).jpeg().toBuffer())
  const output = await picture(), source = row('same-actor', original)
  const profile = { version: 'actual-reference-v1', sourceFingerprint: fingerprint, referenceImage: snapshot, appearance: '同一成熟男性，黑发短须、灰色衣袍与黑色披风，三面身份保持一致。' }
  source.metadata = { ...source.metadata, visualProfile: profile } as typeof source.metadata
  const requests: Array<Record<string, unknown>> = []
  const pool = { query: async (sql: string) => ({ rows: sql.includes('from character_assets') ? [source] : [] }) }
  const params = { workflowId: 'wf', characters: [character], qualityDisposition: 'manual-review-v1', deferArchive: true, identityReferenceAssetId: source.id }
  const execute = async (request: Record<string, unknown>) => { requests.push(request); return { status: 200, body: { images: [{ url: output }] } } }
  const request = { operation: 'character.ensure', model: { id: 'image', provider: 'Kling', capability: 'image', settings: {} }, params }
  try {
    const generated = await executeBuiltinNode(pool as never, request, execute, anchorDependencies)
    const anchorUrl = generated.items[0].metadata.identityReferenceAnchor.anchorUrl
    assert.deepEqual((requests[0].params as Record<string, unknown>).referenceImages, [anchorUrl])
    assert.notEqual(anchorUrl, snapshot)
    assert.equal((requests[0].params as Record<string, unknown>).imageEdit, true)
    const prepared = await prepareKlingImageInputs(requests[0].params as Record<string, unknown>)
    assert.match(String((prepared.referenceImages as string[])[0]), /^data:image\/jpeg;base64,/)
    const decoded = await sharp(Buffer.from(String((prepared.referenceImages as string[])[0]).split(',')[1], 'base64')).metadata()
    assert.equal(decoded.width, 512)
    const providerRequests: Array<{ url: string; body: Record<string, unknown> }> = []
    await callKlingImage({ id: 'image', provider: 'Kling', capability: 'image', settings: { model: 'kling-v3', endpoint: 'https://example.test/v1/images/generations', apiKey: 'test' } }, String(requests[0].prompt), requests[0].params as Record<string, unknown>, { fetch: async (uri, init) => {
      providerRequests.push({ url: String(uri), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ code: 0, data: { task_id: 'edited-variant', task_status: 'succeed', task_result: { images: [{ url: output }] } } }))
    } })
    assert.equal(providerRequests.length, 1)
    assert.equal(providerRequests[0].url, 'https://example.test/v1/images/omni-image')
    assert.equal(providerRequests[0].body.model_name, 'kling-v3-omni')
    assert.equal(providerRequests[0].body.image, undefined)
    assert.deepEqual(providerRequests[0].body.image_list, [{ image: String((prepared.referenceImages as string[])[0]).split(',')[1] }])
    assert.equal(generated.items[0].metadata.identityReferenceUrl, original)
    assert.equal(generated.items[0].metadata.identityReferenceTransportUrl, anchorUrl)
    assert.equal(generated.items[0].metadata.identityReferenceAssetId, source.id)
    await assert.rejects(executeBuiltinNode(pool as never, request, execute, { prepareIdentityAnchor: async () => { throw Error('FACIAL_IDENTITY_ANCHOR_UNAVAILABLE: no reliable face') } }), /FACIAL_IDENTITY_ANCHOR_UNAVAILABLE/)
    assert.equal(requests.length, 1)
    for (const referenceImage of ['/generated/arbitrary-other-actor.jpg', undefined]) {
      source.metadata = { ...source.metadata, visualProfile: { ...profile, referenceImage } } as typeof source.metadata
      await assert.rejects(executeBuiltinNode(pool as never, request, execute), /CHARACTER_IDENTITY_REFERENCE_SNAPSHOT_(?:INVALID|MISSING)/)
    }
    source.metadata = { ...source.metadata, visualProfile: profile } as typeof source.metadata
    await rm(file, { force: true })
    await assert.rejects(executeBuiltinNode(pool as never, request, execute), /CHARACTER_IDENTITY_REFERENCE_SNAPSHOT_MISSING/)
    assert.equal(requests.length, 1)
    await rm(path.join(process.cwd(), 'public', anchorUrl), { force: true })
    await rm(path.join(process.cwd(), 'public', anchorUrl.replace(/\.jpg$/, '.json')), { force: true })
  } finally { await rm(file, { force: true }) }
})

test('strict appearance rejection retries redesign from the facial anchor instead of the rejected full beard sheet', async () => {
  const original = `https://example.com/retry-face-${randomUUID()}.png`, fingerprint = createHash('sha256').update(original).digest('hex')
  const snapshot = `/generated/appearance-${fingerprint.slice(0, 24)}.jpg`, file = path.join(process.cwd(), 'public', snapshot)
  await writeFile(file, await sharp({ create: { width: 384, height: 216, channels: 3, background: '#777' } }).jpeg().toBuffer())
  const old = row('verified-older-face', original)
  old.metadata = { ...old.metadata, visualProfile: { version: 'actual-reference-v1', sourceFingerprint: fingerprint, referenceImage: snapshot, appearance: '同一成熟男性，黑发短须、灰色衣袍与黑色披风，三面身份保持一致。' } } as typeof old.metadata
  let writes = 0
  const pool = { query: async (sql: string) => {
    if (sql.includes('from character_assets')) return { rows: [old] }
    if (sql.includes('from model_execution_records')) return { rows: [{ model_id: 'image', response_data: { qualityRejected: true, qualityRejection: 'CHARACTER_APPEARANCE_REJECTED: gray beard', images: [{ url: '/generated/rejected-gray-beard.png' }] } }] }
    if (sql.includes('from voice_characters')) return { rows: [] }
    writes++; throw Error('must not mutate DB during capture')
  } }
  let captured: Record<string, unknown> | undefined
  const dependencies = { prepareIdentityAnchor: async () => ({ anchorUrl: '/generated/verified-upper-face-only.jpg', sourceAssetId: old.id }) }
  try {
    await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.ensure', model: { id: 'image', provider: 'Kling', capability: 'image', settings: {} }, executionContext: { requestKey: 'same-rejected-execution' }, params: { workflowId: 'wf', characters: [character], validateThreeView: true, maxGenerationAttempts: 5, deferArchive: true, identityReferenceAssetId: old.id, generationPromptTemplate: '{{character.name}}：{{character.description}}。修复反馈：{{feedback}}' } }, async request => { captured = request; throw Error('STOP_CAPTURE') }, dependencies), /STOP_CAPTURE/)
    const params = captured!.params as Record<string, unknown>
    assert.equal(params.referenceImage, undefined)
    assert.deepEqual(params.referenceImages, ['/generated/verified-upper-face-only.jpg'])
    assert.equal(params.imageEdit, true)
    assert.match(String(captured!.prompt), /gray beard/)
    assert.match(String(captured!.prompt), /完整全身正面、侧面、背面/)
    assert.match(String(captured!.prompt), /完全去除所有灰白须丝/)
    assert.equal(writes, 0)
  } finally { await rm(file, { force: true }) }
})

test('archive rejects a cached sheet of the wrong life stage before any write', async () => {
  let writes = 0
  await assert.rejects(executeBuiltinNode({ query: async () => { writes++; return { rows: [] } } } as never, { operation: 'character.archive', params: { workflowId: 'wf', characters: [character], generatedAssets: { items: [{ characterName: '张飞', url: '/generated/old.png', cached: true, metadata: { visualContext: { ...context, age: { stage: 'elderly', basis: 'artistic' } } } }] } } }), /CHARACTER_VISUAL_CONTEXT_MISMATCH/)
  assert.equal(writes, 0)
})

test('archive cannot relabel bare URLs or unproved structured images with requested age', async () => {
  for (const generatedAssets of [{ urls: ['/generated/old.png'] }, { items: [{ characterName: '张飞', url: '/generated/old.png' }] }, { items: [{ characterName: '张飞', url: '/generated/old.png', metadata: { visualContext: context } }] }, { items: [{ characterName: '张飞', url: '/generated/substituted.png', metadata: { visualContext: context, visualContextSource: 'generation-request-v1', visualContextRequestSignature: createHash('sha256').update(characterVisualContextSignature(context)).digest('hex'), visualContextImageFingerprint: createHash('sha256').update('/generated/original.png').digest('hex') } }] }]) {
    let writes = 0
    await assert.rejects(executeBuiltinNode({ query: async () => { writes++; return { rows: [] } } } as never, { operation: 'character.archive', params: { workflowId: 'wf', characters: [character], generatedAssets } }), /CHARACTER_VISUAL_CONTEXT_(?:PROVENANCE_MISSING|MISSING)/)
    assert.equal(writes, 0)
  }
})

test('unknown observations cannot assign an old image a requested age or dark hair', async () => {
  const url = '/generated/legacy.png'
  const visualContextHash = createHash('sha256').update(characterVisualContextSignature(context)).digest('hex')
  for (const visualContextEvidence of [{ ageStage: 'unknown', hair: 'dark', facialHair: 'dark' }, { ageStage: 'adult', hair: 'unknown', facialHair: 'dark' }]) {
    let writes = 0
    await assert.rejects(executeBuiltinNode({ query: async () => { writes++; return { rows: [] } } } as never, { operation: 'character.archive', params: { workflowId: 'wf', characters: [character], generatedAssets: { items: [{ characterName: '张飞', url, metadata: { visualContext: context, visualProfile: { version: 'actual-reference-v2-age-context', visualContextHash, sourceFingerprint: createHash('sha256').update(url).digest('hex'), visualContextEvidence } } }] } } }), /CHARACTER_VISUAL_CONTEXT_PROVENANCE_MISSING/)
    assert.equal(writes, 0)
  }
  const stored: Record<string, unknown>[] = []
  const archived = await executeBuiltinNode({ query: async (sql: string, values: unknown[]) => {
    if (sql.includes('insert into character_assets')) stored.push(JSON.parse(String(values[5])))
    return { rows: [], rowCount: 1 }
  } } as never, { operation: 'character.archive', params: { workflowId: 'wf', characters: [character], generatedAssets: { items: [{ characterName: '张飞', url, metadata: { visualContext: context, visualContextSource: 'actual-reference-review-v1', visualProfile: { version: 'actual-reference-v2-age-context', visualContextHash, sourceFingerprint: createHash('sha256').update(url).digest('hex'), visualContextEvidence: { ageStage: 'adult', hair: 'dark', facialHair: 'dark' } } } }] } } })
  assert.equal(archived.archivedCount, 1)
  assert.equal(stored[0].visualContextSource, 'actual-reference-review-v1')
})

test('ensure to actual appearance to archive preserves bound generation provenance even when adult age is unknown', async () => {
  const url = `/generated/visual-context-test-${randomUUID()}.png`, file = path.join(process.cwd(), 'public', url)
  const appearanceFile = path.join(process.cwd(), 'public/generated', `appearance-${createHash('sha256').update(url).digest('hex').slice(0, 24)}.jpg`)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, await sharp({ create: { width: 384, height: 216, channels: 3, background: '#777' } }).png().toBuffer())
  const observerModel = { id: 'claude-opus-4-8', provider: 'Anthropic', capability: 'text', settings: {} }
  const saved: Record<string, unknown>[] = []
  const pool = { query: async (sql: string, values?: unknown[]) => {
    if (sql.includes('from model_configs')) return { rows: [observerModel] }
    if (sql.includes('insert into character_assets')) saved.push(JSON.parse(String(values![5])))
    return { rows: [], rowCount: 1 }
  } }
  let images = 0, reviews = 0
  const execute = async (request: Record<string, unknown>) => {
    if (request.operation === 'character.three-view') { images++; return { status: 200, body: { images: [{ url }] } } }
    assert.equal(request.operation, 'history.media-review'); reviews++
    return { status: 200, body: { valid: true, matchesDesign: true, appearance: '同一成熟壮实男性，黑色束发和黑色短须，灰袍、黑色披风与宽腰带，三面稳定一致。', issues: [], visualContextEvidence: { ageStage: 'unknown', hair: 'dark', facialHair: 'dark' } } }
  }
  try {
    const generated = await executeBuiltinNode(pool as never, { operation: 'character.ensure', model: { id: 'image', provider: 'Kling', capability: 'image', settings: {} }, params: { workflowId: 'wf', characters: [character], qualityDisposition: 'manual-review-v1', deferArchive: true } }, execute)
    const observed = await executeBuiltinNode(pool as never, { operation: 'character.appearance', params: { workflowId: 'wf', characters: [character], assets: generated.items } }, execute)
    assert.equal(observed.items[0].metadata.visualContextSource, 'generation-request-v1')
    assert.equal(observed.items[0].metadata.visualProfile.visualContextEvidence.ageStage, 'unknown')
    const archived = await executeBuiltinNode(pool as never, { operation: 'character.archive', params: { workflowId: 'wf', characters: [character], generatedAssets: observed } })
    assert.equal(archived.archivedCount, 1)
    assert.equal(saved[0].visualContextSource, 'generation-request-v1')
    assert.equal(images, 1)
    assert.equal(reviews, 1)
    for (const broken of [{ visualContextRequestSignature: 'wrong-context' }, { visualContextImageFingerprint: 'wrong-image' }]) {
      const asset = { ...observed.items[0], metadata: { ...observed.items[0].metadata, ...broken } }
      const rereviewed = await executeBuiltinNode(pool as never, { operation: 'character.appearance', params: { workflowId: 'wf', characters: [character], assets: [asset] } }, execute)
      assert.equal(rereviewed.items[0].metadata.visualContextSource, 'actual-reference-review-v1')
      await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.archive', params: { workflowId: 'wf', characters: [character], generatedAssets: rereviewed } }), /CHARACTER_VISUAL_CONTEXT_PROVENANCE_MISSING/)
    }
    assert.equal(saved.length, 1)
    assert.equal(images, 1)
  } finally { await rm(file, { force: true }); await rm(appearanceFile, { force: true }) }
})

test('a new visual variant recalls an existing voice before image creation instead of creating another voice', async () => {
  const voice = { id: 'old-voice', workflow_id: 'wf', character_name: '张飞', continuity_key: 'legacy-voice' }
  const pool = { async query(sql: string) {
    if (sql.includes('from character_assets')) return { rows: [] }
    if (sql.includes('from voice_characters')) return { rows: [voice] }
    if (sql.includes('from original_character_voices')) return { rows: [{ ...voice, voice_id: 'same-original', status: 'ready' }] }
    throw Error('no mutations')
  } }
  const output = await executeBuiltinNode(pool as never, { operation: 'character.lookup', params: { workflowId: 'wf', characters: [character], includeVoices: true, qualityDisposition: 'manual-review-v1', shot: { audioType: '对白', audioText: '张飞：先走。' } } })
  assert.equal(output.missingCount, 1)
  assert.equal(output.missingCharacters[0].voiceContinuityKey, 'legacy-voice')
  assert.equal(output.voiceCharacters[0].continuityKey, 'legacy-voice')
  assert.equal(output.existingVoices[0].voiceId, 'same-original')
})

test('a visual variant preserves only an existing same-workflow, same-person voice identity', async () => {
  const asset = { id: 'variant', workflow_id: 'wf', character_name: '张飞', metadata: { continuityKey: 'new-visual', voiceContinuityKey: 'legacy-voice' } }
  const identity = { id: 'same-voice-person', workflow_id: 'wf', character_name: '张飞', continuity_key: 'legacy-voice' }
  let inserts = 0
  const pool = { async query(sql: string, values: unknown[]) {
    if (sql.includes('from character_assets')) return { rows: [asset] }
    if (sql.includes('from voice_characters')) { assert.deepEqual(values, ['wf', '张飞', 'legacy-voice']); return { rows: [identity] } }
    inserts++; throw Error('no new voice identity')
  } }
  assert.equal((await characterVoiceIdentity(pool as never, 'variant')).identity.id, identity.id)
  assert.equal(inserts, 0)
  assert.equal(stableVoiceContinuityKey({ name: '张飞', continuityKey: 'another-look', voiceContinuityKey: 'legacy-voice' }), 'legacy-voice')
  await assert.rejects(characterVoiceIdentity({ query: async (sql: string) => ({ rows: sql.includes('from character_assets') ? [asset] : [] }) } as never, 'variant'), /VOICE_IDENTITY_MISMATCH/)
})

test('three view prompt keeps the current stage and dark hair in generation constraints', () => {
  assert.match(buildThreeViewGenerationPrompt(character), /艺术年龄设定/)
  assert.match(buildThreeViewGenerationPrompt(character), /成熟壮年/)
  assert.match(buildThreeViewNegativePrompt(character), /白发/)
  assert.match(buildThreeViewNegativePrompt(character), /白须/)
})
