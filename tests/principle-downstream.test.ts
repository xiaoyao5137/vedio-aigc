import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'
import { cinematicContinuityIssue, principleTailWorldState } from '../src/history-cinema.ts'
import { storyboardContinuityContext, historicalContinuityIssue } from '../src/storyboard-runtime.ts'
import { validateDramaOutline } from '../src/history-drama.ts'
import { compileDurationSchedule } from '../src/duration-schedule.ts'
import { chantShot } from './fixtures/duration-v2-chant.ts'

type Value = Record<string, unknown>
const unknown = () => ({ status: 'unknown' })
const world = (cast: string[], settingId = 'courtyard') => ({ settingId,
  characters: cast.map(name => ({ name, position: unknown(), heldProps: unknown(), pendingAction: unknown() })) })
const policy = (status = 'needs_attention') => ({ qualityPolicy: 'principle-v1',
  qualityReview: { status, canProceed: status !== 'rejected', principleIssues: status === 'rejected' ? [{ problem: '有实际证据的主体错误' }] : [],
    warnings: status === 'passed' ? [] : ['局部动作证据不足，保留未知'], rawReport: { decision: 'uncertain', passed: false } } })
const cast = ['周家宾客', '房家宾客']
const previous = { id: 's1', contentContractVersion: 'cinematic-v1', characters: cast, presentCharacters: cast,
  initialCharacters: cast, endCharacters: cast, duration: 7, worldState: world(cast),
  lastFramePrompt: '两人按计划在院门边站定', audioText: '一句歌谣便能断人高下？', storyProgress: { unitId: 'u1', status: 'continuing' } }
function media(id = 's1', duration = 7): Value {
  const lastFrameUrl = `/generated/verified-${id}-frame-5.jpg`
  return { ...policy(), url: `/generated/verified-${id}.mp4`, originalUrl: `https://provider.example/${id}.mp4`,
    raw: { url: `https://provider.example/${id}.mp4`, params: {} }, duration, decoded: true, evidenceUrl: `/generated/${id}.json`,
    frames: [`/generated/verified-${id}-frame-0.jpg`, lastFrameUrl], lastFrameUrl,
    hasAudio: true, audioEmbedded: true, technicalValidation: { passed: true, speechVerified: false },
    visualReview: { decision: 'uncertain', passed: false, warnings: ['尾帧人物状态无法确认'] } }
}
const pool = { query: async () => ({ rows: [] }) } as never
const verify = (params: Value) => executeBuiltinNode(pool, { operation: 'history.verify', params }) as Promise<Value>

test('principle needs_attention and unavailable keep actual tail continuity without fabricating observed details', () => {
  for (const status of ['needs_attention', 'unavailable']) {
    const video = { ...media(), ...policy(status) }
    const context = { scene: { dramaticUnitId: 'u1', continuityFromPrevious: true }, loop: { previous: {
      shot_script: previous, video_shot: video, last_frame: { available: true, url: video.lastFrameUrl },
    } } }
    const before = structuredClone(context)
    const result = storyboardContinuityContext(context) as typeof context
    assert.deepEqual(context, before)
    assert.deepEqual(result.loop.previous.video_shot.visualReview, video.visualReview)
    assert.deepEqual(result.loop.previous.shot_script.worldState, world(cast))
    assert.doesNotMatch(result.loop.previous.shot_script.lastFramePrompt, /按计划在院门边站定/)
    assert.match(result.loop.previous.shot_script.videoPrompt, /不代表每项动作或人声已实测通过/)
    const current = { ...previous, id: 's2', firstFrameMode: 'reference', enteringCharacters: [],
      continuity: { mode: 'coverage_cut', previousShotId: 's1', bridgeType: 'cut', bridgeAnchor: '对手继续回应' } }
    assert.equal(cinematicContinuityIssue(current, previous, video), undefined)
    const tail = { ...current, firstFrameMode: 'reuse_previous_tail', continuity: { ...current.continuity, mode: 'tail_continuation' } }
    assert.equal(historicalContinuityIssue(tail, { params: { referenceImage: video.lastFrameUrl } }, previous, video), undefined)
    assert.match(historicalContinuityIssue(tail, { params: { referenceImage: '/generated/other.jpg' } }, previous, video)!, /未绑定/)
  }
})

test('actorless tableau after a character illustration is projected to a fresh reference cut', () => {
  const prior = { ...previous, visualTreatment: 'animated', animationStyle: 'character_illustration' }
  const video = media()
  const context = { scene: { id: 'scene-02', editorialRole: 'episode_opening', visualTreatment: 'animated',
    animationStyle: 'historical_tableau', cast: [], dramaticUnitId: 'u1', settingId: 'courtyard',
    continuityFromPrevious: true, continuityMode: 'tail_continuation' }, loop: { previous: {
    shot_script: prior, video_shot: video, last_frame: { available: true, url: video.lastFrameUrl },
  } } }
  const result = storyboardContinuityContext(context) as typeof context
  assert.equal(result.scene.continuityMode, 'coverage_cut')
  assert.equal(result.loop.previous.actualTailEvidence.url, video.lastFrameUrl)
  assert.deepEqual(context.scene.continuityMode, 'tail_continuation', 'the approved execution snapshot remains immutable')
})

test('principle continuity rejects decisions and missing or foreign media even when passed routing flag is true', () => {
  const good = media()
  for (const override of [
    policy('rejected'), { qualityReview: { ...policy().qualityReview, canProceed: false } },
    { decoded: false }, { url: '' }, { evidenceUrl: '' }, { audioEmbedded: false },
    { lastFrameUrl: '/generated/planned.jpg' }, { frames: [] }, { originalUrl: 'https://provider.example/foreign.mp4' },
  ]) {
    const video = { ...good, passed: true, ...override }
    assert.throws(() => storyboardContinuityContext({ scene: { continuityFromPrevious: true }, loop: { previous: {
      shot_script: previous, video_shot: video, last_frame: { available: true, url: video.lastFrameUrl },
    } } }), /CONTINUITY_EVIDENCE_MISSING/)
    assert.ok(cinematicContinuityIssue({ ...previous, continuity: { mode: 'coverage_cut' } }, previous, video))
  }
  assert.throws(() => storyboardContinuityContext({ scene: { dramaticUnitId: 'different', continuityFromPrevious: false }, loop: { previous: {
    shot_script: previous, video_shot: good,
  } } }), /NARRATIVE_INCOMPLETE/)
})

test('principle world state preserves frame-bound observations and uncertainty, never borrowing planned observed states', () => {
  const video = media()
  const state = world(cast) as { settingId: string; characters: Value[] }
  state.characters[0].position = { status: 'observed', value: '院门内侧', evidence: '真实尾帧看见院门与人物相邻' }
  const measured = { ...video, visualReview: { passed: false, worldState: state, endCharacters: [cast[0]],
    endingStateEvidence: { method: 'actual-tail-image', frame: video.lastFrameUrl } } }
  assert.deepEqual(principleTailWorldState(previous, measured), state)
  assert.deepEqual(principleTailWorldState({ ...previous, worldState: state }, video), world(cast))
  const current = { ...previous, id: 's2', firstFrameMode: 'reference', worldState: state,
    continuity: { mode: 'coverage_cut', previousShotId: previous.id, bridgeType: 'cut', bridgeAnchor: '回应' } }
  assert.equal(cinematicContinuityIssue(current, previous, measured), undefined)
  assert.match(cinematicContinuityIssue(current, previous, video)!, /冒充已观察/)
})

function publicationFixture() {
  const approved = validateDramaOutline(JSON.parse(readFileSync(new URL('./fixtures/cinematic-drama-outline.json', import.meta.url), 'utf8'))) as Value
  const scenes = approved.scenes as Value[]
  scenes[1].continuityMode = 'coverage_cut'
  const shots = scenes.map((scene, index) => {
    const sceneCast = scene.cast as string[], beats = scene.requiredBeats as Value[]
    return { ...policy(), id: scene.id, contentContractVersion: 'cinematic-v1', dramaticSceneId: scene.dramaticSceneId,
      duration: scene.targetDuration, characters: sceneCast, initialCharacters: sceneCast, endCharacters: sceneCast, presentCharacters: sceneCast,
      worldState: world(sceneCast, String(scene.dramaticSceneId)), firstFrameMode: 'reference',
      continuity: { mode: scene.continuityMode, bridgeType: index ? 'cut' : 'opening', previousShotId: index ? scenes[index - 1].id : '', bridgeAnchor: '对手回应后的选择' },
      historicalBasis: scene.historicalBasis, adaptationBoundary: scene.adaptationBoundary, pacing: { version: 'dynamic-v1' },
      storyProgress: { unitId: scene.dramaticSceneId, status: scene.closesUnit ? 'complete' : 'continuing' }, completionCriteria: scene.completionCriteria,
      audioType: index === 2 ? '环境声' : '旁白', audioText: beats.flatMap(beat => (beat.observable as Value).audio).join('。'),
      videoPrompt: beats.flatMap(beat => (beat.observable as Value).visual).join('。'), lastFramePrompt: '批准的计划尾帧',
      coveredBeatIds: beats.map(beat => beat.id), shotIntent: { viewpointCharacter: sceneCast[0], purpose: scene.purpose, cameraReason: '观察人物选择' },
      beatDramaturgy: beats.map(beat => ({ beatId: beat.id, function: beat.function, stateChange: beat.stateChange, ...(beat.observable as Value) })) }
  })
  const outline = { ...approved, ...policy(), count: 4, totalDuration: 28 }
  return { citations: [{ title: '后汉书', content: '宾客互相讥评' }], expectedSceneCount: 4, requireQualityEvidence: true,
    approvedSceneOutline: outline, sceneOutline: outline, shots, videos: shots.map(shot => media(String(shot.id), Number(shot.duration))) }
}

test('principle publication and timeline allow needs_attention with honest scopes and retained reports', async () => {
  const params = publicationFixture(), before = structuredClone(params)
  const result = await verify(params)
  assert.equal(result.passed, true, JSON.stringify(result.violations))
  assert.deepEqual(params, before)
  assert.equal((result.qualityReview as Value).status, 'needs_attention')
  assert.deepEqual(result.reviewSummary, { scriptFacts: 'not-reviewed', scriptDramaturgy: 'not-reviewed', segmentMedia: 'needs_attention',
    reviewScope: 'principle-policy', detailedQuality: 'not-certified', episodePlayback: 'not-reviewed', fullVideoWatched: false })
  const timeline = await executeBuiltinNode(pool, { operation: 'timeline.compose', params: {
    storyboards: params.shots, videos: params.videos, historicalVerification: result,
  } }) as Value
  assert.deepEqual(timeline.qualityReview, result.qualityReview)
  assert.deepEqual(timeline.episodePlayback, { status: 'not-reviewed', fullVideoWatched: false })
  const replaced = structuredClone(params.videos)
  replaced[0].originalUrl = 'https://provider.example/foreign.mp4'
  await assert.rejects(() => executeBuiltinNode(pool, { operation: 'timeline.compose', params: {
    storyboards: params.shots, videos: replaced, historicalVerification: result,
  } }), /来源资产未绑定/)
})

test('principle publication rejects failed principles or missing actual assets while strict mode stays opt-in', async () => {
  for (const target of ['approvedSceneOutline', 'shots', 'videos']) {
    const params = publicationFixture()
    Object.assign(target === 'approvedSceneOutline' ? params.approvedSceneOutline : target === 'shots' ? params.shots[0] : params.videos[0], policy('rejected'))
    assert.equal((await verify(params)).passed, false, target)
  }
  for (const override of [{ decoded: false }, { lastFrameUrl: '' }, { evidenceUrl: '' }, { originalUrl: 'foreign.mp4' }]) {
    const params = publicationFixture()
    Object.assign(params.videos[0], override)
    assert.equal((await verify(params)).passed, false, JSON.stringify(override))
  }
  const strict = publicationFixture()
  delete strict.videos[0].qualityPolicy
  assert.equal((await verify(strict)).passed, false)
})

test('valid duration-v2 publication passes version verification while altered schedules and source binding fail', async () => {
  const candidate = chantShot(), compiled = compileDurationSchedule(candidate)
  const shot = { ...candidate, ...compiled, ...policy(), storyProgress: { unitId: 'u1', status: 'complete' } }
  const video = { ...media(shot.id, shot.duration), raw: { url: `https://provider.example/${shot.id}.mp4`, params: { scheduleHash: compiled.scheduleHash } } }
  const params = { citations: [{}], shots: [shot], videos: [video], requireQualityEvidence: true }
  const accepted = await verify(params)
  assert.equal(accepted.passed, true, JSON.stringify(accepted.violations))
  const altered = structuredClone(params)
  altered.shots[0].pacing.beats[0].textOrVocalization += '额外动作'
  assert.equal((await verify(altered)).passed, false)
  const foreign = structuredClone(params)
  foreign.videos[0].raw.params.scheduleHash = 'old-schedule'
  assert.equal((await verify(foreign)).passed, false)
})

test('manual publication and timeline retain semantic warnings and uncertain audio without automatic retakes', async () => {
  const fixture = publicationFixture()
  const params = { ...fixture, qualityDisposition: 'manual-review-v1' }
  params.shots[0].historicalBasis = ''
  params.videos.forEach(video => Object.assign(video, { qualityDisposition: 'manual-review-v1', width: 1280, height: 720,
    hasAudio: false, audioEmbedded: false, technicalValidation: { passed: false, speechVerified: false },
    qualityReview: { status: 'needs_attention', canProceed: true, principleIssues: [{ detail: '人物或台词需要用户验收' }], warnings: [] } }))
  const before = structuredClone(params)
  const result = await verify(params)
  assert.equal(result.passed, true, JSON.stringify(result.violations))
  assert.equal((result.qualityReview as Value).canProceed, true)
  assert.equal((result.qualityReview as Value).status, 'needs_attention')
  assert.equal(result.manualReviewRequired, true)
  assert.ok((result.violations as unknown[]).length > 0)
  assert.equal((result.reviewSummary as Value).detailedQuality, 'not-certified')
  assert.deepEqual(params, before)
  const timeline = await executeBuiltinNode(pool, { operation: 'timeline.compose', params: {
    qualityDisposition: 'manual-review-v1', storyboards: params.shots, videos: params.videos, historicalVerification: result,
  } }) as Value
  assert.equal(timeline.qualityDisposition, 'manual-review-v1')
  assert.equal(timeline.manualReviewRequired, true)
  for (const override of [{ decoded: false }, { lastFrameUrl: '' }, { originalUrl: 'foreign.mp4' }, { duration: 0 }]) {
    const broken = structuredClone(params)
    Object.assign(broken.videos[0], override)
    assert.equal((await verify(broken)).passed, false, JSON.stringify(override))
  }
  assert.equal((await verify({ ...params, videos: [] })).passed, false)
})
