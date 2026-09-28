import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { subtitleFreeVideoPrompt, VIDEO_NO_SUBTITLES_CONTRACT, VIDEO_NO_SUBTITLES_NEGATIVE } from '../src/video-provider-prompt.ts'
import { buildKlingVideoRequest, callKlingVideo } from '../server/model-adapters.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/crr7s5-provider-prompt-overload.json', import.meta.url), 'utf8'))
const model = { id: 'test-subtitles', provider: 'Kling', capability: 'video', settings: { model: 'kling-v3', endpoint: 'https://provider.example.test/v1/videos', apiKey: 'test' } }

test('explicit no-subtitle requests keep audible words, timeline, references and all original negative instructions', () => {
  const legacy = buildKlingVideoRequest(fixture.model, fixture.prompt, fixture.params)
  const before = structuredClone(fixture.params)
  const result = buildKlingVideoRequest(fixture.model, fixture.prompt, { ...fixture.params, subtitlePolicy: 'none' })
  assert.ok(String(result.prompt).includes(VIDEO_NO_SUBTITLES_CONTRACT))
  assert.ok(String(result.prompt).includes(fixture.params.videoTimeline))
  assert.ok(String(result.prompt).includes(fixture.params.audioText))
  assert.ok(String(result.negative_prompt).startsWith(String(legacy.negative_prompt)))
  assert.ok(String(result.negative_prompt).endsWith(VIDEO_NO_SUBTITLES_NEGATIVE))
  for (const key of ['duration', 'sound', 'image_list', 'element_list']) assert.deepEqual(result[key], legacy[key])
  assert.deepEqual(fixture.params, before)
  assert.ok(Array.from(String(result.prompt)).length <= 2500)
})

test('caption suppression is separate from ambient audio and native dialogue', () => {
  const ambient = buildKlingVideoRequest(model, '百姓走过庭院。', { subtitlePolicy: 'none', sound: 'on', audioText: '', pacing: { beats: [] } })
  assert.match(String(ambient.negative_prompt), /额外对白，群体喊话/)
  assert.ok(String(ambient.prompt).includes(VIDEO_NO_SUBTITLES_CONTRACT))
  const dialogue = buildKlingVideoRequest(model, '张角说：请起。', { subtitlePolicy: 'none', sound: 'on' })
  assert.ok(String(dialogue.prompt).includes('张角说：请起。'))
  assert.equal(dialogue.sound, 'on')
})

test('missing or explicitly allowed policy keeps legacy prompts; owned full-line additions are idempotent', () => {
  const source = '作者原文：字幕与声音的区别。\r\n张角说：请起。'
  assert.equal(subtitleFreeVideoPrompt(source, {}), source)
  assert.equal(subtitleFreeVideoPrompt(source, { subtitlePolicy: 'allow' }), source)
  const once = subtitleFreeVideoPrompt(source, { subtitlePolicy: 'none' })
  assert.ok(once.startsWith(source))
  assert.equal(subtitleFreeVideoPrompt(once, { subtitlePolicy: 'none' }), once)
  assert.throws(() => subtitleFreeVideoPrompt(source, { subtitlePolicy: 'unknown' }), /SUBTITLE_POLICY_INVALID/)
  assert.throws(() => subtitleFreeVideoPrompt(source, { subtitlePolicy: '' }), /SUBTITLE_POLICY_INVALID/)
  assert.throws(() => subtitleFreeVideoPrompt(source, { subtitlePolicy: undefined }), /SUBTITLE_POLICY_INVALID/)
  const quote = '作者引用：\n```text\n' + VIDEO_NO_SUBTITLES_CONTRACT + '\n```\n原动作。'
  assert.equal(subtitleFreeVideoPrompt(quote, { subtitlePolicy: 'none' }), quote + '\n' + VIDEO_NO_SUBTITLES_CONTRACT)
  assert.throws(() => subtitleFreeVideoPrompt('```text\n原动作。', { subtitlePolicy: 'none' }), /SUBTITLE_CONTRACT_SCOPE_INVALID/)
})

test('actual POST includes both caption constraints, and adding them can never truncate authored content to buy a request', async () => {
  let count = 0, captured: Record<string, unknown> = {}
  const deps = { fetch: async (_input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, 'POST')
    captured = JSON.parse(String(init.body))
    count++
    return new Response(JSON.stringify({ code: 0, data: { task_id: 'offline-subtitle-test', task_status: 'succeed', task_result: { videos: [{ url: 'https://media.example.test/clip.mp4' }] } } }))
  } }
  await callKlingVideo(model, '庭院人物自然行礼。', { subtitlePolicy: 'none', sound: 'on' }, deps)
  assert.ok(String(captured.prompt).includes(VIDEO_NO_SUBTITLES_CONTRACT))
  assert.ok(String(captured.negative_prompt).includes(VIDEO_NO_SUBTITLES_NEGATIVE))
  assert.equal(count, 1)
  await assert.rejects(() => callKlingVideo(model, '景'.repeat(2490), { subtitlePolicy: 'none', sound: 'on' }, deps), /STORYBOARD_PROMPT_OVERLOAD/)
  await assert.rejects(() => callKlingVideo(model, '原剧情', { subtitlePolicy: 'unsupported' }, deps), /SUBTITLE_POLICY_INVALID/)
  assert.equal(count, 1)
})
