import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compactManagedVideoProviderPrompt, renderVideoProviderPrompt, subtitleFreeVideoPrompt } from '../src/video-provider-prompt.ts'
import { EDITORIAL_VIDEO_PROMPT } from '../src/quality-node-presets.ts'
import { compileKlingVoices, nativeGroupVoicePlan } from '../src/character-voice.ts'
import { speechPerformanceContract } from '../src/speech-performance.ts'
import { prepareThreeViewVideoReferences } from '../server/image-references.ts'
import { buildKlingVideoRequest, callKlingVideo, hardenKlingDialoguePrompt, klingThreeViewVideoPrompt } from '../server/model-adapters.ts'
import { validateWorkflowMediaContract } from '../server/workflow-contracts.ts'
import { projectIndependentNarration } from '../server/narration-projection.ts'
import { appendLipSyncContract } from '../src/workflow-core.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/crr7s5-provider-prompt-overload.json', import.meta.url), 'utf8'))
const source = fixture.prompt as string
const ownedLine = source.split('\n').find(line => line.startsWith('【视觉处理硬约束】'))!
const noNetwork = async () => { throw new Error('Offline preparation must not fetch assets or providers') }

test('the actual local rejection is reproduced after full identity, performance and fixed voice instructions', async () => {
  const params = await prepareThreeViewVideoReferences(fixture.params, noNetwork)
  assert.equal(params.referenceMode, 'identity-sheet')
  const referenced = klingThreeViewVideoPrompt(source, params)
  const guarded = hardenKlingDialoguePrompt(referenced, 'duration-v2')
  const original = compileKlingVoices([guarded, speechPerformanceContract(params)].join('\n').replaceAll('@参考附件1', '<<<image_1>>>'), params, 'kling-v3-omni', true)
  assert.equal(Array.from(original.prompt).length, 2572)
  // Nonmatching metadata must leave this exact overflowing source untouched.
  assert.throws(() => buildKlingVideoRequest(fixture.model, referenced, { ...params, visualTreatment: 'animated' }), /STORYBOARD_PROMPT_OVERLOAD/)
  const request = buildKlingVideoRequest(fixture.model, referenced, params)
  assert.ok(Array.from(String(request.prompt)).length <= 2500)
  assert.match(String(request.prompt), /【因果动作锁】/)
  assert.equal(request.duration, '15')
  assert.deepEqual(request.element_list, original.fields.element_list)
  assert.deepEqual(request.image_list, [{ image_url: fixture.params.referenceImages[0] }, { image_url: fixture.params.referenceImage, type: 'first_frame' }])
  assert.ok(String(request.prompt).includes(fixture.expectedTimeline))
  assert.ok(String(request.prompt).includes(fixture.params.videoTimeline), 'signed windows and complete voice/ending block stay byte-for-byte identical')
  assert.ok(String(request.prompt).includes(fixture.params.audioText))
  for (const line of source.split('\n').filter(line => line !== ownedLine)) assert.ok(String(request.prompt).includes(line), line)
  assert.match(String(request.prompt), /实际首帧优先/)
  assert.match(String(request.prompt), /同一具名角色在成片中只能对应一个人/)
  assert.match(String(request.prompt), /身份参考与动作分离/)
  assert.match(String(request.prompt), /逐声部声画绑定/)
  assert.match(String(request.prompt), /人物声音绑定/)
  assert.doesNotMatch(String(request.prompt), /content shortened/)
  assert.doesNotThrow(() => validateWorkflowMediaContract({ model: fixture.model, prompt: referenced, params,
    executionContext: { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-video' } }))
})

test('only the known owned line is projected, preserving the complete authored prompt and current template compatibility', () => {
  const before = structuredClone(fixture.params)
  const rendered = renderVideoProviderPrompt(source, fixture.params)
  const shortened = rendered.split('\n').find(line => line.startsWith('【视觉处理硬约束】'))!
  assert.equal(ownedLine.length, 433)
  assert.equal(shortened.length, 99)
  assert.equal(rendered.replace(shortened, ownedLine), source)
  assert.equal(renderVideoProviderPrompt(rendered, fixture.params), rendered)
  assert.deepEqual(fixture.params, before)
  const currentLine = EDITORIAL_VIDEO_PROMPT.split('\n').find(line => line.startsWith('【视觉处理硬约束】'))!
  const currentSource = source.replace(ownedLine, currentLine)
  assert.equal(renderVideoProviderPrompt(currentSource, fixture.params), rendered)
})

test('unknown rules, authored additions and conflicting route metadata are never deleted or rewritten', () => {
  for (const candidate of [source.replace(ownedLine, ownedLine + '自定义：全片保持雨夜。'),
    source.replace(ownedLine, ownedLine.replace('可信时代环境', '自定义战争环境')),
    source + '\n【视觉处理硬约束】保留作者指定道具。',
    source + '\n【本镜影视处理】live_action / story']) {
    assert.equal(renderVideoProviderPrompt(candidate, fixture.params), candidate)
  }
  for (const overrides of [{ visualTreatment: 'animated' }, { editorialRole: 'context_bridge' },
    { pacingVersion: 'dynamic-v1' }, { visualTreatment: undefined }]) {
    assert.equal(renderVideoProviderPrompt(source, { ...fixture.params, ...overrides }), source)
  }
})

test('earlier authored quotations of a managed rule remain exact and CRLF delimiters are preserved', () => {
  const quote = `作者要求保留原文引用：${ownedLine}`
  const withQuote = quote + '\r\n' + source.replaceAll('\n', '\r\n')
  const expected = quote + '\r\n' + renderVideoProviderPrompt(source, fixture.params).replaceAll('\n', '\r\n')
  const actual = renderVideoProviderPrompt(withQuote, fixture.params)
  assert.equal(actual, expected)
  assert.equal(actual.split('\r\n')[0], quote)
  assert.equal(actual.split('\r\n').filter(line => line.startsWith('【视觉处理硬约束】')).length, 1)
  assert.equal(renderVideoProviderPrompt(actual, fixture.params), actual)
})

test('the complete provider submission keeps all original content and rejects any remaining overflow before POST', async () => {
  let submissions = 0
  let captured: Record<string, unknown> = {}
  const dependencies = { fetch: async (_input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, 'POST', 'principle identity preparation keeps the complete existing sheet without a download')
    submissions++
    captured = JSON.parse(String(init.body))
    return new Response(JSON.stringify({ code: 0, data: { task_id: 'offline-test-only', task_status: 'succeed',
      task_result: { videos: [{ url: 'https://media.example.test/test.mp4' }] } } }), { status: 200 })
  } }
  await callKlingVideo(fixture.model, source, fixture.params, dependencies)
  assert.equal(submissions, 1)
  assert.ok(Array.from(String(captured.prompt)).length <= 2500)
  assert.match(String(captured.prompt), /【因果动作锁】/)
  assert.ok(String(captured.prompt).includes(fixture.params.videoTimeline))
  assert.ok(String(captured.prompt).includes(fixture.params.audioText))
  const mandatoryLongBody = source + '\n【作者新增动作】' + '保持全部原动作与台词。'.repeat(120)
  await assert.rejects(() => callKlingVideo(fixture.model, mandatoryLongBody, fixture.params, dependencies), /STORYBOARD_PROMPT_OVERLOAD/)
  const customRule = source.replace(ownedLine, ownedLine + '全片保持雨夜。')
  await assert.rejects(() => callKlingVideo(fixture.model, customRule, fixture.params, dependencies), /STORYBOARD_PROMPT_OVERLOAD/)
  assert.equal(submissions, 1, 'remaining content/custom-rule overflow cannot buy a truncated provider request')
})

test('the actual independent narration route retains the full picture request and fits without truncation', async () => {
  const narration = JSON.parse(readFileSync(new URL('./fixtures/independent-narration-provider-overload.json', import.meta.url), 'utf8'))
  const snapshot = structuredClone(narration)
  const projection = projectIndependentNarration(narration.prompt, narration.params)
  const params = await prepareThreeViewVideoReferences(projection.params, noNetwork)
  const referenced = klingThreeViewVideoPrompt(projection.prompt, params)
  const originalRule = referenced.split('\n').find(line => line.startsWith('【视觉处理硬约束】'))!
  const rendered = renderVideoProviderPrompt(referenced, params)
  const applicableRule = rendered.split('\n').find(line => line.startsWith('【视觉处理硬约束】'))!
  assert.equal(rendered.replace(applicableRule, originalRule), referenced, 'only the known inapplicable animation branch changes')
  assert.equal(renderVideoProviderPrompt(rendered, params), rendered)
  assert.equal(Array.from(narration.prompt).length, 2662)
  assert.equal(Array.from(projection.prompt).length, 1913)
  assert.equal(Array.from(referenced).length, 2519)
  const request = buildKlingVideoRequest(narration.model, referenced, params)
  assert.equal(Array.from(String(request.prompt)).length, 2335)
  assert.equal(request.duration, '8')
  assert.deepEqual(request.image_list, narration.params.referenceImages.map((image_url: string) => ({ image_url })))
  const restoreImageMarkers = String(request.prompt).replace(/<<<image_(\d+)>>>/g, '@参考附件$1')
  for (const line of referenced.split('\n').filter(line => line !== originalRule)) assert.ok(restoreImageMarkers.includes(line), line)
  for (const segment of projection.segments) assert.ok(narration.params.audioText.includes(segment.text), 'independent synthesis preserves every word')
  assert.match(String(request.prompt), /首帧人物锁定.*张飞只能在3\.5-7秒/)
  assert.match(String(request.prompt), /人物身份参考：刘备：<<<image_1>>>.*张飞：<<<image_2>>>/)
  assert.match(String(request.prompt), /画内人物不朗读、不作说话口型/)
  assert.deepEqual(narration, snapshot, 'approved source, timing and identity inputs are never mutated')

  let posts = 0
  const dependencies = { fetch: async (_url: string | URL | Request, init?: RequestInit) => {
    posts++
    const posted = JSON.parse(String(init?.body))
    assert.equal(posted.prompt, request.prompt)
    return new Response(JSON.stringify({ code: 0, data: { task_id: 'offline-only', task_status: 'succeed',
      task_result: { videos: [{ url: 'https://media.example.test/test.mp4' }] } } }), { status: 200 })
  } }
  await callKlingVideo(narration.model, projection.prompt, projection.params, dependencies)
  assert.equal(posts, 1)
  await assert.rejects(() => callKlingVideo(narration.model, projection.prompt + '\n【作者动作】' + '继续原有动作。'.repeat(30), projection.params, dependencies), /STORYBOARD_PROMPT_OVERLOAD/)
  assert.equal(posts, 1, 'the complete final 2500-character gate still blocks remaining overflow before POST')
})

test('a signed scene-cut frame replaces only duplicate managed prose and preserves the required final action', () => {
  const narration = JSON.parse(readFileSync(new URL('./fixtures/independent-narration-provider-overload.json', import.meta.url), 'utf8'))
  const projection = projectIndependentNarration(narration.prompt, narration.params)
  const finalState = projection.params.pacing.beats.findLast((beat: { completion?: { modality?: string; requiredThisClip?: boolean } }) =>
    beat.completion?.modality === 'visual' && beat.completion.requiredThisClip)?.completion.finalState as string
  const opening = '已批准的开场环境和人物位置。'.repeat(28)
  const ending = '各人物完成动作后留在原位。'.repeat(20)
  const still = '【静态尾帧】同一完整场景，不新增人物、文字或动作。'
  const params = {
    ...projection.params,
    scheduleHash: projection.params.pacing.scheduleHash,
    sceneCutShot: { visualPrompt: opening, lastFramePrompt: `${ending}\n${still}` },
    sceneCutFrameGate: { passed: true, frame: { sourceUrl: '/generated/approved.png' } },
    referenceImage: 'data:image/png;base64,AAAA', firstFrameMode: 'reference',
    videoTimeline: `完整执行已签署的动作时间轴。${finalState}`,
  }
  const prompt = `${renderVideoProviderPrompt(projection.prompt, params)}\n${params.videoTimeline}\n【场景与开场画面】${opening}\n【本镜结束时的自然动作结果】${ending}\n${still}\n【作者动作】保留原有节拍和角色关系。`
  const compact = compactManagedVideoProviderPrompt(prompt, params)
  assert.ok(compact.length < prompt.length - 200)
  assert.ok(compact.includes(finalState))
  assert.ok(compact.includes(params.videoTimeline))
  assert.ok(compact.includes('【作者动作】保留原有节拍和角色关系。'))
  assert.ok(!compact.includes(opening))
  assert.ok(compactManagedVideoProviderPrompt(prompt, { ...params, sceneCutFrameGate: { passed: false } }).includes(opening))
  assert.ok(compactManagedVideoProviderPrompt(prompt, { ...params, videoTimeline: '缺失最终视觉完成态' }).includes(opening))
})

test('a signed coverage first frame removes only its duplicate opening brief from the video prompt', () => {
  const narration = JSON.parse(readFileSync(new URL('./fixtures/independent-narration-provider-overload.json', import.meta.url), 'utf8'))
  const projection = projectIndependentNarration(narration.prompt, narration.params)
  const opening = '严颜由两名军士押向院门，张飞留在原位。'.repeat(18)
  const referenceImage = 'data:image/png;base64,AAAA'
  const params = { ...projection.params, scheduleHash: projection.params.pacing.scheduleHash,
    firstFrameMode: 'reference', referenceImage,
    coverageShot: { visualPrompt: opening },
    coverageCutFrameGate: { passed: true, frames: [
      { role: 'previous_tail', sourceUrl: '/generated/previous-tail.png' },
      { role: 'candidate_first', sourceUrl: referenceImage },
    ] } }
  const prompt = `${renderVideoProviderPrompt(projection.prompt, params)}\n【场景与开场画面】${opening}\n【作者动作】保留已批准的动作时间轴。`
  const compact = compactManagedVideoProviderPrompt(prompt, params)
  assert.ok(!compact.includes(opening))
  assert.ok(compact.includes('【作者动作】保留已批准的动作时间轴。'))
  assert.ok(!compactManagedVideoProviderPrompt(prompt, { ...params,
    coverageCutFrameGate: { ...params.coverageCutFrameGate, frames: [
      { role: 'candidate_first', sourceUrl: '/generated/approved-coverage-first.png' },
    ] } }).includes(opening), 'provider image preparation may replace the signed source URL with validated image bytes')
  assert.ok(compactManagedVideoProviderPrompt(prompt, { ...params, coverageCutFrameGate: { passed: false, frames: params.coverageCutFrameGate.frames } }).includes(opening))
  assert.ok(compactManagedVideoProviderPrompt(prompt, { ...params, referenceImage: '/generated/different.png' }).includes(opening))
})

test('independent route claims, incomplete contracts and custom visual rules cannot enable projection', async () => {
  const narration = JSON.parse(readFileSync(new URL('./fixtures/independent-narration-provider-overload.json', import.meta.url), 'utf8'))
  const projection = projectIndependentNarration(narration.prompt, narration.params)
  for (const change of [{ audioType: '旁白' }, { audioText: '旁白：仍有同期词语' }, { sound: 'off' },
    { characterVoices: [{}] }, { characterVoices: undefined }, { visualTreatment: 'animated' }]) {
    assert.equal(renderVideoProviderPrompt(projection.prompt, { ...projection.params, ...change }), projection.prompt)
  }
  assert.equal(renderVideoProviderPrompt(narration.prompt, projection.params), narration.prompt, 'version metadata alone is insufficient')
  for (const modified of [projection.prompt.replace('本次不得生成任何可辨词语或配音；', ''),
    projection.prompt + '\n' + projection.prompt.split('\n').find((line: string) => line.startsWith('【独立画外配音】')),
    projection.prompt.replace(ownedLine, ownedLine + '作者要求始终保留夜雨。')]) {
    assert.equal(renderVideoProviderPrompt(modified, projection.params), modified)
  }
})

const native = JSON.parse(readFileSync(new URL('./fixtures/native-dialogue-provider-overload.json', import.meta.url), 'utf8'))

async function completeNativePrompt() {
  const params = await prepareThreeViewVideoReferences(native.params, noNetwork)
  const references = klingThreeViewVideoPrompt(native.prompt, params)
  const guarded = hardenKlingDialoguePrompt(subtitleFreeVideoPrompt(renderVideoProviderPrompt(references, params), params), 'duration-v2')
  const compiled = compileKlingVoices([guarded, speechPerformanceContract(params)].join('\n')
    .replace(/@参考附件(\d+)/g, '<<<image_$1>>>'), params, 'kling-v3-omni', true)
  return { params, references, compiled }
}

test('actual two-person native dialogue retains every authored timeline, word, rider and voice binding within 2500', async () => {
  const original = structuredClone(native)
  const { params, references, compiled } = await completeNativePrompt()
  assert.equal(Array.from(compiled.prompt).length, 3172)
  const compact = compactManagedVideoProviderPrompt(compiled.prompt, params)
  assert.equal(Array.from(compact).length, 2475)
  assert.equal(compactManagedVideoProviderPrompt(compact, params), compact)
  const request = buildKlingVideoRequest(native.model, references, params)
  assert.equal(request.prompt, compact)
  assert.equal(request.duration, '13')
  assert.deepEqual(request.element_list, compiled.fields.element_list)
  assert.deepEqual(request.image_list, native.params.referenceImages.map((image_url: string) => ({ image_url })))
  assert.ok(compact.includes(native.params.videoTimeline.split('\n【声部与收束】')[0]), 'complete authored chronology, pauses and dependencies are untouched')
  for (const line of native.prompt.split('\n').filter((line: string) => !/^【(?:视觉处理硬约束|声部与收束)】/.test(line))) assert.ok(compact.includes(line), line)
  assert.ok(compact.includes(native.params.audioText))
  assert.match(compact, /b03-order \["刘备"\]对白（0\.7至4\.381秒参考）："张飞，带二十骑挡住追兵！"/)
  assert.match(compact, /b03-answer \["张飞"\]对白（4\.381至5\.791秒参考）："你先走。"/)
  assert.match(compact, /二十名骑士全部由真人骑马完成，不包含张飞/)
  assert.match(compact, /两行各十名真人骑士/)
  assert.match(compact, /刘备对应<<<element_1>>>.*张飞对应<<<element_2>>>/)
  assert.match(compact, /画内完整词与本人口型同步始终/)
  assert.match(compact, /动作回应完成后留0\.5秒可读收尾/)
  assert.deepEqual(native, original)
  let posts = 0
  const dependencies = { fetch: async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, 'POST')
    posts++
    assert.deepEqual(JSON.parse(String(init.body)), request)
    return new Response(JSON.stringify({ code: 0, data: { task_id: 'offline-native-only', task_status: 'succeed',
      task_result: { videos: [{ url: 'https://media.example.test/native.mp4' }] } } }), { status: 200 })
  } }
  await callKlingVideo(native.model, native.prompt, native.params, dependencies)
  assert.equal(posts, 1)
  await assert.rejects(() => callKlingVideo(native.model, native.prompt + '\n【作者额外动作】' + '骑'.repeat(26), native.params, dependencies), /STORYBOARD_PROMPT_OVERLOAD/)
  assert.equal(posts, 1, 'remaining overflow fails before a second POST; no content is truncated')
})

test('compiler mismatches, added constraints and invalid clocks cannot enable compact native contracts', async () => {
  const { params, compiled } = await completeNativePrompt()
  for (const modified of [compiled.prompt.replace('"beatId":"b03-answer"', '"beatId":"unknown-answer"'),
    compiled.prompt.replace('0.5 秒可读收尾', '0.5 秒可读收尾并保留作者新增雨声'),
    compiled.prompt + '\n' + compiled.prompt.split('\n').find(line => line.startsWith('【声部与收束】'))]) {
    assert.equal(compactManagedVideoProviderPrompt(modified, params), modified)
    assert.throws(() => buildKlingVideoRequest(native.model, modified, params), /STORYBOARD_PROMPT_OVERLOAD/)
  }
  for (const change of [{ pacingVersion: 'dynamic-v1' }, { visualTreatment: 'animated' },
    { pacing: { ...params.pacing, timingPolicy: { ...params.pacing.timingPolicy, version: 'unknown-policy' } } }]) {
    assert.equal(compactManagedVideoProviderPrompt(compiled.prompt, { ...params, ...change }), compiled.prompt)
  }
  const quoted = `作者引用：${compiled.prompt.split('\n').find(line => line.startsWith('【声部与收束】'))}\r\n`
  const withQuotation = quoted + compiled.prompt.replaceAll('\n', '\r\n')
  assert.ok(compactManagedVideoProviderPrompt(withQuotation, params).startsWith(quoted), 'quoted metadata is not rewritten')
  const customPerformance = compiled.prompt.replace('【逐声部声画绑定】', '【逐声部声画绑定】作者额外要求：')
  assert.ok(compactManagedVideoProviderPrompt(customPerformance, params).includes(customPerformance.split('\n').find(line => line.startsWith('【逐声部声画绑定】'))!))
})

test('anonymous native group voices keep full original speech, collective staging and voice-profile evidence', () => {
  const group = JSON.parse(readFileSync(new URL('./fixtures/native-group-scene-15.json', import.meta.url), 'utf8'))
  const params = { ...group, pacingVersion: 'duration-v2', sound: 'on', qualityDisposition: 'manual-review-v1',
    visualTreatment: 'live_action', editorialRole: 'story', characterVoices: [],
    pacing: { ...group.pacing, actorGroups: group.pacing.actorGroups.map((actor: Record<string, unknown>) => ({ ...actor,
      voiceProfile: { description: '同一群体齐声回应', genderPresentation: '中性声线', texture: '粗粝' } })) } }
  const groups = nativeGroupVoicePlan(params)
  assert.equal(groups.length, 1)
  const compiler = appendLipSyncContract(group.videoPrompt, group.audioType, group.audioText, group.characters, params)
  const source = `【本镜影视处理】live_action / story\n${ownedLine}\n${compiler}\n【完整音轨】${group.audioText}`
  const guarded = hardenKlingDialoguePrompt(renderVideoProviderPrompt(source, params), 'duration-v2')
  const full = compileKlingVoices(guarded + '\n' + speechPerformanceContract(params), { ...params, nativeGroupVoices: groups }, 'kling-v3-omni', true).prompt
  const compact = compactManagedVideoProviderPrompt(full, params)
  assert.ok(compact.length < full.length)
  assert.ok(compact.includes(compiler.split('\n【声部与收束】')[0]))
  assert.ok(compact.includes(group.audioText))
  assert.match(compact, /万余信众按原台词、顺序及群体表演由原生声音演绎/)
  assert.match(compact, /万余信众/)
  assert.match(compact, /同一群体齐声回应、中性声线、粗粝/)
  assert.match(compact, /\["crowd-believers"\]对白/)
  assert.match(compact, /画内完整词与本人口型同步始终/)
  assert.equal(groups[0].status, 'unbound')
  assert.equal(groups[0].speechVerified, false)
  assert.equal(groups[0].lipSyncVerified, false)
})
