import test from 'node:test'
import assert from 'node:assert/strict'
import { cinematicContinuityIssue, expectedEndPresentCharacters, hasExplicitWorldStateUncertainty, hasValidCinematicWorldFactShape, validateCinematicOpeningReview, validateCinematicPresenceReview, validateCinematicShot, validateCinematicWorldState, validateObservedCinematicWorldState } from '../src/history-cinema.ts'
import { dynamicStoryboardTiming } from '../src/history-pacing.ts'
import { validatePerformanceMediaReview, historicalVideoPrompt } from '../src/history-media.ts'
import { cleanStoryboardForValidation, generateHistoricalStoryboard, historicalContinuityIssue, storyboardContinuityContext, plannedSpeechWindows } from '../src/storyboard-runtime.ts'

const unknown = { status: 'unknown' }
const observed = (value: string) => ({ status: 'observed', value, evidence: '实际尾帧已见' })
const worldState = { settingId: 'courtyard', characters: [
  { name: '周家宾客', position: observed('院门内侧，面向案旁的对手'), heldProps: observed('双手空手'), pendingAction: observed('伸手等待对手回应') },
  { name: '房家宾客', position: observed('案旁，面向院门内侧的对手'), heldProps: observed('右手持拜帖'), pendingAction: unknown },
] }
const previous = { id: 's1', contentContractVersion: 'cinematic-v1', presentCharacters: ['周家宾客', '房家宾客'],
  characters: ['周家宾客', '房家宾客'], endCharacters: ['周家宾客', '房家宾客'],
  worldState, worldStateEvidence: { method: 'actual-tail-image', frame: '/generated/verified-test-frame-5.jpg' },
  audioText: '一句歌谣便能断人高下？', storyProgress: { unitId: 'u1', status: 'continuing', pendingActions: ['听到回应后选择是否继续交谈'] } }
const shot = { ...previous, id: 's2', characters: ['周家宾客'], initialCharacters: ['周家宾客'], endCharacters: ['周家宾客'],
  firstFrameMode: 'reference', continuity: { mode: 'coverage_cut', previousShotId: 's1', bridgeType: 'cut', bridgeAnchor: '看拒绝回答对周家宾客的影响' },
  visualPrompt: '周家宾客近景，院门在身后，视线落向画外案旁对手。', lastFramePrompt: '周家宾客收回招呼，移开视线。', camera: '同轴线反打',
  duration: 3, audioType: '环境声', audioText: '', videoPrompt: '0-1秒：周家宾客收回招呼。1-2.7秒：周家宾客移开视线。2.7-3秒：衣袖自然落下。' }
const url = '/generated/verified-test-frame-5.jpg'
const video = { technicalValidation: { passed: true }, speechValidation: { passed: true }, frames: [url], lastFrameUrl: url,
  visualReview: { passed: true, issues: [], endingState: '周家宾客站在院门内，房家宾客站在案旁，持拜帖。', endCharacters: previous.characters,
    worldState, endingStateEvidence: { method: 'actual-tail-image', frame: url } } }
const scene = { continuityFromPrevious: true, settingId: 'courtyard' }

test('reverse coverage keeps the same life stage and costume while allowing another event-date note', () => {
  const context={version:'character-visual-context-v1',age:{stage:'adult',basis:'artistic',asOf:'本场'},look:{key:'guest-robes',description:'素色长袍'}}
  const prior={...previous,characterVisuals:[{name:'周家宾客',visualContext:context}]}
  const current={...shot,characterVisuals:[{name:'周家宾客',visualContext:{...context,age:{...context.age,asOf:'同场续镜'}}}]}
  assert.doesNotThrow(()=>validateCinematicShot(current,scene,prior))
  for(const changed of [{...context,age:{stage:'elderly',basis:'artistic'}},{...context,look:{key:'court',description:'朝服'}}]) {
    assert.throws(()=>validateCinematicShot({...current,characterVisuals:[{name:'周家宾客',visualContext:changed}]},scene,prior),/不得突变年龄或稳定服装/)
  }
})

test('coverage cut permits a reverse close-up while preserving the offscreen participant', () => {
  assert.doesNotThrow(() => validateCinematicShot(shot, scene, previous))
  assert.equal(cinematicContinuityIssue(shot, previous, video), undefined)
  assert.equal(historicalContinuityIssue(shot, { params: { referenceImage: 'character.jpg' }, firstFrameDifference: 0.9 }, previous, video), undefined)
  assert.throws(() => validateCinematicShot({ ...shot, presentCharacters: ['周家宾客'] }, scene, previous), /worldState|反打不等于离场/)
  assert.throws(() => validateCinematicShot({ ...shot, firstFrameMode: 'reuse_previous_tail' }, scene, previous), /firstFrameMode=reference/)
  assert.throws(() => validateCinematicShot({ ...shot, storyProgress: { unitId: 'elsewhere' } }, scene, previous), /相同剧情单元/)
  assert.throws(() => validateCinematicShot({ ...shot, worldState: { ...worldState, settingId: 'palace' } }, scene, previous), /settingId/)
})

test('approved empty-cast historical tableau opening does not invent live-action characters', () => {
  const animated = { id: 'opening', contentContractVersion: 'cinematic-v1', characters: [], presentCharacters: [],
    initialCharacters: [], enteringCharacters: [], endCharacters: [], duration: 10, firstFrameMode: 'reference',
    continuity: { mode: 'scene_cut', previousShotId: '', bridgeType: 'opening', bridgeAnchor: '' },
    worldState: { settingId: 'drama-open', characters: [] }, videoPrompt: '历史场景定格依次展开。' }
  const animatedScene = { editorialRole: 'episode_opening', visualTreatment: 'animated', animationStyle: 'historical_tableau',
    cast: [], settingId: 'drama-open', continuityFromPrevious: false }
  assert.doesNotThrow(() => validateCinematicShot(animated, animatedScene))
  assert.doesNotThrow(() => validateCinematicShot(animated, { ...animatedScene, visualTreatment: 'live_action' }),
    'the approved outline also permits an actorless live-action establishing shot')
  assert.throws(() => validateCinematicShot(animated, { ...animatedScene, visualTreatment: 'live_action', editorialRole: 'story' }), /必须保留仍在场的具名人物/)
  assert.throws(() => validateCinematicShot(animated, { ...animatedScene, animationStyle: 'character_illustration' }), /无人物.*动画/)
})

test('approved empty-cast story montage is governed by animation style rather than editorial role', () => {
  const montage = { id: 'scene-11', contentContractVersion: 'cinematic-v1', editorialRole: 'story',
    visualTreatment: 'animated', animationStyle: 'time_montage', characters: [], presentCharacters: [],
    initialCharacters: [], enteringCharacters: [], endCharacters: [], duration: 6, firstFrameMode: 'reference',
    continuity: { mode: 'scene_cut', previousShotId: 'scene-10', bridgeType: 'cut', bridgeAnchor: '由八州地图切入各地治病活动' },
    worldState: { settingId: 'drama-05', characters: [] }, videoPrompt: '弟子施符水与百姓围观的连续意象。' }
  const scene = { editorialRole: 'story', visualTreatment: 'animated', animationStyle: 'time_montage',
    cast: [], settingId: 'drama-05', continuityFromPrevious: false }
  const prior = { id: 'scene-10', contentContractVersion: 'cinematic-v1', storyProgress: { unitId: 'drama-04' } }
  assert.doesNotThrow(() => validateCinematicShot(montage, scene, prior))
  assert.throws(() => validateCinematicShot(montage, { ...scene, animationStyle: 'character_illustration' }, prior), /无人物.*动画/)
})

test('record-9sfsdt style character illustration can fade into an accepted actorless map tail', () => {
  const prior = { id: 'shot-map', contentContractVersion: 'cinematic-v1', characters: [], presentCharacters: [], endCharacters: [],
    storyProgress: { unitId: 'drama-01' }, worldState: { settingId: 'drama-01', characters: [] },
    worldStateEvidence: { method: 'actual-tail-image', frame: '/generated/map-tail.jpg' } }
  const current = { id: 'shot-portrait', contentContractVersion: 'cinematic-v1', visualTreatment: 'animated',
    animationStyle: 'character_illustration', characters: ['张角'], presentCharacters: ['张角'], initialCharacters: [],
    enteringCharacters: [], endCharacters: ['张角'], duration: 5, firstFrameMode: 'reuse_previous_tail',
    continuity: { mode: 'tail_continuation', previousShotId: prior.id, bridgeType: 'same_frame', bridgeAnchor: '张角人物插画淡入' },
    storyProgress: { unitId: 'drama-01' }, illustrationLayers: [{ characterName: '张角', enterStart: .2, enterDuration: .6 }],
    worldState: { settingId: 'drama-01', characters: [{ name: '张角', position: unknown, heldProps: unknown, pendingAction: unknown }] } }
  const approvedScene = { continuityFromPrevious: true, settingId: 'drama-01' }
  assert.doesNotThrow(() => validateCinematicShot(current, approvedScene, prior))
  assert.deepEqual(current.enteringCharacters, [], 'a composited layer fade is not a physical entrance')

  const invented = structuredClone(current)
  invented.worldState.characters[0].position = observed('草棚前')
  assert.throws(() => validateCinematicShot(invented, approvedScene, prior), /缺少前镜世界状态/)
  assert.throws(() => validateCinematicShot({ ...current, visualTreatment: 'live_action' }, approvedScene, prior), /缺少前镜世界状态/)
})

test('actorless historical tableau changes animation representation with a fresh coverage cut', () => {
  const prior = { id: 'scene-01', contentContractVersion: 'cinematic-v1', visualTreatment: 'animated',
    animationStyle: 'character_illustration', characters: ['张角'], presentCharacters: ['张角'], endCharacters: ['张角'],
    storyProgress: { unitId: 'drama-01' }, worldState: { settingId: 'drama-01', characters: [
      { name: '张角', position: unknown, heldProps: unknown, pendingAction: unknown },
    ] }, worldStateEvidence: { method: 'actual-tail-image', frame: '/generated/actual-scene-01-tail.jpg' } }
  const scene = { editorialRole: 'episode_opening', visualTreatment: 'animated', animationStyle: 'historical_tableau',
    cast: [], continuityFromPrevious: true, settingId: 'drama-01' }
  const tableau = { id: 'scene-02', contentContractVersion: 'cinematic-v1', visualTreatment: 'animated', animationStyle: 'historical_tableau',
    editorialRole: 'episode_opening',
    characters: [], presentCharacters: [], initialCharacters: [], enteringCharacters: [], endCharacters: [], duration: 8,
    firstFrameMode: 'reference', continuity: { mode: 'coverage_cut', previousShotId: prior.id, bridgeType: 'cut', bridgeAnchor: '由地图切到施符水定格场景' },
    storyProgress: { unitId: 'drama-01' }, worldState: { settingId: 'drama-01', characters: [] } }
  assert.doesNotThrow(() => validateCinematicShot(tableau, scene, prior))
  assert.doesNotThrow(() => validateCinematicShot(tableau, { continuityFromPrevious: true }, prior),
    'the paid-media gate can recover immutable animation semantics from the accepted shot')
  assert.throws(() => validateCinematicShot({ ...tableau, firstFrameMode: 'reuse_previous_tail',
    continuity: { ...tableau.continuity, mode: 'tail_continuation', bridgeType: 'same_frame' } }, scene, prior), /historical_tableau.*coverage_cut\/reference/)
})

test('real split presence changes report exact lists and repair omitted earlier presence without inventing an entrance', () => {
  // record-kfldy2 planned the same street scene with only 街市行人 in
  // segment 1, then introduced 传谣乡人 in segment 2 without an entrance.
  const plannedWorld = (cast: string[]) => ({ settingId: 'drama-01', characters: cast.map(name => ({
    name, position: unknown, heldProps: unknown, pendingAction: unknown,
  })) })
  const prior = { ...previous, id: 'shot-01-01-seg1', characters: ['街市行人'],
    presentCharacters: ['街市行人'], endCharacters: ['街市行人'], worldState: plannedWorld(['街市行人']),
    worldStateEvidence: undefined, storyProgress: { unitId: 'drama-01' } }
  for (const mode of ['tail_continuation', 'coverage_cut']) {
    const cast = mode === 'tail_continuation' ? ['传谣乡人'] : ['传谣乡人', '街市行人']
    const current = { ...shot, id: 'shot-01-01-seg2', characters: ['传谣乡人'],
      presentCharacters: cast, initialCharacters: ['传谣乡人'], endCharacters: ['传谣乡人'],
      enteringCharacters: [], worldState: plannedWorld(cast), worldStateEvidence: undefined,
      firstFrameMode: mode === 'tail_continuation' ? 'reuse_previous_tail' : 'reference',
      storyProgress: { unitId: 'drama-01' }, continuity: { mode, previousShotId: prior.id,
        bridgeType: mode === 'tail_continuation' ? 'same_frame' : 'cut', bridgeAnchor: '乡人驻足开始传唱' } }
    const before = structuredClone({ prior, current })
    assert.throws(() => validateCinematicShot(current, { continuityFromPrevious: true, settingId: 'drama-01' }, prior), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /前镜 shot-01-01-seg1 在场 presentCharacters=\["街市行人"\]/)
      assert.match(error.message, /本镜 shot-01-01-seg2 enteringCharacters=\[\]/)
      assert.match(error.message, /本镜 expected=\["街市行人"\]/)
      assert.ok(error.message.includes(`actual=${JSON.stringify(cast)}`))
      assert.ok(error.message.includes(`missing=${JSON.stringify(mode === 'tail_continuation' ? ['街市行人'] : [])}`))
      assert.match(error.message, /unexpected=\["传谣乡人"\]/)
      assert.match(error.message, /不得伪造 enteringCharacters 入场动作.*不得删除本镜实际行动人物/)
      assert.match(error.message, /修复前镜 presentCharacters 及对应 worldState 中遗漏的实际在场声明/)
      return true
    })
    assert.deepEqual({ prior, current }, before, 'diagnostics leave both model candidates intact')
    const both = ['街市行人', '传谣乡人']
    const repairedPrior = { ...prior, presentCharacters: both, worldState: plannedWorld(both) }
    const repairedCurrent = { ...current, presentCharacters: both, worldState: plannedWorld(both) }
    assert.doesNotThrow(() => validateCinematicShot(repairedCurrent, { continuityFromPrevious: true, settingId: 'drama-01' }, repairedPrior))
    assert.deepEqual(repairedCurrent.enteringCharacters, [], 'correct same-scene presence does not invent entrance actions')
    assert.deepEqual(repairedCurrent.characters, ['传谣乡人'], 'the currently visible performer is retained')
  }
})

test('presence repair diagnostics preserve already accepted previous-shot evidence', () => {
  const dropped = { ...shot, presentCharacters: ['周家宾客'], worldState: { ...worldState, characters: [worldState.characters[0]] } }
  const before = structuredClone(previous)
  assert.throws(() => validateCinematicShot(dropped, scene, previous), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /expected=\["周家宾客","房家宾客"\].*actual=\["周家宾客"\]/)
    assert.match(error.message, /missing=\["房家宾客"\].*unexpected=\[\]/)
    assert.match(error.message, /前镜已有实测验收证据.*不能为通过校验改写已验收的前镜或实测 worldState/)
    assert.doesNotMatch(error.message, /应修复前镜 presentCharacters/)
    return true
  })
  assert.deepEqual(previous, before)
})

test('coverage opening cannot teleport a prop or convert unknown state into observation', () => {
  const changed = structuredClone(shot)
  changed.worldState.characters[0].heldProps = observed('右手持拜帖')
  assert.throws(() => validateCinematicShot(changed, scene, previous), /无动作改变位置、持物/)
  assert.match(cinematicContinuityIssue(changed, previous, video)!, /无动作改变位置、持物/)
  const missingActual = { ...video, visualReview: { ...video.visualReview, worldState: undefined } }
  assert.match(cinematicContinuityIssue(shot, previous, missingActual)!, /实测 worldState/)
  const unknownPrevious = structuredClone(video)
  unknownPrevious.visualReview.worldState.characters[0].heldProps = unknown as typeof worldState.characters[0]['heldProps']
  assert.match(cinematicContinuityIssue(shot, previous, unknownPrevious)!, /冒充已观察/)
})

test('world-state shape diagnostics retain the applicable evidence rule during repair', () => {
  const invalidWorld = structuredClone(worldState)
  invalidWorld.characters[0].position = { status: 'unknown', value: '计划站在门前' } as typeof invalidWorld.characters[0]['position']
  const first = { ...shot, worldState: invalidWorld, continuity: { mode: 'scene_cut', bridgeType: 'opening' } }
  const before = structuredClone(first)
  assert.throws(() => validateCinematicShot(first, { continuityFromPrevious: false }), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /worldState.*position.*必须为有 value\/evidence/)
    assert.match(error.message, /尚无可继承的实测状态.*unknown.*不能为修复字段格式而改成 observed/)
    return true
  })
  assert.deepEqual(first, before)
  assert.throws(() => validateCinematicShot({ ...shot, worldState: invalidWorld }, scene, previous), /已有实测前镜的事实必须逐字段继承/)
  assert.throws(() => validateCinematicShot(first, { continuityFromPrevious: false }, previous), /尚无可继承的实测状态/)
})

test('screen left/right never becomes persistent world position and hidden people remain unknown', () => {
  const bad = structuredClone(worldState)
  bad.characters[0].position.value = '画面左侧'
  assert.throws(() => validateCinematicWorldState(bad, previous.presentCharacters), /不能用画面坐标/)
  assert.throws(() => validateObservedCinematicWorldState(worldState, shot, shot.endCharacters), /在尾帧画外/)
  const tail = { ...worldState, characters: [worldState.characters[0], { name: '房家宾客', position: unknown, heldProps: unknown, pendingAction: unknown }] }
  assert.doesNotThrow(() => validateObservedCinematicWorldState(tail, shot, shot.endCharacters))
})

test('explicit uncertainty detection is narrow and can be embedded without module dependencies', () => {
  const embedded = new Function(`return (${hasExplicitWorldStateUncertainty.toString()})`)() as typeof hasExplicitWorldStateUncertainty
  const uncertain = [
    '右手下垂但因模糊无法完全确认', '左手因袍服遮挡部分无法完全确认', '无法确认具体状态',
    '无法判断', '无法完全判断', '无法辨认', '无法完全辨认', '无法看清', '无法完全看清', '看不清左手',
    '无法 完全 确认', 'held props unknown', 'UNCERTAIN due to occlusion',
  ]
  const other: unknown[] = ['双手无遮挡', '无模糊，双手空置', '无明确持物', '没有明显物品', '手掌清晰可见',
    'unknowns', 'uncertainty-free', '', undefined, null, 0, { evidence: 'unknown' }]
  for (const detector of [hasExplicitWorldStateUncertainty, embedded]) {
    for (const value of uncertain) assert.equal(detector(value), true, value)
    for (const value of other) assert.equal(detector(value), false, JSON.stringify(value))
  }
})

test('observed world facts reject explicit uncertainty in either value or evidence without rewriting the report', () => {
  for (const key of ['position', 'heldProps', 'pendingAction'] as const) {
    for (const field of ['value', 'evidence'] as const) {
      const state = structuredClone(worldState)
      state.characters[0][key] = { ...observed('实际已见'), [field]: '因模糊无法完全确认' }
      const original = structuredClone(state)
      assert.throws(() => validateCinematicWorldState(state, previous.presentCharacters), /STORYBOARD_WORLD_STATE_INVALID.*不能声明 observed.*unknown/)
      assert.throws(() => validateObservedCinematicWorldState(state, previous, previous.endCharacters), /VIDEO_REVIEW_INVALID.*不能声明 observed/)
      assert.deepEqual(state, original)
    }
  }
  const clear = structuredClone(worldState)
  clear.characters[0].heldProps = { status: 'observed', value: '双手空置，无明确持物', evidence: '双手无遮挡、无模糊' }
  assert.doesNotThrow(() => validateCinematicWorldState(clear, previous.presentCharacters))
})

test('unknown world facts retain observation limits without becoming inherited observed values', () => {
  const reason = '帧5双手因袍服遮挡及拍摄距离无法确认持物状态'
  const state = { ...worldState, characters: worldState.characters.map(character => ({ ...character,
    heldProps: { status: 'unknown', evidence: reason },
  })) }
  const original = structuredClone(state)
  assert.equal(validateCinematicWorldState(state, previous.presentCharacters), state)
  assert.equal(validateObservedCinematicWorldState(state, previous, previous.endCharacters), state)
  const actualVideo = { ...video, visualReview: { ...video.visualReview, worldState: state } }
  assert.equal(cinematicContinuityIssue({ ...shot, worldState: state }, previous, actualVideo), undefined)
  assert.match(cinematicContinuityIssue(shot, previous, actualVideo)!, /冒充已观察/)
  assert.deepEqual(state, original, 'validation must retain the original uncertainty and reason')

  const embedded = new Function(`return (${hasValidCinematicWorldFactShape.toString()})`)() as typeof hasValidCinematicWorldFactShape
  for (const validator of [hasValidCinematicWorldFactShape, embedded]) {
    for (const value of [undefined, null, '', '  ']) assert.equal(validator({ status: 'unknown', value, evidence: reason }), true)
    for (const value of ['双手空置', 'unknown', 0, false, {}, []]) assert.equal(validator({ status: 'unknown', value, evidence: reason }), false)
    for (const evidence of [0, false, {}, []]) assert.equal(validator({ status: 'unknown', evidence }), false)
  }
  for (const value of ['双手空置', 0, false, {}, []]) {
    const invalid = { ...state, characters: state.characters.map(character => ({ ...character, heldProps: { status: 'unknown', value, evidence: reason } })) }
    assert.throws(() => validateObservedCinematicWorldState(invalid, previous, previous.endCharacters), /VIDEO_REVIEW_INVALID.*无事实 value/)
  }
})

test('replay of actual coverage tail report rejects observed props whose own evidence says they cannot be confirmed', () => {
  // Verbatim tail-state excerpt from controlled-20260906-coverage-spans-v1 /
  // media-direct-frames-v1/sanguo-media-review-1.json; keep the original bad report.
  const report = { worldState: { settingId: 'drama-encounter', characters: [
    { name: '周家宾客甲', position: unknown, heldProps: { status: 'observed', value: '双手空置，左手叉腰，右手下垂',
      evidence: '帧5(7.96秒)左侧人物左手叉腰空手，右手下垂但因模糊无法完全确认，无明确持物' }, pendingAction: unknown },
    { name: '房家宾客甲', position: unknown, heldProps: { status: 'observed', value: '双手空置，右手抬起胸前，左手垂于身侧',
      evidence: '帧5(7.96秒)右侧人物右手抬起张开于胸前无持物，左手垂于身侧因袍服遮挡部分无法完全确认但无明确持物' }, pendingAction: unknown },
  ] } }
  const original = structuredClone(report)
  const current = { ...shot, worldState: { settingId: 'drama-encounter' }, presentCharacters: ['周家宾客甲', '房家宾客甲'] }
  assert.throws(() => validateObservedCinematicWorldState(report.worldState, current, current.presentCharacters), /VIDEO_REVIEW_INVALID.*周家宾客甲.heldProps.*unknown/)
  for (const character of report.worldState.characters) {
    const state = { ...report.worldState, characters: [character] }
    assert.equal(hasExplicitWorldStateUncertainty(character.heldProps.evidence), true)
    assert.throws(() => validateObservedCinematicWorldState(state, { ...current, presentCharacters: [character.name] }, [character.name]), /VIDEO_REVIEW_INVALID.*heldProps.*unknown/)
  }
  assert.deepEqual(report, original)
})

test('coverage first-frame review separates actual mismatch from missing evidence', () => {
  const checks = ['position', 'heldProps', 'pendingAction'].map(field => ({ character: '周家宾客', field, status: 'observed', evidence: '第0帧相同实景与持物', frameIndices: [0] }))
  const review = { continuityReview: { mode: 'coverage_cut', passed: true, checks } }
  assert.doesNotThrow(() => validateCinematicOpeningReview(shot, review))
  assert.throws(() => validateCinematicOpeningReview(shot, { continuityReview: { ...review.continuityReview, checks: checks.slice(1) } }), /VIDEO_REVIEW_INVALID/)
  assert.throws(() => validateCinematicOpeningReview(shot, { continuityReview: { ...review.continuityReview, checks: checks.map(check => ({ ...check, status: 'unobservable' })) } }), /补充采证，不能购买重拍/)
  assert.throws(() => validateCinematicOpeningReview(shot, { continuityReview: { ...review.continuityReview, checks: checks.map(check => ({ ...check, status: 'mismatch' })) } }), /VIDEO_QUALITY_REJECTED/)
})

test('coverage opening required observations cannot claim certainty while their evidence explicitly denies it', () => {
  const checks = ['position', 'heldProps', 'pendingAction'].map(field => ({ character: '周家宾客', field, status: 'observed', evidence: '第0帧清楚可见', frameIndices: [0] }))
  for (const evidence of ['右手下垂但因模糊无法完全确认', '左手因袍服遮挡部分无法完全确认', 'held props uncertain']) {
    const report = { continuityReview: { mode: 'coverage_cut', passed: true, checks: checks.map(check => check.field === 'heldProps' ? { ...check, evidence } : check) } }
    const original = structuredClone(report)
    assert.throws(() => validateCinematicOpeningReview(shot, report), /VIDEO_REVIEW_INVALID.*关键开场状态证据明确不确定/)
    assert.deepEqual(report, original)
  }
  assert.doesNotThrow(() => validateCinematicOpeningReview(shot, { continuityReview: { mode: 'coverage_cut', passed: true,
    checks: checks.map(check => ({ ...check, evidence: '双手无遮挡、无模糊，无明确持物' })) } }))
})

test('coverage review allows uncertain extra unknown fields without relaxing required observations or rewriting evidence', () => {
  // Actual coverage sample: opening locations/actions are unknown; only empty
  // hands were observed. The reviewer additionally explained unknown locations.
  const current = { ...shot, characters: previous.characters, initialCharacters: previous.characters,
    worldState: { ...worldState, characters: worldState.characters.map(character => ({ ...character, position: unknown, pendingAction: unknown })) } }
  const checks = previous.characters.flatMap(character => [
    { character, field: 'heldProps', status: 'observed', evidence: '第0帧与前镜已采证持物状态一致', frameIndices: [0] },
    { character, field: 'position', status: 'unobservable', evidence: '前镜位置未知，本镜没有足够实景锚点可比较', frameIndices: [0] },
  ])
  const review = { continuityReview: { mode: 'coverage_cut', passed: true, checks } }
  const original = JSON.stringify({ current, review })
  assert.doesNotThrow(() => validateCinematicOpeningReview(current, review))
  assert.equal(JSON.stringify({ current, review }), original, 'unknown stays unknown and the original review is not rewritten')
  const reviewed = (values: typeof checks) => ({ continuityReview: { ...review.continuityReview, checks: values } })
  for (const status of ['unobservable', 'mismatch']) {
    assert.throws(() => validateCinematicOpeningReview(current, reviewed(checks.map((check, index) => index === 0 ? { ...check, status } : check))),
      status === 'mismatch' ? /VIDEO_QUALITY_REJECTED/ : /VIDEO_REVIEW_INVALID.*关键开场状态不可观察/)
  }
  for (const status of ['observed', 'mismatch']) {
    assert.throws(() => validateCinematicOpeningReview(current, reviewed(checks.map((check, index) => index === 1 ? { ...check, status } : check))), /VIDEO_REVIEW_INVALID.*附加项只能说明不确定/)
  }
  for (const extra of [checks[1], { ...checks[1], character: '不在场人物' }, { ...checks[1], field: 'costume' }]) {
    assert.throws(() => validateCinematicOpeningReview(current, reviewed([...checks, extra])), /VIDEO_REVIEW_INVALID/)
  }
  assert.throws(() => validateCinematicOpeningReview(current, reviewed(checks.slice(1))), /VIDEO_REVIEW_INVALID/)
  assert.throws(() => validateCinematicOpeningReview(current, { continuityReview: { ...review.continuityReview, checks: [...checks, null] } }), /VIDEO_REVIEW_INVALID/)
  assert.throws(() => validateCinematicOpeningReview(current, { continuityReview: { ...review.continuityReview, passed: false } }), /VIDEO_REVIEW_INVALID.*报告失败/)
})

test('an actual exit changes the next scene presence only with explicit action and observed evidence', () => {
  const exiting = { ...shot, characters: previous.characters, initialCharacters: previous.characters, endCharacters: ['房家宾客'],
    videoPrompt: '0-1秒：周家宾客收回招呼。1-2.7秒：周家宾客走出院门离开现场。2.7-3秒：房家宾客回视门口。',
    continuity: { ...shot.continuity, exitingCharacters: [{ name: '周家宾客', startSecond: 1, endSecond: 2.7, path: '穿过院门到院外', evidenceAnchor: '周家宾客走出院门离开现场' }] } }
  assert.doesNotThrow(() => validateCinematicShot(exiting, scene, previous))
  assert.deepEqual(expectedEndPresentCharacters(exiting), ['房家宾客'])
  const state = { ...worldState, characters: [worldState.characters[1]] }
  const presenceChecks = [{ character: '周家宾客', status: 'observed', evidence: '第1帧走向院门，第4帧经过院门离开院子', frameIndices: [1, 4] }]
  const review = { ...video.visualReview, endCharacters: ['房家宾客'], presentCharacters: ['房家宾客'], worldState: state, presenceChecks }
  assert.doesNotThrow(() => validateCinematicPresenceReview(exiting, review))
  assert.throws(() => validateCinematicPresenceReview(exiting, { ...review, presenceChecks: [] }), /实际帧的动作过程证据/)
  assert.throws(() => validateCinematicPresenceReview(exiting, { ...review, presenceChecks: [{ ...presenceChecks[0], status: 'unobservable' }] }), /不能把裁切出画当离场/)
  const next = { ...shot, id: 's3', presentCharacters: ['房家宾客'], characters: ['房家宾客'], initialCharacters: ['房家宾客'], endCharacters: ['房家宾客'], worldState: state,
    continuity: { ...shot.continuity, previousShotId: 's2' } }
  assert.equal(cinematicContinuityIssue(next, exiting, { ...video, visualReview: review }), undefined)
  const cropped = { ...exiting, continuity: { ...exiting.continuity, exitingCharacters: [{ ...exiting.continuity.exitingCharacters[0], evidenceAnchor: '周家宾客走出画面' }] }, videoPrompt: '周家宾客走出画面' }
  assert.throws(() => validateCinematicShot(cropped, scene, previous), /裁切出画不等于离场/)
})

test('continuity context uses actual state after an ambient-only take and preserves immutable scripts', () => {
  const original = structuredClone(previous)
  const context = storyboardContinuityContext({ scene, loop: { previous: { shot_script: previous,
    video_shot: { ...video, speechValidation: undefined, audioMode: 'ambient', hasAudio: true }, last_frame: { available: true, url } } } })
  const actual = ((context.loop as Record<string, unknown>).previous as Record<string, unknown>).actualTailEvidence as Record<string, unknown>
  assert.deepEqual(actual.worldState, worldState)
  assert.deepEqual(actual.presentCharacters, previous.presentCharacters)
  assert.deepEqual(previous, original)
  assert.deepEqual(cleanStoryboardForValidation({ ...shot, raw: 'provider' }).worldState, worldState)
  const clean = cleanStoryboardForValidation({ ...shot, repairProvenance: { candidateVersion: 2 }, factualReview: { passed: true }, dramaturgyReview: { passed: true },
    passed: true, issues: [], reviewVersion: 'cinematic-review-v1', repairContext: { scope: 'scene' } })
  assert.equal(clean.repairProvenance, undefined)
  assert.equal(clean.factualReview, undefined)
  assert.equal(clean.dramaturgyReview, undefined)
  assert.equal(clean.passed, undefined)
  assert.equal(clean.repairContext, undefined)
  assert.equal(clean.contentContractVersion, 'cinematic-v1')
  assert.deepEqual(plannedSpeechWindows(shot), [])
  assert.match(historicalVideoPrompt(shot), /本镜为同场切镜|全片没有对白或旁白/)
})

test('a tail continuation after a close-up cannot erase an offscreen participant in the real writer or paid gate', async () => {
  const hidden = { name: '房家宾客', position: unknown, heldProps: unknown, pendingAction: unknown }
  const actualWorld = { ...worldState, characters: [worldState.characters[0], hidden] }
  const prior = { ...previous, characters: ['周家宾客'], endCharacters: ['周家宾客'], worldState: actualWorld,
    lastFramePrompt: '周家宾客站在院门内侧，双手空手，视线朝画外。' }
  const beat = { id: 'decision', description: '周家宾客决定结束交谈', setting: '院门', mustShow: ['周家宾客收回招呼'],
    function: 'choice', stateChange: '收回招呼并移开视线', observable: { visual: ['周家宾客收回招呼'], audio: [] } }
  const currentScene = { ...scene, id: 's2', dramaticSceneId: 'u1', cast: ['周家宾客'], requiredBeats: [beat] }
  const candidate: Record<string, unknown> = { ...shot, firstFrameMode: 'reuse_previous_tail', enteringCharacters: [],
    continuity: { mode: 'tail_continuation', previousShotId: prior.id, bridgeType: 'same_frame', bridgeAnchor: '' },
    visualPrompt: prior.lastFramePrompt, worldState: actualWorld, dramaticSceneId: 'u1', title: '拒绝往来', mood: '受挫后的决断',
    pacing: performance, coveredBeatIds: ['decision'],
    shotIntent: { viewpointCharacter: '周家宾客', purpose: '看到交谈意愿被撤回', cameraReason: '近景看清动作选择' },
    beatDramaturgy: [{ beatId: beat.id, function: beat.function, stateChange: beat.stateChange, ...beat.observable }],
    historicalBasis: '[史料1] 两家宾客互相讥揣', adaptationBoundary: '具体动作拟制，不新增史实' }
  delete candidate.worldStateEvidence
  const dropped = { ...candidate, presentCharacters: ['周家宾客'], worldState: { ...actualWorld, characters: [actualWorld.characters[0]] } }
  const priorVideo = { ...video, speechValidation: undefined, audioMode: 'ambient', hasAudio: true,
    visualReview: { ...video.visualReview, endingState: prior.lastFramePrompt, endCharacters: prior.endCharacters, worldState: actualWorld } }
  assert.match(cinematicContinuityIssue(dropped, prior, priorVideo)!, /presentCharacters.*继承/)
  assert.equal(cinematicContinuityIssue(candidate, prior, priorVideo), undefined)
  assert.match(cinematicContinuityIssue(candidate, prior, { ...priorVideo, technicalValidation: { passed: false } })!, /已验收成片/)
  assert.match(cinematicContinuityIssue(candidate, prior, { ...priorVideo, hasAudio: false })!, /已验收成片/)
  assert.equal(cinematicContinuityIssue({ ...dropped, contentContractVersion: undefined }, prior, undefined), undefined, 'legacy contract remains unchanged')
  let repairCalls = 0
  const result = await generateHistoricalStoryboard({ prompt: '既有批准声画义务', initialCandidate: dropped,
    expected: { scene: currentScene, previousShot: prior, requireContinuityContract: true, requireDynamicPacing: true },
    generate: async prompt => {
      repairCalls += 1
      assert.match(prompt, /presentCharacters.*继承/)
      return structuredClone(candidate)
    } })
  assert.equal(repairCalls, 1, 'the invalid initial candidate must be rejected before media generation')
  assert.equal((result.scriptValidation as Record<string, unknown>).passed, true)
  assert.deepEqual(result.presentCharacters, ['周家宾客', '房家宾客'])
  assert.deepEqual(result.characters, ['周家宾客'])
  assert.equal(cinematicContinuityIssue(result, prior, priorVideo), undefined)
})

const performance = {
  version: 'dynamic-v1', actionSeconds: 0, reactionSeconds: 0.3,
  activityWindows: [{ kind: 'reaction', startSecond: 0, endSecond: 0.3 }],
  performanceBeats: [{ id: 'decision', purpose: '决定不再交谈', stateChange: '收回招呼并移开视线', evidenceAnchor: '收回招呼',
    startSecond: 0, endSecond: 2.7, overlapWith: ['reaction'] }],
}

test('a meaningful silent decision gets a three-second budget without counting reaction twice', () => {
  const timing = dynamicStoryboardTiming('', performance, shot)
  assert.equal(timing.requiredDuration, 3)
  assert.equal(timing.tailSeconds, 0.3)
  assert.equal(timing.additionalPerformanceSeconds, 2.4)
  assert.equal(timing.overlapSeconds, 0.3)
  assert.equal(timing.rawRequiredSeconds, 3)
  assert.throws(() => dynamicStoryboardTiming('', { ...performance, performanceBeats: [{ ...performance.performanceBeats[0], overlapWith: [] }] }, shot), /overlapWith/)
  assert.throws(() => dynamicStoryboardTiming('', { ...performance, performanceBeats: [{ ...performance.performanceBeats[0], stateChange: '保持不动以表示犹豫' }] }, shot), /不能用心理标签/)
  assert.throws(() => dynamicStoryboardTiming('', performance, { ...shot, videoPrompt: '0-3秒：静止等待。' }), /不能用心理标签/)
  assert.throws(() => dynamicStoryboardTiming('', { ...performance, activityWindows: [{ kind: 'reaction', startSecond: 0, endSecond: 2.7 }] }, shot), /不能重复计时/)
})

test('speech overlapping a visible response is budgeted at the natural rate once', () => {
  const line = '遵命。'
  const speech = 2 / 4.5 + 0.25
  const pacing = { ...performance, activityWindows: [{ kind: 'speech', startSecond: 0, endSecond: speech }, { kind: 'reaction', startSecond: 0, endSecond: 0.3 }],
    performanceBeats: [{ ...performance.performanceBeats[0], overlapWith: ['speech', 'reaction'] }] }
  assert.equal(dynamicStoryboardTiming(line, pacing, shot).requiredDuration, 3)
  assert.throws(() => dynamicStoryboardTiming(line, { ...pacing, activityWindows: [{ kind: 'speech', startSecond: 0, endSecond: 2 }, pacing.activityWindows[1]] }, shot), /拉长自然语速/)
})

test('performance acceptance requires actual state change evidence and unobservable does not purchase a retake', () => {
  const checks = [{ beatId: 'decision', status: 'observed', evidence: '第0帧手在身前，第4帧已收回并移开视线', observedStateChange: '伸手招呼到收回招呼', startSecond: 0, endSecond: 2.7, frameIndices: [0, 4] }]
  const timedShot = { ...shot, pacing: performance }
  assert.doesNotThrow(() => validatePerformanceMediaReview({ performanceChecks: checks }, timedShot))
  assert.throws(() => validatePerformanceMediaReview({ performanceChecks: [{ ...checks[0], frameIndices: [4, 4] }] }, timedShot), /VIDEO_REVIEW_INVALID/)
  assert.throws(() => validatePerformanceMediaReview({ performanceChecks: [{ ...checks[0], status: 'unobservable' }] }, timedShot), /不能当作未发生而重拍/)
  assert.throws(() => validatePerformanceMediaReview({ performanceChecks: [{ ...checks[0], status: 'incomplete' }] }, timedShot), /VIDEO_QUALITY_REJECTED/)
})

test('production writer preserves an approved cinematic close-up and ambient decision without forcing same_frame', async () => {
  const beat = { id: 'decision', description: '周家宾客决定结束交谈', setting: '院门', mustShow: ['周家宾客收回招呼'],
    function: 'choice', stateChange: '收回招呼并移开视线', observable: { visual: ['周家宾客收回招呼'], audio: [] } }
  const currentScene = { ...scene, id: 's2', dramaticSceneId: 'u1', cast: previous.presentCharacters, requiredBeats: [beat] }
  const candidate: Record<string, unknown> = { ...shot, dramaticSceneId: 'u1', title: '拒绝往来', mood: '受挫后的决断', pacing: performance, coveredBeatIds: ['decision'],
    shotIntent: { viewpointCharacter: '周家宾客', purpose: '看到交谈意愿被撤回', cameraReason: '近景看清动作选择' },
    beatDramaturgy: [{ beatId: beat.id, function: beat.function, stateChange: beat.stateChange, ...beat.observable }],
    historicalBasis: '[史料1] 两家宾客互相讥揣', adaptationBoundary: '具体动作拟制，不新增史实' }
  delete candidate.worldStateEvidence
  const result = await generateHistoricalStoryboard({ prompt: '既有批准声画义务', expected: { scene: currentScene, previousShot: previous,
    requireContinuityContract: true, requireDynamicPacing: true }, initialCandidate: candidate,
    generate: async () => { throw new Error('approved cinematic framing must not be replaced with a copied wide shot') } })
  assert.equal((result.continuity as Record<string, unknown>).mode, 'coverage_cut')
  assert.equal(result.firstFrameMode, 'reference')
  assert.equal(result.visualPrompt, shot.visualPrompt)
  assert.equal(result.audioType, '环境声')
  assert.deepEqual(result.presentCharacters, previous.presentCharacters)
  assert.deepEqual(result.characters, ['周家宾客'])
  assert.equal((result.scriptValidation as Record<string, unknown>).passed, true)
  let repairCalls = 0
  const repaired = await generateHistoricalStoryboard({ prompt: '保留批准的沉默决定', expected: { scene: currentScene, previousShot: previous,
    requireContinuityContract: true, requireDynamicPacing: true }, initialCandidate: { ...candidate,
      pacing: { ...performance, performanceBeats: [{ ...performance.performanceBeats[0], overlapWith: [] }] } },
    generate: async prompt => {
      repairCalls++
      assert.match(prompt, /重新预算/)
      assert.doesNotMatch(prompt, /程序计算的动态预算/)
      return candidate
    } })
  assert.equal(repairCalls, 0, 'an overlap list is derived from the existing windows without purchasing another draft')
  assert.equal((repaired.scriptValidation as Record<string, unknown>).passed, true)
  assert.equal((repaired.scriptValidation as Record<string, unknown>).localRepair, true)
})

test('repeated diagnostic rounds retain escalation and honor all five configured attempts', async () => {
  const beat = { id: 'decision', description: '周家宾客决定结束交谈', setting: '院门', mustShow: ['周家宾客收回招呼'],
    function: 'choice', stateChange: '收回招呼并移开视线', observable: { visual: ['周家宾客收回招呼'], audio: [] } }
  const currentScene = { ...scene, id: 's2', dramaticSceneId: 'u1', cast: ['周家宾客'], requiredBeats: [beat] }
  const stuck = structuredClone(shot)
  delete (stuck as Record<string, unknown>).contentContractVersion
  const prompts: string[] = []
  const failure = await generateHistoricalStoryboard({ prompt: '批准的声画义务',
    expected: { scene: currentScene, previousShot: previous, requireDynamicPacing: true, qualityDisposition: 'strict-v1', maxGenerationAttempts: 5 },
    generate: async prompt => { prompts.push(prompt); return structuredClone(stuck) } }).catch((reason: unknown) => reason as Error)
  assert.match((failure as Error).message, /分镜修复未通过（5 次/)
  assert.equal(prompts.length, 5, 'repeated errors must not silently truncate the explicit retry budget')
  assert.ok(!prompts[1].includes('完全相同的缺陷清单'), 'the first repeat must be the escalation, not the give-up')
  assert.match(prompts[2], /完全相同的缺陷清单/)
  assert.match(prompts[2], /换一种分镜写法/)
  assert.match(prompts[4], /相同缺陷已连续出现 4 轮/)
})
