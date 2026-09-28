// Reversible one-parameter preview override; no execution or model calls.
import fs from 'node:fs/promises'
import pg from 'pg'
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'

const args = process.argv.slice(2)
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const apply = args.includes('--apply'), restore = args.includes('--restore'), proofPath = option('--proof')
assert.ok(proofPath, '--proof required')
const saved = restore ? JSON.parse(await fs.readFile(proofPath, 'utf8')) : undefined
const workflowId = saved?.workflowId ?? option('--workflow'), nodeId = saved?.nodeId ?? option('--node'), parameterName = saved?.parameterName ?? option('--param')
assert.ok(workflowId && nodeId && parameterName, 'Explicit workflow, node and parameter required')
const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await client.connect()
try {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const workflow = (await client.query(`SELECT nodes,md5(nodes::text) AS hash FROM workflow_configs WHERE id=$1${apply ? ' FOR UPDATE' : ''}`, [workflowId])).rows[0]
  assert.ok(workflow, 'Workflow missing')
  const node = workflow.nodes.find(node => node.id === nodeId)
  const parameters = node?.params.filter(parameter => (parameter.englishName ?? parameter.name) === parameterName)
  assert.equal(parameters?.length, 1, 'An existing unique parameter is required')
  const before = parameters[0]
  if (restore) assert.ok(isDeepStrictEqual(before, saved.after), 'Parameter changed concurrently; refusing restore')
  const after = restore ? saved.before : { ...before, value: (await fs.readFile(option('--value-file'), 'utf8')).trim() }
  if (after.type === 'json') JSON.parse(after.value)
  const proof = { version: 'workflow-preview-parameter-v1', at: new Date().toISOString(), workflowId, nodeId, parameterName,
    before, after, applied: false, restored: restore, beforeHash: workflow.hash, modelCalls: 0, executionWrites: 0 }
  // Keep restore data before the configuration transaction can commit.
  if (apply && !restore) await fs.writeFile(proofPath, JSON.stringify(proof, null, 2), { flag: 'wx', mode: 0o600 })
  if (apply) {
    const nodes = workflow.nodes.map(value => value.id !== nodeId ? value : { ...value, params: value.params.map(parameter => parameter.id === before.id ? after : parameter) })
    await client.query('UPDATE workflow_configs SET nodes=$2::jsonb,updated_at=now() WHERE id=$1', [workflowId, JSON.stringify(nodes)])
  }
  await client.query('COMMIT')
  const result = { ...proof, applied: apply }
  if (apply) await fs.writeFile(restore ? proofPath + '.restored.json' : proofPath, JSON.stringify(result, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ workflowId, nodeId, parameterName, applied: apply, restored: restore, modelCalls: 0, executionWrites: 0 }))
} catch (error) { await client.query('ROLLBACK'); throw error } finally { await client.end() }
