import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { principleDurationTransitionIssue } from '../src/history-cinema.ts'
import { adjacentSceneCutBridgeIssue } from '../src/history-drama.ts'
import { storyboardContinuityContext } from '../src/storyboard-runtime.ts'

type Value = Record<string, unknown>
const range = (second: number) => ({ lower: second, upper: second })

function priorTake() {
  const shot: Value = { id: 'shot-01', storyProgress: { unitId: 'drama-01', status: 'complete', pendingActions: [] },
    pacing: { version: 'duration-v2', scheduleHash: 'schedule-01', beats: [
      { id: 'bind', sourceBeatId: 'source-bind', completion: { requiredThisClip: true } },
      { id: 'question', sourceBeatId: 'source-question', completion: { requiredThisClip: true } },
      { id: 'later', sourceBeatId: 'source-later', completion: { requiredThisClip: false } },
    ] } }
  const lastFrameUrl = '/generated/verified-shot-01-frame-5.jpg'
  const video: Value = { qualityPolicy: 'principle-v1', qualityReview: { status: 'needs_attention', canProceed: true,
    principleIssues: [], warnings: ['action_timing_overlap'] },
    url: '/generated/verified-shot-01.mp4', originalUrl: 'https://provider.example/shot-01.mp4',
    raw: { url: 'https://provider.example/shot-01.mp4', params: { scheduleHash: 'schedule-01' } },
    duration: 13, decoded: true, evidenceUrl: '/generated/shot-01-evidence.json',
    frames: ['/generated/verified-shot-01-frame-0.jpg', lastFrameUrl], lastFrameUrl,
    hasAudio: true, audioEmbedded: true, technicalValidation: { passed: true },
    visualReview: { warnings: ['action_timing_overlap'], endingState: '两人面对面站定' },
    durationCompletion: { applicable: true, assessment: 'complete', route: 'accept', passed: true, reasons: [],
      scheduleHash: 'schedule-01', evidenceRef: '/generated/shot-01-evidence.json',
      checks: [
        { beatId: 'bind', sourceBeatId: 'source-bind', status: 'complete', reasons: [], observedStart: range(2), observedEnd: range(7) },
        { beatId: 'question', sourceBeatId: 'source-question', status: 'complete', reasons: [], observedStart: range(8), observedEnd: range(11) },
      ], remainingMandatoryBeats: [], actualCompletionInterval: range(11), requiredEndSecond: 11.5 } }
  const scene = { id: 'scene-02', dramaticUnitId: 'drama-02', continuityFromPrevious: false, continuityMode: 'scene_cut' }
  const context = { scene, approved_scene_outline: { scenes: [
    { id: 'shot-01', visualTreatment: 'live_action' }, scene,
  ] }, loop: { previous: { shot_script: shot, video_shot: video } } }
  return { shot, video, scene, context }
}

test('a complete and evidence-bound duration-v2 take permits a legitimate hard cut without tail reuse', () => {
  const { shot, video, context } = priorTake()
  assert.equal(principleDurationTransitionIssue(shot, video), undefined)
  assert.deepEqual(storyboardContinuityContext(context), context, 'new scene retains its independent reference opening')
})

test('planned completion, a real still and permissive review cannot release a new unit without measured beat closure', () => {
  for (const mutate of [
    (video: Value) => { delete video.durationCompletion },
    (video: Value) => { (video.durationCompletion as Value).assessment = 'uncertain' },
    (video: Value) => { (video.durationCompletion as Value).passed = false },
    (video: Value) => { (video.durationCompletion as Value).scheduleHash = 'old-schedule' },
    (video: Value) => { (video.durationCompletion as Value).evidenceRef = '/generated/old-take.json' },
    (video: Value) => { ((video.durationCompletion as Value).checks as Value[]).pop() },
    (video: Value) => { (((video.durationCompletion as Value).checks as Value[])[0]).status = 'uncertain' },
    (video: Value) => { ((video.durationCompletion as Value).remainingMandatoryBeats as string[]).push('bind') },
    (video: Value) => { (video.durationCompletion as Value).requiredEndSecond = 13.5 },
  ]) {
    const fixture = priorTake()
    mutate(fixture.video)
    assert.ok(principleDurationTransitionIssue(fixture.shot, fixture.video))
    assert.throws(() => storyboardContinuityContext(fixture.context), /STORYBOARD_NARRATIVE_INCOMPLETE/)
  }
})

test('an accepted manual duration risk reaches the next shot as an unknown state', () => {
  const fixture = priorTake()
  fixture.context.qualityDisposition = 'manual-review-v1'
  fixture.video.qualityDisposition = 'manual-review-v1'
  fixture.video.passed = true
  fixture.video.width = 1920
  fixture.video.height = 1080
  const completion = fixture.video.durationCompletion as Value
  completion.assessment = 'uncertain'
  completion.passed = false
  completion.route = 'same-media-evidence'
  fixture.video.qualityRisks = [{ code: 'duration_evidence_limit', evidenceRef: fixture.video.evidenceUrl }]
  const projected = storyboardContinuityContext(fixture.context)
  assert.match(String((projected.storyboardQualityWarnings as string[])[0]), /未证实/)
  assert.equal((fixture.video.durationCompletion as Value).passed, false)
  assert.equal(fixture.shot.storyProgress && (fixture.shot.storyProgress as Value).status, 'complete')
})

test('an unfinished previous dramatic unit cannot change unit even under manual review', () => {
  const fixture = priorTake()
  fixture.shot.storyProgress = { unitId: 'drama-01', status: 'continuing', pendingActions: ['问责未结束'] }
  fixture.context.qualityDisposition = 'manual-review-v1'
  assert.throws(() => storyboardContinuityContext(fixture.context), /剧情尚未结束/)
})

test('a duration-v2 scene cut cannot omit dramaticUnitId to bypass the previous take gate', () => {
  const fixture = priorTake()
  delete (fixture.scene as Value).dramaticUnitId
  assert.throws(() => storyboardContinuityContext(fixture.context), /换场缺少已批准 dramaticUnitId/)
})

const beat = (setting: string, visual: string) => ({ id: setting, description: visual, setting, mustShow: [visual],
  observable: { visual: [visual], audio: [] } })
function outlineScenes() {
  const prior = { id: 'scene-01', editorialRole: 'story', visualTreatment: 'live_action', cast: ['守方', '被押者'],
    requiredBeats: [beat('街口', '士卒将被押者双腕缚紧')] }
  const next = { id: 'scene-02', editorialRole: 'story', visualTreatment: 'live_action', continuityMode: 'scene_cut',
    cast: ['守方', '被押者'], purpose: '被押者仍被缚在院中，守方开始问责', requiredBeats: [beat('院落', '被押者仍被缚站在院中')] }
  return { prior, next }
}

test('an invented bridgeAnchor does not excuse an unfilmed location move with retained physical state', () => {
  const { prior, next } = outlineScenes()
  prior.id = 'shot-01'
  Object.assign(next, { dramaticUnitId: 'drama-02', continuityFromPrevious: false })
  assert.match(adjacentSceneCutBridgeIssue(prior, next)!, /迁移承接/)
  const fixture = priorTake()
  fixture.context.approved_scene_outline = { scenes: [prior, next] }
  fixture.context.scene = { ...next, dramaticUnitId: 'drama-02', continuityFromPrevious: false, sourceSceneId: next.id,
    bridgeAnchor: '省略押送' }
  assert.throws(() => storyboardContinuityContext(fixture.context), /STORYBOARD_SCENE_BRIDGE_UNVERIFIED/)
  delete (fixture.context.scene as Value).bridgeAnchor
  next.requiredBeats.unshift(beat('院落', '士卒押送被押者进入院落，众人落位'))
  assert.equal(adjacentSceneCutBridgeIssue(prior, next), undefined, 'an observable transition beat is a valid editorial bridge')
  assert.doesNotThrow(() => storyboardContinuityContext(fixture.context))
  next.requiredBeats.shift()
  prior.requiredBeats.push(beat('街口', '士卒押送被押者离开街口，走入院落'))
  assert.equal(adjacentSceneCutBridgeIssue(prior, next), undefined, 'a transition filmed at the end of the prior scene also counts')
})

test('a captive already presented at a new location still needs a filmed or heard move', () => {
  const { prior, next } = outlineScenes()
  prior.cast = next.cast = ['主将', '俘虏']
  prior.requiredBeats = [beat('城门内侧', '军士拉紧绳索，俘虏双腕绳结闭合')]
  next.requiredBeats = [beat('院落', '俘虏已被军士押在主将面前，主将开始问责')]
  next.purpose = '省略押送路程，俘虏已被军士押在主将面前'
  assert.match(adjacentSceneCutBridgeIssue(prior, next)!, /迁移承接/)
  next.requiredBeats[0].observable.visual = ['俘虏已被军士押在主将面前，不另拍押送路程']
  assert.match(adjacentSceneCutBridgeIssue(prior, next)!, /迁移承接/,
    'a static arrived state inside observable is not the travel process')
  next.requiredBeats[0].observable.visual = ['军士押着俘虏走入院落，经过门槛后停在主将面前']
  assert.equal(adjacentSceneCutBridgeIssue(prior, next), undefined)
})

test('a half step at the former location is not a bridge to the next location', () => {
  const { prior, next } = outlineScenes()
  prior.cast = next.cast = ['张飞', '严颜']
  prior.requiredBeats = [beat('城门内侧', '军士收紧严颜腕上的绳结，严颜被牵得向前半步')]
  prior.requiredBeats[0].observable.visual = ['军士收紧严颜腕上的绳结', '严颜被牵得向前半步，随即站稳']
  next.requiredBeats = [beat('院落', '严颜已被军士押在张飞面前，军士不另拍押送路程')]
  next.purpose = '严颜已被军士押在张飞面前，不另拍押送路程'
  assert.match(adjacentSceneCutBridgeIssue(prior, next)!, /迁移承接/)
  prior.requiredBeats[0].observable.visual = ['军士押送严颜离开城门内侧，脚步走向院落']
  assert.equal(adjacentSceneCutBridgeIssue(prior, next), undefined)
})

test('a relocation must occur at the prior tail or the next opening in approved observable evidence', () => {
  const { prior, next } = outlineScenes()
  prior.requiredBeats.unshift(beat('街口', '士卒押送被押者离开街口'))
  next.requiredBeats.push(beat('院落', '士卒押送被押者进入院落'))
  assert.match(adjacentSceneCutBridgeIssue(prior, next)!, /迁移承接/,
    'a former opening or a later beat cannot repair the actual cut boundary')
  next.purpose = '士卒押送被押者进入院落'
  next.requiredBeats[0].description = '士卒押送被押者进入院落'
  next.requiredBeats[0].mustShow = ['士卒押送被押者进入院落']
  assert.match(adjacentSceneCutBridgeIssue(prior, next)!, /迁移承接/,
    'purpose, description and mustShow do not replace observable sound or picture')
  next.requiredBeats[0].observable.audio = ['押送队伍的脚步声由街口渐近院门，铁链声穿过门洞']
  assert.equal(adjacentSceneCutBridgeIssue(prior, next), undefined, 'audible movement at the opening is a bridge')
})

test('retained held props require the same prop, while an observable next-day jump stays legal', () => {
  const { prior, next } = outlineScenes()
  prior.cast = next.cast = ['使者']
  prior.requiredBeats = [beat('街口', '使者手持令牌停在街口')]
  next.requiredBeats = [beat('院落', '使者握着令牌站在院落')]
  assert.match(adjacentSceneCutBridgeIssue(prior, next)!, /迁移承接/)
  next.requiredBeats[0].observable.visual = ['翌日晨光照进院落，使者握着令牌开始新的议事']
  assert.equal(adjacentSceneCutBridgeIssue(prior, next), undefined)
  next.requiredBeats[0].observable.visual = ['使者握着文书站在院落']
  next.requiredBeats[0].description = '使者握着文书站在院落'
  next.requiredBeats[0].mustShow = ['使者握着文书站在院落']
  assert.equal(adjacentSceneCutBridgeIssue(prior, next), undefined, 'a different object is not retained state')
})

test('different anonymous groups kneeling around one shared actor do not create retained posture', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/crr7s5-cross-stage-outline-candidates.json', import.meta.url), 'utf8'))
  const scenes = fixture.candidates[1].candidate.scenes
  assert.deepEqual(scenes[3].cast, ['张角'])
  assert.deepEqual(scenes[4].cast, ['张角'])
  assert.equal(adjacentSceneCutBridgeIssue(scenes[3], scenes[4]), undefined,
    'the family kneels first and the crowd kneels next; Zhang Jiao does neither')
})

test('a shared observer does not inherit an anonymous holder or an environmental prop', () => {
  const { prior, next } = outlineScenes()
  prior.cast = next.cast = ['见证者']
  prior.requiredBeats = [beat('茅屋外', '家属手持令牌向见证者陈情，门边灯笼亮起')]
  next.requiredBeats = [beat('空地', '百姓手持令牌向见证者陈情，空地灯笼亮起')]
  next.purpose = '另一批百姓另起陈情'
  assert.equal(adjacentSceneCutBridgeIssue(prior, next), undefined)
})

test('independent action and cast do not impose a tail image or relocation beat on a legal cut', () => {
  const { prior, next } = outlineScenes()
  next.cast = ['新来者']
  assert.equal(adjacentSceneCutBridgeIssue(prior, next), undefined)
  next.cast = ['守方', '被押者']
  next.requiredBeats = [beat('院落', '守方望向远方，新场事件开始')]
  next.purpose = '新场事件开始'
  assert.equal(adjacentSceneCutBridgeIssue(prior, next), undefined)
})
