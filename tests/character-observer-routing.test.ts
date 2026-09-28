import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { executeBuiltinNode, type BuiltinNodeRequest } from '../server/builtin-nodes.ts'

const vision = { id: 'configured-vision', provider: 'Codex', capability: 'text', settings: {} }

async function replay(options: { model?: BuiltinNodeRequest['model']; modelId?: string; nodes?: Record<string, unknown>[]; missingModel?: boolean }) {
  const url = `/generated/observer-route-test-${randomUUID()}.png`, file = path.join(process.cwd(), 'public', url)
  const preview = path.join(process.cwd(), 'public/generated', `appearance-${createHash('sha256').update(url).digest('hex').slice(0, 24)}.jpg`)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, await sharp({ create: { width: 80, height: 60, channels: 3, background: '#777' } }).png().toBuffer())
  const reads: Array<{ sql: string; values?: unknown[] }> = [], calls: string[] = []
  const pool = { query: async (sql: string, values?: unknown[]) => {
    reads.push({ sql, values })
    if (sql.includes('from workflow_configs')) return { rows: [{ nodes: options.nodes ?? [] }] }
    if (sql.includes('from model_configs')) return { rows: options.missingModel ? [] : [{ ...vision, id: String(values?.[0]) }] }
    return { rows: [] }
  } }
  try {
    const output = await executeBuiltinNode(pool as never, { operation: 'character.appearance', model: options.model, params: { workflowId: 'wf', ...(options.modelId !== undefined ? { appearanceReviewModelId: options.modelId } : {}), assets: [{ characterName: '张飞', workflowId: 'wf', url }] } }, async request => {
      calls.push(request.model.id)
      return { status: 200, body: { valid: true, matchesDesign: true, appearance: '同一成熟壮实男性，黑色束发、深色短须和灰色衣袍，三面身份保持一致。', issues: [] } }
    })
    assert.equal(output.items.length, 1)
    return { reads, calls }
  } finally { await rm(file, { force: true }); await rm(preview, { force: true }) }
}

test('explicit actual text model takes precedence over stored appearance settings', async () => {
  const result = await replay({ model: { ...vision, id: 'explicit-vision' }, modelId: 'parameter-vision', nodes: [{ id: 'sanguo-character-review', modelId: 'workflow-vision' }] })
  assert.deepEqual(result.calls, ['explicit-vision'])
  assert.equal(result.reads.length, 0)
  const parameter = await replay({ modelId: 'parameter-vision', nodes: [{ id: 'sanguo-character-review', modelId: 'workflow-vision' }] })
  assert.deepEqual(parameter.calls, ['parameter-vision'])
  assert.equal(parameter.reads.some(read => read.sql.includes('workflow_configs')), false)
})

test('workflow character reviewer model is used before the retired default, with generic role binding preferred', async () => {
  for (const nodes of [[{ id: 'sanguo-character-review', modelId: 'workflow-vision' }], [{ id: 'custom-review', modelId: 'workflow-vision', metadata: { reviewRole: 'character-appearance' } }, { id: 'sanguo-character-review', modelId: 'old-vision' }], [{ id: 'custom-review', modelId: 'workflow-vision', operation: 'character.appearance-review' }]]) {
    const result = await replay({ nodes })
    assert.deepEqual(result.calls, ['workflow-vision'])
    assert.deepEqual(result.reads.find(read => read.sql.includes('model_configs'))?.values, ['workflow-vision'])
  }
  const legacy = await replay({ nodes: [] })
  assert.deepEqual(legacy.calls, ['claude-opus-4-8'])
})

test('invalid explicit or configured review routes fail without provider fallback', async () => {
  await assert.rejects(replay({ model: { ...vision, provider: 'Local' } }), /CHARACTER_OBSERVER_MODEL_INVALID/)
  await assert.rejects(replay({ nodes: [{ id: 'sanguo-character-review', modelId: 'missing-vision' }], missingModel: true }), /missing-vision/)
  await assert.rejects(replay({ nodes: [{ id: 'one', modelId: 'first', metadata: { reviewRole: 'character-appearance' } }, { id: 'two', modelId: 'second', metadata: { reviewRole: 'character-appearance' } }] }), /唯一模型绑定/)
})
