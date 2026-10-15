import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveSceneCutOpeningPlan } from '../server/scene-cut-opening-plan.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V167,
  SCENE_CUT_FRAME_REVIEW_PROMPT_V167 } from '../src/scene-cut-t0-image-contract.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V168, SCENE_CUT_FRAME_REVIEW_PROMPT_V168,
  upgradeSceneCutOpeningPlanWorkflow, validateSceneCutStanceStartReview } from '../src/scene-cut-opening-plan-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V169, SCENE_CUT_FRAME_REVIEW_PROMPT_V169,
  upgradeSceneCutTravelStartWorkflow, validateSceneCutTravelStartReview } from '../src/scene-cut-travel-start-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V170, SCENE_CUT_FRAME_REVIEW_PROMPT_V170,
  upgradeSceneCutOpeningProjectionWorkflow,
  validateSceneCutOpeningProjectionReview } from '../src/scene-cut-opening-projection-workflow.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'

const shot = { id: 'scene-generic-1', continuity: { mode: 'scene_cut' }, visualTreatment: 'live_action',
  pacing: { scheduleHash: 'duration-v2-sha256-generic', beats: [
    { id: 'bind', kind: 'action', textOrVocalization: '军士在双腕收紧绳结',
      completion: { requiredThisClip: true, finalState: '绳圈贴腕且结扣闭合' } },
    { id: 'stand', kind: 'action', textOrVocalization: '俘虏将双脚踏稳，挺直背脊',
      completion: { requiredThisClip: true, finalState: '双腿站稳且背脊挺直' } },
    { id: 'escort', kind: 'action', textOrVocalization: '军士押俘虏朝厅门走去',
      completion: { requiredThisClip: true, finalState: '到达厅门外' } },
  ], schedule: [{ beatId: 'bind', startSecond: 0 },
    { beatId: 'stand', startSecond: 2 }, { beatId: 'escort', startSecond: 4 }] } }

test('required visual beats yield positive t0 pixels bound to shot and schedule', () => {
  const plan = deriveSceneCutOpeningPlan(shot)
  assert.equal(plan.shotId, shot.id)
  assert.equal(plan.scheduleHash, shot.pacing.scheduleHash)
  assert.match(plan.shotSha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(plan.requiredVisualActions.map(item => item.beatId), ['bind', 'stand', 'escort'])
  assert.deepEqual(plan.requiredVisualActions.map(item => item.categories[0]),
    ['fastener_tightening', 'stance_straightening', 'travel_to_target'])
  assert.match(plan.requiredVisualActions[0].visibleT0.join(' '), /松圈.*下垂.*活结/s)
  assert.match(plan.requiredVisualActions[1].visibleT0.join(' '), /微屈.*前倾/s)
  assert.match(plan.requiredVisualActions[2].visibleT0.join(' '), /地面路径和距离/)
  assert.notEqual(deriveSceneCutOpeningPlan({ ...shot, id: 'other' }).shotSha256, plan.shotSha256)
  assert.match(SCENE_CUT_FIRST_FRAME_PROMPT_V168, /\$\{scene_cut_opening_state\}/)
  assert.match(SCENE_CUT_FRAME_REVIEW_PROMPT_V168, /stanceStartCheck/)
})

test('prior binding and maintained upright posture are not reclassified as new actions', () => {
  const realShape = { ...shot, pacing: { ...shot.pacing, beats: [
    { id: 'action-bind', kind: 'action',
      textOrVocalization: '军士在严颜腕上收紧绳结。严颜双腕置于身前。',
      completion: { requiredThisClip: true, evidenceAnchor: '军士在严颜腕上收紧绳结。',
        finalState: '腕部绳结收紧' } },
    { id: 'action-stand', kind: 'action',
      textOrVocalization: '严颜将双脚踏稳，挺直背脊。承接绳结收紧的牵力，脚底重新站实。',
      completion: { requiredThisClip: true, evidenceAnchor: '严颜将双脚踏稳，挺直背脊。',
        finalState: '背脊挺直，腕部仍被缚' } },
    { id: 'action-escort', kind: 'action',
      textOrVocalization: '军士押严颜离开院中，朝北侧厅门走去。严颜背脊保持挺直。',
      completion: { requiredThisClip: true,
        evidenceAnchor: '军士押严颜离开院中，朝北侧厅门走去。',
        finalState: '到达厅门外，仍挺立' } },
  ], schedule: [{ beatId: 'action-bind', startSecond: 0 },
    { beatId: 'action-stand', startSecond: 2 },
    { beatId: 'action-escort', startSecond: 4 }] } }
  const actions = deriveSceneCutOpeningPlan(realShape).requiredVisualActions
  assert.deepEqual(actions.map(item => item.categories), [
    ['fastener_tightening'], ['stance_straightening'], ['travel_to_target'] ])
})

test('schema169 plan keeps all feet planted only when the approved shot shows them', () => {
  const traveling = { ...shot,
    visualPrompt: '东汉院落，北侧厅门在后景。单一时刻的全身画面，两脚可见；两名士兵原地站立。连续实拍动作：军士收紧绳结，俘虏站稳，随后押送到厅门。',
    camera: '东南侧 40 毫米侧前方全身机位；俘虏初始朝南。押送起步后镜头跟移。' }
  const old = deriveSceneCutOpeningPlan(traveling)
  const full = deriveSceneCutOpeningPlan(traveling, 2)
  assert.equal(old.version, 'scene-cut-opening-plan-v1')
  assert.equal(full.version, 'scene-cut-opening-plan-v2')
  assert.match(full.requiredVisualActions[1].visibleT0.join(' '), /脚掌与脚跟都仍接地/)
  assert.match(full.requiredVisualActions[2].visibleT0.join(' '), /双脚脚掌与脚跟均接地/)
  assert.match(full.requiredVisualActions[0].visibleT0.join(' '), /绳圈离腕.*未多圈贴紧/)
  const closeShot = { ...traveling, visualPrompt: '东汉院落，面部和双腕近景。连续实拍动作：收紧绳结，随后押送。',
    camera: '东南侧面部近景。' }
  const close = deriveSceneCutOpeningPlan(closeShot, 2)
  assert.doesNotMatch(close.requiredVisualActions[2].visibleT0.join(' '), /双脚脚掌与脚跟均接地/)
  assert.match(close.requiredVisualActions[2].visibleT0.join(' '), /不为看脚而改变构图/)
  assert.match(SCENE_CUT_FIRST_FRAME_PROMPT_V169,
    /\$\{scene_cut_opening_state\.openingVisualContext\}/)
  const rendered = renderWorkflowTemplate(SCENE_CUT_FIRST_FRAME_PROMPT_V169,
    { scene_cut_opening_state: full })
  assert.match(rendered, /东汉院落.*东南侧 40 毫米/s)
  assert.doesNotMatch(rendered, /连续实拍动作|军士收紧绳结|俘虏站稳|押送到厅门|approvedFinalState|后续.*跟移/)
  assert.doesNotMatch(rendered, /\$\{scene_cut_opening_state\./)
  assert.deepEqual(full.openingVisualContext?.namedCharacters, [])
  assert.equal(full.openingVisualContext?.openingCamera,
    '东南侧 40 毫米侧前方全身机位；俘虏初始朝南。')
  const pass = { requiredVisualActionChecks: [{ beatId: 'escort', travelStartCheck: {
    applicable: true, atApprovedOrigin: true, feetInspectionRequired: true,
    allParticipantsFeetGrounded: true, noStrideInProgress: true,
    destinationNotReached: true, routeStillPossible: true,
    pixelEvidence: '三人双足脚掌脚跟均接地，原地等待；厅门在后方仍可转身走到' } }] }
  assert.equal(validateSceneCutTravelStartReview(pass, traveling), true)
  for (const key of ['allParticipantsFeetGrounded', 'noStrideInProgress', 'routeStillPossible']) {
    const fail = structuredClone(pass)
    fail.requiredVisualActionChecks[0].travelStartCheck[key] = false
    assert.throws(() => validateSceneCutTravelStartReview(fail, traveling),
      /SCENE_CUT_FRAME_REJECTED/)
  }
  const closePass = structuredClone(pass)
  closePass.requiredVisualActionChecks[0].travelStartCheck.feetInspectionRequired = false
  closePass.requiredVisualActionChecks[0].travelStartCheck.allParticipantsFeetGrounded = false
  assert.equal(validateSceneCutTravelStartReview(closePass,
    closeShot), true)
  const forged = structuredClone(closePass)
  forged.requiredVisualActionChecks[0].travelStartCheck.feetInspectionRequired = true
  assert.throws(() => validateSceneCutTravelStartReview(forged,
    closeShot), /SCENE_CUT_FRAME_REJECTED/)
})

test('schema170 derives the original street opening without importing later gesture, binding or approach', () => {
  const original = { id: 'scene-01', continuity: { mode: 'scene_cut' },
    visualTreatment: 'live_action', characters: ['张飞', '严颜'],
    visualPrompt: '16:9，真人实景，自然日光，东汉服化道。江州城内战后街口，夯土墙与木构门面形成纵深，地面有尘土。首帧为单一时刻全画幅：张飞在画面左侧，严颜在右侧，相距约两步；匿名军士已在严颜两侧及侧后方，身前尚留缺口，近身军士持用于缚腕的绳索。严颜双腕尚未缚住。张飞为成熟成年男性，深褐袍配暗褐札甲；严颜灰褐袍、旧色札甲。动作执行：0–2.5秒，张飞抬手示意军士合拢；2.5–7.5秒，军士将严颜双腕缚住；7.5–9.5秒，张飞走到严颜面前。',
    camera: '单一连续镜头，平视略偏严颜正面的斜侧全景，约35毫米等效焦段；严颜双腕置于清楚可辨的画幅区域。以张飞与严颜的连线为视线轴，全程在同一侧。张飞从左侧沿封堵线内侧走近右侧严颜，摄影机仅作小幅跟摇维持构图。',
    pacing: { scheduleHash: 'original-street-schedule', beats: [
      { id: 'b01-close', kind: 'action', completion: { requiredThisClip: true,
        evidenceAnchor: '张飞抬手示意军士合拢，封住严颜身前的缺口' } },
      { id: 'b01-bind', kind: 'action', completion: { requiredThisClip: true,
        evidenceAnchor: '军士将严颜双腕缚住' } },
      { id: 'b01-approach', kind: 'action', completion: { requiredThisClip: true,
        evidenceAnchor: '张飞走到严颜面前' } },
    ], schedule: [{ beatId: 'b01-close', startSecond: 0 },
      { beatId: 'b01-bind', startSecond: 2.5 },
      { beatId: 'b01-approach', startSecond: 7.5 }] } }
  const before = structuredClone(original)
  const plan = deriveSceneCutOpeningPlan(original, 3)
  assert.deepEqual(original, before, 'the approved shot is only read')
  assert.equal(plan.version, 'scene-cut-opening-plan-v3')
  assert.deepEqual(plan.requiredVisualActions.map(item => item.categories), [
    ['gesture_gap_closure'], ['binding_from_unbound'], ['travel_to_target'] ])
  assert.match(plan.requiredVisualActions[0].visibleT0.join(' '), /手臂仍在低位.*缺口仍清楚敞开/)
  assert.match(plan.requiredVisualActions[1].visibleT0.join(' '), /双腕.*尚未被绳带围住.*绳索在操作者手里/)
  assert.match(plan.requiredVisualActions[2].visibleT0.join(' '), /相距约两步.*未在目标面前站定/)
  assert.match(plan.openingVisualContext?.staticScene ?? '', /江州城内战后街口.*身前尚留缺口.*双腕尚未缚住/s)
  assert.match(plan.openingVisualContext?.openingCamera ?? '', /平视.*约35毫米等效焦段.*同一侧/s)
  assert.doesNotMatch(plan.openingVisualContext?.openingCamera ?? '', /走近|跟摇/)
  const rendered = renderWorkflowTemplate(SCENE_CUT_FIRST_FRAME_PROMPT_V170,
    { scene_cut_opening_state: plan })
  assert.match(rendered, /手臂仍在低位.*双腕.*尚未被绳带围住.*相距约两步/s)
  assert.doesNotMatch(rendered, /张飞走到严颜面前。|动作执行：|后续.*跟摇/)
  const base = { requiredVisualActionChecks: [
    { beatId: 'b01-close', gestureClosureStartCheck: { applicable: true,
      gestureNotRaised: true, gapStillOpen: true, guardsBeforeClosure: true,
      pixelEvidence: '张飞手下垂，严颜身前仍有缺口，两军士分立' } },
    { beatId: 'b01-bind', bindingStartCheck: { applicable: true,
      targetStillUnbound: true, bindingMaterialSeparate: true, bindingActionSpaceVisible: true,
      pixelEvidence: '双腕分开，军士手持绳，腕绳分离' } },
    { beatId: 'b01-approach' },
  ] }
  assert.equal(validateSceneCutOpeningProjectionReview(base, original), true)
  const bad = structuredClone(base)
  bad.requiredVisualActionChecks[1].bindingStartCheck!.targetStillUnbound = false
  assert.throws(() => validateSceneCutOpeningProjectionReview(bad, original),
    /SCENE_CUT_FRAME_REJECTED/)
  const badGap = structuredClone(base)
  badGap.requiredVisualActionChecks[0].gestureClosureStartCheck!.gapStillOpen = false
  assert.throws(() => validateSceneCutOpeningProjectionReview(badGap, original),
    /SCENE_CUT_FRAME_REJECTED/)
})

test('schema170 leaves unrelated static setting and held props in a different scene cut', () => {
  const other = { ...shot, characters: ['使者'],
    visualPrompt: '雨后驿院，木门半开，石阶潮湿。使者站在檐下，左手提一盏铜灯，腰侧挂令牌，屏风在右后方。连续实拍动作：使者走向门外。',
    camera: '东侧35毫米平视中景，灯和令牌均可见。随后跟拍使者走出。',
    pacing: { ...shot.pacing, beats: [{ id: 'move', kind: 'action',
      textOrVocalization: '使者走向门外', completion: { requiredThisClip: true,
        evidenceAnchor: '使者走向门外', finalState: '使者出门' } }],
    schedule: [{ beatId: 'move', startSecond: 0 }] } }
  const plan = deriveSceneCutOpeningPlan(other, 3)
  assert.match(plan.openingVisualContext?.staticScene ?? '', /雨后驿院.*木门半开.*铜灯.*令牌.*屏风/s)
  assert.match(plan.openingVisualContext?.openingCamera ?? '', /东侧35毫米平视中景.*灯和令牌/)
  assert.doesNotMatch(plan.openingVisualContext?.openingCamera ?? '', /跟拍/)
})

test('stance gate requires visibly unsettled legs and unfinished torso', () => {
  const review = { requiredVisualActionChecks: [
    { beatId: 'bind' },
    { beatId: 'stand', approvedResetBeatId: '', stanceStartCheck: {
      applicable: true, bentKneeOrUnsettledWeightVisible: true,
      torsoNotFullyStraight: true, pixelEvidence: '左膝弯，右脚尚未踏实；背脊前倾' } },
    { beatId: 'escort' },
  ] }
  assert.equal(validateSceneCutStanceStartReview(review, shot), true)
  for (const key of ['bentKneeOrUnsettledWeightVisible', 'torsoNotFullyStraight']) {
    const failed = structuredClone(review)
    failed.requiredVisualActionChecks[1].stanceStartCheck[key] = false
    assert.throws(() => validateSceneCutStanceStartReview(failed, shot), /SCENE_CUT_FRAME_REJECTED/)
  }
  assert.throws(() => validateSceneCutStanceStartReview({ requiredVisualActionChecks: [] }, shot),
    /SCENE_CUT_FRAME_REJECTED/)
})

test('schema168 inserts plan before image and leaves unrelated nodes intact', () => {
  const owner = { id: 'sanguo-scene-loop', kind: 'loop', childIds: [
    'sanguo-scene-cut-source-archive', 'sanguo-scene-cut-first-frame',
    'sanguo-scene-cut-review', 'sanguo-scene-cut-approval' ] }
  const archive = { id: 'sanguo-scene-cut-source-archive', kind: 'http',
    position: { x: 100, y: 100 }, loop: { id: 'loop' } }
  const image = { id: 'sanguo-scene-cut-first-frame', kind: 'image',
    position: { x: 300, y: 100 }, prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V167, params: [] }
  const review = { id: 'sanguo-scene-cut-review', kind: 'text',
    prompt: SCENE_CUT_FRAME_REVIEW_PROMPT_V167, params: [] }
  const approval = { id: 'sanguo-scene-cut-approval', kind: 'http', params: [] }
  const manual = { id: 'manual', kind: 'code', prompt: 'keep me' }
  const graph = { id: 'wf-sanguo-history-drama', schemaVersion: 167,
    nodes: [owner, archive, image, review, approval, manual],
    edges: [{ id: 'old', from: archive.id, to: image.id },
      { id: 'manual-edge', from: manual.id, to: review.id },
      { id: 'sg-e-map-annotation-review', from: 'map-branch', to: 'map-review' }] }
  const next = upgradeSceneCutOpeningPlanWorkflow(graph)
  assert.equal(next.schemaVersion, 168)
  assert.equal(next.nodes.length, graph.nodes.length + 1)
  assert.equal(next.nodes.find(node => node.id === 'manual'), manual)
  assert.deepEqual(next.nodes.find(node => node.id === owner.id)?.childIds?.slice(0, 3),
    [archive.id, 'sanguo-scene-cut-opening-plan', image.id])
  assert.equal(next.edges.some(edge => edge.from === archive.id && edge.to === image.id), false)
  assert.equal(next.edges.some(edge => edge.from === archive.id && edge.to === 'sanguo-scene-cut-opening-plan'), true)
  assert.equal(next.edges.some(edge => edge.from === 'sanguo-scene-cut-opening-plan' && edge.to === image.id), true)
  assert.equal(next.edges.some(edge => edge.id === 'manual-edge'), true)
  assert.deepEqual(next.edges.map(edge => edge.id), [
    'manual-edge', 'sg-e-scene-opening-plan-in', 'sg-e-scene-opening-plan-out',
    'sg-e-map-annotation-review',
  ])
  assert.equal(next.nodes.find(node => node.id === image.id)?.params?.find(param =>
    param.englishName === 'sceneCutOpeningPlan')?.value, '${scene_cut_opening_state}')
  assert.equal(upgradeSceneCutOpeningPlanWorkflow(next), next)
  assert.equal(upgradeSceneCutOpeningPlanWorkflow({ ...next, schemaVersion: 169 }).schemaVersion, 169)
  const v169 = upgradeSceneCutTravelStartWorkflow(next)
  assert.equal(v169.schemaVersion, 169)
  assert.equal(v169.edges, next.edges)
  assert.equal(v169.nodes.length, next.nodes.length)
  assert.deepEqual(v169.nodes.filter((node, index) => node !== next.nodes[index]).map(node => node.id),
    ['sanguo-scene-cut-first-frame', 'sanguo-scene-cut-review'])
  assert.equal(v169.nodes.find(node => node.id === image.id)?.prompt,
    SCENE_CUT_FIRST_FRAME_PROMPT_V169)
  assert.equal(v169.nodes.find(node => node.id === review.id)?.prompt,
    SCENE_CUT_FRAME_REVIEW_PROMPT_V169)
  assert.equal(upgradeSceneCutTravelStartWorkflow(v169), v169)
  assert.equal(upgradeSceneCutTravelStartWorkflow({ ...v169, schemaVersion: 170 }).schemaVersion, 170)
  const edited = { ...next, nodes: next.nodes.map(node => node.id === review.id
    ? { ...node, prompt: `${node.prompt} 用户编辑` } : node) }
  assert.equal(upgradeSceneCutTravelStartWorkflow(edited), edited)
})

test('schema170 updates only the managed opening projection and identity plate version', () => {
  const plate = { id: 'sc-source-identity-plate-version', name: 'identityPlateVersion',
    englishName: 'identityPlateVersion', type: 'text', required: false,
    value: 'scene-cut-identity-plate-v3' }
  const archive = { id: 'sanguo-scene-cut-source-archive', params: [{ id: 'keep', name: 'keep',
    englishName: 'keep', type: 'text', required: false, value: 'manual' }] }
  const image = { id: 'sanguo-scene-cut-first-frame', prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V169 }
  const review = { id: 'sanguo-scene-cut-review', prompt: SCENE_CUT_FRAME_REVIEW_PROMPT_V169 }
  const unrelated = { id: 'unrelated', prompt: 'preserve' }
  const graph = { id: 'wf-sanguo-history-drama', schemaVersion: 169,
    nodes: [archive, image, review, unrelated], edges: [{ id: 'keep-edge' }] }
  const next = upgradeSceneCutOpeningProjectionWorkflow(graph)
  assert.equal(next.schemaVersion, 170)
  assert.equal(next.edges, graph.edges)
  assert.equal(next.nodes[3], unrelated)
  assert.deepEqual(next.nodes[0].params, [...archive.params, plate])
  assert.equal(next.nodes[1].prompt, SCENE_CUT_FIRST_FRAME_PROMPT_V170)
  assert.equal(next.nodes[2].prompt, SCENE_CUT_FRAME_REVIEW_PROMPT_V170)
  assert.equal(upgradeSceneCutOpeningProjectionWorkflow(next), next)
  const edited = { ...graph, nodes: graph.nodes.map(node => node.id === review.id
    ? { ...node, prompt: 'user edited' } : node) }
  assert.equal(upgradeSceneCutOpeningProjectionWorkflow(edited), edited)
})
