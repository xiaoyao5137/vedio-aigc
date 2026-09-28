import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { appendLipSyncContract } from '../src/workflow-core.ts'
import { chantShot, chantScene } from './fixtures/duration-v2-chant.ts'
import { compileDurationSchedule } from '../src/duration-schedule.ts'
import { prepareThreeViewVideoReferences } from '../server/image-references.ts'
import { prepareKlingImageInputs, klingThreeViewVideoPrompt, buildKlingVideoRequest, callKlingVideo, hardenKlingDialoguePrompt } from '../server/model-adapters.ts'

function body() {
  const shot = chantShot(), compiled = compileDurationSchedule(shot, { scene: chantScene })
  return '【场景与开场实景】甘陵土路和民居，乡人随后入画。\n【场景真实性硬约束】实景与自然光。\n'
    + appendLipSyncContract(compiled.videoPrompt, shot.audioType, shot.audioText, shot.characters, { ...shot, ...compiled })
}

test('only a complete compiled voice block receives the compact v2 lip guard', () => {
  const source = body(), compact = hardenKlingDialoguePrompt(source, 'duration-v2')
  assert.ok(compact.startsWith(source + '\n'))
  assert.match(compact, /画内声部匹配自然口型/)
  assert.equal(hardenKlingDialoguePrompt(compact, 'duration-v2'), compact)
  for (const partial of [source.replace('已声明的无词群体声部必须实际可听', ''),
    source.replace('导演参考窗口用于定位表演，硬边界和前置依赖必须遵守。', ''),
    '【声部与收束】只有标题，没有完整声音约束。']) {
    const guarded = hardenKlingDialoguePrompt(partial, 'duration-v2')
    assert.ok(guarded.startsWith(partial + '\n'))
    assert.match(guarded, /不套统一语速/)
    assert.doesNotMatch(guarded, /画内声部匹配自然口型/)
  }
})

test('full local identity preparation preserves the entire near-limit body and still rejects overflow before provider POST', async () => {
  const png = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><rect width="100" height="100" fill="#a44"/><rect x="100" width="100" height="100" fill="#4a4"/><rect x="200" width="100" height="100" fill="#44a"/></svg>')).png().toBuffer()
  const params = { pacingVersion: 'duration-v2', duration: 9, sound: 'on', referenceMode: 'three-view-all',
    referenceImages: ['data:image/png;base64,' + png.toString('base64')],
    referenceBindings: [{ characterName: '传唱歌谣的乡人', role: 'entering', entrance: { name: '传唱歌谣的乡人', startSecond: 0, endSecond: .8, path: '街巷左侧入口' } }] }
  const model = { id: 'public-test', provider: 'Kling', capability: 'video', settings: { model: 'kling-v3', endpoint: 'https://provider.example.test/v1/videos', apiKey: 'test' } }
  const prepared = await prepareThreeViewVideoReferences(await prepareKlingImageInputs(params), async () => { throw Error('public fixture must not fetch any remote asset') })
  assert.equal(prepared.referenceImages.length, 3)
  const base = body(), initial = buildKlingVideoRequest(model, klingThreeViewVideoPrompt(base, prepared), prepared)
  const source = base + '\n' + '土'.repeat(2495 - Array.from(String(initial.prompt)).length - 1)
  let submissions = 0, captured: Record<string, unknown> = {}
  const dependencies = { fetch: async (_input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, 'POST'); submissions++
    captured = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ code: 0, data: { task_id: 'mock-only', task_status: 'succeed', task_result: { videos: [{ url: 'https://media.example.test/mock.mp4' }] } } }), { status: 200 })
  } }
  await callKlingVideo(model, source, params, dependencies)
  assert.equal(submissions, 1)
  assert.equal((captured.image_list as unknown[]).length, 3)
  assert.equal(Array.from(String(captured.prompt)).length, 2495)
  assert.ok(String(captured.prompt).includes(source), 'keep every original action, voice, timeline and scene byte')
  assert.match(String(captured.prompt), /<<<image_1>>>正面、<<<image_2>>>侧面、<<<image_3>>>背面/)
  assert.match(String(captured.prompt), /首帧人物锁定/)
  assert.match(String(captured.prompt), /参考图背景隔离/)
  assert.match(String(captured.prompt), /持续动作保持至该段结束/)
  assert.doesNotMatch(String(captured.prompt), /content shortened/)
  await assert.rejects(() => callKlingVideo(model, source + '土'.repeat(6), params, dependencies), /STORYBOARD_PROMPT_OVERLOAD/)
  assert.equal(submissions, 1, 'overflow must fail before a second POST, never truncate')
})
