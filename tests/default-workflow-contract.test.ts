import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

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
  assert.deepEqual(
    [...characterImage.matchAll(/englishName: '([^']+)'/g)].map((match) => match[1]),
    ['characters', 'allCharacters', 'existingAssets', 'validateThreeView', 'maxGenerationAttempts'],
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

  const sceneOutline = nodeSource(source, 'sanguo-scene-outline', 'sanguo-scene-loop')
  assert.match(sceneOutline, /params: \[\]/)
  assert.doesNotMatch(sceneOutline, /englishName:/)

  const characterLookup = nodeSource(source, 'sanguo-character-lookup', 'sanguo-character-portrait')
  assert.match(characterLookup, /params: \[\]/)
  assert.doesNotMatch(characterLookup, /englishName:/)

  const firstFrameBranch = nodeSource(source, 'sanguo-first-frame-branch', 'sanguo-first-frame-tail')
  assert.match(firstFrameBranch, /params: \[\]/)
  assert.doesNotMatch(firstFrameBranch, /englishName:/)

  const reuseTail = nodeSource(source, 'sanguo-first-frame-tail', 'sanguo-end-frame')
  assert.match(reuseTail, /params: \[\]/)
  assert.doesNotMatch(reuseTail, /englishName:/)

  const endFrame = nodeSource(source, 'sanguo-end-frame', 'sanguo-video')
  assert.match(endFrame, /\$\{shot_script\.lastFramePrompt\}/)
  assert.match(endFrame, /单一时间点/)
  assert.match(endFrame, /上下三段/)
  assert.match(endFrame, /任何可读文字/)
  assert.deepEqual(
    [...endFrame.matchAll(/englishName: '([^']+)'/g)].map((match) => match[1]),
    ['referenceImages', 'size', 'referenceMode', 'referenceBindings'],
  )

  const video = nodeSource(source, 'sanguo-video', 'sanguo-last-frame')
  assert.deepEqual(
    [...video.matchAll(/englishName: '([^']+)'/g)].map((match) => match[1]),
    ['referenceImage', 'endImage', 'referenceImages', 'referenceMode', 'referenceBindings', 'aspectRatio', 'duration', 'mode', 'sound', 'negativePrompt'],
  )
  assert.match(video, /englishName: 'referenceImage', type: 'image', required: false/)
  assert.match(video, /englishName: 'duration', type: 'number', required: true, value: '15'/)
  assert.match(video, /结束画面：\$\{shot_script\.lastFramePrompt\}/)
  assert.match(video, /englishName: 'endImage'/)
  assert.doesNotMatch(video, /englishName: '(title|camera)'/)
  assert.match(source, /from: 'sanguo-first-frame-branch', to: 'sanguo-first-frame-tail'/)
  assert.match(source, /from: 'sanguo-first-frame-branch', to: 'sanguo-end-frame'/)
  assert.match(source, /from: 'sanguo-end-frame', to: 'sanguo-video'/)
  assert.match(source, /from: 'sanguo-first-frame-tail', to: 'sanguo-video'/)
  const edges = source.slice(source.indexOf('const sanguoEdges:'), source.indexOf('const initialWorkflows:'))
  assert.doesNotMatch(edges, /from: 'sanguo-first-frame-branch', to: 'sanguo-first-frame'|from: 'sanguo-first-frame', to:/)

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
  assert.match(workflowNodes, /id: 'sanguo-end-frame'/)
})
