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

  const characterImage = nodeSource(source, 'sanguo-character-image', 'sanguo-first-frame-branch')
  assert.doesNotMatch(characterImage, /operation: 'character\.ensure'/)
  assert.doesNotMatch(characterImage, /待生成人物|已有人物图片|allCharacters|needsGeneration/)
  assert.deepEqual(
    [...characterImage.matchAll(/englishName: '([^']+)'/g)].map((match) => match[1]),
    ['referenceImages', 'size', 'n'],
  )

  const firstFrame = nodeSource(source, 'sanguo-first-frame', 'sanguo-first-frame-tail')
  assert.doesNotMatch(firstFrame, /operation: 'frame\.first\.resolve'/)
  assert.doesNotMatch(firstFrame, /firstFramePrompt|镜头标题|首帧策略/)
  assert.deepEqual(
    [...firstFrame.matchAll(/englishName: '([^']+)'/g)].map((match) => match[1]),
    ['referenceImages', 'size'],
  )

  const storyboard = nodeSource(source, 'sanguo-shot-script', 'sanguo-character-lookup')
  assert.match(storyboard, /params: \[\]/)
  assert.doesNotMatch(storyboard, /englishName:/)

  const sceneOutline = nodeSource(source, 'sanguo-scene-outline', 'sanguo-scene-loop')
  assert.match(sceneOutline, /params: \[\]/)
  assert.doesNotMatch(sceneOutline, /englishName:/)

  const characterLookup = nodeSource(source, 'sanguo-character-lookup', 'sanguo-character-image')
  assert.match(characterLookup, /params: \[\]/)
  assert.doesNotMatch(characterLookup, /englishName:/)

  const firstFrameBranch = nodeSource(source, 'sanguo-first-frame-branch', 'sanguo-first-frame')
  assert.match(firstFrameBranch, /params: \[\]/)
  assert.doesNotMatch(firstFrameBranch, /englishName:/)

  const reuseTail = nodeSource(source, 'sanguo-first-frame-tail', 'sanguo-video')
  assert.match(reuseTail, /params: \[\]/)
  assert.doesNotMatch(reuseTail, /englishName:/)

  const video = nodeSource(source, 'sanguo-video', 'sanguo-last-frame')
  assert.deepEqual(
    [...video.matchAll(/englishName: '([^']+)'/g)].map((match) => match[1]),
    ['referenceImage', 'duration', 'mode', 'sound', 'negativePrompt'],
  )
  assert.doesNotMatch(video, /englishName: '(title|camera)'/)

  const tailFrame = nodeSource(source, 'sanguo-last-frame', 'sanguo-verify')
  assert.match(tailFrame, /kind: 'code'/)
  assert.match(tailFrame, /code: SANGUO_TAIL_FRAME_CODE/)
  assert.match(tailFrame, /params: \[\]/)
  assert.doesNotMatch(tailFrame, /englishName:/)
  assert.doesNotMatch(tailFrame, /kind: 'asset'|operation: 'frame\.tail\.resolve'|modelId:/)

  const workflowEnd = source.indexOf('const sanguoEdges:', source.indexOf('const sanguoNodes: WorkflowNode[]'))
  const workflowNodes = source.slice(source.indexOf('const sanguoNodes: WorkflowNode[]'), workflowEnd)
  assert.doesNotMatch(workflowNodes, /id: 'sanguo-audio'/)
})
