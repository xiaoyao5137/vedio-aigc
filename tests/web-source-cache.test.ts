import test from 'node:test'
import assert from 'node:assert/strict'
import { retrieveInternetSourcesWithExecutionCache } from '../server/builtin-nodes.ts'
import type { InternetSourceInput, InternetSourceResult } from '../server/web-sources.ts'

const input: InternetSourceInput = {
  query: '符水与饥民 后汉书 卷七十一',
  urls: ['https://zh.wikisource.org/wiki/後漢書'],
  maxSources: 3,
  maxPassages: 6,
}

const cachedResult: InternetSourceResult = {
  query: input.query,
  sourceDetail: '',
  count: 1,
  citations: [{
    index: 1,
    id: 'web-cached',
    title: '後漢書/卷71',
    source: '维基文库',
    edition: '',
    url: 'https://zh.wikisource.org/wiki/後漢書/卷71',
    fetchedAt: '2026-09-13T12:00:00.000Z',
    content: '鉅鹿張角自稱大賢良師，符水呪說以療病，百姓信向之。',
    retrieval: 'internet',
  }],
  text: 'cached text',
  sourceMode: 'internet',
  fetchedAt: '2026-09-13T12:00:00.000Z',
  attemptedUrls: input.urls!,
  failures: [],
}

test('source retrieval prefers a fresh online result and does not query execution cache', async () => {
  let queries = 0
  const fresh = { ...cachedResult, fetchedAt: '2026-09-13T13:00:00.000Z' }
  const result = await retrieveInternetSourcesWithExecutionCache(
    { query: async () => { queries += 1; return { rows: [] } } } as never,
    input,
    { workflowId: 'wf-history' },
    async () => fresh,
  )
  assert.equal(result, fresh)
  assert.equal(queries, 0)
})

test('source retrieval reuses only an exact successful request when a site is throttled', async () => {
  const result = await retrieveInternetSourcesWithExecutionCache(
    { query: async (_sql: string, values: unknown[]) => {
      assert.deepEqual(values, ['wf-history'])
      return { rows: [{ execution_record_id: 'record-source-proof', node_run: { status: 'success', inputs: input, output: cachedResult } }] }
    } } as never,
    input,
    { workflowId: 'wf-history' },
    async () => { throw new Error('HTTP 429') },
  )
  assert.equal(result.citations[0].id, 'web-cached')
  assert.equal(result.citations[0].fetchedAt, '2026-09-13T12:00:00.000Z')
  assert.equal(result.cacheRecovery?.executionRecordId, 'record-source-proof')
  assert.match(result.cacheRecovery?.onlineError ?? '', /429/)
})

test('source retrieval can validate a legacy stored run whose inputs were moved to an execution graph slot', async () => {
  const result = await retrieveInternetSourcesWithExecutionCache(
    { query: async () => ({ rows: [{ execution_record_id: 'record-legacy-proof', node_run: {
      status: 'success', inputs: { slot: 9 }, output: cachedResult,
    } }] }) } as never,
    input,
    { workflowId: 'wf-history' },
    async () => { throw new Error('HTTP 429') },
  )
  assert.equal(result.cacheRecovery?.executionRecordId, 'record-legacy-proof')
})

test('source retrieval never substitutes a cache entry from a different request', async () => {
  await assert.rejects(() => retrieveInternetSourcesWithExecutionCache(
    { query: async () => ({ rows: [{ execution_record_id: 'record-other', node_run: { status: 'success', inputs: { ...input, query: '其他主题' }, output: cachedResult } }] }) } as never,
    input,
    { workflowId: 'wf-history' },
    async () => { throw new Error('HTTP 429') },
  ), /HTTP 429/)
})
