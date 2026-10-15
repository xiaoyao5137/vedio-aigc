import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { encodeExecutionState, decodeExecutionState } from '../src/execution-storage.ts'
import { upgradeStoryQualityWorkflow } from '../src/story-quality-workflow.ts'
import { buildSourceStoryMediaRetakeWorkflow, checkedStoryMediaRetakeWorkflow,
  STORY_MEDIA_RETAKE_CANONICAL_EDGES } from '../src/story-media-retake-workflow.ts'
import { storyVideoModelContract } from '../src/story-media-retake-model.ts'
import { createJsonHasher } from '../scripts/restore-branch-checkpoint.mjs'
import { forkStoryMediaRetake, parseArguments, prepareStoryMediaRetakeFork,
  verifyArchivedVideo, verifyOpeningImage } from '../scripts/fork-story-media-retake.mjs'

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const param = (englishName: string, value: string, required = true) => ({ id: englishName, name: englishName,
  englishName, type: 'text', required, value })
const node = (id: string, kind: string, resultVar = id, x = 0) => ({ id, title: id, kind, resultVar,
  prompt: '', params: [] as ReturnType<typeof param>[], uploads: [],
  loop: { enabled: kind === 'loop', sourcePath: '', fallbackCount: 0, itemVar: 'shot' },
  position: { x, y: 0 }, parentId: undefined as string | undefined,
  childIds: undefined as string[] | undefined, operation: undefined as string | undefined })

function workflow() {
  const loop = node('node-loop', 'loop', 'shot_loop', 900)
  loop.childIds = ['node-image', 'node-video', 'node-video-concat']
  loop.loop = { enabled: true, sourcePath: 'script_generation.shots', fallbackCount: 8, itemVar: 'shot' }
  const script = node('node-script', 'text', 'script_generation', 600)
  const image = node('node-image', 'image', 'first_frame', 1200)
  const video = node('node-video', 'video', 'video_shot', 1500)
  ;(video as typeof video & { modelId?: string }).modelId = 'keling3'
  video.prompt = '完成 ${shotTimedActions}，全长 ${shot.duration} 秒'
  video.params = [param('duration', '${shot.duration}'), param('referenceImage', '${first_frame}')]
  const concat = node('node-video-concat', 'videoConcat', 'stage_video', 1800)
  concat.parentId = loop.id
  concat.operation = 'video.concat'
  concat.params = [param('currentVideo', '${video_shot}')]
  const before = { id: 'wf-story', schemaVersion: 4,
    nodes: [node('node-input', 'input', 'input', 0), node('node-model-images', 'image', 'model_images', 300),
      script, loop, image, video, concat],
    edges: [
      { id: 'a', from: 'node-input', to: 'node-model-images' },
      { id: 'b', from: 'node-model-images', to: 'node-script' },
      { id: 'c', from: 'node-script', to: 'node-loop' },
      { id: 'd', from: 'node-loop', to: 'node-image' },
      { id: 'e', from: 'node-image', to: 'node-video' },
      { id: 'f', from: 'node-video', to: 'node-video-concat' },
    ] }
  const current = upgradeStoryQualityWorkflow(before)
  return { id: 'wf-story', schema_version: 5, nodes_md5: 'b'.repeat(32),
    edges_md5: 'c'.repeat(32), nodes: current.nodes,
    edges: STORY_MEDIA_RETAKE_CANONICAL_EDGES.map(edge => ({ ...edge })) }
}

function fixture(bytes = Buffer.alloc(2048, 17)) {
  const wf = workflow()
  const byId = new Map(wf.nodes.map(item => [item.id, item]))
  const shot = { title: 'breakfast', duration: 4, timedActions: '0–2 秒完成交易；2–4 秒保持终态',
    visualBeats: [{ id: 'exchange', action: '交付纸钞', completion: '店员持有纸钞', startSecond: 0, endSecond: 2 }] }
  const sourceUrl = 'https://example.invalid/paid.mp4?token=signed-secret'
  const localUrl = '/generated/archive.mp4'
  const evidenceUrl = '/generated/archive-evidence.json'
  const frameUrls = [0, 1, 2, 3].map(i => `/generated/archive-frame-${i}.jpg`)
  const evidence = { url: localUrl, sha256: sha256(bytes), decoded: true,
    originalUrl: sourceUrl, evidenceUrl, frames: frameUrls, frameTimes: [0, 1, 2, 3] }
  const observations = { version: 'story-shot-observations-v1', sourceVideoSha256: evidence.sha256,
    evidenceUrl, frames: frameUrls.map((frameUrl, i) => ({ frameIndex: i, second: i, frameUrl,
      description: i >= 2 ? '纸钞仍在台面' : '纸钞放在买方爪边' })) }
  const assessment = { version: 'story-shot-media-review-v1', passed: false,
    sourceVideoSha256: evidence.sha256, evidenceUrl,
    beatChecks: [{ id: 'exchange', status: 'incomplete', reason: '纸钞未转移',
      evidenceFrameIndices: [2, 3], evidenceObservations: ['纸钞仍在台面', '纸钞仍在台面'] }],
    endingHold: { status: 'incomplete', reason: '计划终态未形成', firstFrameIndex: 2, lastFrameIndex: 3,
      firstObservation: '纸钞仍在台面', lastObservation: '纸钞仍在台面' } }
  const review = { version: 'story-shot-media-review-v1', passed: false, retryable: true,
    reviewStatus: 'incomplete', videoUrl: sourceUrl, videoEvidence: evidence, observations, assessment,
    beatChecks: assessment.beatChecks, endingHold: assessment.endingHold, issues: ['纸钞未转归店员'] }
  const videoOutput = { url: sourceUrl, model: 'video-provider' }
  const reviewOutput = { url: localUrl, originalUrl: sourceUrl, passed: false,
    videoEvidence: evidence, storyMediaReview: review }
  const input = { topic: 'breakfast', vedio_count: 1 }
  const inputContext = { input }
  const scriptContext = { ...inputContext, script_generation: { shots: [shot] } }
  const scriptReviewContext = { ...scriptContext, script_review: { passed: true, shots: [shot] } }
  const loopContext = { ...scriptReviewContext, shot_loop: { count: 1 } }
  const loopNode = byId.get('node-loop')!
  const firstFrame = { url: '/generated/opening.png' }
  const imageContext = { ...loopContext, shot, first_frame: firstFrame }
  const videoContext = { ...imageContext, video_shot: videoOutput }
  const run = (id: string, index: number, status: string, output: unknown, context: Record<string, unknown>,
    extra: Record<string, unknown> = {}) => ({ id: `${id}-${index}`, node: byId.get(id)!,
      label: `${id} -> ${byId.get(id)!.resultVar}`, status, output, context,
      inputs: {}, inputContext: context, revision: 0, attempt: 1, errorAttempt: 1, ...extra })
  const scoped = { loopGroupId: 'loop-1', loopIndex: 0, loopItem: shot, loopNode }
  const runs = [
    run('node-input', 0, 'success', input, inputContext),
    run('node-model-images', 1, 'success', { items: [] }, inputContext),
    run('node-script', 2, 'success', { shots: [shot] }, scriptContext),
    run('node-script-review', 3, 'success', { passed: true, shots: [shot] }, scriptReviewContext),
    run('node-loop', 4, 'success', { count: 1 }, loopContext),
    run('node-image', 5, 'success', firstFrame, imageContext, scoped),
    run('node-video', 6, 'success', videoOutput, videoContext, scoped),
    run('node-video-review', 7, 'failed', reviewOutput, videoContext,
      { ...scoped, inputs: { shot, video: videoOutput }, error: '质量校验未通过' }),
    run('node-video-concat', 8, 'idle', undefined, {}, scoped),
  ]
  const state = { id: 'record-source', workflowId: 'wf-story', workflowName: 'story',
    mode: 'step', nodeRuns: runs, runtimeInputs: { input }, context: videoContext,
    logs: ['source completed', 'review failed'], selectedNodeId: 'node-video-review' }
  const source = { id: state.id, workflow_id: 'wf-story', workflow_name: 'story',
    runtime_inputs: { input }, result_md5: 'a'.repeat(32), result: encodeExecutionState(state) }
  const model = { id: 'keling3', provider: 'Kling', capability: 'video',
    settings: { endpoint: 'https://api.example.invalid/v1/videos', model: 'kling-v3', mode: 'std',
      image: 'https://signed.example.invalid/demo.png?token=signed-secret', apiKey: 'secret' } }
  return { source, wf, bytes, review, shot, sourceUrl, localUrl, model }
}

test('apply gate requires a reviewed source hash and explicit distinct target ID', () => {
  assert.throws(() => parseArguments(['--source', 'record-source', '--apply']), /requires an explicit --id/)
  assert.throws(() => parseArguments(['--source', 'record-source', '--id', 'record-source']), /distinct/)
  assert.throws(() => parseArguments(['--source', 'record-source', '--review-index', '1.5']), /nonnegative integer/)
  assert.throws(() => parseArguments(['--source', 'record-source', '--expected-source-md5', 'wrong']), /32-digit MD5/)
  assert.throws(() => parseArguments(['--source', 'record-source', '--id', 'record-new',
    '--expected-source-md5', 'a'.repeat(32), '--apply']), /expected-workflow-md5/)
  assert.throws(() => parseArguments(['--source', 'record-source', '--expected-workflow-md5', 'wrong']), /32-digit MD5/)
  assert.throws(() => parseArguments(['--source', 'record-source', '--source-workflow-snapshot',
    '--id', 'record-new', '--expected-source-md5', 'a'.repeat(32),
    '--expected-workflow-md5', 'b'.repeat(32), '--apply']), /expected-workflow-edges-md5/)
  assert.equal(parseArguments(['--source', 'record-source']).apply, false)
  assert.equal(parseArguments(['--source', 'record-source', '--source-workflow-snapshot']).sourceWorkflowSnapshot, true)
  assert.equal(parseArguments(['--source', 'record-source', '--id', 'record-new',
    '--expected-source-md5', 'a'.repeat(32), '--expected-workflow-md5', 'b'.repeat(32), '--apply']).apply, true)
})

test('snapshot mode freezes exact source nodes and canonical edges despite changed current prompts', () => {
  const { source, wf, model } = fixture()
  const state = decodeExecutionState<{ nodeRuns: Array<{ node: { id: string; params: Array<{ englishName?: string }> } }> }>(source.result)
  for (const run of state.nodeRuns) {
    if (['node-image', 'node-video'].includes(run.node.id)) {
      run.node = { ...run.node, params: run.node.params.filter(item => item.englishName !== 'storyShot') }
    }
  }
  const oldSource = { ...source, result: encodeExecutionState(state) }
  const drifted = { ...wf, nodes: wf.nodes.map(item => item.id === 'node-script'
    ? { ...item, prompt: '已改成另一剧情' } : item) }
  assert.throws(() => prepareStoryMediaRetakeFork(oldSource, drifted, 'record-new', undefined,
    undefined, { model }), /node contracts differ/)
  const prepared = prepareStoryMediaRetakeFork(oldSource, drifted, 'record-new', undefined,
    undefined, { model, sourceWorkflowSnapshot: true })
  const frozen = prepared.state.storyMediaRetake.sourceWorkflow
  assert.deepEqual(frozen.edges, wf.edges)
  assert.deepEqual(frozen.nodes.find((item: { id: string }) => item.id === 'node-video'), state.nodeRuns[6].node)
  assert.equal(frozen.nodes.find((item: { id: string }) => item.id === 'node-video')
    .params.some((item: { englishName?: string }) => item.englishName === 'storyShot'), false)
  assert.equal(prepared.state.nodeRuns[6].node.params.some((item: { englishName?: string }) =>
    item.englishName === 'storyShot'), false)
  assert.equal(prepared.proof.sourceWorkflowSnapshot, true)
  assert.match(prepared.proof.sourceWorkflowHash, /^[a-f\d]{64}$/)
  assert.equal(prepared.proof.preservedPrefixHash,
    createJsonHasher()(decodeExecutionState<{ nodeRuns: unknown[] }>(oldSource.result).nodeRuns.slice(0, 6)))
  assert.doesNotMatch(JSON.stringify(prepared.proof), /signed-secret|https?:\/\//)
  assert.throws(() => prepareStoryMediaRetakeFork(oldSource,
    { ...drifted, edges: [...drifted.edges, { id: 'bypass', from: 'node-video', to: 'node-video-concat' }] },
    'record-new', undefined, undefined, { model, sourceWorkflowSnapshot: true }), /canonical schema-5/)
})

test('pure source workflow check rejects any changed edge or repeated run node snapshot', () => {
  const { source, wf } = fixture()
  const state = decodeExecutionState<{ nodeRuns: Array<{ node: { id: string; prompt: string } }> }>(source.result)
  const runs = state.nodeRuns
  const frozen = buildSourceStoryMediaRetakeWorkflow(runs, wf.edges, { name: 'saved story' })
  assert.ok(frozen)
  assert.equal(checkedStoryMediaRetakeWorkflow(frozen, runs), true)
  assert.equal(checkedStoryMediaRetakeWorkflow({ ...frozen, schemaVersion: 4 }, runs), false)
  assert.equal(checkedStoryMediaRetakeWorkflow({ ...frozen, nodes: frozen.nodes.slice(1) }, runs), false)
  assert.equal(checkedStoryMediaRetakeWorkflow({ ...frozen,
    nodes: frozen.nodes.map(item => item.id === 'node-video' ? { ...item, prompt: 'changed' } : item) }, runs), false)
  assert.equal(checkedStoryMediaRetakeWorkflow({ ...frozen,
    edges: frozen.edges.map(item => item.id === 'edge-video-concat'
      ? { ...item, to: 'node-video-concat' } : item) }, runs), false)
  assert.equal(checkedStoryMediaRetakeWorkflow({ ...frozen,
    edges: [...frozen.edges, { id: 'bypass', from: 'node-video', to: 'node-video-concat' }] }, runs), false)
  const repeated = [...runs, { ...runs[6], node: { ...runs[6].node, prompt: 'changed only in second loop' } }]
  assert.equal(checkedStoryMediaRetakeWorkflow(frozen, repeated), false)
  assert.equal(buildSourceStoryMediaRetakeWorkflow(repeated, wf.edges, { name: 'saved story' }), undefined)
})

test('fork preserves the complete successful prefix and begins at the video, not the failed review', () => {
  const { source, wf, sourceUrl, model } = fixture()
  const before = createJsonHasher()(source.result)
  const prepared = prepareStoryMediaRetakeFork(source, wf, 'record-new', undefined,
    '2026-09-30T00:00:00.000Z', { model })
  const state = prepared.state
  assert.equal(prepared.proof.firstPendingIndex, 6)
  assert.equal(state.nodeRuns[6].node.id, 'node-video')
  assert.equal(state.nodeRuns[6].status, 'idle')
  assert.match(String(state.nodeRuns[6].retryFeedback), /exchange/)
  assert.equal(state.nodeRuns[6].output, undefined)
  assert.equal(state.nodeRuns[7].output, undefined)
  assert.ok(state.nodeRuns.slice(6).every((run: { status: string }) => run.status === 'idle'))
  assert.deepEqual(state.nodeRuns.slice(0, 6), decodeExecutionState<{ nodeRuns: unknown[] }>(source.result).nodeRuns.slice(0, 6))
  assert.equal(state.context.first_frame.url, '/generated/opening.png')
  assert.equal(state.context.video_shot, undefined)
  assert.equal(state.parentExecutionId, source.id)
  assert.equal(state.generationScopeId, 'record-new')
  assert.equal(state.storyMediaRetake.sourceVideoSha256, prepared.evidence.sha256)
  assert.equal(state.storyMediaRetake.targetVideoRunId, state.nodeRuns[6].id)
  assert.deepEqual(state.storyMediaRetake.targetVideoModel, storyVideoModelContract(model))
  assert.doesNotMatch(JSON.stringify(state.storyMediaRetake.targetVideoModel), /signed-secret|apiKey/)
  assert.equal(prepared.proof.modelCalls, 0)
  assert.doesNotMatch(JSON.stringify(prepared.proof), /signed-secret|https?:\/\//)
  assert.equal(createJsonHasher()(source.result), before)
  assert.equal(createJsonHasher()(decodeExecutionState(prepared.encoded)), createJsonHasher()(state))
  assert.equal(state.nodeRuns[5].context.first_frame.url, '/generated/opening.png')
  assert.equal(sourceUrl, decodeExecutionState<{ nodeRuns: Array<{ output?: { url?: string } }> }>(source.result).nodeRuns[6].output?.url)
})

test('uncertain review, missing completion proof, stale prefix, and old workflow fail closed', () => {
  const base = fixture()
  type EditableState = { nodeRuns: Array<{ status: string; output: { storyMediaReview: {
    reviewStatus: string; assessment: { beatChecks: Array<{ evidenceObservations: string[] }> } } } }> }
  const changed = (edit: (state: EditableState) => void) => {
    const state = decodeExecutionState<EditableState>(base.source.result)
    edit(state)
    return { ...base.source, result: encodeExecutionState(state) }
  }
  assert.throws(() => prepareStoryMediaRetakeFork(changed(state => {
    state.nodeRuns[7].output.storyMediaReview.reviewStatus = 'uncertain'
  }), base.wf, 'record-new', undefined, undefined, { model: base.model }), /confirmed incomplete/)
  assert.throws(() => prepareStoryMediaRetakeFork(changed(state => {
    state.nodeRuns[7].output.storyMediaReview.assessment.beatChecks[0].evidenceObservations[1] = 'different'
  }), base.wf, 'record-new', undefined, undefined, { model: base.model }), /confirmed incomplete/)
  assert.throws(() => prepareStoryMediaRetakeFork(changed(state => {
    state.nodeRuns[5].status = 'failed'
  }), base.wf, 'record-new', undefined, undefined, { model: base.model }), /first blocked step/)
  const fresh = fixture()
  assert.throws(() => prepareStoryMediaRetakeFork(fresh.source, { ...fresh.wf, schema_version: 4 },
    'record-new', undefined, undefined, { model: fresh.model }), /schema 5/)
  assert.throws(() => prepareStoryMediaRetakeFork(fresh.source, { ...fresh.wf,
    nodes: fresh.wf.nodes.map(item => item.id === 'node-video' ? { ...item, prompt: 'changed ${shot.timedActions}' } : item) },
  'record-new', undefined, undefined, { model: fresh.model }), /node contracts differ/)
})

test('archived video must exist under generated and match the saved review SHA', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'story-retake-'))
  const outside = path.join(os.tmpdir(), `story-retake-outside-${process.pid}.mp4`)
  try {
    const bytes = Buffer.alloc(2048, 17)
    await writeFile(path.join(root, 'archive.mp4'), bytes)
    const evidence = { url: '/generated/archive.mp4', sha256: sha256(bytes) }
    assert.deepEqual(await verifyArchivedVideo(evidence, root), { ...evidence, bytes: 2048 })
    await writeFile(path.join(root, 'archive.mp4'), Buffer.alloc(2048, 18))
    await assert.rejects(verifyArchivedVideo(evidence, root), /bytes differ/)
    await writeFile(outside, bytes)
    await symlink(outside, path.join(root, 'escape.mp4'))
    await assert.rejects(verifyArchivedVideo({ url: '/generated/escape.mp4', sha256: sha256(bytes) }, root),
      /escapes the generated directory/)
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { force: true }) }
})

test('preserved opening image is a decodable local asset with matching saved SHA', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'story-retake-image-'))
  try {
    const bytes = await sharp({ create: { width: 64, height: 64, channels: 3,
      background: { r: 90, g: 120, b: 160 } } }).png({ compressionLevel: 0 }).toBuffer()
    assert.ok(bytes.length >= 1024)
    await writeFile(path.join(root, 'opening.png'), bytes)
    const output = { url: '/generated/opening.png', raw: { raw: { image: { sha256: sha256(bytes) } } } }
    assert.deepEqual(await verifyOpeningImage(output, root), { url: output.url, sha256: sha256(bytes), bytes: bytes.length })
    await assert.rejects(verifyOpeningImage({ ...output, raw: { raw: { image: { sha256: '0'.repeat(64) } } } }, root),
      /bytes differ/)
    await writeFile(path.join(root, 'opening.png'), Buffer.alloc(2048, 0))
    await assert.rejects(verifyOpeningImage({ url: output.url }, root), /cannot be decoded/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('read-only transaction issues no INSERT; explicit apply inserts one new record and leaves source intact', async () => {
  const { source, wf, bytes, model } = fixture()
  const root = await mkdtemp(path.join(os.tmpdir(), 'story-retake-db-'))
  await writeFile(path.join(root, 'archive.mp4'), bytes)
  await writeFile(path.join(root, 'opening.png'), await sharp({ create: { width: 64, height: 64,
    channels: 3, background: { r: 90, g: 120, b: 160 } } }).png({ compressionLevel: 0 }).toBuffer())
  const calls: string[] = []
  let stored: unknown
  const db = { query: async (sql: string, params: unknown[] = []) => {
    calls.push(sql)
    if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
    if (sql.includes('INSERT INTO execution_records')) {
      stored = JSON.parse(String(params[5])); return { rows: [{ id: params[0] }], rowCount: 1 }
    }
    if (sql.includes('SELECT result FROM execution_records')) return { rows: [{ result: stored }], rowCount: 1 }
    if (sql.includes('SELECT md5(result::text)')) return { rows: [{ result_md5: source.result_md5 }], rowCount: 1 }
    if (sql.includes('SELECT md5(nodes::text)')) return { rows: [{ nodes_md5: wf.nodes_md5,
      edges_md5: wf.edges_md5 }], rowCount: 1 }
    if (sql.includes('FROM model_configs')) return { rows: [model], rowCount: 1 }
    if (sql.includes('FROM execution_records')) return { rows: [source], rowCount: 1 }
    if (sql.includes('FROM workflow_configs')) return { rows: [wf], rowCount: 1 }
    throw Error(`unexpected query: ${sql}`)
  } }
  try {
    const before = await readFile(path.join(root, 'archive.mp4'))
    const preview = await forkStoryMediaRetake(db, { sourceId: source.id, id: 'record-new', apply: false }, root)
    assert.equal(preview.applied, false)
    assert.equal(calls[0], 'BEGIN READ ONLY')
    assert.ok(!calls.some(sql => sql.includes('INSERT') || sql.includes('UPDATE') || sql.includes('DELETE')))
    calls.length = 0
    await assert.rejects(forkStoryMediaRetake(db, { sourceId: source.id, id: 'record-new', apply: true,
      expectedSourceMd5: source.result_md5, expectedWorkflowMd5: '0'.repeat(32) }, root), /workflow MD5 differs/)
    assert.ok(!calls.some(sql => sql.includes('INSERT')))
    calls.length = 0
    const applied = await forkStoryMediaRetake(db, { sourceId: source.id, id: 'record-new', apply: true,
      expectedSourceMd5: source.result_md5, expectedWorkflowMd5: wf.nodes_md5 }, root)
    assert.equal(applied.applied, true)
    assert.equal(calls.filter(sql => sql.includes('INSERT INTO execution_records')).length, 1)
    assert.ok(!calls.some(sql => sql.includes('UPDATE') || sql.includes('DELETE')))
    assert.equal(createJsonHasher()(source.result), createJsonHasher()(fixture().source.result))
    assert.deepEqual(await readFile(path.join(root, 'archive.mp4')), before)
  } finally { await rm(root, { recursive: true, force: true }) }
})
