import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMigrationArgs, prepareStoryReviewBranchMigration,
  assertMigrationScope, migrateStoryReviewBranch } from '../scripts/migrate-story-review-branch.mjs'
import { STORY_MEDIA_RETAKE_CANONICAL_EDGES } from '../src/story-media-retake-workflow.ts'

const param = (name, value, required = true) => ({ id: name, name, englishName: name,
  type: 'text', required, value })
const node = (id, kind, resultVar = id, x = 0) => ({ id, title: id, kind, resultVar,
  prompt: '', params: [], uploads: [], loop: { enabled: kind === 'loop', sourcePath: '',
    fallbackCount: 0, itemVar: 'shot' }, position: { x, y: 90 } })

function schema5Row() {
  const input = node('node-input', 'input', 'input', 50)
  const modelImages = node('node-model-images', 'image', 'model_images', 350)
  const script = node('node-script', 'text', 'script_generation', 650)
  const scriptReview = { ...node('node-script-review', 'validation', 'script_review', 950),
    operation: 'story.script-review', params: [param('script', '${script_generation}'),
      param('expectedCount', '${input.vedio_count}'), param('source', '${storyScriptSource}', false)] }
  const loop = { ...node('node-loop', 'loop', 'shot_loop', 1250),
    childIds: ['node-image', 'node-video', 'node-video-review', 'node-video-concat'],
    loop: { enabled: true, sourcePath: 'script_review.shots', fallbackCount: 0, itemVar: 'shot' } }
  const image = { ...node('node-image', 'image', 'first_frame', 1550), parentId: loop.id,
    params: [param('storyShot', '${shot}')] }
  const video = { ...node('node-video', 'video', 'video_shot', 1850), parentId: loop.id,
    prompt: '逐项完成 ${shot.timedActions}',
    params: [param('storyShot', '${shot}'), param('requiredPromptText', '${shot.timedActions}'),
      param('promptOverflowPolicy', 'reject'), param('expectedDuration', '${shot.duration}'),
      param('requiredSound', 'on')] }
  const review = { ...node('node-video-review', 'validation', 'video_review', 2150),
    parentId: loop.id, operation: 'story.media-review',
    params: [param('shot', '${shot}'), param('video', '${video_shot}')] }
  const concat = { ...node('node-video-concat', 'videoConcat', 'stage_video', 2450),
    parentId: loop.id, operation: 'video.concat', params: [param('currentVideo', '${video_review}')] }
  return { id: 'wf-story', schema_version: 5, nodes: [input, modelImages, script, scriptReview,
    loop, image, video, review, concat],
  edges: STORY_MEDIA_RETAKE_CANONICAL_EDGES.map(edge => ({ ...edge })) }
}

test('apply requires explicit reviewed nodes and edges MD5 values', async () => {
  assert.equal(parseMigrationArgs([]).apply, false)
  assert.throws(() => parseMigrationArgs(['--apply']), /requires fresh/)
  assert.throws(() => parseMigrationArgs(['--apply', '--expected-nodes-md5', 'a'.repeat(32)]), /requires fresh/)
  assert.throws(() => parseMigrationArgs(['--expected-edges-md5', 'bad']), /32-character MD5/)
  assert.throws(() => parseMigrationArgs(['--apply', '--apply']), /Duplicate/)
  assert.deepEqual(parseMigrationArgs(['--apply', '--expected-nodes-md5', 'A'.repeat(32),
    '--expected-edges-md5', 'B'.repeat(32)]), {
    apply: true, expectedNodesMd5: 'a'.repeat(32), expectedEdgesMd5: 'b'.repeat(32),
  })
  await assert.rejects(migrateStoryReviewBranch({ query: () => { throw Error('DB queried') } },
    { apply: true, expectedNodesMd5: '', expectedEdgesMd5: '' }), /requires reviewed/)
})

test('schema 5 migration adds only the visible result branch and its two routed edges', () => {
  const before = schema5Row()
  const source = structuredClone(before)
  const { current, next, diff } = prepareStoryReviewBranchMigration(before)
  assert.deepEqual(before, source, 'preview mutated the saved source')
  assert.equal(current.schemaVersion, 5)
  assert.equal(next.schemaVersion, 6)
  assert.deepEqual(diff.addedNodeIds, ['node-video-review-result-branch'])
  assert.deepEqual(diff.changedEdgeIds, ['edge-video-review-concat'])
  assert.deepEqual(diff.addedEdgeIds.sort(), ['edge-video-review-pass', 'edge-video-review-retake'].sort())
  assert.deepEqual(diff.removedNodeIds, [])
  assert.deepEqual(diff.removedEdgeIds, [])
  const oldById = new Map(current.nodes.map(item => [item.id, item]))
  const nextById = new Map(next.nodes.map(item => [item.id, item]))
  assert.deepEqual(nextById.get('node-video')?.params, oldById.get('node-video')?.params)
  assert.equal(nextById.get('node-video')?.prompt, oldById.get('node-video')?.prompt)
  assert.deepEqual(nextById.get('node-loop')?.childIds,
    ['node-image', 'node-video', 'node-video-review', 'node-video-review-result-branch', 'node-video-concat'])
  assert.deepEqual(next.edges.filter(edge => edge.from === 'node-video-review-result-branch')
    .map(edge => [edge.branch, edge.to]).sort(), [['false', 'node-video'], ['true', 'node-video-concat']])
})

test('schema 6 rerun is a no-op and a changed generator contract fails the migration scope', () => {
  const before = schema5Row()
  const first = prepareStoryReviewBranchMigration(before)
  const repeated = prepareStoryReviewBranchMigration({ id: 'wf-story', schema_version: 6,
    nodes: first.next.nodes, edges: first.next.edges })
  assert.deepEqual(repeated.diff, { addedNodeIds: [], removedNodeIds: [], changedNodeIds: [],
    addedEdgeIds: [], removedEdgeIds: [], changedEdgeIds: [] })
  const changed = structuredClone(first.next)
  changed.nodes.find(item => item.id === 'node-video').prompt = 'changed paid prompt'
  assert.throws(() => assertMigrationScope(first.current, changed), /execution contract changed/)
  const bypass = structuredClone(first.next)
  bypass.edges.push({ id: 'review-bypass', from: 'node-video-review', to: 'node-video-concat' })
  assert.throws(() => assertMigrationScope(first.current, bypass))
})
