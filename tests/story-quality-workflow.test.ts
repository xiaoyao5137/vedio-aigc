import test from 'node:test'
import assert from 'node:assert/strict'
import { STORY_SCRIPT_REVIEW_NODE_ID, STORY_SCRIPT_REVIEW_RESULT_BRANCH_NODE_ID,
  STORY_SCRIPT_REVIEW_RESULT_BRANCH_CODE, STORY_VIDEO_REVIEW_NODE_ID,
  STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE, STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID,
  STORY_VISUAL_ONLY_VIDEO_REVIEW_RESULT_BRANCH_CODE,
  storyQualityBranchCodeContext, storyVideoReviewBranchCodeContext, upgradeStoryQualityWorkflow } from '../src/story-quality-workflow.ts'
import { scopedLoopNodes } from '../src/workflow-core.ts'
import { branchConfigurationErrors, orderRouteNodes, routeBranch, validationResultBranch } from '../src/workflow-branch.ts'
import { executeCodeNode } from '../server/code-node.ts'

type TestNode = { id: string; title: string; kind: string; resultVar: string; prompt: string; modelId?: string;
  params: Array<{ id: string; name: string; englishName?: string; type: string; required: boolean; value: string }>;
  uploads: unknown[]; loop: { enabled: boolean; sourcePath: string; fallbackCount: number; itemVar: string };
  position: { x: number; y: number }; parentId?: string; childIds?: string[]; operation?: string; code?: string }
type TestEdge = { id: string; from: string; to: string; branch?: string }
type TestWorkflow = { id: string; schemaVersion: number; nodes: TestNode[]; edges: TestEdge[] }

function node(id: string, kind: string, resultVar = id, x = 0): TestNode {
  return { id, title: id, kind, resultVar, prompt: '', params: [], uploads: [],
    loop: { enabled: kind === 'loop', sourcePath: '', fallbackCount: 0, itemVar: 'shot' },
    position: { x, y: 100 } }
}

function schema4(): TestWorkflow {
  const loop = node('node-loop', 'loop', 'shot_loop', 900)
  loop.childIds = ['node-image', 'node-video', 'node-video-concat']
  loop.loop = { enabled: true, sourcePath: 'script_generation.shots', fallbackCount: 8, itemVar: 'shot' }
  const script = node('node-script', 'text', 'script_generation', 600)
  script.modelId = 'reviewable-text-model'
  const video = node('node-video', 'video', 'video_shot', 1500)
  video.prompt = '按节拍 ${shotTimedActions} 生成 ${shot.duration} 秒视频。'
  video.params = [{ id: 'duration', name: '时长', englishName: 'duration', type: 'number', required: true, value: '${shot.duration}' }]
  const concat = node('node-video-concat', 'videoConcat', 'stage_video', 1800)
  concat.operation = 'video.concat'
  concat.parentId = loop.id
  concat.params = [
    { id: 'previous', name: '上一轮', englishName: 'previousVideo', type: 'json', required: false, value: '${loop.previous.stage_video}' },
    { id: 'current', name: '本轮', englishName: 'currentVideo', type: 'json', required: true, value: '${video_shot}' },
  ]
  return { id: 'wf-story', schemaVersion: 4,
    nodes: [node('node-input', 'input', 'input', 50), node('node-model-images', 'image', 'model_images', 300),
      script, loop, node('node-image', 'image', 'first_frame', 1200), video, concat],
    edges: [
      { id: 'input-model', from: 'node-input', to: 'node-model-images' },
      { id: 'model-script', from: 'node-model-images', to: script.id },
      { id: 'script-loop', from: script.id, to: loop.id },
      { id: 'loop-image', from: loop.id, to: 'node-image' },
      { id: 'image-video', from: 'node-image', to: video.id },
      { id: 'video-concat', from: video.id, to: concat.id },
    ] }
}

const storyLayoutOrder = [
  'node-input', 'node-model-images', 'node-script', STORY_SCRIPT_REVIEW_NODE_ID,
  'node-loop', 'node-image', 'node-video', STORY_VIDEO_REVIEW_NODE_ID,
  STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID, 'node-video-concat',
]

function assertStoryNodeSpacing(workflow: TestWorkflow) {
  const byId = new Map(workflow.nodes.map(item => [item.id, item]))
  const ordered = storyLayoutOrder.map(id => byId.get(id)!)
  for (let index = 1; index < ordered.length; index++) {
    assert.ok(ordered[index].position.x - ordered[index - 1].position.x >= 300,
      `${ordered[index - 1].id} overlaps ${ordered[index].id}`)
  }
}

function schema5(): TestWorkflow {
  return upgradeStoryQualityWorkflow(schema4())
}

function schema6(): TestWorkflow { return upgradeStoryQualityWorkflow(schema5()) }
function schema7(): TestWorkflow { return upgradeStoryQualityWorkflow(schema6()) }

test('schema 4 story inserts visible reviews and a bounded video result branch', () => {
  const before = schema4()
  const historical = upgradeStoryQualityWorkflow(before)
  assert.equal(historical.schemaVersion, 5)
  const after = upgradeStoryQualityWorkflow(historical)
  assert.equal(after.schemaVersion, 6)
  assert.deepEqual(after.nodes.map(item => item.id), [
    'node-input', 'node-model-images', 'node-script', STORY_SCRIPT_REVIEW_NODE_ID,
    'node-loop', 'node-image', 'node-video', STORY_VIDEO_REVIEW_NODE_ID,
    STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID, 'node-video-concat',
  ])
  assertStoryNodeSpacing(after)
  assert.deepEqual(after.nodes.map(item => item.position.x),
    [50, 350, 650, 950, 1250, 1550, 1850, 2150, 2450, 2750])
  assert.ok(after.nodes.every(item => item.position.y === 100))
  const scriptReview = after.nodes.find(item => item.id === STORY_SCRIPT_REVIEW_NODE_ID)!
  const image = after.nodes.find(item => item.id === 'node-image')!
  const mediaReview = after.nodes.find(item => item.id === STORY_VIDEO_REVIEW_NODE_ID)!
  const resultBranch = after.nodes.find(item => item.id === STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID)!
  const loop = after.nodes.find(item => item.id === 'node-loop')!
  const video = after.nodes.find(item => item.id === 'node-video')!
  const concat = after.nodes.find(item => item.id === 'node-video-concat')!
  assert.equal(scriptReview.kind, 'validation')
  assert.equal(scriptReview.operation, 'story.script-review')
  assert.equal(scriptReview.modelId, 'reviewable-text-model')
  for (const paidNode of [image, video]) {
    const binding = paidNode.params.find(item => item.englishName === 'storyShot')
    assert.equal(binding?.value, '${shot}')
    assert.equal(binding?.required, true)
    assert.equal(binding?.type, 'json')
  }
  assert.deepEqual(Object.fromEntries(scriptReview.params.map(item => [item.englishName, item.value])), {
    script: '${script_generation}', expectedCount: '${input.vedio_count}', source: '${storyScriptSource}',
  })
  assert.equal(mediaReview.kind, 'validation')
  assert.equal(mediaReview.operation, 'story.media-review')
  assert.equal(mediaReview.modelId, 'reviewable-text-model')
  assert.equal(mediaReview.parentId, loop.id)
  assert.equal(resultBranch.kind, 'branch')
  assert.equal(resultBranch.parentId, loop.id)
  assert.equal(resultBranch.code, STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE)
  assert.equal(resultBranch.params.find(item => item.englishName === 'maxAttempts')?.value, '2')
  assert.deepEqual(Object.fromEntries(mediaReview.params.map(item => [item.englishName, item.value])), {
    shot: '${shot}', video: '${video_shot}',
  })
  assert.equal(loop.loop.sourcePath, 'script_review.shots')
  assert.equal(loop.loop.fallbackCount, 0)
  assert.deepEqual(loop.childIds, ['node-image', 'node-video', STORY_VIDEO_REVIEW_NODE_ID,
    STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID, 'node-video-concat'])
  assert.deepEqual(scopedLoopNodes(after, loop.id, after.nodes).map(item => item.id), loop.childIds)
  assert.equal(video.prompt, '按节拍 ${shot.timedActions} 生成 ${shot.duration} 秒视频。')
  assert.equal(video.params.find(item => item.englishName === 'promptOverflowPolicy')?.value, 'reject')
  assert.equal(video.params.find(item => item.englishName === 'requiredPromptText')?.value, '${shot.timedActions}')
  assert.equal(video.params.find(item => item.englishName === 'requiredPromptText')?.required, true)
  assert.equal(video.params.find(item => item.englishName === 'expectedDuration')?.value, '${shot.duration}')
  assert.equal(video.params.find(item => item.englishName === 'requiredSound')?.value, 'on')
  assert.equal(concat.params.find(item => item.englishName === 'currentVideo')?.value, '${video_review}')
  assert.deepEqual(after.edges.filter(edge => ['node-script', STORY_SCRIPT_REVIEW_NODE_ID, 'node-video',
    STORY_VIDEO_REVIEW_NODE_ID, STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID].includes(edge.from))
    .map(edge => [edge.from, edge.to, edge.branch]).sort(), [
      ['node-script', STORY_SCRIPT_REVIEW_NODE_ID, undefined], [STORY_SCRIPT_REVIEW_NODE_ID, 'node-loop', undefined],
      ['node-video', STORY_VIDEO_REVIEW_NODE_ID, undefined],
      [STORY_VIDEO_REVIEW_NODE_ID, STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID, undefined],
      [STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID, 'node-video-concat', 'true'],
      [STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID, 'node-video', 'false'],
    ].sort())
  assert.equal(validationResultBranch(after, STORY_VIDEO_REVIEW_NODE_ID), true)
  assert.deepEqual(branchConfigurationErrors(after), [])
  const next = upgradeStoryQualityWorkflow(after)
  assert.equal(next.schemaVersion, 7)
  assert.equal(upgradeStoryQualityWorkflow(next), next)
  assert.equal(before.nodes.length, 7)
  assert.equal(before.edges.find(edge => edge.id === 'script-loop')?.to, 'node-loop')
  assert.equal(before.edges.find(edge => edge.id === 'video-concat')?.to, 'node-video-concat')
})

test('saved schema 5 graph validates before adding the result branch and paid shot bindings', () => {
  const current = schema5()
  const legacy = { ...current, nodes: current.nodes.map(node => ['node-image', 'node-video'].includes(node.id)
    ? { ...node, params: node.params.filter(param => param.englishName !== 'storyShot') } : node) }
  const restored = upgradeStoryQualityWorkflow(legacy)
  assert.equal(restored.schemaVersion, 6)
  assert.equal(restored.nodes.find(node => node.id === 'node-image')?.params.at(-1)?.value, '${shot}')
  assert.equal(restored.nodes.find(node => node.id === 'node-video')?.params.at(-1)?.value, '${shot}')
  assert.equal(upgradeStoryQualityWorkflow(upgradeStoryQualityWorkflow(restored)).schemaVersion, 7)
})

test('schema 7 layout only moves crowded successors and preserves custom gaps and vertical positions', () => {
  const spaced = schema7()
  const customX = new Map([
    [STORY_SCRIPT_REVIEW_NODE_ID, 1100], [STORY_SCRIPT_REVIEW_RESULT_BRANCH_NODE_ID, 1200],
    ['node-loop', 1300], ['node-image', 1750],
    ['node-video', 1950], [STORY_VIDEO_REVIEW_NODE_ID, 2400],
    [STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID, 2500], ['node-video-concat', 2550],
  ])
  const saved = { ...spaced, nodes: spaced.nodes.map((item, index) => ({ ...item,
    position: { x: customX.get(item.id) ?? item.position.x, y: 100 + index * 17 },
  })) }
  const laidOut = upgradeStoryQualityWorkflow(saved)
  assert.notEqual(laidOut, saved)
  assertStoryNodeSpacing(laidOut)
  assert.deepEqual(laidOut.nodes.map(item => item.position.x),
    [50, 350, 650, 1100, 1400, 1700, 2000, 2300, 2600, 2900, 3200])
  for (const [index, item] of laidOut.nodes.entries()) {
    assert.equal(item.position.y, saved.nodes[index].position.y)
    assert.deepEqual({ ...item, position: saved.nodes[index].position }, saved.nodes[index],
      `${item.id} changed outside its x coordinate`)
  }
  assert.equal(laidOut.edges, saved.edges)
  assert.equal(upgradeStoryQualityWorkflow(laidOut), laidOut)

  const wide = { ...spaced, nodes: spaced.nodes.map((item, index) => ({ ...item,
    position: { x: 70 + index * 390, y: item.position.y + index },
  })) }
  assert.equal(upgradeStoryQualityWorkflow(wide), wide)
})

test('migration retains custom edges, prompt content and existing overflow setting', () => {
  const before = schema4()
  const custom = { id: 'custom-video-audit', from: 'node-video', to: 'user-audit' }
  before.edges.push(custom)
  before.nodes.push(node('user-audit', 'code', 'user_audit', 1850))
  before.nodes.find(item => item.id === 'node-loop')!.childIds!.push('user-audit')
  const video = before.nodes.find(item => item.id === 'node-video')!
  video.prompt = '保留自定义摄影提示；${shot.content}。'
  video.params.push({ id: 'overflow', name: '超限', englishName: 'promptOverflowPolicy', type: 'text', required: true, value: 'reject' })
  const after = upgradeStoryQualityWorkflow(before)
  assert.deepEqual(after.edges.find(edge => edge.id === custom.id), custom)
  assert.ok(after.nodes.find(item => item.id === 'node-video')!.prompt.startsWith(video.prompt))
  assert.ok(after.nodes.find(item => item.id === 'node-video')!.prompt.includes('${shot.timedActions}'))
  assert.equal(after.nodes.find(item => item.id === 'node-video')!.params.filter(item => item.englishName === 'promptOverflowPolicy').length, 1)
  assert.equal(after.nodes.find(item => item.id === 'node-video')!.params.find(item => item.englishName === 'promptOverflowPolicy')?.id, 'overflow')
  assert.deepEqual(after.nodes.find(item => item.id === 'node-loop')!.childIds,
    ['node-image', 'node-video', STORY_VIDEO_REVIEW_NODE_ID, 'node-video-concat', 'user-audit'])
})

test('story video migration makes an existing truncation setting reject overflow before payment', () => {
  const before = schema4()
  const video = before.nodes.find(item => item.id === 'node-video')!
  video.params.push({ id: 'custom-overflow', name: '提示词策略', englishName: 'promptOverflowPolicy',
    type: 'text', required: false, value: 'truncate' })
  const after = upgradeStoryQualityWorkflow(before)
  assert.deepEqual(after.nodes.find(item => item.id === 'node-video')!.params.find(item => item.id === 'custom-overflow'),
    { id: 'custom-overflow', name: '提示词策略', englishName: 'promptOverflowPolicy',
      type: 'text', required: true, value: 'reject' })
})

test('other workflows stay unchanged; incomplete or bypassable story topology fails closed', () => {
  const before = schema4()
  const other = { ...before, id: 'another-workflow' }
  assert.equal(upgradeStoryQualityWorkflow(other), other)
  const prior = { ...before, schemaVersion: 3 }
  assert.throws(() => upgradeStoryQualityWorkflow(prior), /STORY_QUALITY_CONFLICT/)
  const disconnected = { ...before, edges: before.edges.filter(edge => edge.id !== 'video-concat') }
  assert.throws(() => upgradeStoryQualityWorkflow(disconnected), /STORY_QUALITY_CONFLICT/)
  const bypass = { ...before, edges: [...before.edges, { id: 'custom-bypass', from: 'node-script', to: 'node-loop', branch: 'yes' }] }
  assert.throws(() => upgradeStoryQualityWorkflow(bypass), /STORY_QUALITY_CONFLICT/)
  const collision = { ...before, nodes: [...before.nodes, node(STORY_VIDEO_REVIEW_NODE_ID, 'code')] }
  assert.throws(() => upgradeStoryQualityWorkflow(collision), /STORY_QUALITY_CONFLICT/)
  const customConcat = { ...before, nodes: before.nodes.map(item => item.id === 'node-video-concat'
    ? { ...item, params: item.params.map(param => param.englishName === 'currentVideo'
      ? { ...param, value: '${custom_approved_video}' } : param) } : item) }
  assert.throws(() => upgradeStoryQualityWorkflow(customConcat), /STORY_QUALITY_CONFLICT/)
  const alternate = { ...before, edges: [...before.edges, { id: 'script-image-bypass', from: 'node-script', to: 'node-image' }] }
  assert.throws(() => upgradeStoryQualityWorkflow(alternate), /STORY_QUALITY_CONFLICT/)
  const accepted = upgradeStoryQualityWorkflow(before)
  const tampered = { ...accepted, nodes: accepted.nodes.map(item => item.id === 'node-video'
    ? { ...item, params: item.params.filter(param => param.englishName !== 'requiredPromptText') } : item) }
  assert.throws(() => upgradeStoryQualityWorkflow(tampered), /STORY_QUALITY_CONFLICT/)
})

test('an extra paid video before the script review cannot bypass migration or schema 5 checks', () => {
  const legacy = schema4()
  const sideVideo = node('custom-video', 'video', 'custom_video', 450)
  legacy.nodes.splice(2, 0, sideVideo)
  legacy.edges = legacy.edges.filter(edge => edge.id !== 'model-script')
  legacy.edges.push({ id: 'model-custom-video', from: 'node-model-images', to: sideVideo.id })
  legacy.edges.push({ id: 'custom-video-script', from: sideVideo.id, to: 'node-script' })
  const beforeReview = orderRouteNodes(legacy).ordered.map(item => item.id)
  assert.ok(beforeReview.indexOf(sideVideo.id) < beforeReview.indexOf('node-script'))
  assert.throws(() => upgradeStoryQualityWorkflow(legacy), /STORY_QUALITY_CONFLICT/)

  const current = schema7()
  const modified = { ...current, nodes: [...current.nodes, sideVideo], edges: [
    ...current.edges.filter(edge => edge.id !== 'model-script'),
    { id: 'model-custom-video', from: 'node-model-images', to: sideVideo.id },
    { id: 'custom-video-script', from: sideVideo.id, to: 'node-script' },
  ] }
  assert.throws(() => upgradeStoryQualityWorkflow(modified), /STORY_QUALITY_CONFLICT/)
})

test('schema 5 review inputs stay bound to the generated script, source, shot and video', () => {
  const current = schema6()
  for (const [id, key, value] of [
    [STORY_SCRIPT_REVIEW_NODE_ID, 'script', '${other_script}'],
    [STORY_SCRIPT_REVIEW_NODE_ID, 'expectedCount', '1'],
    [STORY_SCRIPT_REVIEW_NODE_ID, 'source', ''],
    [STORY_VIDEO_REVIEW_NODE_ID, 'shot', '{}'],
    [STORY_VIDEO_REVIEW_NODE_ID, 'video', '${other_video}'],
  ]) {
    const modified = { ...current, nodes: current.nodes.map(item => item.id !== id ? item : {
      ...item, params: item.params.map(param => param.englishName === key ? { ...param, value } : param),
    }) }
    assert.throws(() => upgradeStoryQualityWorkflow(modified), /STORY_QUALITY_CONFLICT/, `${id}.${key}`)
  }
  const unrequired = { ...current, nodes: current.nodes.map(item => item.id !== STORY_VIDEO_REVIEW_NODE_ID ? item : {
    ...item, params: item.params.map(param => param.englishName === 'video' ? { ...param, required: false } : param),
  }) }
  assert.throws(() => upgradeStoryQualityWorkflow(unrequired), /STORY_QUALITY_CONFLICT/)
})

test('duplicate node IDs and review output names cannot overwrite saved quality evidence', () => {
  const legacy = schema4()
  legacy.nodes.push({ ...legacy.nodes.find(item => item.id === 'node-video')! })
  assert.throws(() => upgradeStoryQualityWorkflow(legacy), /STORY_QUALITY_CONFLICT/)

  const current = schema6()
  const duplicatedId = { ...current, nodes: [...current.nodes, { ...current.nodes.find(item => item.id === 'node-video')! }] }
  assert.throws(() => upgradeStoryQualityWorkflow(duplicatedId), /STORY_QUALITY_CONFLICT/)
  for (const resultVar of ['script_review', 'video_review']) {
    const overwritten = { ...current, nodes: [...current.nodes,
      { ...node(`custom-${resultVar}`, 'code', resultVar), position: { x: 1900, y: 100 } }] }
    assert.throws(() => upgradeStoryQualityWorkflow(overwritten), /STORY_QUALITY_CONFLICT/)
  }
})

test('schema 6 requires exactly one review decision route and an in-loop false return', () => {
  const current = schema7()
  const branch = STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID
  for (const edges of [
    current.edges.filter(edge => edge.id !== 'edge-video-review-retake'),
    current.edges.map(edge => edge.id === 'edge-video-review-retake' ? { ...edge, to: 'node-image' } : edge),
    current.edges.map(edge => edge.id === 'edge-video-review-pass' ? { ...edge, to: 'node-video' } : edge),
    [...current.edges, { id: 'review-bypass', from: STORY_VIDEO_REVIEW_NODE_ID, to: 'node-video-concat' }],
    [...current.edges, { id: 'loop-bypass', from: 'node-image', to: 'node-video-concat' }],
    [...current.edges, { id: 'input-video-review-bypass', from: 'node-input', to: 'node-video-concat' }],
    [...current.edges, { id: 'input-script-review-bypass', from: 'node-input', to: 'node-loop' }],
  ]) {
    assert.throws(() => upgradeStoryQualityWorkflow({ ...current, edges }), /STORY_QUALITY_CONFLICT/)
  }
  const noOwner = { ...current, nodes: current.nodes.map(item => item.id === 'node-loop'
    ? { ...item, childIds: item.childIds!.filter(id => id !== branch) } : item) }
  assert.throws(() => upgradeStoryQualityWorkflow(noOwner), /STORY_QUALITY_CONFLICT/)
  const editable = { ...current, nodes: current.nodes.map(item => item.id !== branch ? item : {
    ...item, code: item.code + '\n// 审核注释', params: item.params.map(param => param.englishName === 'maxAttempts'
      ? { ...param, value: '3' } : param),
  }) }
  assert.equal(upgradeStoryQualityWorkflow(editable), editable)
})

function reviewedTake() {
  const sourceUrl = 'https://media.example.invalid/paid-take.mp4'
  const url = '/generated/verified-story.mp4'
  const sha256 = 'a'.repeat(64)
  const evidenceUrl = '/generated/verified-story.json'
  const frameTimes = [0, 1, 2, 3]
  const frames = frameTimes.map(index => `/generated/frame-${index}.jpg`)
  const observations = { version: 'story-shot-observations-v1', sourceVideoSha256: sha256, evidenceUrl,
    frames: frameTimes.map((second, frameIndex) => ({ frameIndex, second, frameUrl: frames[frameIndex],
      description: frameIndex >= 2 ? '纸袋仍在桌面' : '柴犬看着纸袋' })) }
  const videoEvidence = { decoded: true, url, originalUrl: sourceUrl, sha256, evidenceUrl, frameTimes, frames }
  const assessment = { version: 'story-shot-media-review-v1', passed: false, sourceVideoSha256: sha256, evidenceUrl,
    beatChecks: [{ id: 'deliver', status: 'incomplete', evidenceFrameIndices: [2, 3],
      evidenceObservations: ['纸袋仍在桌面', '纸袋仍在桌面'] }],
    endingHold: { status: 'uncertain', reason: '缺少已完成终态' } }
  const storyMediaReview = { version: 'story-shot-media-review-v1', videoUrl: sourceUrl,
    passed: false, retryable: true, reviewStatus: 'incomplete', issues: ['交接未完成'],
    videoEvidence, assessment, observations }
  const report = { url, originalUrl: sourceUrl, passed: false, videoEvidence, storyMediaReview }
  const shot = { visualBeats: [{ id: 'deliver', endSecond: 2, completion: '纸袋到蓝猫爪边' }] }
  const video = { url: sourceUrl }
  return { report, shot, video }
}

test('result branch accepts only a source-bound incomplete report and returns bounded evidence feedback', () => {
  const decide = new Function('params', 'branch', STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE) as
    (params: Record<string, unknown>, branch: { counts: { false: number } }) => unknown
  const fixture = reviewedTake()
  const decision = decide({ ...fixture, maxAttempts: 2 }, { counts: { false: 0 } }) as { value: boolean; feedback: string }
  assert.equal(decision.value, false)
  assert.match(decision.feedback, /纸袋仍在桌面/)
  assert.match(decision.feedback, /纸袋到蓝猫爪边/)
  assert.ok(decision.feedback.length <= 550)
  assert.doesNotMatch(decision.feedback, /media\.example\.invalid/)
  assert.throws(() => decide({ ...fixture, maxAttempts: 2 }, { counts: { false: 1 } }), /达到上限/)

  const uncertain = structuredClone(fixture)
  uncertain.report.storyMediaReview.reviewStatus = 'uncertain'
  uncertain.report.storyMediaReview.retryable = false
  uncertain.report.storyMediaReview.assessment.beatChecks[0].status = 'uncertain'
  uncertain.report.storyMediaReview.assessment.endingHold.status = 'uncertain'
  assert.equal(decide({ ...uncertain, maxAttempts: 2 }, { counts: { false: 0 } }), true)
  const contradictory = structuredClone(uncertain)
  contradictory.report.storyMediaReview.assessment.beatChecks[0].status = 'incomplete'
  assert.throws(() => decide({ ...contradictory, maxAttempts: 2 }, { counts: { false: 0 } }),
    /STORY_MEDIA_RETAKE_EVIDENCE_INVALID/)
  for (const status of ['invalid', 'technical-failure']) {
    const changed = structuredClone(fixture)
    changed.report.storyMediaReview.reviewStatus = status
    assert.throws(() => decide({ ...changed, maxAttempts: 2 }, { counts: { false: 0 } }),
      (error: Error) => error.message.includes(`STORY_MEDIA_REVIEW_REQUIRED: ${status}`)
        && error.message.includes('交接未完成') && error.message.includes('不能自动付费重拍或拼接'), status)
  }
  const wrongVideo = structuredClone(fixture)
  wrongVideo.video.url = 'https://media.example.invalid/other.mp4'
  assert.throws(() => decide({ ...wrongVideo, maxAttempts: 2 }, { counts: { false: 0 } }),
    /STORY_MEDIA_RETAKE_EVIDENCE_INVALID/)
  const inventedQuote = structuredClone(fixture)
  inventedQuote.report.storyMediaReview.assessment.beatChecks[0].evidenceObservations = ['已交接', '已交接']
  assert.throws(() => decide({ ...inventedQuote, maxAttempts: 2 }, { counts: { false: 0 } }),
    /STORY_MEDIA_RETAKE_EVIDENCE_INVALID/)
  const passed = structuredClone(fixture)
  passed.report.passed = true
  passed.report.storyMediaReview.passed = true
  passed.report.storyMediaReview.reviewStatus = 'passed'
  assert.equal(decide({ ...passed, maxAttempts: 2 }, { counts: { false: 0 } }), true)
})

test('managed story review branch projects only retry state while retaining source-bound params', async () => {
  const branch = schema6().nodes.find(item => item.id === STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID)!
  const savedContext = { branch: { visits: 0, counts: { true: 0, false: 0 } },
    model_images: 'i'.repeat(4 * 1024 * 1024), first_frame: 'f'.repeat(2 * 1024 * 1024),
    video_shot: 'v'.repeat(2 * 1024 * 1024), video_review: 'r'.repeat(4 * 1024 * 1024),
    params: { report: 'duplicate saved review' } }
  assert.ok(Buffer.byteLength(JSON.stringify(savedContext)) > 12 * 1024 * 1024)
  const projected = storyVideoReviewBranchCodeContext('wf-story', branch, savedContext)
  assert.deepEqual(projected, { branch: savedContext.branch })
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) < 100)
  assert.equal(savedContext.video_review.length, 4 * 1024 * 1024)

  const fixture = reviewedTake()
  const params = { ...fixture, maxAttempts: 2 }
  await assert.rejects(executeCodeNode({ code: branch.code!, params, context: savedContext }), /流程上下文超过 12MB 限制/)
  const decision = await executeCodeNode({ code: branch.code!, params, context: projected })
  assert.equal(decision.value, false)
  assert.match(String(decision.feedback), /纸袋仍在桌面/)

  const invalid = structuredClone(fixture)
  invalid.report.storyMediaReview.reviewStatus = 'invalid'
  await assert.rejects(executeCodeNode({ code: branch.code!,
    params: { ...invalid, maxAttempts: 2 }, context: projected }), /STORY_MEDIA_REVIEW_REQUIRED/)

  assert.equal(storyVideoReviewBranchCodeContext('wf-other', branch, savedContext), savedContext)
  assert.equal(storyVideoReviewBranchCodeContext('wf-story', { ...branch, code: branch.code + '\n// custom' }, savedContext), savedContext)
  assert.equal(storyVideoReviewBranchCodeContext('wf-story', { ...branch, kind: 'code' }, savedContext), savedContext)
  const accepted = { id: 'node-video-review-accepted', kind: 'code', code: 'return { routed: true };' }
  assert.deepEqual(storyVideoReviewBranchCodeContext('wf-workplace-second-trial-v1', accepted, savedContext), {})
  assert.equal(storyVideoReviewBranchCodeContext('wf-other', accepted, savedContext), savedContext)
  assert.equal(storyVideoReviewBranchCodeContext('wf-workplace-second-trial-v1',
    { ...accepted, code: 'return { custom: true };' }, savedContext), savedContext)
})

test('unconfirmed visual report follows the pass edge with a source-bound risk reminder', () => {
  const decide = new Function('params', 'branch', STORY_VISUAL_ONLY_VIDEO_REVIEW_RESULT_BRANCH_CODE) as
    (params: Record<string, unknown>, branch: { counts: { false: number } }) => unknown
  const fixture = reviewedTake()
  fixture.report.storyMediaReview.reviewStatus = 'invalid'
  fixture.report.storyMediaReview.retryable = false
  fixture.report.storyMediaReview.issues = ['观察与动作结论引用不一致']
  fixture.report.storyMediaReview.videoEvidence.technicalValidation = { passed: true }
  const result = decide({ ...fixture, maxAttempts: 2 }, { counts: { false: 0 } }) as Record<string, unknown>
  assert.equal(result.value, true)
  assert.equal(result.passed, true)
  assert.deepEqual(result.riskReminder, { sourceVideoSha256: 'a'.repeat(64), reviewStatus: 'invalid',
    issues: ['观察与动作结论引用不一致'], message: '逐帧质检未能确证缺陷；本镜按通过连线继续，保留原报告风险。' })
  const unavailable = structuredClone(fixture)
  unavailable.report.storyMediaReview.reviewStatus = 'unavailable'
  unavailable.report.storyMediaReview.assessment = null
  unavailable.report.storyMediaReview.observations = null
  unavailable.report.storyMediaReview.issues = ['CLI 未产生完整文字']
  const risk = decide({ ...unavailable, maxAttempts: 2 }, { counts: { false: 0 } }) as Record<string, unknown>
  assert.equal(risk.value, true)
  assert.equal((risk.riskReminder as Record<string, unknown>).reviewStatus, 'unavailable')
  assert.deepEqual(storyQualityBranchCodeContext('wf-workplace-second-trial-v1',
    { id: STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID, kind: 'branch', code: STORY_VISUAL_ONLY_VIDEO_REVIEW_RESULT_BRANCH_CODE },
    { branch: { counts: { false: 0 } }, video_review: 'r'.repeat(13 * 1024 * 1024) }),
  { branch: { counts: { false: 0 } } })
  fixture.report.storyMediaReview.videoEvidence.sha256 = 'b'.repeat(64)
  assert.throws(() => decide({ ...fixture, maxAttempts: 2 }, { counts: { false: 0 } }), /同源视频/)
})

test('script review has a visible bounded rewrite route and preserves the preceding image result', async () => {
  const workflow = schema7()
  const branch = workflow.nodes.find(item => item.id === STORY_SCRIPT_REVIEW_RESULT_BRANCH_NODE_ID)!
  assert.equal(branch.code, STORY_SCRIPT_REVIEW_RESULT_BRANCH_CODE)
  assert.equal(validationResultBranch(workflow, STORY_SCRIPT_REVIEW_NODE_ID), true)
  assert.deepEqual(branchConfigurationErrors(workflow), [])
  assert.deepEqual(workflow.edges.filter(edge => edge.from === branch.id).map(edge => [edge.branch, edge.to]),
    [['true', 'node-loop'], ['false', 'node-script']])
  const context = { branch: { visits: 0, counts: { true: 0, false: 0 } }, model_images: { items: ['saved-image'] } }
  const report = { version: 'story-script-review-v1', passed: false, code: 'STORY_SHOT_TIMING_INVALID',
    issues: ['第一镜动作缺少完成状态'], repairAttempt: { attempted: false } }
  const decision = await executeCodeNode({ code: branch.code!, params: { report, maxAttempts: 3 },
    context: storyQualityBranchCodeContext('wf-story', branch, context) })
  assert.equal(decision.value, false)
  assert.deepEqual(decision.feedback.issues, report.issues)
  const runs = workflow.nodes.map((node, i) => ({ id: `${node.id}-${i}`, node, status: 'idle',
    context: {}, inputContext: {}, durationMs: 0 }))
  const writerIndex = runs.findIndex(run => run.node.id === 'node-script')
  const reviewIndex = runs.findIndex(run => run.node.id === STORY_SCRIPT_REVIEW_NODE_ID)
  const branchIndex = runs.findIndex(run => run.node.id === branch.id)
  runs[writerIndex] = { ...runs[writerIndex], status: 'success', output: { shots: ['first-draft'] },
    inputContext: { ...context }, context: { ...context } } as typeof runs[number]
  runs[reviewIndex] = { ...runs[reviewIndex], status: 'success', output: report,
    inputContext: { ...context }, context: { ...context } } as typeof runs[number]
  const transition = routeBranch(workflow, runs, branchIndex, decision,
    { ...context, script_generation: { shots: ['first-draft'] }, script_review: report })
  assert.equal(transition.index, writerIndex)
  assert.equal(transition.runs[writerIndex].status, 'idle')
  assert.equal(transition.runs[reviewIndex].status, 'idle')
  assert.deepEqual(transition.context.model_images, context.model_images)
  assert.equal(transition.runs[writerIndex].retryFeedback.issues[0], report.issues[0])
  const approved = await executeCodeNode({ code: branch.code!, params: {
    report: { version: report.version, passed: true, shots: [{ id: 'shot-1' }], issues: [] }, maxAttempts: 3,
  }, context: { branch: { visits: 1, counts: { true: 0, false: 1 } } } })
  assert.equal(approved.value, true)
  await assert.rejects(executeCodeNode({ code: branch.code!, params: { report, maxAttempts: 3 },
    context: { branch: { visits: 2, counts: { true: 0, false: 2 } } } }), /STORY_SCRIPT_RETRY_BUDGET_EXHAUSTED/)
  await assert.rejects(executeCodeNode({ code: branch.code!, params: {
    report: { version: report.version, passed: false, issues: [] }, maxAttempts: 3,
  }, context: { branch: context.branch } }), /STORY_SCRIPT_REVIEW_INVALID/)
})

test('schema 7 rejects a script review bypass or an unbounded rewrite route', () => {
  const current = schema7()
  const branch = STORY_SCRIPT_REVIEW_RESULT_BRANCH_NODE_ID
  for (const edges of [
    current.edges.filter(edge => edge.id !== 'edge-script-review-retry'),
    current.edges.map(edge => edge.id === 'edge-script-review-retry' ? { ...edge, to: 'node-model-images' } : edge),
    current.edges.map(edge => edge.id === 'edge-script-review-pass' ? { ...edge, to: 'node-image' } : edge),
    [...current.edges, { id: 'script-bypass', from: STORY_SCRIPT_REVIEW_NODE_ID, to: 'node-loop' }],
  ]) assert.throws(() => upgradeStoryQualityWorkflow({ ...current, edges }), /STORY_QUALITY_CONFLICT/)
  const unbounded = { ...current, nodes: current.nodes.map(node => node.id !== branch ? node : {
    ...node, params: node.params.map(param => param.englishName === 'maxAttempts' ? { ...param, value: '999' } : param),
  }) }
  assert.throws(() => upgradeStoryQualityWorkflow(unbounded), /STORY_QUALITY_CONFLICT/)
})
