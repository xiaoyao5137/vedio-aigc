import test from 'node:test'
import assert from 'node:assert/strict'
import { contextWithGenerationAttempt } from '../src/generation-request-context.ts'
import { createDramaGenerationBudget } from '../src/drama-generation-budget.ts'
import { requestNodeJson } from '../src/node-transport.ts'
import { createInflightModelRequests, modelRequestFingerprint } from '../server/model-request-key.ts'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { assertModelProviderAllowed } from '../server/provider-policy.ts'
import { assertHistoricalImageProvider } from '../server/history-image-policy.ts'
import { prepareWorkflowMediaRequest, validateHistoricalMapPaidImageRequest, validateWorkflowMediaContract } from '../server/workflow-contracts.ts'
import { validateCoverageCutPaidImageRequest, validateCoverageCutPaidVideoRequest } from '../server/coverage-cut-runtime.ts'
import { persistCoverageCutFirstFrameResponse } from '../server/coverage-cut-frame-storage.ts'
import { loadReviewImages, reviewImagesFingerprint } from '../server/review-images.ts'

const originalContext = Object.freeze({ requestKey: 'record-test:attempt-1:revision-0:writer:0:', workflowId: 'workflow', nodeId: 'writer' })
const request = { model: { id: 'writer-model', provider: 'Anthropic', capability: 'text', settings: { model: 'configured-writer' } },
  prompt: 'Exactly the same repair prompt and original candidate on every attempt.', params: { maxGenerationAttempts: 5 }, operation: 'history.scene-outline' }
type Request = typeof request & { executionContext: typeof originalContext }
type Result = { status: number; body: { valid: boolean; providerCall: number } }

/** Load the current production dispatch/checkpoint code rather than copying its
 * cache decision into the test. Only PostgreSQL and the external provider are
 * replaced with isolated I/O; no server, real database or model is contacted. */
const serverSource = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')
const dispatchStart = serverSource.indexOf('const shareModelRequest = createInflightModelRequests()')
const dispatchEnd = serverSource.indexOf('// https://vite.dev/config/', dispatchStart)
const statusStart = serverSource.indexOf('function executionTaskInfo(')
const statusEnd = serverSource.indexOf('async function saveModelExecutionRecord(', statusStart)
assert.ok(dispatchStart >= 0 && dispatchEnd > dispatchStart && statusStart >= 0 && statusEnd > statusStart)
const dispatchCode = ts.transpileModule(serverSource.slice(statusStart, statusEnd) + '\n' + serverSource.slice(dispatchStart, dispatchEnd),
  { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }).outputText

function checkpointServer(provider: () => Promise<Result>) {
  const persisted = new Map<string, Result>()
  const identities: string[] = []
  const records: Array<{ status: string; httpStatus: number; requestData: { requestKey: string; fingerprint: string; operation: string }; responseData: Result['body'] }> = []
  const env = { createInflightModelRequests, modelRequestFingerprint, assertModelProviderAllowed, assertHistoricalImageProvider,
    withModelRequestAdvisoryLock: async (_pool: unknown, _identity: string | undefined, execute: () => Promise<unknown>) => execute(),
    prepareWorkflowMediaRequest, validateHistoricalMapPaidImageRequest, validateWorkflowMediaContract,
    validateCoverageCutPaidImageRequest, validateCoverageCutPaidVideoRequest, persistCoverageCutFirstFrameResponse,
    loadReviewImages, reviewImagesFingerprint,
    ensureSchema: async () => {},
    pool: { query: async (sql: string, values: string[]) => {
      assert.match(sql, /select response_data,http_status from model_execution_records/)
      assert.match(sql, /request_data->>'requestKey'=\$1 and request_data->>'fingerprint'=\$2 and status='succeeded'/)
      assert.match(sql, /coalesce\(request_data->>'operation',''\)=\$3/)
      const saved = records.findLast(row => row.status === 'succeeded' && row.requestData.requestKey === values[0]
        && row.requestData.fingerprint === values[1] && (row.requestData.operation ?? '') === values[2])
      return { rows: saved ? [{ response_data: saved.responseData, http_status: saved.httpStatus }] : [] }
    } },
    callNodeExternalUntracked: provider,
    saveModelExecutionRecord: async (record: typeof records[number]) => {
      records.push(record)
      if (record.status === 'succeeded') persisted.set(JSON.stringify([record.requestData.requestKey, record.requestData.fingerprint, record.requestData.operation]),
        { status: record.httpStatus, body: record.responseData })
    },
    errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
    CodexTextError: class extends Error {},
  }
  const execute = new Function('env', `const {${Object.keys(env).join(',')}}=env;\n${dispatchCode}\nreturn callNodeExternal;`)(env) as (request: Request) => Promise<Result>
  const send = async (_url: string, payload: unknown) => {
    const value = payload as Request
    identities.push(JSON.stringify([value.executionContext.requestKey, modelRequestFingerprint(value), value.operation]))
    return execute(value)
  }
  return { send, identities, persisted }
}

test('semantic generation identity preserves the original context, accepts only one through five, and never invents an unkeyed identity', () => {
  for (let generation = 1; generation <= 5; generation++) {
    const context = contextWithGenerationAttempt(originalContext, generation)
    assert.equal(context.requestKey, `${originalContext.requestKey}:generation-${generation}`)
    assert.equal(context.nodeId, originalContext.nodeId)
    assert.deepEqual(contextWithGenerationAttempt(originalContext, generation), context, 'same semantic attempt has a deterministic key')
  }
  assert.equal(originalContext.requestKey, 'record-test:attempt-1:revision-0:writer:0:')
  for (const generation of [0, -1, 1.1, 21, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => contextWithGenerationAttempt(originalContext, generation), /GENERATION_ATTEMPT_INVALID/)
  }
  for (const context of [{}, { requestKey: undefined }, { requestKey: '' }, { requestKey: ' ' }]) {
    assert.equal(contextWithGenerationAttempt(context, 1), context)
  }
})

test('identical invalid candidates receive five real semantic generations and the fifth may pass instead of looping on the first checkpoint', async () => {
  const budget = createDramaGenerationBudget(undefined, 5)
  let purchases = 0
  const server = checkpointServer(async () => ({ status: 200, body: { valid: ++purchases === 5, providerCall: purchases } }))
  const fingerprints = new Set<string>()
  let accepted: Result | undefined
  while (budget.canConsume()) {
    budget.consume()
    const executionContext = contextWithGenerationAttempt(originalContext, budget.used)
    const payload = { ...request, executionContext }
    fingerprints.add(modelRequestFingerprint(payload))
    const response = await requestNodeJson<Result>('/api/node-run', payload, executionContext.requestKey, { send: server.send, wait: async () => {} })
    assert.equal(response.body.providerCall, budget.used)
    if (response.body.valid) { accepted = response; break }
  }
  assert.equal(purchases, 5)
  assert.equal(accepted?.body.valid, true)
  assert.equal(budget.used, 5)
  assert.equal(fingerprints.size, 1, 'prompt/model/parameters remain unchanged; only semantic attempt identity changes')
  assert.equal(new Set(server.identities).size, 5)
  assert.equal(server.persisted.size, 5, 'retain every rejected provider candidate as its own checkpoint')
  assert.throws(() => budget.consume(), /DRAMA_GENERATION_LIMIT/)
  assert.equal(purchases, 5, 'exhaustion never buys attempt six')
})

test('the regression harness reproduces the old fixed-key cache trap', async () => {
  let purchases = 0
  const server = checkpointServer(async () => ({ status: 200, body: { valid: false, providerCall: ++purchases } }))
  const payload = { ...request, executionContext: originalContext }
  const candidates = await Promise.all(Array.from({ length: 3 }, () => server.send('/api/node-run', payload)))
  const persistedReplay = await server.send('/api/node-run', structuredClone(payload))
  assert.equal(purchases, 1)
  assert.ok(candidates.every(result => result.body.providerCall === 1))
  assert.equal(persistedReplay.body.providerCall, 1)
})

test('a lost response reattaches to the same generation checkpoint with the exact payload and one purchase', async () => {
  const budget = createDramaGenerationBudget(undefined, 5)
  budget.consume()
  const executionContext = contextWithGenerationAttempt(originalContext, budget.used)
  const payload = { ...request, executionContext }
  let purchases = 0, transportCalls = 0
  const server = checkpointServer(async () => ({ status: 200, body: { valid: true, providerCall: ++purchases } }))
  const response = await requestNodeJson<Result>('/api/node-run', payload, executionContext.requestKey, {
    send: async (url, repeatedPayload) => {
      transportCalls++
      assert.equal(repeatedPayload, payload)
      const result = await server.send(url, repeatedPayload)
      if (transportCalls === 1) throw Error('Failed to fetch')
      return result
    }, wait: async () => {},
  })
  assert.equal(transportCalls, 2)
  assert.equal(purchases, 1)
  assert.equal(budget.used, 1)
  assert.equal(new Set(server.identities).size, 1)
  assert.equal(response.body.providerCall, 1)
})

test('concurrent reconnects for one generation share the actual inflight provider request', async () => {
  let purchases = 0
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const server = checkpointServer(async () => { purchases++; await pending; return { status: 200, body: { valid: true, providerCall: purchases } } })
  const executionContext = contextWithGenerationAttempt(originalContext, 4), payload = { ...request, executionContext }
  const first = server.send('/api/node-run', payload), second = server.send('/api/node-run', structuredClone(payload))
  release()
  const results = await Promise.all([first, second])
  assert.equal(purchases, 1)
  assert.equal(results[0], results[1])
})

test('parent planning and child repairs consume one generation sequence and retain it across a saved budget', () => {
  const parent = createDramaGenerationBudget(undefined, 5), keys: string[] = []
  for (let i = 0; i < 3; i++) { parent.consume(); keys.push(contextWithGenerationAttempt(originalContext, parent.used).requestKey) }
  const child = createDramaGenerationBudget({ previousCandidate: { repairProvenance: { generationAttempts: parent.used } } }, 5)
  while (child.canConsume()) { child.consume(); keys.push(contextWithGenerationAttempt(originalContext, child.used).requestKey) }
  assert.equal(child.used, 5)
  assert.equal(new Set(keys).size, 5)
  assert.ok(keys[3].endsWith(':generation-4'))
  assert.ok(keys[4].endsWith(':generation-5'))
  assert.throws(() => child.consume(), /DRAMA_GENERATION_LIMIT/)
})
