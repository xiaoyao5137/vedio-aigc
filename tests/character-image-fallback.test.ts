import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'
import { modelRequestFingerprint } from '../server/model-request-key.ts'
import { assertHistoricalImageProvider } from '../server/history-image-policy.ts'

test('historical image requests reject Ofox before submission but allow text review', () => {
  const executionContext = { workflowId: 'wf-sanguo-history-drama' }
  assert.throws(() => assertHistoricalImageProvider({ executionContext, model: { provider: 'OpenAI', capability: 'image' } }), /HISTORY_IMAGE_PROVIDER_REQUIRED/)
  assert.doesNotThrow(() => assertHistoricalImageProvider({ executionContext, model: { provider: 'Kling', capability: 'image' } }))
  assert.doesNotThrow(() => assertHistoricalImageProvider({ executionContext, model: { provider: 'Anthropic', capability: 'text' } }))
})

test('only the signed scene-cut opening node may use Codex image generation', () => {
  const executionContext = { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-scene-cut-first-frame' }
  assert.doesNotThrow(() => assertHistoricalImageProvider({ executionContext,
    model: { provider: 'Codex', capability: 'image' } }))
  assert.throws(() => assertHistoricalImageProvider({ executionContext,
    model: { provider: 'OpenAI', capability: 'image' } }), /HISTORY_IMAGE_PROVIDER_REQUIRED/)
  assert.throws(() => assertHistoricalImageProvider({ executionContext: { ...executionContext,
    nodeId: 'sanguo-coverage-first-frame' }, model: { provider: 'Codex', capability: 'image' } }),
  /HISTORY_IMAGE_PROVIDER_REQUIRED/)
  assert.throws(() => assertHistoricalImageProvider({ executionContext: { ...executionContext,
    nodeId: 'sanguo-end-frame' }, model: { provider: 'Codex', capability: 'image' } }),
  /HISTORY_IMAGE_PROVIDER_REQUIRED/)
})

test('historical checkpoint with exhausted Kling budget never invokes its old Ofox fallback', async () => {
  const primary = { id: 'kling-image-3', provider: 'Kling', capability: 'image', settings: {} }
  const pool = { async query(sql: string) {
    if (/select id, workflow_id, character_name/.test(sql)) return { rows: [] }
    if (/select model_id,response_data/.test(sql)) return { rows: [1, 2].map(() => ({ model_id: primary.id, response_data: { qualityRejected: true, qualityRejection: '三视图质量检查失败：布局不合格' } })) }
    throw new Error(`unexpected SQL: ${sql}`)
  } }
  let purchases = 0
  await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.ensure', model: primary,
    executionContext: { workflowId: 'wf-sanguo-history-drama', requestKey: 'old-checkpoint' },
    params: { characters: ['乡人'], validateThreeView: true, maxGenerationAttempts: 2, fallbackModelId: 'gpt-image-2' } }, async () => {
    purchases += 1
    return { status: 500, body: {} }
  }), /三视图质量检查失败/)
  assert.equal(purchases, 0)
})

test('quality failures are bounded across resumes and fallback does not inherit rejected pixels', async () => {
  const primary = { id: 'primary', provider: 'Kling', capability: 'image', settings: {} }
  const fallback = { ...primary, id: 'fallback', provider: 'Ofox' }
  const square = `data:image/png;base64,${(await sharp({ create: { width: 600, height: 600, channels: 3, background: '#777777' } }).png().toBuffer()).toString('base64')}`
  const rows: Array<{ model_id: string; fingerprint: string; response_data: Record<string, unknown> }> = []
  const calls: string[] = []
  const pool = { async query(sql: string, params: unknown[] = []) {
    if (/select id, workflow_id, character_name/.test(sql)) return { rows: [] }
    if (/select \* from model_configs/.test(sql)) return { rows: [fallback] }
    if (/select model_id,response_data/.test(sql)) return { rows: rows.filter((row) => row.response_data.qualityRejected).toReversed() }
    if (/update model_execution_records/.test(sql)) {
      const row = rows.find((item) => item.fingerprint === params[1])!
      Object.assign(row.response_data, JSON.parse(String(params[2])))
      return { rows: [] }
    }
    throw new Error(`unexpected SQL: ${sql}`)
  } }
  const request = { operation: 'character.ensure', model: primary, executionContext: { requestKey: 'same-logical-execution' },
    params: { characters: [{ name: '乡人', description: '中年男性无须', designPrompt: '中年男性无须' }], validateThreeView: true, maxGenerationAttempts: 2, fallbackModelId: 'fallback' } }
  const generate = async (input: Parameters<NonNullable<Parameters<typeof executeBuiltinNode>[2]>>[0]) => {
    calls.push(input.model.id)
    if (input.model.id === 'fallback') {
      assert.equal(input.params.referenceImage, undefined)
      assert.equal(input.params.imageEdit, undefined)
    }
    const body = { images: [{ url: square }] }
    rows.push({ model_id: input.model.id, fingerprint: modelRequestFingerprint(input), response_data: body })
    return { status: 200, body }
  }
  await assert.rejects(executeBuiltinNode(pool as never, request, generate), /三视图质量检查失败/)
  assert.deepEqual(calls, ['primary', 'fallback'])
  await assert.rejects(executeBuiltinNode(pool as never, request, generate), /三视图质量检查失败/)
  assert.equal(calls.length, 2, 'resuming an exhausted shared quality budget must make zero provider purchases')
})

test('transport failure never spends fallback quality budget', async () => {
  const primary = { id: 'primary', provider: 'Kling', capability: 'image', settings: {} }
  const calls: string[] = []
  const pool = { async query(sql: string) {
    if (/model_configs/.test(sql)) return { rows: [{ ...primary, id: 'fallback', provider: 'Ofox' }] }
    return { rows: [] }
  } }
  await assert.rejects(executeBuiltinNode(pool as never, { operation: 'character.ensure', model: primary,
    params: { characters: ['乡人'], validateThreeView: true, fallbackModelId: 'fallback' } }, async ({ model }) => {
    calls.push(model.id)
    return { status: 429, body: { error: 'rate limited' } }
  }), /rate limited/)
  assert.deepEqual(calls, ['primary'])
})

test('character image quality uses the full five-attempt budget and cannot reset it on resume', async () => {
  const primary = { id: 'primary', provider: 'Kling', capability: 'image', settings: {} }
  const square = `data:image/png;base64,${(await sharp({ create: { width: 60, height: 60, channels: 3, background: '#777777' } }).png().toBuffer()).toString('base64')}`
  const rows: Array<{ model_id: string; fingerprint: string; response_data: Record<string, unknown> }> = []
  const pool = { async query(sql: string, params: unknown[] = []) {
    if (/select id, workflow_id, character_name/.test(sql)) return { rows: [] }
    if (/select model_id,response_data/.test(sql)) return { rows: rows.filter(row => row.response_data.qualityRejected).toReversed() }
    if (/update model_execution_records/.test(sql)) {
      rows.filter(row => row.fingerprint === params[1]).forEach(row => Object.assign(row.response_data, JSON.parse(String(params[2]))))
      return { rows: [] }
    }
    throw Error(`unexpected SQL: ${sql}`)
  } }
  const request = { operation: 'character.ensure', model: primary, executionContext: { requestKey: 'five-logical-execution' },
    params: { characters: ['乡人'], validateThreeView: true, maxGenerationAttempts: 5 } }
  let calls = 0
  const generate = async (input: Parameters<NonNullable<Parameters<typeof executeBuiltinNode>[2]>>[0]) => {
    calls++
    const body = { images: [{ url: square }] }
    rows.push({ model_id: input.model.id, fingerprint: modelRequestFingerprint(input), response_data: body })
    return { status: 200, body }
  }
  await assert.rejects(executeBuiltinNode(pool as never, request, generate), /三视图质量检查失败/)
  assert.equal(calls, 5)
  await assert.rejects(executeBuiltinNode(pool as never, request, generate), /三视图质量检查失败/)
  assert.equal(calls, 5, 'an exhausted checkpoint preserves its five failures and cannot buy attempt six')
})
