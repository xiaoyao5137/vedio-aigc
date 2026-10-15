import test from 'node:test'
import assert from 'node:assert/strict'
import { upgradeDurationQuality, upgradeQualityWorkflow } from '../src/quality-node-presets.ts'
import { migrateBranchWorkflow, migrateBranchRuns } from '../src/branch-migration.ts'
import { compileDurationSchedule } from '../src/duration-schedule.ts'
import { durationCompletionRecovery } from '../src/duration-workflow.ts'
import { durationMediaAcceptCode, refreshPendingDurationMediaAcceptRuns } from '../src/principle-workflow.ts'
import { upgradeDurationAdvisoryWorkflow } from '../src/duration-advisory-workflow.ts'
import { PRINCIPLE_MEDIA_RUNTIME_CODE } from '../src/principle-media-quality.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { speechMetrics } from '../server/speech-metrics.ts'
import { chantScene, chantShot } from './fixtures/duration-v2-chant.ts'
import { serializeRuntimeFunction } from '../src/serialized-runtime.ts'
import { nodePromptInputContext } from '../src/review-input.ts'
import { resolveNodePolicy } from '../src/node-policy-input.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { SANGUO_CINEMATIC_STORYBOARD_PROMPT, SANGUO_STORYBOARD_PROMPT_BEFORE_TRUSTED_TAIL_STATE } from '../src/storyboard-prompt.ts'

// VM inputs/outputs intentionally include mutable, differently shaped fixtures.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Value = Record<string, any>

// Build the previous managed contract from public presets, so these VM tests
// do not depend on private, ignored execution dumps or a running application.
function priorWorkflow(upgrade = upgradeQualityWorkflow) {
  const base = { id: 'wf-sanguo-history-drama', schemaVersion: 59,
    nodes: ['sanguo-scene-outline', 'sanguo-shot-script', 'sanguo-character-image', 'sanguo-video', 'sanguo-last-frame', 'loop'].map(id => ({
      id, title: id, kind: id === 'sanguo-video' ? 'video' : id === 'sanguo-shot-script' ? 'text' : 'code', modelId: 'user-model', resultVar: id,
      prompt: 'test', params: [], uploads: [], loop: { enabled: false, sourcePath: '', fallbackCount: 1, itemVar: 'item' },
      position: { x: 0, y: 0 }, parentId: 'loop', ...(id === 'loop' ? { childIds: ['sanguo-shot-script', 'sanguo-character-image', 'sanguo-video', 'sanguo-last-frame'] } : {}) })),
    edges: [{ id: 'v-tail', from: 'sanguo-video', to: 'sanguo-last-frame' }] }
  return migrateBranchWorkflow(upgrade(base))
}
const previous = priorWorkflow(), migrated = upgradeDurationQuality(previous)
const getNode = (id: string, workflow = migrated) => workflow.nodes.find(node => node.id === id)!
const paramsFor = (id: string, workflow = migrated) => Object.fromEntries(getNode(id, workflow).params.map(param => [param.englishName ?? param.name,
  param.type === 'number' ? Number(param.value) : ['json', 'boolean'].includes(param.type) ? JSON.parse(param.value) : param.value]))
const execute = (id: string, context: Value, params: Value = {}, workflow = migrated) => executeCodeNode({
  code: getNode(id, workflow).code!, context, params: { ...paramsFor(id, workflow), ...params } }) as Promise<Value>
const point = (second: number) => ({ lower: second, upper: second })

test('same-video native sampling excludes audio-only uncertainty windows', () => {
  const context: Value = { shot_script: {}, video_take: { url: '/generated/take.mp4' },
    video_evidence: { url: '/generated/take.mp4', evidenceUrl: '/generated/evidence.json', duration: 13,
      frameTimes: [0, 2, 6, 12.9] } }
  const completion: Value = { route: 'same-media-evidence', reasons: ['需检查绑腕过程和旁白句尾'], remainingMandatoryBeats: ['bind', 'speech'],
    evidenceRequests: [
      { beatId: 'speech', kind: 'audio-review', modality: 'audio', startSecond: 0, endSecond: 3 },
      { beatId: 'bind', kind: 'native-sequence', modality: 'visual', startSecond: 2, endSecond: 8 },
    ] }
  const result = durationCompletionRecovery(context, completion, {})
  assert.deepEqual(result.samplingRetryPlan.nativeSequence.windows, [{ start: 2, end: 8 }])
  assert.equal(result.samplingRetryPlan.nativeSequence.reviewMaxFrames, 256)
})

test('duration migration recognizes the frozen pre-tail-state writer without overwriting custom or ambiguous text', () => {
  const source = structuredClone(previous), writer = source.nodes.find(node => node.id === 'sanguo-shot-script')!
  writer.prompt = '导演前缀\n' + SANGUO_STORYBOARD_PROMPT_BEFORE_TRUSTED_TAIL_STATE + '\n导演后缀'
  const before = structuredClone(source), next = upgradeDurationQuality(source)
  const upgraded = next.nodes.find(node => node.id === writer.id)!
  assert.equal(next.schemaVersion, 115)
  assert.ok(upgraded.prompt.startsWith('导演前缀\n'))
  assert.ok(upgraded.prompt.includes('\n导演后缀'))
  assert.ok(upgraded.prompt.includes('${loop.previous.shot_script.worldState}'))
  assert.ok(!upgraded.prompt.includes('${loop.previous.video_shot.worldState}'))
  assert.equal(upgraded.modelId, writer.modelId)
  assert.deepEqual(source, before)
  for (const prompt of [writer.prompt.replace('世界状态', '用户自定义状态'), writer.prompt + SANGUO_CINEMATIC_STORYBOARD_PROMPT,
    writer.prompt + SANGUO_STORYBOARD_PROMPT_BEFORE_TRUSTED_TAIL_STATE]) {
    const custom = structuredClone(source)
    custom.nodes.find(node => node.id === writer.id)!.prompt = prompt
    const original = structuredClone(custom)
    assert.throws(() => upgradeDurationQuality(custom), /DURATION_MIGRATION_CONFLICT/)
    assert.deepEqual(custom, original)
  }
})

function contextFixture(): Value {
  const original = chantShot(), compiled = compileDurationSchedule(original, { scene: chantScene })
  const shot: Value = { ...original, ...compiled, storyProgress: { status: 'in-progress', unitId: 'song', pendingActions: ['后续剧情'] },
    completionCriteria: ['本镜歌谣和群众回应完整'], contentContractVersion: 'cinematic-v1' }
  const frameTimes = Array.from({ length: 91 }, (_, i) => i / 10), frames = frameTimes.map((_, i) => `/generated/frame-${i}.jpg`)
  const alignment = [{ planned: compiled.speechWindows[0], actualStart: .8, actualEnd: 6.3, matchedStart: .8, matchedEnd: 6.3,
    boundaryEvidenceVersion: 2, boundaryStatus: 'reliable', boundaryUncertaintyReasons: [], firstTokenMatched: true, lastTokenMatched: true,
    utteranceCandidateStart: .8, utteranceCandidateEnd: 6.3, startBoundaryRange: point(.8), endBoundaryRange: point(6.3), alignmentCoverage: 1 }]
  const video = { url: 'https://media.example.test/synthetic-chant.mp4', params: { scheduleHash: compiled.scheduleHash } }
  const evidence: Value = { url: '/generated/synthetic-chant.mp4', originalUrl: video.url, decoded: true, duration: 9.04,
    evidenceUrl: '/generated/synthetic-chant-evidence.json', frames, frameTimes, width: 1280, height: 720, hasAudio: true, meanVolumeDb: -20,
    lastFrameUrl: frames.at(-1), speechValidation: { alignmentVersion: 2, phoneticErrorRate: 0, lastSpeechEnd: 8.1, alignment }, speechMetrics: speechMetrics(alignment),
    nativeSequence: { sourceVideoSha256: 'a'.repeat(64), archiveSha256: 'b'.repeat(64), totalNativeFrames: 91,
      selectedNativeFrameIndices: frameTimes.map((_, i) => i), windows: [{ start: 0, end: 9, complete: true }],
      preservedSamples: [0, 8, 63, 81, 90].map(i => ({ evidenceIndex: i, nativeFrameIndex: i })) },
    frameReferences: frameTimes.map((second, i) => ({ evidenceIndex: i, nativeFrameIndex: i, pts: i, timeBase: '1/10', second, url: frames[i], sourceSha256: 'c'.repeat(64) })),
    audioObservations: [{ id: 'group-hum', evidenceRef: '/generated/synthetic-chant-evidence.json', method: 'human-listen', status: 'confirmed',
      actorIds: ['listeners'], finding: '合成测试证据：群众短促哼唱完成，曲调与主唱一致。', audibility: 'observed', completionCue: 'observed', melodyRelation: 'observed',
      observedStart: point(6.3), observedEnd: point(8.1) }] }
  const checks = compiled.schedule.map(item => {
    const start = item.startSecond, end = item.endSecond
    return { beatId: item.beatId, sourceBeatId: item.sourceBeatId, status: 'complete', reason: '合成测试证据：已连续记录本节拍动作过程和完成态。',
      observedStart: point(start), observedEnd: point(end), visual: {
        frameIndices: frameTimes.flatMap((time, index) => time >= start && time <= end ? [index] : []),
        observedChange: '人物执行了完整动作过程。', observedFinalState: '所承诺的动作已经收束。' },
      audio: { evidenceIds: item.beatId === 'lead-song' ? ['speech-0'] : item.beatId === 'crowd-response' ? ['group-hum'] : [] } }
  })
  return { shot_script: shot, video_take: video, video_evidence: evidence,
    media_review: { durationCompletion: { scheduleHash: compiled.scheduleHash, evidenceRef: evidence.evidenceUrl, checks } } }
}

test('duration migration adds one bounded replan branch and two edges, preserving original source and model selection', () => {
  assert.equal(previous.schemaVersion, 113)
  assert.equal(migrated.schemaVersion, 115)
  assert.equal(migrated.nodes.length, previous.nodes.length + 1)
  assert.equal(migrated.edges.length, previous.edges.length + 2)
  assert.equal(upgradeDurationQuality(migrated), migrated)
  assert.equal(getNode('sanguo-video').modelId, getNode('sanguo-video', previous).modelId)
  assert.ok(getNode('loop').childIds!.includes('sanguo-duration-replan'))
  assert.ok(migrated.edges.some(edge => edge.from === 'sanguo-media-accept' && edge.to === 'sanguo-duration-replan'))
  assert.ok(migrated.edges.some(edge => edge.from === 'sanguo-duration-replan' && edge.to === 'sanguo-shot-script' && edge.branch === 'false'))
  for (const id of ['sanguo-media-request', 'sanguo-media-metrics', 'sanguo-media-accept']) assert.ok(getNode(id).code!.endsWith(getNode(id, previous).code!))
  const preview114 = { ...migrated, schemaVersion: 114 }
  const refreshed = upgradeDurationQuality(preview114)
  assert.equal(refreshed.schemaVersion, 115)
  assert.equal(refreshed.nodes.filter(node => node.id === 'sanguo-duration-replan').length, 1)
  assert.equal(refreshed.nodes.length, migrated.nodes.length)
  assert.equal(refreshed.edges.length, migrated.edges.length)
})

test('viewing or hydrating historical v1 runs cannot insert new v2 branches or replace frozen node definitions', () => {
  const runs = previous.nodes.map(node => ({ id: node.id, node, status: 'success', durationMs: 0, context: {}, output: { historical: true } }))
  const snapshot = JSON.stringify(runs)
  assert.equal(migrateBranchRuns(migrated, runs), runs)
  assert.equal(JSON.stringify(runs), snapshot)
  assert.equal(runs.some(run => run.node.id === 'sanguo-duration-replan'), false)
})

test('v2 script review receives the compiled candidate without stale raw drafts and keeps independent vocalization rules after refresh', () => {
  const reviewer = getNode('sanguo-shot-script-review', previous)
  assert.ok(reviewer)
  const upgraded = upgradeDurationQuality(previous)
  const refreshed = upgradeDurationQuality({ ...upgraded, schemaVersion: 114 })
  const node = getNode(reviewer.id, refreshed)
  assert.equal(node.prompt.split('【duration-v2分镜审核契约】').length, 2)
  assert.match(node.prompt, /kind=vocalization/)
  const mode = node.params.find(param => param.englishName === 'promptInputMode')?.value
  assert.equal(mode, 'normalized-results')
  const candidate = { videoPrompt: '当前边走边唱', text: '{"videoPrompt":"旧稿走完再唱"}', raw: { content: '旧稿' } }
  const snapshot = JSON.stringify(candidate)
  assert.deepEqual(nodePromptInputContext({ shot_script: candidate }, mode), { shot_script: { videoPrompt: '当前边走边唱' } })
  assert.equal(JSON.stringify(candidate), snapshot)
})

test('actual v2 media reviewer uses per-voice budgets and waits for required responses before considering a cut', async () => {
  const legacy = getNode('sanguo-media-review', previous), snapshot = JSON.stringify(legacy)
  const reviewer = getNode('sanguo-media-review')
  assert.match(legacy.prompt, /动作\/observed表演\/ASR结束后按maxIdleTailSeconds\/tailSeconds提裁尾/)
  assert.doesNotMatch(reviewer.prompt, /动作\/observed表演\/ASR结束后按|params\.minSpeechRate|allowedSpan已含停顿容差/)
  assert.match(reviewer.prompt, /timingPolicy\.speech\[deliveryStyle\]/)
  assert.match(reviewer.prompt, /allowedSpan来自该声部已编译窗口的end-start/)
  assert.match(reviewer.prompt, /主唱之后原要求中的反应、群体发声或其他必需动作不属于idle/)
  assert.match(reviewer.prompt, /completionUpper \+ timingPolicy\.endingReadabilityReserve/)
  assert.match(reviewer.prompt, /任何必需动作或声音未完成\/未知时，不能计算可裁尾点/)
  const source = JSON.parse(reviewer.params.find(param => (param.englishName || param.name) === 'reviewPolicySource')!.value)
  const reviewPolicy = resolveNodePolicy(source, migrated.nodes, node => paramsFor(node.id))!
  assert.equal(reviewPolicy.tailSeconds, undefined)
  assert.equal(reviewPolicy.minSpeechRate, undefined)
  assert.equal(reviewPolicy.maxIdleTailSeconds, 1.2)
  assert.equal(reviewPolicy.maxPhoneticErrorRate, .2)
  const context = contextFixture()
  // A valid slower chant with later, independently required group audio must
  // render the compiled budget, not a global dialogue-rate or ASR-only cut rule.
  Object.assign(context.video_evidence.speechMetrics[0], { actualStart: 2.42, actualEnd: 7.26, elapsed: 4.84 })
  context.media_metrics = await execute('sanguo-media-metrics', context)
  const prompt = renderWorkflowTemplate(reviewer.prompt, { ...context, params: { reviewPolicy } })
  assert.equal(context.media_metrics.speech[0].timingAssessment, 'within-allowance')
  assert.match(prompt, /"allowedSpan":5\.5/)
  assert.match(prompt, /"deliveryStyle":"chant"/)
  assert.match(prompt, /本镜余量为0\.5秒/)
  assert.doesNotMatch(prompt, /"minSpeechRate"|"tailSeconds":0\.3|\$\{shot_script\.pacing/)
  assert.equal(JSON.stringify(legacy), snapshot)
  assert.equal(paramsFor('sanguo-media-accept', previous).tailSeconds, .3)
})

test('refresh-managed media timing replaces one section idempotently without accumulating contradictory policies', () => {
  const refresh = (workflow: typeof migrated) => upgradeDurationQuality({ ...workflow, schemaVersion: 114 })
  const refreshed = refresh(migrated), twice = refresh(refreshed)
  assert.deepEqual(twice, refreshed)
  for (const workflow of [migrated, refreshed, twice]) {
    const node = getNode('sanguo-media-review', workflow)
    assert.equal(node.prompt.split('【duration-v2成片时长契约】').length, 2)
    assert.equal(node.prompt.split('【duration-v2逐节拍完成证据】').length, 2)
    assert.equal(node.prompt.split('【duration-v2时间解释】').length, 2)
    assert.doesNotMatch(node.prompt, /params\.minSpeechRate|ASR结束后按maxIdleTailSeconds\/tailSeconds提裁尾/)
    assert.equal(workflow.nodes.length, migrated.nodes.length)
    assert.equal(getNode('sanguo-media-review', previous).prompt.includes('【duration-v2成片时长契约】'), false)
  }
})

test('serialized v2 request keeps compiled clocks, declared group voice and same-material adaptive samples', async () => {
  const context = contextFixture(), request = await execute('sanguo-media-request', context)
  assert.equal(request.scheduleHash, context.shot_script.pacing.scheduleHash)
  assert.equal(request.latestSpeechEnd, 8.5)
  assert.deepEqual(request.speechWindows, context.shot_script.pacing.speechWindows)
  assert.equal(request.vocalizationRequirements.length, 1)
  assert.deepEqual(request.sampleTimes, context.shot_script.pacing.sampleTimes)
  const sampleTimes = [0, .8, 4, 6.3, 8.1, 9], nativeSequence = { enabled: true, windows: [{ start: 6, end: 9 }], reviewMaxFrames: 160 }
  context.mediaSamplingRetry = { sourceUrl: context.video_take.url, round: 1, sampleTimes, nativeSequence }
  const retry = await execute('sanguo-media-request', context)
  assert.deepEqual(retry.sampleTimes, sampleTimes)
  assert.deepEqual(retry.nativeSequence, nativeSequence)
  assert.equal(retry.samplingPlan.sourceUrl, context.video_take.url)
  await assert.rejects(() => execute('sanguo-media-request', context, { maxSamplingFrames: 25 }), /DURATION_SAMPLING_LIMIT/)
})

test('serialized metrics overrides the legacy six-second rate with compiled singing window and uncertain terminal evidence', async () => {
  const context = contextFixture()
  const metrics = await execute('sanguo-media-metrics', context)
  assert.equal(metrics.durationPlan.requestedDuration, 9)
  assert.equal(metrics.speech[0].allowedSpan, 5.5)
  assert.equal(metrics.speech[0].timingAssessment, 'within-allowance')
  assert.equal(metrics.tailTiming.minSeconds, .5)
  assert.equal(metrics.audioReviewRequired.length, 1)
  Object.assign(context.video_evidence.speechMetrics[0], { actualEnd: 4.99, matchedEnd: 4.99, elapsed: 4.62,
    timingReliable: false, boundaryStatus: 'uncertain', lastTokenMatched: false, utteranceCandidateEnd: 5.53 })
  const uncertain = await execute('sanguo-media-metrics', context)
  assert.equal(uncertain.speech[0].timingAssessment, 'uncertain')
  assert.equal(uncertain.speech[0].utteranceCandidateEnd, 5.53)
})

test('serialized gate refuses a mismatched generation hash or another material before acceptance', async () => {
  for (const mutate of [(context: Value) => { context.video_take.params.scheduleHash = 'wrong-schedule' },
    (context: Value) => { context.video_evidence.originalUrl = 'https://media.example.test/other.mp4' }]) {
    const context = contextFixture(); mutate(context)
    const result = await execute('sanguo-media-accept', context)
    assert.match(result.routeError, /DURATION_CONTRACT_INVALID/)
    assert.notEqual(result.passed, true)
    assert.equal(result.samplingRetryPlan, undefined)
  }
})

test('a frame-bound core event contradiction takes precedence over uncertain duration evidence', async () => {
  const context = contextFixture(), quote = '军士先完成绑缚，随后张飞上前'
  context.shot_script.videoPrompt = quote + '；保持原有三句旁白。'
  context.media_review = { ...context.media_review, version: 'principle-review-v1', decision: 'revise', issues: [{
    code: 'core_event_contradiction', problem: '依赖动作被提前执行', repair: '修正动作先后顺序',
    evidence: { source: 'frame', path: 'videoPrompt', quote, frameIndices: [60, 70, 80],
      finding: '第60帧人物已上前，第80帧绑缚才完成。' },
  }] }
  context.media_review.durationCompletion.checks[0].status = 'uncertain'
  context.media_review.durationCompletion.checks[0].reason = '无法确认本节拍完成时刻。'
  const before = structuredClone(context)
  const accept = (input: Value) => executeCodeNode({ code: PRINCIPLE_MEDIA_RUNTIME_CODE + '\n' + durationMediaAcceptCode,
    context: input, params: { qualityDisposition: 'manual-review-v1' } }) as Promise<Value>
  const result = await accept(context)
  assert.equal(result.durationCompletion.assessment, 'incomplete')
  assert.equal(result.passed, false, 'confirmed conflict routes to a bounded repair')
  assert.equal(result.manualDecisionRequired, false)
  assert.equal(result.qualityReview.manualDecisionRequired, true)
  assert.equal(result.qualityReview.principleIssues[0].code, 'core_event_contradiction')
  assert.equal(result.qualityReview.principleIssues[0].evidence.quote, quote)
  assert.match(result.routeError, /DURATION_REPLAN_REQUIRED/)
  assert.equal(result.samplingRetryPlan, undefined)
  assert.deepEqual(context, before, 'the paid take and signed review are preserved')
  const afterRetake = structuredClone(context)
  afterRetake.durationRepair = { previousCandidate: { id: afterRetake.shot_script.id },
    sourceVideo: 'https://media.example.test/prior-take.mp4', issues: [{ code: 'core_event_contradiction' }] }
  const advisory = await accept(afterRetake)
  assert.equal(advisory.passed, true, 'a second contradictory take remains available for human review')
  assert.equal(advisory.qualityReview.status, 'needs_attention')
  assert.equal(advisory.durationCompletion.assessment, 'incomplete')
  assert.equal(advisory.durationCompletion.route, 'manual-review')
  assert.equal(advisory.qualityRisks.at(-1).code, 'core_event_contradiction')
  assert.equal(advisory.qualityRisks.at(-1).disposition, 'human_review_after_retake')
  assert.equal(advisory.routeError, undefined)
  for (const mutate of [
    (input: Value) => { input.media_review.issues[0].evidence.quote = '未批准的动作顺序' },
    (input: Value) => { input.media_review.issues[0].evidence.frameIndices = [999] },
    (input: Value) => { input.media_review.decision = 'uncertain' },
  ]) {
    const weak = structuredClone(context); mutate(weak)
    const uncertain = await accept(weak)
    assert.equal(uncertain.manualDecisionRequired, false)
    assert.equal(uncertain.durationCompletion.assessment, 'uncertain')
    assert.equal(uncertain.passed, true)
    assert.ok(uncertain.qualityRisks.some((risk: Value) => risk.code === 'duration_completion_unverified'))
  }
})

test('resumed video acceptance refreshes only a pending managed gate', () => {
  const current = { id: 'sanguo-media-accept', kind: 'code', prompt: '', params: [],
    code: 'core_event_contradiction_after_retake' }
  const old = { ...current, code: 'old acceptance code' }
  const runs = [{ node: old, status: 'idle' }, { node: old, status: 'success' }]
  const refreshed = refreshPendingDurationMediaAcceptRuns({ nodes: [current] }, runs)
  assert.equal(refreshed[0].node.code, current.code)
  assert.equal(refreshed[1].node.code, old.code)
})

test('unknown group audio stops for same-media listening and never enters automatic paid regeneration', async () => {
  const context = contextFixture(); context.video_evidence.audioObservations = []
  const result = await execute('sanguo-media-accept', context)
  assert.equal(result.passed, false)
  assert.match(result.routeError, /DURATION_AUDIO_REVIEW_REQUIRED/)
  assert.equal(result.durationCompletion.assessment, 'uncertain')
  assert.equal(result.audioReviewRequest.sourceUrl, context.video_evidence.url)
  assert.equal(result.samplingRetryPlan, undefined)
  assert.equal((await execute('sanguo-duration-replan', { ...context, video_shot: result, branch: { counts: { false: 0 } } })).value, true)
  await assert.rejects(() => execute('sanguo-media-accept-error-branch', { ...context, video_shot: result, branch: { counts: { false: 0 } } }), /DURATION_AUDIO_REVIEW_REQUIRED/)
})

test('manual review carries exhausted uncertain duration as explicit risk after keeping the paid video', async () => {
  const context = contextFixture()
  context.video_evidence.nativeSequence = {}
  context.media_review.durationCompletion.checks[0].status = 'uncertain'
  const before = structuredClone(context)
  const result = await executeCodeNode({ code: PRINCIPLE_MEDIA_RUNTIME_CODE + '\n' + durationMediaAcceptCode,
    context, params: { qualityDisposition: 'manual-review-v1' } }) as Value
  assert.equal(result.passed, true)
  assert.equal(result.routeError, undefined)
  assert.equal(result.manualDecisionRequired, false)
  assert.equal(result.qualityReview.canProceed, true)
  assert.equal(result.durationCompletion.assessment, 'uncertain')
  assert.ok(result.qualityRisks.some((risk: Value) => risk.code === 'duration_completion_unverified'))
  assert.equal(result.url, context.video_evidence.url)
  assert.deepEqual(context, before)
})

test('schema 187 refresh changes only the pending duration recovery block', () => {
  const start = durationMediaAcceptCode.indexOf('const recovery=(function durationCompletionRecovery(')
  const end = durationMediaAcceptCode.indexOf('return recovery;', start) + 'return recovery;'.length
  const old = durationMediaAcceptCode.slice(0, start)
    + `return (${durationCompletionRecovery.toString()})(context,completion,params);`
    + durationMediaAcceptCode.slice(end)
  const source = { id: 'wf-sanguo-history-drama', schemaVersion: 187,
    nodes: [{ id: 'sanguo-media-accept', code: `// PRINCIPLE_POLICY_START\n${old}\n// PRINCIPLE_POLICY_END\nreturn {legacy:true};` },
      { id: 'other', code: 'return 1;' }] }
  const before = structuredClone(source), result = upgradeDurationAdvisoryWorkflow(source)
  assert.equal(result.schemaVersion, 188)
  assert.match(result.nodes[0].code, /qualityRisks/)
  assert.ok(result.nodes[0].code.endsWith('return {legacy:true};'))
  assert.strictEqual(result.nodes[1], source.nodes[1])
  assert.deepEqual(source, before)
  assert.strictEqual(upgradeDurationAdvisoryWorkflow(result), result)
})

test('uncertain visual completion preserves existing samples and the same source URL for one native review', async () => {
  const context = contextFixture(), evidence = context.video_evidence
  delete evidence.nativeSequence; delete evidence.frameReferences
  evidence.frameTimes = [0, .8, 6.3, 8.1, 9]; evidence.frames = evidence.frameTimes.map((_: number, i: number) => '/generated/sparse-' + i + '.jpg')
  const result = await execute('sanguo-media-accept', context)
  assert.equal(result.passed, false)
  assert.match(result.routeError, /REVIEW_RESULT_INVALID/)
  assert.equal(result.samplingRetryPlan.sourceUrl, context.video_take.url)
  assert.deepEqual(result.samplingRetryPlan.sampleTimes, evidence.frameTimes)
  assert.equal(result.samplingRetryPlan.nativeSequence.enabled, true)
  assert.equal(result.samplingRetryPlan.nativeSequence.reviewMaxFrames, 256)
  assert.ok(result.samplingRetryPlan.nativeSequence.windows.every((window: Value) => window.start >= 0 && window.end <= evidence.duration))
  const exhausted = await executeCodeNode({ code: `return (${durationCompletionRecovery.toString()})(context,context.completion,params);`,
    context: { ...context, completion: result.durationCompletion, mediaSamplingRetry: { sourceUrl: context.video_take.url, round: 2 } }, params: { maxAdaptiveSamplingRounds: 2 } }) as Value
  assert.match(exhausted.routeError, /DURATION_EVIDENCE_EXHAUSTED/)
  assert.equal(exhausted.samplingRetryPlan, undefined)
})

test('confirmed actual truncation returns to replanning with a bounded branch and preserved failed material', async () => {
  const context = contextFixture(), row = context.media_review.durationCompletion.checks[2]
  Object.assign(row, { status: 'incomplete', observedEnd: point(9), defect: { kind: 'truncated', modality: 'visual', reason: '合成测试末帧显示群众点头过程尚未收束。' } })
  row.visual.frameIndices = Array.from({ length: 28 }, (_, i) => 63 + i)
  row.visual.observedChange = '群众低头后尚在抬头，实际末帧中动作仍在进行。'
  const result = await execute('sanguo-media-accept', context)
  assert.equal(result.durationCompletion.assessment, 'incomplete', JSON.stringify(result.durationCompletion))
  assert.match(result.routeError, /DURATION_REPLAN_REQUIRED/)
  assert.equal(result.durationRepair.sourceVideo, context.video_evidence.url)
  assert.equal(result.durationCompletion.minimumAdditionalSeconds, null)
  const next = await execute('sanguo-duration-replan', { ...context, video_shot: result, branch: { counts: { false: 0 } } })
  assert.equal(next.value, false)
  assert.deepEqual(next.contextPatch.durationRepair, result.durationRepair)
  const fifth = await execute('sanguo-duration-replan', { ...context, video_shot: result, branch: { counts: { false: 3 } } })
  assert.equal(fifth.value, false)
  await assert.rejects(() => execute('sanguo-duration-replan', { ...context, video_shot: result, branch: { counts: { false: 4 } } }), /DURATION_REPLAN_LIMIT/)
})

test('legacy v1 takes execute their previous request, metrics and gate code without v2 enforcement', async () => {
  const context = contextFixture()
  context.shot_script.pacing.version = 'dynamic-v1'
  delete context.video_take.params.scheduleHash
  for (const id of ['sanguo-media-request', 'sanguo-media-metrics', 'sanguo-media-accept']) {
    const legacy = await execute(id, context, {}, previous)
    const current = await execute(id, context)
    assert.deepEqual(current, legacy, id)
  }
})

test('runtime serialization rejects ambiguous dependency declarations instead of emitting broken persistent code', () => {
  const consumer = { toString: () => 'function consumer() { return 1 }' }
  assert.throws(() => serializeRuntimeFunction(consumer, [{ dependency: { name: '', toString: consumer.toString } }]), /WORKFLOW_RUNTIME_BINDING_INVALID/)
  const dependency = { name: 'same', toString: () => 'function same() { return 1 }' }
  assert.throws(() => serializeRuntimeFunction(consumer, [{ dependency }, { dependency }]), /WORKFLOW_RUNTIME_BINDING_INVALID/)
})

async function completeGateContext(): Promise<Value> {
  const context = contextFixture(), shot = context.shot_script, evidence = context.video_evidence
  shot.worldState = { settingId: 'street', characters: [] }
  context.media_request = await execute('sanguo-media-request', context)
  context.media_metrics = await execute('sanguo-media-metrics', context)
  const inputs: Value[] = context.media_metrics.requirementReviewInputs
  context.media_requirement_reviews = { items: inputs.map(input => ({ requirementId: input.requirement.id, status: 'complete',
    evidence: '合成测试原帧中人物的位置与姿态符合本项要求。', frameIndices: input.attachmentReferences.map((frame: Value) => frame.index) })) }
  Object.assign(context.media_review, { decision: 'accepted', passed: true, issues: [], warnings: [], retryPrompt: '', defectEvidence: [],
    requirementChecks: inputs.map(input => ({ requirementId: input.requirement.id, status: 'complete', evidence: '合成测试原帧支持本项要求。',
      frameIndices: input.frameReferences.map((frame: Value) => frame.index) })),
    evidence: [{ source: 'frame', reference: 90, finding: '合成测试末帧人物自然站立。' }], endCharacters: shot.endCharacters,
    endingState: '传唱歌谣的乡人在围观乡人附近自然站立',
    narrativeClosure: { unitId: shot.storyProgress.unitId, complete: false, actionEvidence: '歌谣唱出。', responseEvidence: '群众回应结束。',
      unresolvedActions: shot.storyProgress.pendingActions, criteriaChecks: shot.completionCriteria.map((criterion: string) => ({ criterion, status: 'complete', evidence: '合成测试声画已完整记录。' })) },
    pacingReview: { passed: true, reason: '歌谣和短促回应完整。', lastMeaningfulActionSecond: 8.1, performanceChecks: [] },
    speechChecks: [{ text: context.media_request.speechWindows[0].text, assessment: 'natural', reason: '合成测试唱词在编译窗口中自然完成。' }],
    tailTimingCheck: { assessment: context.media_metrics.tailTiming.assessment, reason: '合成测试片尾余量正常。' },
    visualChecks: shot.characters.map((character: string) => ({ character, consistent: true, expectedObjects: '空手',
      actualObjectsByFrame: evidence.frames.map((_: string, index: number) => ({ index, objects: '空手' })), evidence: '合成测试原帧人物空手。' })),
    presentCharacters: shot.presentCharacters, presenceChecks: [], worldState: { settingId: 'street', characters: shot.characters.map((name: string) => ({ name,
      position: { status: 'unknown', evidence: '合成测试未量化站位。' }, heldProps: { status: 'unknown', evidence: '合成测试未记录持物。' },
      pendingAction: { status: 'unknown', evidence: '合成测试未约束后续动作。' } })) } })
  context.media_observations = { items: evidence.nativeSequence.preservedSamples.map((row: Value) => ({ index: row.evidenceIndex,
    second: evidence.frameTimes[row.evidenceIndex], setting: '街巷', people: [], tailObservation: '人物自然站立。' })) }
  return context
}

test('production minified migration executes the same complete and uncertain v2 request, metrics and quality gate paths as source', async () => {
  const { build } = await import('vite')
  const result = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: true,
    lib: { entry: new URL('../src/quality-node-presets.ts', import.meta.url).pathname, formats: ['es'] } } })
  const output = Array.isArray(result) ? result[0] : result
  const chunk = output.output.find(item => item.type === 'chunk' && item.isEntry)
  assert.ok(chunk)
  const bundled = await import('data:text/javascript;base64,' + Buffer.from(chunk.code).toString('base64'))
  assert.notEqual(bundled.upgradeDurationQuality.toString(), upgradeDurationQuality.toString(), 'execute the build-transformed migration rather than source functions')
  // Build the legacy body through the minified preset module too. Reusing a
  // source-generated v113 body would conceal its own serialized closure bugs.
  const deployed = bundled.upgradeDurationQuality(priorWorkflow(bundled.upgradeQualityWorkflow)) as typeof migrated
  assert.equal(deployed.schemaVersion, migrated.schemaVersion)
  const context = await completeGateContext()
  const request = await execute('sanguo-media-request', context, {}, deployed)
  assert.deepEqual(request, await execute('sanguo-media-request', context))
  assert.equal(request.scheduleHash, context.shot_script.pacing.scheduleHash)
  assert.deepEqual(request.speechWindows, context.shot_script.pacing.speechWindows)
  const metrics = await execute('sanguo-media-metrics', context, {}, deployed)
  assert.deepEqual(metrics, await execute('sanguo-media-metrics', context))
  assert.equal(metrics.durationPlan.requestedDuration, 9)
  assert.equal(metrics.speech[0].allowedSpan, 5.5)
  const accepted = await execute('sanguo-media-accept', context, {}, deployed)
  assert.equal(accepted.passed, true, JSON.stringify(accepted))
  assert.equal(accepted.durationCompletion.assessment, 'complete')
  assert.equal(accepted.visualReview.independentReviewProvenance.primaryReview.passed, true)
  assert.deepEqual(accepted, await execute('sanguo-media-accept', context))
  const contradictory = structuredClone(context)
  const ending = contradictory.media_requirement_reviews.items.at(-1)
  Object.assign(ending, { status: 'incomplete', evidence: '合成测试末帧人物坐在地上，与自然站立相反。', frameIndices: [0], repair: '只修复尾帧为原文要求的自然站立。',
    defect: { basis: 'visible-state-contradiction', violatedQuote: context.shot_script.lastFramePrompt,
      requiredStateQuote: '自然站立', observedState: '人物坐在地上。', temporalBasis: 'state-at-sample' } })
  const rejected = await execute('sanguo-media-accept', contradictory, {}, deployed)
  assert.equal(rejected.passed, false, JSON.stringify(rejected))
  assert.equal(rejected.visualReview.decision, 'rejected')
  assert.deepEqual(rejected, await execute('sanguo-media-accept', contradictory))
  const visualUnknown = structuredClone(context)
  Object.assign(visualUnknown.media_requirement_reviews.items[1], { status: 'unobservable', evidence: '合成测试帧中人物被遮挡，无法确认动作。', frameIndices: [0] })
  const sampling = await execute('sanguo-media-accept', visualUnknown, {}, deployed)
  assert.match(sampling.routeError, /MEDIA_ADAPTIVE_SAMPLING_LIMIT/)
  assert.equal(sampling.samplingRetryPlan, undefined, 'existing continuous native frames cannot reset the sampling round')
  assert.deepEqual(sampling, await execute('sanguo-media-accept', visualUnknown))
  context.video_evidence.audioObservations = []
  const gate = await execute('sanguo-media-accept', context, {}, deployed)
  assert.deepEqual(gate, await execute('sanguo-media-accept', context))
  assert.equal(gate.durationCompletion.assessment, 'uncertain')
  assert.match(gate.routeError, /DURATION_AUDIO_REVIEW_REQUIRED/)
  assert.equal(gate.audioReviewRequest.sourceUrl, context.video_evidence.url)
  assert.equal(gate.samplingRetryPlan, undefined)
})
