import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { SANGUO_CINEMATIC_STORYBOARD_PROMPT as prompt,
  SANGUO_STORYBOARD_PROMPT_BEFORE_AUDIO_LINE_BINDING as timingPrompt,
  SANGUO_STORYBOARD_PROMPT_BEFORE_TRUSTED_TAIL_STATE as beforeTrustedTail,
  refreshStoryboardEditorialPrompt } from '../src/storyboard-prompt.ts'
import { SANGUO_STORYBOARD_PROMPT_BEFORE_DISPLAY_TIMING as legacy } from '../src/legacy-storyboard-timing-prompt.ts'
import { SANGUO_DRAMATIC_EXPRESSION_STORYBOARD_PROMPT } from '../src/dramatic-expression.ts'
import { SANGUO_SAND_TABLE_WRITING_PROMPT } from '../src/sand-table-contract.ts'

const line = (prefix: string) => {
  const matches = prompt.split('\n').filter(value => value.startsWith(prefix))
  assert.equal(matches.length, 1, `exactly one contract paragraph: ${prefix}`)
  return matches[0]
}

test('initial writer applies declared windows without beats and uses their actual latest end', () => {
  const ordinary = line('- 普通预算：')
  assert.match(ordinary, /仅计算audioText实际说话正文，不计说话人标签/)
  assert.match(ordinary, /未提供activityWindows且无performanceBeats时，duration=max\(3,ceil\(speechSeconds\+actionSeconds\+reactionSeconds\+0\.3\)\)/)
  const windows = line('- 若pacing声明activityWindows:')
  assert.match(windows, /即使performanceBeats未提供或为空，也必须校验/)
  assert.match(windows, /有限数值，0<=startSecond<endSecond/)
  assert.match(windows, /各类窗口合计分别对应speechSeconds\/actionSeconds\/reactionSeconds，同类窗口不得重叠/)
  assert.match(windows, /plannedEndSecond取所有activityWindows与performanceBeats的最晚endSecond/)
  assert.match(windows, /duration=max\(3,ceil\(plannedEndSecond\+0\.3\)\)，上限15/)
  assert.match(windows, /并集长度不能抹去时间偏移或空档/)
  assert.match(windows, /不能把活动窗强行拉长到duration/)
  assert.doesNotMatch(prompt, /整体按区间并集\+0\.3秒取整/)
})

test('initial writer reserves the full dependent action after speech and preserves original obligations', () => {
  const sequence = line('- 原剧情或已声明动作有')
  assert.match(sequence, /前置事件、可观察起始状态、连续完成区间与完成后的状态/)
  assert.match(sequence, /最后一句speech窗口结束之后安排/)
  assert.match(sequence, /按原动作实际需要预留独立完成时间，动作完成后再留0\.3秒剪辑余量/)
  assert.match(sequence, /不能把只够说话的区间同时当作说完后的动作时间/)
  assert.match(sequence, /完整保留台词、原动作和自然幅度，超过15秒就连续拆段/)
  assert.match(sequence, /不能据此认定实片动作已完成或新增验收义务/)
})

test('framing guidance makes existing changes visible without inventing motion or observation', () => {
  const framing = line('- 对本段原已要求的状态变化')
  assert.match(framing, /沿用已批准机位意图和视线轴线/)
  assert.match(framing, /相关身体部位、持物归属与变化方向的景别、角度/)
  assert.match(framing, /不为质检新增微动作或夸大原动作幅度/)
  assert.match(framing, /不把计划中的可观察性写成实际已观察证据/)
})

test('the importable migration anchor exactly preserves the frozen original writer and literal placeholders', () => {
  assert.equal(legacy.length, 5158)
  assert.equal(createHash('sha256').update(legacy).digest('hex'), 'dfde14390eae54dbcbf5530fdfea4044712521eef2a5cd6b1d3f59071cb5a2a0')
  for (const placeholder of ['${input.episode_title}', '${input.aspect_ratio}', '${scene}', '${historical_sources.text}', '${loop.previous.video_shot.worldState}']) {
    assert.ok(legacy.includes(placeholder))
    assert.ok(timingPrompt.includes(placeholder))
  }
  assert.ok(prompt.includes('${loop.previous.shot_script.worldState}'))
  assert.ok(!prompt.includes('${loop.previous.video_shot.worldState}'))
  assert.equal(legacy.endsWith('单纯走出画框或切为他人特写不构成离场。\n'), true)
})

test('the timing increment preserves every unrelated writer paragraph and JSON field', () => {
  const changed = ['- 普通预算：', '- 确需超过自然反应预算的无声表演，']
  const added = ['- 对本段原已要求的状态变化，', '- 若pacing声明activityWindows:', '- 原剧情或已声明动作有']
  const without = (text: string, prefixes: string[]) => text.split('\n').filter(value => !prefixes.some(prefix => value.startsWith(prefix))).join('\n')
  assert.equal(without(timingPrompt, [...changed, ...added]), without(legacy, changed))
})

test('trusted-tail and editorial guidance leave historical writer anchors frozen', () => {
  assert.equal(beforeTrustedTail.length, 6192)
  assert.equal(createHash('sha256').update(beforeTrustedTail).digest('hex'), '1794ee395778b93405709385de55d24fc61f25c1f3a671b268f21a3107286150')
  const withoutStateGuidance = (text: string) => text.split('\n').filter(line => !line.startsWith('- worldState')
    && !line.startsWith('上一镜已采证世界状态：') && !line.startsWith('上一镜开场继承用的可信世界状态')).join('\n')
  const editorialBaseline = refreshStoryboardEditorialPrompt(beforeTrustedTail)
    .replace('"shotIntent":{"viewpointCharacter":"本镜关注人物"', '"shotIntent":{"viewpointCharacter":"本镜关注人物；无人编辑镜头固定为观众"')
    .replace('"visualPrompt":"开场静态实景、可见人物汉字全名、稳定外观、构图和持物"', '"visualPrompt":"真人镜写开场实景与可见人物；历史地图镜只写无字、无箭头、无人物的地理底板"')
    .replace('"lastFramePrompt":"单一时间点的末帧实际预期：可见人物全名、最终站位持物"', '"lastFramePrompt":"真人镜写人物末帧；历史地图镜只写无字、无箭头、无人物的地理底板结果"')
  // The current template adds editorial guidance; the importable migration
  // anchors and all unrelated timing/continuity clauses still stay frozen.
  assert.ok(prompt.includes(SANGUO_DRAMATIC_EXPRESSION_STORYBOARD_PROMPT))
  assert.ok(prompt.includes(SANGUO_SAND_TABLE_WRITING_PROMPT))
  assert.ok(!beforeTrustedTail.includes(SANGUO_DRAMATIC_EXPRESSION_STORYBOARD_PROMPT))
  const beforeExpression = prompt.replace('\n\n' + SANGUO_DRAMATIC_EXPRESSION_STORYBOARD_PROMPT, '')
    .replace('\n\n' + SANGUO_SAND_TABLE_WRITING_PROMPT, '')
    .replace('"mood":"符合本场力度与变化的具体情绪"', '"mood":"克制的具体情绪"')
  assert.equal(withoutStateGuidance(beforeExpression), withoutStateGuidance(editorialBaseline))
  assert.ok(beforeTrustedTail.includes('${loop.previous.video_shot.worldState}'))
  assert.ok(prompt.includes('${loop.previous.shot_script.worldState}'))
})
