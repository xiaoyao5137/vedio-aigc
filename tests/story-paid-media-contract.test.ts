import test from 'node:test'
import assert from 'node:assert/strict'
import { validateWorkflowMediaContract } from '../server/workflow-contracts.ts'
import { renderStoryShotTimedActions } from '../src/story-shot-timing.ts'

function reviewedShot() {
  const shot = {
    title: '早餐舍友',
    content: '0—2秒：芙伊把早餐袋举给卷毛看并叫喵儿；2—4秒：卷毛叫旺回应，把另一袋放进芙伊通勤包。',
    firstFramePrompt: '早餐店顾客侧，芙伊穿通勤外套拿两袋早餐；卷毛穿休闲衣背游玩包，作为顾客站在她身边。',
    mood: '工作赚钱养家的芙伊与无业游玩的卷毛是同居舍友，互相回应。',
    camera: '固定中景', duration: 5, audioContractVersion: 'animal-interaction-v1',
    visualBeats: [
      { id: 'cat', action: '芙伊把早餐袋举给卷毛看并叫喵儿', completion: '芙伊举着早餐袋', startSecond: 0, endSecond: 2 },
      { id: 'dog', action: '卷毛叫旺回应，把另一袋放进芙伊通勤包', completion: '卷毛把另一袋放入包内', startSecond: 2, endSecond: 4 },
    ],
    vocalBeats: [
      { id: 'cat-call', speaker: '芙伊', utterance: '喵儿', startSecond: 0.7, endSecond: 1.2,
        visualBeatId: 'cat', responseTo: null },
      { id: 'dog-reply', speaker: '卷毛', utterance: '旺', startSecond: 2.3, endSecond: 2.8,
        visualBeatId: 'dog', responseTo: 'cat-call' },
    ],
  }
  return { ...shot, timedActions: renderStoryShotTimedActions(shot) }
}

function paidImage(shot: ReturnType<typeof reviewedShot>) {
  return { model: { capability: 'image' }, prompt: `真实首帧：${shot.firstFramePrompt}`,
    params: { storyShot: shot }, executionContext: { workflowId: 'wf-story', nodeId: 'node-image' } }
}

function paidVideo(shot: ReturnType<typeof reviewedShot>) {
  return { model: { capability: 'video' }, prompt: `真实视频：${shot.timedActions}`,
    params: { storyShot: shot, duration: shot.duration, expectedDuration: shot.duration,
      requiredPromptText: shot.timedActions, sound: 'on', requiredSound: 'on' },
    executionContext: { workflowId: 'wf-story', nodeId: 'node-video' } }
}

test('reviewed roommate shot binds both paid image and video requests', () => {
  const shot = reviewedShot()
  assert.doesNotThrow(() => validateWorkflowMediaContract(paidImage(shot)))
  assert.doesNotThrow(() => validateWorkflowMediaContract(paidVideo(shot)))
})

test('saved timed vocal shots keep their reviewed clock at both paid gates', () => {
  const shot = reviewedShot()
  const legacy = { ...shot, timedActions: renderStoryShotTimedActions(shot, 'legacy-timed') }
  assert.notEqual(legacy.timedActions, shot.timedActions)
  assert.doesNotThrow(() => validateWorkflowMediaContract(paidImage(legacy)))
  assert.doesNotThrow(() => validateWorkflowMediaContract(paidVideo(legacy)))
  const changedCall = { ...legacy, vocalBeats: legacy.vocalBeats.map((beat, index) => index === 0
    ? { ...beat, startSecond: 0.8, endSecond: 1.4 } : beat) }
  assert.throws(() => validateWorkflowMediaContract(paidImage(changedCall)), /STORY_PAID_SHOT_MISMATCH/)
  assert.throws(() => validateWorkflowMediaContract(paidVideo(changedCall)), /STORY_PAID_SHOT_MISMATCH/)
})

test('old silent or coworker shots cannot reach either paid media node through saved loop output', () => {
  const shot = reviewedShot()
  const oldSilent = { ...shot, audioContractVersion: undefined, vocalBeats: undefined }
  for (const request of [paidImage(oldSilent as never), paidVideo(oldSilent as never)]) {
    assert.throws(() => validateWorkflowMediaContract(request), /ANIMAL_INTERACTION_INVALID/)
  }
  const wrongRole = { ...shot, firstFramePrompt: '卷毛戴工牌站在咖啡店收银位，芙伊来取餐。' }
  for (const request of [paidImage(wrongRole), paidVideo(wrongRole)]) {
    assert.throws(() => validateWorkflowMediaContract(request), /STORY_PERSONA_INVALID/)
  }
  const servingAction = '卷毛叫旺回应，给顾客端咖啡并收钱，芙伊赶着去上班'
  const servingBeats = [shot.visualBeats[0], { ...shot.visualBeats[1], action: servingAction }]
  const servingContent = `0—2秒：${shot.visualBeats[0].action}；2—4秒：${servingAction}。`
  const servingShot = { ...shot, content: servingContent, visualBeats: servingBeats,
    timedActions: renderStoryShotTimedActions({ ...shot, content: servingContent, visualBeats: servingBeats }) }
  const hiddenStaffRole = [
    { ...shot, firstFramePrompt: '卷毛系围裙站在咖啡店吧台，接过客人的订单并递出拿铁。' },
    servingShot,
  ]
  for (const savedShot of hiddenStaffRole) {
    for (const request of [paidImage(savedShot), paidVideo(savedShot)]) {
      assert.throws(() => validateWorkflowMediaContract(request), /STORY_PERSONA_INVALID/)
    }
  }
})

test('paid boundary rejects missing or forged reviewed shot bindings', () => {
  const shot = reviewedShot()
  assert.throws(() => validateWorkflowMediaContract({ ...paidImage(shot), params: {} }), /STORY_PAID_SHOT_REQUIRED/)
  assert.throws(() => validateWorkflowMediaContract({ ...paidImage(shot), prompt: '未绑定原首帧' }), /STORY_PAID_IMAGE_MISMATCH/)
  assert.throws(() => validateWorkflowMediaContract({ ...paidVideo(shot), params: { ...paidVideo(shot).params,
    requiredPromptText: '伪造的时间轴' } }), /STORY_PAID_VIDEO_MISMATCH/)
  assert.throws(() => validateWorkflowMediaContract({ ...paidVideo(shot), prompt: `${shot.timedActions}\n仅环境声与动作音效` }), /STORY_PAID_VIDEO_SILENT_CONFLICT/)
  assert.throws(() => validateWorkflowMediaContract({ ...paidVideo(shot), params: { ...paidVideo(shot).params,
    sound: 'off' } }), /STORY_PAID_VIDEO_MISMATCH/)
})
