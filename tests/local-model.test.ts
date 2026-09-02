import test from 'node:test'
import assert from 'node:assert/strict'
import { runLocalModel } from '../server/local-model.ts'
import { deriveSceneOutlineMetrics } from '../src/workflow-core.ts'

test('local historical planner derives scene count and total duration from fetched-source complexity', () => {
  const brief = runLocalModel({ capability: 'text', operation: 'history.scene-outline', prompt: '', params: { episodeTitle: '符水与饥民', citations: ['史料1'], historicalSources: '张角以符水疗病。' } }) as Record<string, unknown>
  const detailed = runLocalModel({ capability: 'text', operation: 'history.scene-outline', prompt: '', params: { episodeTitle: '符水与饥民', citations: ['史料1', '史料2', '史料3', '史料4'], historicalSources: '张角以符水疗病。百姓信向。弟子传播。众徒相应。遂置三十六方。各立渠帅。黄巾起事。京师震动。' } }) as Record<string, unknown>
  const briefScenes = brief.scenes as Array<Record<string, unknown>>
  const scenes = detailed.scenes as Array<Record<string, unknown>>
  assert.notEqual(briefScenes.length, scenes.length)
  assert.equal('count' in detailed, false)
  assert.equal('totalDuration' in detailed, false)
  const normalized = deriveSceneOutlineMetrics(detailed)
  assert.equal(normalized.count, scenes.length)
  assert.equal(normalized.totalDuration, scenes.length * 15)
  assert(scenes.every((scene) => scene.targetDuration === 15))
  assert(scenes.every((scene) => scene.historicalBasis && scene.adaptationBoundary))
  const purposes = scenes.map((scene) => String(scene.purpose)).join('\n')
  assert.match(purposes, /危机|反常|信息差/)
  assert.match(purposes, /试探|碰撞|反制/)
  assert.match(purposes, /后果|代价|选择/)
  assert.match(purposes, /悬念|未答|威胁/)
  assert(scenes.every((scene) => /性格|信息差|悬念/.test(String(scene.adaptationBoundary))))
})

test('local historical planner reads scene-outline inputs directly from prompt placeholders', () => {
  const prompt = `为《符水与饥民》规划连续短镜头。\n\n史料引用清单：\n${JSON.stringify([{ title: '后汉书·皇甫嵩朱儁列传' }])}\n\n史料原文：\n张角以符水疗病。百姓信向。`
  const outline = runLocalModel({ capability: 'text', operation: 'history.scene-outline', prompt, params: {} }) as Record<string, unknown>
  const scenes = outline.scenes as Array<Record<string, unknown>>
  assert.equal(outline.episodeTitle, '符水与饥民')
  assert.match(String(scenes[0].historicalBasis), /后汉书·皇甫嵩朱儁列传/)
})

test('storyboard emits the strict cast and frame-continuity contract', () => {
  const shot = runLocalModel({ capability: 'text', operation: 'history.storyboard', prompt: '', params: { episodeTitle: '符水与饥民', scene: { id: 's1', sequence: 1, title: '入局', purpose: '张角为病者施治', targetDuration: 8, continuityFromPrevious: false, historicalBasis: '[史料1] 张角传道', adaptationBoundary: '对白拟制' } } }) as Record<string, unknown>
  assert.equal(shot.id, 's1')
  assert.deepEqual(shot.characters, ['张角'])
  assert.equal(shot.duration, 15)
  assert.equal(shot.firstFrameMode, 'reference')
  assert.match(String(shot.lastFramePrompt), /代价|反应|威胁|悬念/)
  assert.match(String(shot.videoPrompt), /意图—阻力—反应—变化/)
  assert.match(String(shot.mood), /信息差|机锋|反差/)
  assert.equal(shot.audioType, '对白')
  assert.equal(shot.historicalBasis, '[史料1] 张角传道')
  assert.equal(shot.adaptationBoundary, '对白拟制')
})

test('local storyboard can read workflow context directly from prompt placeholders', () => {
  const scene = { id: 's2', sequence: 2, title: '试探', purpose: '张角观察来人', targetDuration: 15, continuityFromPrevious: true, historicalBasis: '[史料1] 张角传道', adaptationBoundary: '对白拟制' }
  const prompt = `把本集《符水与饥民》的当前场景改写为短分镜。\n\n当前场景：${JSON.stringify(scene)}\n\n史料原文：张角以符水疗病。`
  const shot = runLocalModel({ capability: 'text', operation: 'history.storyboard', prompt, params: {} }) as Record<string, unknown>
  assert.equal(shot.id, 's2')
  assert.equal(shot.title, '试探')
  assert.equal(shot.duration, 15)
  assert.equal(shot.firstFrameMode, 'reuse_previous_tail')
})

test('local media simulators return browser-renderable dry-run assets', () => {
  const image = runLocalModel({ capability: 'image', prompt: '东汉乡野', params: { title: '首帧' } }) as Record<string, unknown>
  const video = runLocalModel({ capability: 'video', prompt: '缓慢推进，同时生成对白和环境声', params: { image: '/frame.png', duration: 5, sound: 'on' } }) as Record<string, unknown>
  const audio = runLocalModel({ capability: 'audio', prompt: '旁白', params: { duration: 1 } }) as Record<string, unknown>
  assert.match(String(image.url), /^data:image\/svg\+xml;base64,/)
  assert.match(String(video.lastFrameUrl), /^data:image\/svg\+xml;base64,/)
  assert.equal(video.audioEmbedded, true)
  assert.match(String(audio.url), /^data:audio\/wav;base64,/)
})
