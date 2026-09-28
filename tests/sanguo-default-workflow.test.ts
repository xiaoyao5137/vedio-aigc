import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { assertSanguoDefaultWorkflow, loadSanguoDefaultWorkflow, SANGUO_DEFAULT_WORKFLOW_URL } from '../src/sanguo-default-workflow.ts'

const snapshotPath = new URL('../public/data/sanguo-default-workflow.json', import.meta.url)

test('cold-start resource carries the reviewed schema 158 media graph', async () => {
  const graph = JSON.parse(await readFile(snapshotPath, 'utf8'))
  assertSanguoDefaultWorkflow(graph)
  assert.equal(graph.voicePolicy, 'strict')
  const byId = new Map(graph.nodes.map((node: { id: string }) => [node.id, node]))
  const request = byId.get('sanguo-media-request') as { code: string }
  const review = byId.get('sanguo-media-review') as { prompt: string }
  const accept = byId.get('sanguo-media-accept') as { code: string }
  const input = byId.get('sanguo-input') as { params: Array<{ englishName: string; value: string }> }
  const context = byId.get('sanguo-context-init') as { uploads: Array<{ dataUrl: string }> }
  assert.equal(input.params.find(param => param.englishName === 'episode_number')?.value, '41')
  assert.equal(input.params.find(param => param.englishName === 'characterAssetSelections')?.value, '{}')
  assert.equal(context.uploads[0]?.dataUrl, '/data/三国历史短剧1000集策划总表.xlsx')
  assert.equal(graph.nodes.flatMap((node: { uploads?: unknown[] }) => node.uploads ?? []).length, 1)
  assert.doesNotMatch(JSON.stringify(graph), /\/generated\/|model-run-|character-mukn|data:application/)
  assert.match(request.code, /latestSpeechEnd/)
  assert.match(request.code, /reactionSamples/)
  assert.match(review.prompt, /dependentReactionCheck/)
  assert.match(accept.code, /manualDecisionRequired/)
  assert.match(accept.code, /automaticRetakeAllowed/)
  const loaded = await loadSanguoDefaultWorkflow(async url => {
    assert.equal(url, SANGUO_DEFAULT_WORKFLOW_URL)
    return Response.json(graph)
  })
  assert.deepEqual(loaded, graph)
})

test('cold-start merge uses schema 158, while a saved Sanguo graph is never fetched or replaced', async () => {
  const graph = JSON.parse(await readFile(snapshotPath, 'utf8'))
  const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' })
  try {
    const { mergeDefaultWorkflows, normalizeWorkflow } = await server.ssrLoadModule('/src/App.tsx')
    let fetches = 0
    const fetcher = async (url: string) => {
      fetches++
      assert.equal(url, SANGUO_DEFAULT_WORKFLOW_URL)
      return Response.json(graph)
    }
    const cold = await mergeDefaultWorkflows([], fetcher)
    const sanguo = cold.find((workflow: { id: string }) => workflow.id === graph.id)
    assert.equal(fetches, 1)
    assert.deepEqual(JSON.parse(JSON.stringify(sanguo)), graph)
    assert.deepEqual(JSON.parse(JSON.stringify(normalizeWorkflow(graph))), graph)
    assert.equal(cold.length, 3)

    const saved = { ...graph, name: '用户保留的三国工作流名称' }
    const existing = await mergeDefaultWorkflows([saved], async () => {
      throw new Error('已有三国图谱不应请求出厂资源')
    })
    assert.equal(existing.find((workflow: { id: string }) => workflow.id === graph.id)?.name, saved.name)
    assert.equal(existing.filter((workflow: { id: string }) => workflow.id === graph.id).length, 1)
  } finally {
    await server.close()
  }
})

test('missing or malformed cold-start resource fails closed before workflow execution', async () => {
  await assert.rejects(loadSanguoDefaultWorkflow(async () => new Response('', { status: 404 })),
    /SANGUO_DEFAULT_UNAVAILABLE/)
  await assert.rejects(loadSanguoDefaultWorkflow(async () => Response.json({ id: 'wf-sanguo-history-drama', schemaVersion: 122 })),
    /SANGUO_DEFAULT_INVALID/)
})
