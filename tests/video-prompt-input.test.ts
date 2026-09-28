import test from 'node:test'
import assert from 'node:assert/strict'
import { videoPromptInputContext } from '../src/video-prompt-input.ts'
import { nodePromptInputContext } from '../src/review-input.ts'
import { renderRetryFeedbackPrompt, renderWorkflowTemplate } from '../src/workflow-template.ts'

const stillConstraint = '【静态尾帧】只呈现动作完成后的单一时间点与最终状态；单幅全画幅画面，禁止分镜、拼贴。'
const opening = '门客站于门前，双手拱于胸前，面向院外。'
const ending = '门客站立，双手仍拱于胸前，目光望向前方。'
const videoPrompt = '0-1秒：门客双手拱于胸前。1-5.4秒：门客欠身说第一句。5.4-9.8秒：保持拱手说第二句。9.8-13.1秒：微微点头说第三句。13.1-14秒：恢复直立，保持原手势。'
const shot = {
  id: 'custom-shot', visualPrompt: `${opening}\n${stillConstraint}`, lastFramePrompt: `${ending}\n${stillConstraint}`,
  videoPrompt, audioText: '门客：第一句。\n门客：第二句。\n门客：第三句。', duration: 14,
  performanceBeats: [{ startSecond: 5.4, endSecond: 9.8, action: '保持拱手', evidence: { text: '实际动作义务' } }],
  worldState: { characters: [{ name: '门客', heldProps: { status: 'unknown' } }] },
}

test('motion-state removes only appended image instructions from arbitrary nested storyboard variables', () => {
  const context = { custom_result: shot, params: { nested: { candidates: [shot] }, duration: 14, referenceImage: '/generated/actual-frame.jpg' },
    loop: { previous: { another_result: shot } }, retry: { feedback: '只修复5.4-9.8秒提前放手，保留全部台词与动作。' } }
  const before = JSON.stringify(context)
  const projected = videoPromptInputContext(context, 'motion-state')
  for (const candidate of [projected.custom_result, projected.params.nested.candidates[0], projected.loop.previous.another_result]) {
    assert.equal(candidate.visualPrompt, opening)
    assert.equal(candidate.lastFramePrompt, ending)
    assert.equal(candidate.videoPrompt, videoPrompt)
    assert.equal(candidate.audioText, shot.audioText)
    assert.equal(candidate.duration, 14)
    assert.equal(candidate.performanceBeats, shot.performanceBeats)
    assert.equal(candidate.worldState, shot.worldState)
  }
  assert.equal(projected.custom_result, projected.params.nested.candidates[0])
  assert.equal(projected.params.duration, 14)
  assert.equal(projected.params.referenceImage, context.params.referenceImage)
  assert.equal(projected.retry, context.retry)
  const prompt = renderWorkflowTemplate('开场：${custom_result.visualPrompt}\n动作：${custom_result.videoPrompt}\n尾部：${custom_result.lastFramePrompt}\n台词：${custom_result.audioText}', projected)
    + renderRetryFeedbackPrompt(projected.retry.feedback)
  assert.equal(prompt.includes('【静态尾帧】'), false)
  assert.equal(prompt.includes(videoPrompt), true)
  assert.equal(prompt.includes(ending), true)
  assert.equal(prompt.includes(context.retry.feedback), true)
  assert.equal(JSON.stringify(context), before, 'durable candidates and image-node inputs keep the image instructions')
  assert.equal(videoPromptInputContext(projected, 'motion-state'), projected)
})

test('default and text/image views retain the original still-image requirements', () => {
  const context = { shot }
  for (const mode of [undefined, null, '', 'normalized-results', 'motion-states']) assert.equal(videoPromptInputContext(context, mode), context)
  assert.equal(nodePromptInputContext(context, 'motion-state'), context, 'text input mode does not apply the video projection')
  const imagePrompt = renderWorkflowTemplate('${shot.lastFramePrompt}', context)
  assert.equal(imagePrompt, shot.lastFramePrompt)
  assert.equal(imagePrompt.includes(stillConstraint), true)
})

test('ordinary text and genuine motion instructions are retained even when they mention the still-frame marker', () => {
  const motion = '抬手后拱手，9秒再放下；【静态尾帧】是说明中的逐字引用，不得因此删动作。'
  const context = { standalone: { visualPrompt: `${opening}${stillConstraint}`, lastFramePrompt: `${ending}${stillConstraint}` },
    candidate: { videoPrompt: motion, lastFramePrompt: ending, visualPrompt: '  原场景正文  ', audioText: '台词含【静态尾帧】四字', dialogue: [{ text: '【静态尾帧】' }] },
    report: { text: `证据：${stillConstraint}`, issues: [{ text: stillConstraint }] }, plainText: stillConstraint }
  assert.equal(videoPromptInputContext(context, 'motion-state'), context, 'only known appended state fields in a storyboard are projected')
})
