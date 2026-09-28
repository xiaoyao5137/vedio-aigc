import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { SANGUO_CINEMATIC_STORYBOARD_PROMPT } from '../src/storyboard-prompt.ts'
import { animatedMapEndFrameNode, animatedMapFirstFrameNode } from '../src/animated-map-frames.ts'
import { EDITORIAL_VIDEO_PROMPT } from '../src/quality-node-presets.ts'

const appPath = new URL('../src/App.tsx', import.meta.url)

function nodeSource(source: string, nodeId: string, nextNodeId: string) {
  const workflowStart = source.indexOf('const sanguoNodes: WorkflowNode[]')
  const start = source.indexOf(`id: '${nodeId}'`, workflowStart)
  const end = source.indexOf(`id: '${nextNodeId}'`, start)
  assert.notEqual(start, -1, `missing ${nodeId}`)
  assert.notEqual(end, -1, `missing ${nextNodeId}`)
  return source.slice(start, end)
}

test('default Sanguo capability nodes only expose reusable parameters', async () => {
  const source = await readFile(appPath, 'utf8')

  const internet = nodeSource(source, 'sanguo-knowledge', 'sanguo-scene-outline')
  assert.match(internet, /operation: 'internet\.retrieve'/)
  assert.doesNotMatch(internet, /sourceDetail|sourceNames|篇目／卷次|主史料名称/)
  assert.deepEqual(
    [...internet.matchAll(/englishName: '([^']+)'/g)].map((match) => match[1]),
    ['query', 'urls', 'maxSources', 'maxPassages'],
  )

  const characterImage = nodeSource(source, 'sanguo-character-image', 'sanguo-character-archive')
  assert.match(characterImage, /operation: 'character\.ensure'/)
  assert.match(characterImage, /modelId: 'kling-image-3'/)
  assert.match(characterImage, /englishName: 'fallbackModelId'[^\n]*value: ''/)
  assert.deepEqual(
    [...characterImage.matchAll(/englishName: '([^']+)'/g)].map((match) => match[1]),
    ['characters', 'allCharacters', 'existingAssets', 'validateThreeView', 'fallbackModelId', 'maxGenerationAttempts'],
  )

  const characterPortrait = nodeSource(source, 'sanguo-character-portrait', 'sanguo-character-image')
  assert.match(characterPortrait, /operation: 'character\.historical-portrait'/)
  assert.deepEqual(
    [...characterPortrait.matchAll(/englishName: '([^']+)'/g)].map((match) => match[1]),
    ['characters', 'allCharacters', 'maxSources', 'maxPassages'],
  )
  assert.match(characterPortrait, /character_lookup\.missingCharacters/)

  const characterArchive = nodeSource(source, 'sanguo-character-archive', 'sanguo-first-frame-branch')
  assert.match(characterArchive, /operation: 'character\.archive'/)
  assert.deepEqual(
    [...characterArchive.matchAll(/englishName: '([^']+)'/g)].map((match) => match[1]),
    ['characters', 'generatedAssets'],
  )

  const storyboard = nodeSource(source, 'sanguo-shot-script', 'sanguo-character-lookup')
  assert.match(storyboard, /params: \[\]/)
  assert.doesNotMatch(storyboard, /englishName:/)
  assert.match(SANGUO_CINEMATIC_STORYBOARD_PROMPT, /上一镜承接信息/)
  assert.match(SANGUO_CINEMATIC_STORYBOARD_PROMPT, /loop\.previous\.shot_script\.lastFramePrompt/)
  assert.match(SANGUO_CINEMATIC_STORYBOARD_PROMPT, /loop\.previous\.last_frame\.available/)
  assert.match(SANGUO_CINEMATIC_STORYBOARD_PROMPT, /视线匹配、动作匹配或声音桥/)

  const sceneOutline = nodeSource(source, 'sanguo-scene-outline', 'sanguo-scene-loop')
  assert.match(sceneOutline, /params: \[\]/)
  assert.doesNotMatch(sceneOutline, /englishName:/)

  const characterLookup = nodeSource(source, 'sanguo-character-lookup', 'sanguo-character-portrait')
  assert.match(characterLookup, /params: \[\]/)
  assert.doesNotMatch(characterLookup, /englishName:/)

  const firstFrameBranch = nodeSource(source, 'sanguo-first-frame-branch', 'sanguo-first-frame-tail')
  assert.match(firstFrameBranch, /params: \[\]/)
  assert.doesNotMatch(firstFrameBranch, /englishName:/)

  const reuseTail = nodeSource(source, 'sanguo-first-frame-tail', 'sanguo-video')
  assert.match(reuseTail, /params: \[\]/)
  assert.doesNotMatch(reuseTail, /englishName:/)

  assert.equal(animatedMapFirstFrameNode.modelId, 'kling-image-3')
  assert.equal(animatedMapFirstFrameNode.resultVar, 'first_frame')
  assert.deepEqual(animatedMapFirstFrameNode.runIf, { path: 'first_frame_branch.shouldGenerateAnimatedFirstFrame', equals: true })
  assert.match(animatedMapEndFrameNode.prompt, /\$\{shot_script\.lastFramePrompt\}/)
  assert.match(animatedMapEndFrameNode.prompt, /单一 16:9 尾帧/)
  assert.match(animatedMapEndFrameNode.prompt, /其他动画不得重绘、改写、增删或移动已有中文/)
  assert.deepEqual(animatedMapEndFrameNode.runIf, { path: 'first_frame_branch.shouldGenerateAnimatedEndFrame', equals: true })
  assert.deepEqual(
    animatedMapEndFrameNode.params.map(param => param.englishName),
    ['referenceImage', 'aspectRatio', 'resolution', 'n', 'visualTreatment', 'animationStyle', 'animationAesthetic', 'frameRole', 'mapFirstGate', 'mapEditorialRole'],
  )

  const video = nodeSource(source, 'sanguo-video', 'sanguo-last-frame')
  assert.deepEqual(
    [...video.matchAll(/englishName: '([^']+)'/g)].map((match) => match[1]),
    ['referenceImage', 'endImage', 'animationStyle', 'animationAesthetic', 'referenceImages', 'referenceMode', 'referenceBindings', 'characters', 'characterEquipment', 'equipmentBindings', 'illustrationLayers', 'aspectRatio', 'duration', 'pacingVersion', 'mode', 'sound', 'negativePrompt'],
  )
  assert.match(video, /englishName: 'referenceImage', type: 'image', required: false/)
  assert.match(video, /englishName: 'duration', type: 'number', required: true, value: '\$\{shot_script\.duration\}'/)
  assert.match(video, /prompt: EDITORIAL_VIDEO_PROMPT/)
  assert.match(EDITORIAL_VIDEO_PROMPT, /【本镜影视处理】\$\{shot_script\.visualTreatment\} \/ \$\{shot_script\.editorialRole\}/)
  assert.match(EDITORIAL_VIDEO_PROMPT, /【场景与开场画面】\$\{shot_script\.visualPrompt\}/)
  assert.match(EDITORIAL_VIDEO_PROMPT, /【视觉处理硬约束】/)
  assert.match(EDITORIAL_VIDEO_PROMPT, /animationStyle/)
  assert.match(EDITORIAL_VIDEO_PROMPT, /必须完全忽略附件中的纯色底/)
  assert.match(video, /幕布背景/)
  assert.match(video, /englishName: 'endImage'.*end_frame\.url/)
  assert.doesNotMatch(video, /结束画面：/)
  assert.doesNotMatch(video, /englishName: '(title|camera)'/)
  assert.match(source, /from: 'sanguo-first-frame-branch', to: 'sanguo-first-frame-tail'/)
  assert.match(source, /from: 'sanguo-first-frame-branch', to: 'sanguo-video'/)
  assert.match(source, /from: 'sanguo-first-frame-tail', to: 'sanguo-video'/)
  const edges = source.slice(source.indexOf('const sanguoEdges:'), source.indexOf('const initialWorkflows:'))
  assert.match(edges, /from: 'sanguo-animated-map-first-frame', to: 'sanguo-end-frame'/)
  assert.match(edges, /from: 'sanguo-end-frame', to: 'sanguo-video'/)

  const tailFrame = nodeSource(source, 'sanguo-last-frame', 'sanguo-verify')
  assert.match(tailFrame, /kind: 'code'/)
  assert.match(tailFrame, /code: SANGUO_TAIL_FRAME_CODE/)
  assert.match(tailFrame, /params: \[\]/)
  assert.doesNotMatch(tailFrame, /englishName:/)
  assert.doesNotMatch(tailFrame, /kind: 'asset'|operation: 'frame\.tail\.resolve'|modelId:/)

  const workflowEnd = source.indexOf('const sanguoEdges:', source.indexOf('const sanguoNodes: WorkflowNode[]'))
  const workflowNodes = source.slice(source.indexOf('const sanguoNodes: WorkflowNode[]'), workflowEnd)
  assert.doesNotMatch(workflowNodes, /id: 'sanguo-audio'/)
  assert.doesNotMatch(workflowNodes, /id: 'sanguo-first-frame'/)
  assert.equal(animatedMapEndFrameNode.id, 'sanguo-end-frame')
})
