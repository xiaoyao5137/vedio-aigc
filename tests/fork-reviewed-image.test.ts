import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { createJsonHasher } from '../scripts/restore-branch-checkpoint.mjs'
import { forkReviewedImage, inspectReplacementImage, parseArguments, prepareReviewedImageFork } from '../scripts/fork-reviewed-image.mjs'

const md5 = '0123456789abcdef0123456789abcdef'
const sha = 'a'.repeat(64)
const replacement = { url: '/generated/reviewed.png', sha256: sha, bytes: 200, width: 1600, height: 900, format: 'png' }
const options = { sourceId: 'record-source', nodeId: 'end-frame', loop: 2, id: 'record-fork',
  createdAt: '2026-09-28T10:00:00.000Z', reason: '已复核并手工修正尾帧实体位置', reviewReference: 'review/scene-2' }

function fixture() {
  const paidOutput = { url: '/generated/paid-first.png', urls: ['/generated/paid-first.png'], items: [{ url: '/generated/paid-first.png' }] }
  const imageInputContext = { input: { topic: 'approved' }, first_frame: paidOutput, shot_script: { id: 'shot-2' } }
  const oldOutput = { url: 'https://provider.example/old-end.png', urls: ['https://provider.example/old-end.png'],
    items: [{ url: 'https://provider.example/old-end.png' }], raw: { taskId: 'old-paid-task', imageUrl: 'https://provider.example/old-end.png' },
    prompt: 'original prompt', params: { referenceImage: paidOutput.url }, model: 'image-model' }
  const targetContext = { ...imageInputContext, end_frame: oldOutput }
  const runs = [
    { id: 'input', node: { id: 'input', kind: 'input', resultVar: 'input' }, status: 'success', output: imageInputContext.input,
      context: { input: imageInputContext.input }, inputContext: {}, attempts: [], revision: 0 },
    { id: 'paid-first', node: { id: 'first-frame', kind: 'image', resultVar: 'first_frame' }, status: 'success', output: paidOutput,
      context: imageInputContext, inputContext: { input: imageInputContext.input }, attempts: [{ status: 'failed', error: 'old' }], revision: 1 },
    { id: 'shot', node: { id: 'shot', kind: 'code', resultVar: 'shot_script' }, status: 'success', output: imageInputContext.shot_script,
      context: imageInputContext, inputContext: imageInputContext, revision: 0 },
    { id: 'end-frame-scene-2', node: { id: 'end-frame', kind: 'image', resultVar: 'end_frame' }, status: 'success', output: oldOutput,
      context: targetContext, inputContext: imageInputContext, inputs: { referenceImage: paidOutput.url },
      attempts: [{ status: 'failed', error: 'old-attempt' }], attempt: 2, revision: 1, loopGroupId: 'scene-loop', loopIndex: 1 },
    { id: 'video-scene-2', node: { id: 'video', kind: 'video', resultVar: 'video_take' }, status: 'idle', output: undefined,
      context: { stale: true }, inputs: { endImage: oldOutput.url }, inputContext: targetContext,
      routeInputContext: targetContext, loopPrevious: { stale: 'old-tail' }, paramOverrides: { prompt: 'user edit' },
      attempts: [{ status: 'failed', output: { paidReceipt: 'past-failure' } }], revision: 3,
      loopGroupId: 'scene-loop', loopIndex: 1, loopNode: { id: 'scene-loop', loop: { itemVar: 'scene' } }, loopItem: { id: 'scene-2' } },
    { id: 'review-scene-2', node: { id: 'review', kind: 'code', resultVar: 'media_review' }, status: 'idle', output: undefined,
      context: {}, inputs: {}, inputContext: {}, loopGroupId: 'scene-loop', loopIndex: 1,
      loopNode: { id: 'scene-loop', loop: { itemVar: 'scene' } }, loopItem: { id: 'scene-2' }, revision: 0 },
  ]
  const state = { id: 'record-source', workflowId: 'workflow', mode: 'run', historical: true,
    requestScopeId: 'original-paid-scope', generationScopeId: 'original-generation', nodeRuns: runs,
    context: targetContext, logs: ['old logs'], branchHistory: [{ from: 'branch', to: 'end-frame' }], runtimeInputs: { topic: 'approved' } }
  return { state, source: { id: state.id, workflow_id: state.workflowId, workflow_name: 'Workflow',
    runtime_inputs: state.runtimeInputs, result_md5: md5, result: encodeExecutionState(state) } }
}

test('fork adopts one reviewed image, preserves paid prefix and original evidence, then rebuilds the pending video context', () => {
  const { state, source } = fixture(), before = structuredClone(source), hash = createJsonHasher()
  const prepared = prepareReviewedImageFork(source, replacement, options), fork = prepared.state
  assert.deepEqual(source, before)
  assert.equal(fork.id, options.id)
  assert.equal(fork.parentExecutionId, source.id)
  assert.equal(fork.requestScopeId, state.requestScopeId)
  assert.equal(fork.generationScopeId, options.id)
  assert.equal(fork.mode, 'step')
  assert.equal(hash(fork.nodeRuns.slice(0, 3)), hash(state.nodeRuns.slice(0, 3)))
  assert.equal(hash(fork.branchHistory), hash(state.branchHistory))
  assert.equal(fork.nodeRuns[3].status, 'success')
  assert.equal(fork.nodeRuns[3].output.url, replacement.url)
  assert.deepEqual(fork.nodeRuns[3].output.urls, [replacement.url])
  assert.deepEqual(fork.nodeRuns[3].output.items, [{ url: replacement.url }])
  assert.equal(fork.nodeRuns[3].output.raw, undefined)
  assert.equal(fork.nodeRuns[3].attempts[1].output.raw.taskId, 'old-paid-task')
  assert.equal(fork.nodeRuns[3].manualImageAdoption.sourceImageUrl, state.nodeRuns[3].output.url)
  assert.equal(fork.nodeRuns[3].manualImageAdoption.replacementSha256, sha)
  assert.equal(fork.context.end_frame.url, replacement.url)
  assert.equal(fork.nodeRuns[4].status, 'idle')
  assert.equal(fork.nodeRuns[4].routeInputContext, undefined)
  assert.deepEqual(fork.nodeRuns[4].paramOverrides, { prompt: 'user edit' })
  assert.deepEqual(fork.nodeRuns[4].attempts, state.nodeRuns[4].attempts)
  const preparedVideo = prepareWorkflowRunContext(fork.nodeRuns, 4)
  assert.equal(preparedVideo?.inputContext.end_frame.url, replacement.url)
  assert.equal(preparedVideo?.inputContext.first_frame.url, state.nodeRuns[1].output.url)
  assert.equal(prepared.proof.preservedPrefixCount, 3)
  assert.equal(prepared.proof.idleSuffixCount, 2)
  assert.equal(prepared.proof.providerRequests, 0)
  assert.equal(hash(decodeExecutionState(JSON.parse(JSON.stringify(prepared.encoded)))), hash(fork))
})

test('ambiguous, active or completed downstream work and malformed image contracts fail closed', () => {
  const mutations = [
    (s: ReturnType<typeof fixture>['state']) => { s.nodeRuns[4].status = 'success' },
    (s: ReturnType<typeof fixture>['state']) => { s.nodeRuns[4].status = 'failed' },
    (s: ReturnType<typeof fixture>['state']) => { s.nodeRuns[4].status = 'running' },
    (s: ReturnType<typeof fixture>['state']) => { s.nodeRuns[3].node.kind = 'code' },
    (s: ReturnType<typeof fixture>['state']) => { s.nodeRuns[1].node.id = 'end-frame' },
    (s: ReturnType<typeof fixture>['state']) => { s.nodeRuns[3].output.urls.push('/other.png') },
    (s: ReturnType<typeof fixture>['state']) => { s.nodeRuns[3].output.extraReview = { passed: true } },
    (s: ReturnType<typeof fixture>['state']) => { s.nodeRuns[3].context.end_frame = { url: '/different.png' } },
    (s: ReturnType<typeof fixture>['state']) => { s.context = { ...s.context, after: true } },
  ]
  for (const mutate of mutations) {
    const { state, source } = fixture(); mutate(state)
    source.result = encodeExecutionState(state)
    const before = structuredClone(source)
    assert.throws(() => prepareReviewedImageFork(source, replacement, { ...options, loop: undefined }), /REVIEWED_IMAGE_FORK_INVALID/)
    assert.deepEqual(source, before)
  }
  assert.throws(() => prepareReviewedImageFork(fixture().source, replacement, { ...options, id: 'record-source' }), /NEW record/)
  assert.throws(() => prepareReviewedImageFork(fixture().source, { ...replacement, url: 'https://external/image.png' }, options), /descriptor/)
})

test('CLI requires review details and both immutable guards for apply', () => {
  const args = ['--source', 'record-source', '--node', 'end-frame', '--loop', '2', '--image', '/tmp/reviewed.png',
    '--reason', 'reviewed corrected entities', '--review-reference', 'review/scene-2']
  assert.equal(parseArguments(args).apply, false)
  assert.equal(parseArguments(args).loop, 2)
  assert.equal(parseArguments([...args, '--expected-source-md5', md5, '--expected-image-sha256', sha, '--apply']).apply, true)
  for (const invalid of [[], [...args, '--apply'], [...args, '--loop', '3'], [...args, '--expected-image-sha256', 'bad'],
    [...args, '--source', 'again'], [...args, '--review-reference'], [...args, '--apply=true']]) {
    assert.throws(() => parseArguments(invalid), /REVIEWED_IMAGE_FORK_INVALID/)
  }
})

async function withImage(run: (root: string, imagePath: string, digest: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reviewed-image-fork-'))
  try {
    const generated = path.join(root, 'public/generated')
    await mkdir(generated, { recursive: true })
    const imagePath = path.join(generated, 'reviewed.png')
    await sharp({ create: { width: 16, height: 9, channels: 3, background: '#aabbcc' } }).png().toFile(imagePath)
    const digest = (await inspectReplacementImage(imagePath, root)).sha256
    await run(root, imagePath, digest)
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('local image is fully decoded, hashed and restricted to server-visible public/generated', async () => {
  await withImage(async (root, imagePath, digest) => {
    const asset = await inspectReplacementImage(imagePath, root)
    assert.equal(asset.url, '/generated/reviewed.png')
    assert.equal(asset.sha256, digest)
    assert.deepEqual([asset.width, asset.height, asset.format], [16, 9, 'png'])
    const outsider = path.join(root, 'outsider.png')
    await writeFile(outsider, await readFile(imagePath))
    await assert.rejects(inspectReplacementImage(outsider, root), /directly under public\/generated/)
    await writeFile(path.join(root, 'public/generated/bad.png'), 'not an image')
    await assert.rejects(inspectReplacementImage(path.join(root, 'public/generated/bad.png'), root), /does not fully decode/)
  })
})

function fakeDatabase({ corruptInsert = false, changed = false, occupied = false } = {}) {
  const { source } = fixture(), statements: string[] = []
  let inserted: Record<string, unknown> | undefined
  return { statements, async query(sql: string, params: unknown[] = []) {
    statements.push(sql)
    if (sql.startsWith('SELECT *')) return { rows: [source] }
    if (sql.startsWith('SELECT id FROM')) return { rows: occupied ? [{ id: options.id }] : [] }
    if (sql.startsWith('INSERT INTO')) {
      assert.notEqual(params[0], source.id)
      assert.deepEqual(JSON.parse(String(params[5])), source.runtime_inputs)
      inserted = JSON.parse(String(params[6]))
      if (corruptInsert) inserted!.id = 'bad-readback'
      return { rows: [] }
    }
    if (sql.startsWith('SELECT result FROM')) return { rows: [{ result: inserted }] }
    if (sql.startsWith('SELECT md5')) return { rows: [{ result_md5: changed ? 'changed' : md5 }] }
    return { rows: [] }
  } }
}

test('preview reads only; apply inserts exactly one guarded fork and rolls back stale or corrupt writes', async () => {
  await withImage(async (root, imagePath, digest) => {
    const base = { ...options, imagePath, expectedSha256: digest }
    const preview = fakeDatabase(), dry = await forkReviewedImage(preview, base, root)
    assert.equal(preview.statements[0], 'BEGIN READ ONLY')
    assert.equal(dry.applied, false)
    assert.ok(preview.statements.every(sql => !/INSERT|UPDATE|DELETE/.test(sql)))
    const applied = fakeDatabase(), proof = await forkReviewedImage(applied, { ...base, expectedMd5: md5, apply: true }, root)
    assert.equal(proof.applied, true)
    assert.equal(applied.statements.filter(sql => sql.startsWith('INSERT INTO')).length, 1)
    assert.ok(applied.statements.every(sql => !/UPDATE|DELETE/.test(sql)))
    assert.ok(applied.statements[1].endsWith('FOR SHARE'))
    for (const [db, changedOptions, expected] of [
      [fakeDatabase(), { expectedSha256: 'f'.repeat(64) }, /replacement SHA256 differs/],
      [fakeDatabase(), { expectedMd5: 'f'.repeat(32) }, /source MD5 differs/],
      [fakeDatabase({ changed: true }), {}, /source changed/],
      [fakeDatabase({ corruptInsert: true }), {}, /inserted fork/],
      [fakeDatabase({ occupied: true }), {}, /already exists/],
    ] as const) {
      await assert.rejects(forkReviewedImage(db, { ...base, expectedMd5: md5, apply: true, ...changedOptions }, root), expected)
      assert.ok(db.statements.every(sql => !/UPDATE|DELETE/.test(sql)))
      if (db.statements.length) assert.equal(db.statements.at(-1), 'ROLLBACK')
    }
  })
})
