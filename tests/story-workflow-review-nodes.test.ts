import test from 'node:test'
import assert from 'node:assert/strict'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'
import { createStoryScriptSource } from '../src/story-shot-timing.ts'

const noDatabase = { query: async () => { throw Error('review operations must not query the database') } } as never

function plannedShot() {
  return {
    title: '早餐交换', content: '0—2秒，蓝猫把硬币推到柴犬爪边；2—4秒，柴犬把包子纸袋推到蓝猫爪边。',
    duration: 5, camera: '固定中景', mood: '温暖', firstFramePrompt: '猫和狗在柜台两侧。',
    visualBeats: [
      { id: 'coin', action: '蓝猫把硬币推到柴犬爪边', completion: '硬币停在柴犬前爪边', startSecond: 0, endSecond: 2 },
      { id: 'bag', action: '柴犬把包子纸袋推到蓝猫爪边', completion: '纸袋停在蓝猫前爪边', startSecond: 2, endSecond: 4 },
    ],
  }
}

test('explicit story script review supplies timed actions without changing the writer output', async () => {
  const shot = plannedShot()
  const script = { shots: [shot], items: [shot], raw: { model: 'writer' } }
  const before = structuredClone(script)
  const result = await executeBuiltinNode(noDatabase, {
    operation: 'story.script-review', params: { script, expectedCount: 1 },
  }) as Record<string, unknown>
  assert.equal(result.version, 'story-script-review-v1')
  assert.equal(result.passed, true)
  assert.equal(result.items, result.shots)
  assert.deepEqual(script, before)
  const reviewed = (result.shots as Array<Record<string, unknown>>)[0]
  assert.notEqual(reviewed, shot)
  assert.match(String(reviewed.timedActions), /0–2 秒：蓝猫把硬币推到柴犬爪边/)
  assert.match(String(reviewed.timedActions), /4–5 秒：保持已完成状态/)
})

test('story script review returns traceable rejection before any media call for dropped or compressed actions', async () => {
  const merged = plannedShot()
  merged.visualBeats = [merged.visualBeats[0]]
  const rejected = await executeBuiltinNode(noDatabase, {
    operation: 'story.script-review', params: { script: { shots: [merged] }, expectedCount: 1 },
  }) as Record<string, unknown>
  assert.equal(rejected.passed, false)
  assert.equal(rejected.code, 'STORY_SHOT_TIMING_INVALID')
  assert.ok((rejected.issues as string[]).some(issue => issue.includes('一一对应')))

  const cramped = plannedShot()
  cramped.duration = 3
  cramped.visualBeats[0].endSecond = 1
  cramped.visualBeats[1].startSecond = 1
  cramped.visualBeats[1].endSecond = 3
  const rejectedTiming = await executeBuiltinNode(noDatabase, {
    operation: 'story.script-review', params: { script: [cramped], expectedCount: 1 },
  }) as Record<string, unknown>
  assert.equal(rejectedTiming.passed, false)
  assert.ok((rejectedTiming.issues as string[]).some(issue => issue.includes('最小预算')))
  assert.ok((rejectedTiming.issues as string[]).some(issue => issue.includes('可读收尾')))
})

test('story script review respects a saved source instead of accepting rewritten action text', async () => {
  const shot = plannedShot()
  const source = createStoryScriptSource([shot], { sourceExecutionId: 'record-original', sourceRunId: 'node-script' })
  const rewritten = plannedShot()
  rewritten.content = rewritten.content.replace('包子纸袋', '空纸袋')
  rewritten.visualBeats[1].action = '柴犬把空纸袋推到蓝猫爪边'
  const result = await executeBuiltinNode(noDatabase, {
    operation: 'story.script-review', params: { script: [rewritten], source, expectedCount: 1 },
  }) as Record<string, unknown>
  assert.equal(result.passed, false)
  assert.ok((result.issues as string[]).some(issue => issue.includes('改写了原剧本动作')))
})

test('story script review makes at most one visible model repair and rechecks the original actions', async () => {
  const cramped = plannedShot()
  cramped.duration = 3
  cramped.visualBeats[0].endSecond = 1
  cramped.visualBeats[1].startSecond = 1
  cramped.visualBeats[1].endSecond = 3
  const repaired = plannedShot()
  const calls: Array<{ operation?: string; requestKey?: string; prompt: string }> = []
  const result = await executeBuiltinNode(noDatabase, {
    operation: 'story.script-review',
    model: { id: 'script-model', provider: 'Kling', capability: 'text', settings: {} },
    executionContext: { requestKey: 'record-1:node-script-review' },
    params: { script: { shots: [cramped] }, expectedCount: 1 },
  }, async ({ operation, executionContext, prompt }) => {
    calls.push({ operation, requestKey: executionContext?.requestKey, prompt })
    return { status: 200, body: JSON.stringify([repaired]) }
  }) as Record<string, unknown>
  assert.equal(calls.length, 1)
  assert.equal(calls[0].operation, 'story.script-repair')
  assert.equal(calls[0].requestKey, 'record-1:node-script-review:repair-1')
  assert.match(calls[0].prompt, /完整初稿/)
  assert.match(calls[0].prompt, /柴犬把包子纸袋推到蓝猫爪边/)
  assert.equal(result.passed, true)
  assert.deepEqual((result.shots as Array<Record<string, unknown>>)[0].visualBeats, repaired.visualBeats)
  const attempt = result.repairAttempt as Record<string, unknown>
  assert.equal(attempt.attempted, true)
  assert.equal(attempt.outcome, 'passed')
  assert.equal((attempt.modelCall as Record<string, unknown>).modelId, 'script-model')
})

test('story script repair rejects a structurally valid model answer that rewrites a saved action', async () => {
  const original = plannedShot()
  const source = createStoryScriptSource([original], { sourceExecutionId: 'record-original', sourceRunId: 'node-script' })
  const cramped = plannedShot()
  cramped.duration = 3
  cramped.visualBeats[0].endSecond = 1
  cramped.visualBeats[1].startSecond = 1
  cramped.visualBeats[1].endSecond = 3
  const rewritten = plannedShot()
  rewritten.content = rewritten.content.replace('包子纸袋', '空纸袋')
  rewritten.visualBeats[1].action = '柴犬把空纸袋推到蓝猫爪边'
  let calls = 0
  const result = await executeBuiltinNode(noDatabase, {
    operation: 'story.script-review',
    model: { id: 'script-model', provider: 'Kling', capability: 'text', settings: {} },
    params: { script: [cramped], source, expectedCount: 1 },
  }, async () => { calls += 1; return { status: 200, body: JSON.stringify([rewritten]) } }) as Record<string, unknown>
  assert.equal(calls, 1)
  assert.equal(result.passed, false)
  assert.ok((result.issues as string[]).some(issue => issue.includes('改写了原剧本动作')))
  assert.equal((result.repairAttempt as Record<string, unknown>).outcome, 'rejected')
})

test('wf-story media review keeps a paid legacy take but refuses missing cat and dog vocal plans', async () => {
  const calls: Array<{ operation?: string; model?: string; url?: string }> = []
  const video = { url: 'https://example.test/paid-clip', raw: { taskId: 'paid-task' }, params: { sound: 'on' } }
  const result = await executeBuiltinNode(noDatabase, {
    operation: 'story.media-review', model: { id: 'review-model', provider: 'Kling', capability: 'text', settings: {} },
    executionContext: { workflowId: 'wf-story', nodeId: 'node-media-review' },
    params: { shot: plannedShot(), video, aspectRatio: '9:16', requireAudio: true },
  }, async (request) => {
    calls.push({ operation: request.operation, model: request.model.id })
    return { status: 200, body: {} }
  }, { reviewStoryVideo: async (options) => {
    calls.push({ model: options.model.id, url: options.videoUrl })
    throw Error('legacy shot must stop before model review')
  } }) as Record<string, unknown>
  assert.deepEqual(calls, [])
  assert.equal(result.passed, false)
  assert.match(String((result.issues as string[])[0]), /ANIMAL_INTERACTION_INVALID/)
  assert.equal(result.url, video.url)
  assert.equal(result.originalUrl, video.url)
  assert.equal((result.raw as Record<string, unknown>).taskId, 'paid-task')
  assert.deepEqual(result.params, video.params)
  assert.equal(result.videoEvidence, null)
  assert.equal((result.storyMediaReview as Record<string, unknown>).passed, false)
  assert.deepEqual(video, { url: 'https://example.test/paid-clip', raw: { taskId: 'paid-task' }, params: { sound: 'on' } })
})

test('wf-story media review never labels a model-only verdict as vocal acceptance', async () => {
  const shot = plannedShot()
  const planned = { ...shot,
    visualBeats: [
      { ...shot.visualBeats[0], action: '芙伊叫喵儿，然后把硬币推到柴犬爪边' },
      { ...shot.visualBeats[1], action: '卷毛叫旺，然后把包子纸袋推到蓝猫爪边' },
    ],
    audioContractVersion: 'animal-interaction-v1',
    vocalBeats: [
      { id: 'cat', speaker: '芙伊', utterance: '喵儿', startSecond: 0.5, endSecond: 1,
        visualBeatId: 'coin', responseTo: null },
      { id: 'dog', speaker: '卷毛', utterance: '旺', startSecond: 2.5, endSecond: 3,
        visualBeatId: 'bag', responseTo: 'cat' },
    ],
  }
  const video = { url: 'https://example.test/paid-clip', raw: { taskId: 'paid-task' } }
  const evidence = { url: '/generated/verified-clip.mp4', evidenceUrl: '/generated/clip-evidence.json',
    sha256: 'a'.repeat(64), decoded: true }
  let reviews = 0
  const result = await executeBuiltinNode(noDatabase, {
    operation: 'story.media-review', executionContext: { workflowId: 'wf-story', nodeId: 'node-video-review' },
    params: { shot: planned, video },
  }, undefined, { reviewStoryVideo: async () => {
    reviews++
    return { version: 'story-shot-media-review-v1', passed: true, reviewStatus: 'passed', retryable: false,
      issues: [], videoEvidence: evidence } as never
  } }) as Record<string, unknown>
  assert.equal(reviews, 1)
  assert.equal(result.passed, false)
  assert.match((result.issues as string[]).join('；'), /STORY_VOCAL_LISTENING_REQUIRED/)
  assert.equal(result.url, evidence.url)
  assert.equal(result.originalUrl, video.url)
  assert.equal((result.raw as Record<string, unknown>).taskId, 'paid-task')
})

test('uncertain media review keeps the same paid video and does not request another generation', async () => {
  const video = { url: '/generated/paid.mp4', raw: { taskId: 'paid-once' } }
  let mediaCalls = 0
  const result = await executeBuiltinNode(noDatabase, {
    operation: 'story.media-review', params: { shot: plannedShot(), video },
  }, async () => { mediaCalls += 1; throw Error('unexpected model request') }, {
    reviewStoryVideo: async () => ({ version: 'story-shot-media-review-v1', passed: false,
      reviewStatus: 'uncertain', retryable: false, issues: ['道具到达位置被遮挡'], videoEvidence: null }) as never,
  }) as Record<string, unknown>
  assert.equal(mediaCalls, 0)
  assert.equal(result.passed, false)
  assert.equal(result.url, video.url)
  assert.equal((result.raw as Record<string, unknown>).taskId, 'paid-once')
  assert.deepEqual(result.issues, ['道具到达位置被遮挡'])
  assert.equal((result.storyMediaReview as Record<string, unknown>).reviewStatus, 'uncertain')
})
