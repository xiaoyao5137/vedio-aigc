#!/usr/bin/env node
// Read-only preview by default. CAS-upgrades only the saved Sanguo media-accept
// principle block and its DB schema guard; paid tasks/executions are immutable.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { PRINCIPLE_MEDIA_RUNTIME_CODE } from '../src/principle-media-quality.ts'

const apply = process.argv.includes('--apply')
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? '' : process.argv[index + 1] ?? '' }
const folder = path.resolve(option('--out') || 'logs/dramatic-expression/live-20260928/dependent-reaction-review-hold-cas-v1')
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' && !(value instanceof Date)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex')
const workflowId = 'wf-sanguo-history-drama'
const pattern = /\/\/ PRINCIPLE_POLICY_START[\s\S]*?\/\/ PRINCIPLE_POLICY_END/g
function updatedAccept(code) {
  assert.equal([...code.matchAll(pattern)].length, 1)
  assert.ok(code.includes('dependentReactionAssessment') && !code.includes('manual-review-hold'))
  const block = `// PRINCIPLE_POLICY_START\nif (params.qualityMode === 'principle-v1') {\ntry {\n${PRINCIPLE_MEDIA_RUNTIME_CODE}\nreturn principleMediaQuality.acceptMedia(context,params);\n} catch (error) { return {passed:false,routeError:error.message}; }\n}\n// PRINCIPLE_POLICY_END`
  const next = code.replace(pattern, () => block)
  assert.ok(next.includes('manual-review-hold') && next.includes('temporalReaction'))
  assert.equal(code.replace(pattern, ''), next.replace(pattern, ''))
  return next
}
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const histories = async () => (await db.query(`select id,xmin::text as revision,ctid::text as location,
  pg_column_size(result) as stored_bytes from execution_records where workflow_id=$1 order by id`, [workflowId])).rows
const ledgers = async () => (await db.query(`select id,xmin::text as revision,ctid::text as location,status,task_id,
  pg_column_size(request_data) as request_bytes,pg_column_size(response_data) as response_bytes
  from model_execution_records where workflow_id=$1 order by id`, [workflowId])).rows
const guards = async () => (await db.query(`select tgname from pg_trigger where tgrelid='workflow_configs'::regclass
  and not tgisinternal and tgenabled='O' and tgname like 'guard_sanguo_schema_%_write' order by tgname`)).rows.map(row => row.tgname)
await db.connect()
let committed = false
try {
  await db.query(apply ? 'begin isolation level repeatable read' : 'begin isolation level repeatable read read only')
  const row = (await db.query(`select id,schema_version,nodes,edges,updated_at,xmin::text as revision
    from workflow_configs where id=$1${apply ? ' for update' : ''}`, [workflowId])).rows[0]
  assert.equal(row?.schema_version, 157)
  const beforeHash = sha([row.schema_version, row.nodes, row.edges, row.revision])
  const beforeHistory = await histories(), beforeLedgers = await ledgers(), beforeGuards = await guards()
  assert.deepEqual(beforeGuards, ['guard_sanguo_schema_157_write'])
  assert.equal(beforeLedgers.filter(item => item.status === 'processing').length, 0)
  const indexes = row.nodes.flatMap((node, index) => node.id === 'sanguo-media-accept' ? [index] : [])
  assert.equal(indexes.length, 1)
  const index = indexes[0], old = row.nodes[index]
  const nodes = row.nodes.map((node, at) => at === index ? { ...node, code: updatedAccept(node.code) } : node)
  for (let at = 0; at < nodes.length; at++) if (at !== index) assert.equal(sha(nodes[at]), sha(row.nodes[at]))
  let backupPath
  if (apply) {
    assert.equal(option('--expected-before-sha256'), beforeHash, 'Saved graph changed after preview')
    await mkdir(folder, { recursive: true })
    backupPath = path.join(folder, `schema157-before-${Date.now()}.json`)
    await writeFile(backupPath, JSON.stringify(row, null, 2), { flag: 'wx', mode: 0o600 })
    const changed = await db.query(`update workflow_configs set schema_version=158,nodes=$2::jsonb,updated_at=now()
      where id=$1 and schema_version=157 and nodes=$3::jsonb and edges=$4::jsonb and xmin::text=$5 returning id`,
    [workflowId, JSON.stringify(nodes), JSON.stringify(row.nodes), JSON.stringify(row.edges), row.revision])
    assert.equal(changed.rowCount, 1, 'Workflow CAS failed')
    await db.query('drop trigger guard_sanguo_schema_157_write on workflow_configs')
    await db.query('drop function guard_sanguo_schema_157()')
    await db.query(`create function guard_sanguo_schema_158()
      returns trigger language plpgsql as $$
      begin
        if TG_OP = 'DELETE' then
          if OLD.id = 'wf-sanguo-history-drama' and OLD.schema_version >= 158 then
            raise exception 'SANGUO_SCHEMA_REGRESSION: 已部署 schema 158，旧页面不得删除三国工作流' using errcode = '23514';
          end if;
          return OLD;
        end if;
        if NEW.id = 'wf-sanguo-history-drama' and NEW.schema_version < 158 then
          raise exception 'SANGUO_SCHEMA_REGRESSION: 三国工作流不得回退至 schema %', NEW.schema_version using errcode = '23514';
        end if;
        return NEW;
      end $$`)
    await db.query(`create trigger guard_sanguo_schema_158_write before insert or update or delete
      on workflow_configs for each row execute function guard_sanguo_schema_158()`)
  }
  const saved = (await db.query(`select schema_version,nodes,edges,xmin::text as revision
    from workflow_configs where id=$1`, [workflowId])).rows[0]
  assert.equal(saved.schema_version, apply ? 158 : 157)
  assert.equal(sha(saved.nodes), sha(apply ? nodes : row.nodes))
  assert.equal(sha(saved.edges), sha(row.edges))
  const afterGuards = await guards()
  assert.deepEqual(afterGuards, apply ? ['guard_sanguo_schema_158_write'] : beforeGuards)
  assert.deepEqual(await histories(), beforeHistory)
  assert.deepEqual(await ledgers(), beforeLedgers)
  if (apply) { await db.query('commit'); committed = true }
  else await db.query('rollback')
  const proof = { format: 'dependent-reaction-review-hold-cas-v1', at: new Date().toISOString(),
    applied: apply, fromSchema: 157, toSchema: 158, beforeHash, savedSchema: saved.schema_version,
    changedNodeId: old.id, oldCodeSha256: sha(old.code), newCodeSha256: sha(nodes[index].code),
    savedGraphSha256: sha(saved.nodes), edgesSha256: sha(saved.edges),
    oldGuard: beforeGuards[0], savedGuard: afterGuards[0],
    executionRecordCount: beforeHistory.length, executionRowsSha256: sha(beforeHistory),
    modelLedgerCount: beforeLedgers.length, modelLedgerRowsSha256: sha(beforeLedgers),
    providerProcessingCount: 0, executionWrites: 0, modelLedgerWrites: 0, backupPath }
  await mkdir(folder, { recursive: true })
  await writeFile(path.join(folder, `migration-${apply ? 'applied' : 'preview'}.json`), JSON.stringify(proof, null, 2) + '\n')
  console.log(JSON.stringify(proof, null, 2))
} catch (error) {
  if (!committed) await db.query('rollback').catch(() => {})
  throw error
} finally { await db.end() }
