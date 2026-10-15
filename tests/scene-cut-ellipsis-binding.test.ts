import test from 'node:test'
import assert from 'node:assert/strict'
import { approvedSceneCutEllipsis, adjacentSceneCutBridgeIssue } from '../src/history-drama.ts'
import { storyboardContinuityContext } from '../src/storyboard-runtime.ts'

type Value = Record<string, unknown>
const interval = (second: number) => ({ lower: second, upper: second })

function originalStyleBoundary() {
  const first = { id: 'scene-01', dramaticUnitId: 'drama-01', dramaticSceneId: 'drama-01',
    visualTreatment: 'live_action', continuityMode: 'scene_cut', continuityFromPrevious: false,
    closesUnit: true, cast: ['张飞', '严颜'], requiredBeats: [{ id: 'beat-01', setting: '街口',
      observable: { visual: ['军士将严颜双腕缚紧，张飞走到严颜面前'], audio: [] } }] }
  const second = { id: 'scene-02', dramaticUnitId: 'drama-02', dramaticSceneId: 'drama-02',
    visualTreatment: 'live_action', continuityMode: 'scene_cut', continuityFromPrevious: false,
    closesUnit: false, cast: ['张飞', '严颜'],
    adaptationBoundary: '由街口直接切至问讯，束缚和衣甲保持连续，不增拍无叙事增量的押送。',
    requiredBeats: [{ id: 'beat-02', setting: '院落',
      observable: { visual: ['严颜双腕被缚站在院落，张飞开始问责'], audio: [] } }] }
  return { first, second }
}

function completePriorTake() {
  const lastFrameUrl = '/generated/scene-01-actual-tail.jpg'
  return { shot_script: { id: 'scene-01', storyProgress: { unitId: 'drama-01', status: 'complete', pendingActions: [] },
    pacing: { version: 'duration-v2', scheduleHash: 'schedule-01', beats: [
      { id: 'bind', sourceBeatId: 'beat-01', completion: { requiredThisClip: true } },
    ] } },
  video_shot: { qualityPolicy: 'principle-v1', qualityReview: { status: 'needs_attention', canProceed: true,
    principleIssues: [], warnings: [] }, url: '/generated/scene-01-accepted.mp4',
    originalUrl: 'https://provider.example/scene-01.mp4',
    raw: { url: 'https://provider.example/scene-01.mp4', params: { scheduleHash: 'schedule-01' } },
    duration: 13, decoded: true, evidenceUrl: '/generated/scene-01-evidence.json',
    frames: ['/generated/scene-01-frame-0.jpg', lastFrameUrl], lastFrameUrl,
    hasAudio: true, audioEmbedded: true, technicalValidation: { passed: true },
    durationCompletion: { applicable: true, assessment: 'complete', route: 'accept', passed: true, reasons: [],
      scheduleHash: 'schedule-01', evidenceRef: '/generated/scene-01-evidence.json',
      checks: [{ beatId: 'bind', sourceBeatId: 'beat-01', status: 'complete', reasons: [],
        observedStart: interval(2), observedEnd: interval(7) }],
      remainingMandatoryBeats: [], actualCompletionInterval: interval(7), requiredEndSecond: 7.5 } },
  last_frame: { available: true, url: lastFrameUrl } }
}

function context() {
  const { first, second } = originalStyleBoundary()
  return { scene: { ...second, sourceSceneId: second.id },
    approved_scene_outline: { scenes: [first, second] },
    scene_outline: { scenes: structuredClone([first, second]) },
    loop: { previous: completePriorTake() } } as Value
}

test('an original-style approved ellipsis is conditional on the accepted adjacent scene pair', () => {
  const { first, second } = originalStyleBoundary()
  assert.match(adjacentSceneCutBridgeIssue(first, second, { allowApprovedEllipsis: false })!, /迁移承接/)
  assert.deepEqual(approvedSceneCutEllipsis(first, second), {
    version: 'scene-cut-approved-ellipsis-v1', previousSceneId: 'scene-01',
    currentSceneId: 'scene-02', previousUnitId: 'drama-01', currentUnitId: 'drama-02',
    sharedCast: ['张飞', '严颜'],
  })
})

test('scene cut cannot use a mutable scene_outline as a replacement for the accepted outline', () => {
  const value = context()
  delete value.approved_scene_outline
  assert.throws(() => storyboardContinuityContext(value), /STORYBOARD_.*(?:OUTLINE|ELLIPSIS|BRIDGE|APPROVED|CONTINUITY)/)
})

test('scene cut cannot skip adjacency validation with an unmatched sourceSceneId', () => {
  const value = context()
  value.scene = { ...(value.scene as Value), sourceSceneId: 'scene-that-was-not-approved' }
  assert.throws(() => storyboardContinuityContext(value), /STORYBOARD_.*(?:OUTLINE|ELLIPSIS|BRIDGE|APPROVED|CONTINUITY)/)
})

test('scene cut cannot substitute a repaired/expanded scene for the accepted ellipsis text', () => {
  const value = context()
  const current = (value.scene_outline as { scenes: Value[] }).scenes[1]
  current.adaptationBoundary = '由街口直接切至问讯，束缚和衣甲保持连续；新增拍摄押送。'
  assert.throws(() => storyboardContinuityContext(value), /STORYBOARD_.*(?:OUTLINE|ELLIPSIS|BRIDGE|APPROVED|CONTINUITY)/)
})

test('scene cut cannot bind its approval to a different preceding accepted shot', () => {
  const value = context()
  const prior = (value.loop as Value).previous as Value
  prior.shot_script = { ...(prior.shot_script as Value), id: 'another-scene-01' }
  assert.throws(() => storyboardContinuityContext(value), /STORYBOARD_.*(?:OUTLINE|ELLIPSIS|BRIDGE|APPROVED|CONTINUITY)/)
})
