import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { addPendingStoryResultBranchRuns, inspectSupersededPaidImage,
  parseArguments } from '../scripts/fork-story-editorial-script.mjs'

const base = [
  '--source', 'record-original', '--id', 'record-editorial-child',
  '--shots', 'edited-shots.json', '--out', 'reviewed-receipt.json',
]

test('editorial fork defaults to read-only preparation', () => {
  const options = parseArguments(base)
  assert.equal(options.apply, false)
  assert.equal(options.expect, undefined)
  assert.equal(parseArguments([...base, '--dry-run']).apply, false)
})

test('editorial fork requires a reviewed receipt before an insert', () => {
  assert.throws(() => parseArguments([...base, '--apply']), /--apply requires a reviewed dry-run receipt/)
  assert.throws(() => parseArguments([...base, '--expect', 'old-receipt.json']), /only used with --apply/)
  assert.equal(parseArguments([...base, '--apply', '--expect', 'old-receipt.json']).apply, true)
})

test('editorial fork rejects ambiguous or duplicate record targets', () => {
  assert.throws(() => parseArguments([...base, '--id', 'record-other']), /duplicate/)
  assert.throws(() => parseArguments([
    '--source', 'record-same', '--id', 'record-same', '--shots', 'edited-shots.json', '--out', 'receipt.json',
  ]), /distinct/)
  assert.throws(() => parseArguments([...base, '--unexpected']), /unknown/)
  assert.throws(() => parseArguments([...base, '--shots']), /incomplete/)
})

test('schema-6 editorial fork inserts only idle result branches around old loop shells', () => {
  const sourceIds = ['node-input', 'node-model-images', 'node-script', 'node-script-review', 'node-loop',
    ...Array.from({ length: 2 }, () => ['node-image', 'node-video', 'node-video-review', 'node-video-concat']).flat()]
  const runs = sourceIds.map((id, index) => ({ id: `${id}-${index}`, node: { id },
    status: index < 3 ? 'success' : 'idle', output: index < 3 ? { original: index } : undefined,
    context: index < 3 ? { original: index } : {}, inputs: {}, inputContext: {},
    loopItem: undefined }))
  const branch = { id: 'node-video-review-result-branch', title: '质检路由', kind: 'branch', resultVar: 'video_review_decision' }
  const workflow = { schemaVersion: 6, nodes: [
    { id: 'node-loop', childIds: ['node-image', 'node-video', 'node-video-review', branch.id, 'node-video-concat'] },
    branch,
  ] }
  const expanded = addPendingStoryResultBranchRuns(runs, workflow, 2)
  assert.equal(expanded.length, 15)
  assert.deepEqual(expanded.map(run => run.node.id).slice(5), Array.from({ length: 2 }, () => [
    'node-image', 'node-video', 'node-video-review', branch.id, 'node-video-concat',
  ]).flat())
  assert.deepEqual(expanded.slice(0, 3), runs.slice(0, 3))
  assert.equal(expanded[8].status, 'idle')
  assert.equal(expanded[8].output, undefined)
  assert.equal(expanded[13].status, 'idle')
  assert.equal(new Set(expanded.map(run => run.id)).size, expanded.length)
  assert.deepEqual(runs.map(run => run.node.id), sourceIds, 'the saved source remains untouched')
  assert.throws(() => addPendingStoryResultBranchRuns(runs, { ...workflow, schemaVersion: 5 }, 2), /schema-6/)
  assert.throws(() => addPendingStoryResultBranchRuns(runs, { ...workflow,
    nodes: [{ ...workflow.nodes[0], childIds: ['node-image', 'node-video', 'node-video-concat'] }, branch] }, 2), /schema-6/)
  const paid = runs.map((run, index) => index === 6 ? { ...run, status: 'success' } : run)
  assert.throws(() => addPendingStoryResultBranchRuns(paid, workflow, 2), /non-idle/)
})

test('superseded paid image proof verifies archived bytes without exposing its URL', async () => {
  const mediaRoot = await mkdtemp(path.join(tmpdir(), 'story-editorial-image-'))
  try {
    const bytes = Buffer.from('immutable paid first-frame evidence')
    const url = '/generated/frame.png'
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    await writeFile(path.join(mediaRoot, 'frame.png'), bytes)
    const reviewedShot = { title: '现行分镜', firstFramePrompt: '镜头中看见猫狗' }
    const run = {
      id: 'source-paid-image-0', node: { id: 'node-image' }, status: 'success', loopIndex: 0,
      loopItem: reviewedShot, inputContext: { shot: reviewedShot },
      output: { url, urls: [url], items: [{ url }], params: { storyShot: reviewedShot },
        raw: { raw: { image: { url, bytes: bytes.length, sha256 } } } },
    }
    const proof = await inspectSupersededPaidImage(run, reviewedShot, mediaRoot)
    assert.equal(proof.archivedAssetSha256, sha256)
    assert.equal(proof.archivedAssetBytes, bytes.length)
    assert.equal(proof.sourceRunId, run.id)
    assert.doesNotMatch(JSON.stringify(proof), /\/generated\/|frame\.png/)
    await writeFile(path.join(mediaRoot, 'frame.png'), Buffer.from('changed media bytes'))
    await assert.rejects(inspectSupersededPaidImage(run, reviewedShot, mediaRoot), /archive differs/)
    await assert.rejects(inspectSupersededPaidImage({ ...run, loopItem: { title: 'other' } }, reviewedShot, mediaRoot),
      /not bound to the reviewed first shot/)
  } finally {
    await rm(mediaRoot, { recursive: true, force: true })
  }
})
