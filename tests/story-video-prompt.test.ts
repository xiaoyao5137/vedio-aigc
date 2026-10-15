import test from 'node:test'
import assert from 'node:assert/strict'
import { STORY_SHOT_IMAGE_PROMPT, STORY_SHOT_VIDEO_PROMPT,
  upgradeStoryShotImagePrompt, upgradeStoryShotVideoPrompt } from '../src/story-video-prompt.ts'

test('wf-story upgrades marker-only custom video prompts to carry the actual timed beats', () => {
  for (const custom of ['【节拍完成】保持氛围。', '根据已校验的剧本节拍生成视频，镜头固定。', '镜头固定。']) {
    const upgraded = upgradeStoryShotVideoPrompt(custom)
    assert.match(upgraded, /\$\{shot\.timedActions\}/)
    assert.match(upgraded, /至少 1 秒可读终态/)
    assert.equal(upgradeStoryShotVideoPrompt(upgraded), upgraded, 'normalization stays idempotent')
  }
})

test('wf-story migrates legacy beat placeholders without duplicating current bindings', () => {
  for (const old of ['本镜动作：${shotTimedActions}。', '本镜动作：${shot.content}。']) {
    assert.equal(upgradeStoryShotVideoPrompt(old), '本镜动作：${shot.timedActions}。')
  }
  const current = '本镜动作：${shot.timedActions}。'
  assert.equal(upgradeStoryShotVideoPrompt(current), current)
  assert.equal(upgradeStoryShotVideoPrompt(upgradeStoryShotVideoPrompt('${shotTimedActions}')),
    upgradeStoryShotVideoPrompt('${shotTimedActions}'))
})

test('story media defaults keep the dog a nonworking roommate and carry real animal calls', () => {
  assert.match(STORY_SHOT_IMAGE_PROMPT, /同居.*卷毛.*不上班/)
  assert.match(STORY_SHOT_VIDEO_PROMPT, /猫芙伊只发自然猫叫“喵”.*狗卷毛只发自然狗吠“汪”/)
  assert.match(STORY_SHOT_VIDEO_PROMPT, /绝不能由人声朗读、模仿或配音/)
  assert.match(STORY_SHOT_VIDEO_PROMPT, /自然环境声和动作音效.*不要把非叫声时段处理为静音/)
  assert.match(STORY_SHOT_IMAGE_PROMPT, /设备通话画面.*不在芙伊所在地另造一只实体狗/)
  assert.match(STORY_SHOT_VIDEO_PROMPT, /从设备传出.*不得在芙伊办公室凭空增加实体狗/)
  assert.doesNotMatch(STORY_SHOT_VIDEO_PROMPT, /无人话、旁白、配音或台词/)
  const oldVideo = '以输入首帧为开场，生成一段连续的9:16竖屏写实职场短视频。角色是具有猫狗外形的职场员工。生成与画面同步的自然环境声和动作音效，无人话、旁白、配音或台词。'
  assert.equal(upgradeStoryShotVideoPrompt(oldVideo), STORY_SHOT_VIDEO_PROMPT)
  const oldImage = '生成一张9:16竖屏写实摄影照片，作为拟人化职场短剧开场的静止首帧。按照本镜描述呈现职业服饰、工牌、直立或员工坐姿、办公空间与道具。'
  assert.equal(upgradeStoryShotImagePrompt(oldImage), STORY_SHOT_IMAGE_PROMPT)
})
