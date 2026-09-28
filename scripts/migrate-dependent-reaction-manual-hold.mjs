#!/usr/bin/env node
// Read-only by default. Apply updates only the managed media request/reviewer/
// acceptance nodes and the schema version; no execution or model ledger writes.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { PRINCIPLE_MEDIA_RUNTIME_CODE, PRINCIPLE_MEDIA_REVIEW_PROMPT } from '../src/principle-media-quality.ts'

const apply = process.argv.includes('--apply')
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? '' : process.argv[index + 1] ?? '' }
const folder = path.resolve(option('--out') || 'logs/dramatic-expression/live-20260928/dependent-reaction-manual-hold-cas-v1')
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' && !(value instanceof Date)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex')
const workflowId = 'wf-sanguo-history-drama'
const clauses = {
  'sanguo-media-request': 'return principleMediaQuality.mediaRequest(context);',
  'sanguo-media-accept': 'return principleMediaQuality.acceptMedia(context,params);',
}
function newCode(old, statement) {
  const pattern = /\/\/ PRINCIPLE_POLICY_START[\s\S]*?\/\/ PRINCIPLE_POLICY_END/g
  assert.equal([...old.matchAll(pattern)].length, 1, 'Expected one managed principle branch')
  const block = `// PRINCIPLE_POLICY_START\nif (params.qualityMode === 'principle-v1') {\ntry {\n${PRINCIPLE_MEDIA_RUNTIME_CODE}\n${statement}\n} catch (error) { return {passed:false,routeError:error.message}; }\n}\n// PRINCIPLE_POLICY_END`
  const updated = old.replace(pattern, () => block)
  assert.ok(updated.includes('deriveApprovedReactionDeadline') && updated.includes('dependentReactionAssessment'))
  assert.equal(old.replace(pattern, ''), updated.replace(pattern, ''), 'Legacy branch changed')
  return updated
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
// A row rewrite changes xmin/ctid. Compare those plus stored sizes inside one
// transaction without de-TOASTing the 3.5 GB execution archive twice.
const executionRows = async () => (await client.query(`select id,xmin::text as revision,ctid::text as location,
  pg_column_size(result) as stored_bytes from execution_records where workflow_id=$1 order by id`, [workflowId])).rows
const paidRows = async () => (await client.query(`select id,xmin::text as revision,ctid::text as location,status,task_id,
  pg_column_size(request_data) as request_bytes,pg_column_size(response_data) as response_bytes
  from model_execution_records where workflow_id=$1 order by id`, [workflowId])).rows
await client.connect()
let committed = false
try {
  await client.query(apply ? 'begin isolation level repeatable read' : 'begin isolation level repeatable read read only')
  const saved = (await client.query(`select id,schema_version,nodes,edges,updated_at,xmin::text as row_revision
    from workflow_configs where id=$1${apply ? ' for update' : ''}`, [workflowId])).rows[0]
  assert.equal(saved?.schema_version, 156, 'Expected saved schema 156; stop before changing another graph')
  const beforeHash = sha([saved.schema_version, saved.nodes, saved.edges, saved.row_revision])
  const beforeExecutions = await executionRows(), beforePaid = await paidRows()
  assert.equal(beforePaid.filter(row => row.status === 'processing').length, 0, 'Provider task still processing')
  const ids = Object.keys(clauses).concat('sanguo-media-review')
  for (const id of ids) assert.equal(saved.nodes.filter(node => node.id === id).length, 1)
  const nextNodes = saved.nodes.map(node => clauses[node.id]
    ? { ...node, code: newCode(node.code, clauses[node.id]) }
    : node.id === 'sanguo-media-review'
      ? { ...node, prompt: PRINCIPLE_MEDIA_REVIEW_PROMPT } : node)
  for (let index = 0; index < saved.nodes.length; index++) {
    if (!ids.includes(saved.nodes[index].id)) assert.equal(sha(saved.nodes[index]), sha(nextNodes[index]))
  }
  const changed = ids.filter(id => sha(saved.nodes.find(node => node.id === id)) !== sha(nextNodes.find(node => node.id === id)))
  assert.deepEqual(changed.sort(), ids.sort(), 'Managed nodes were not all updated')
  let backupPath
  if (apply) {
    assert.equal(option('--expected-before-sha256'), beforeHash, 'Workflow row differs from reviewed preview')
    await mkdir(folder, { recursive: true })
    backupPath = path.join(folder, `schema156-before-${Date.now()}.json`)
    await writeFile(backupPath, JSON.stringify(saved, null, 2), { flag: 'wx', mode: 0o600 })
    const updated = await client.query(`update workflow_configs set schema_version=157,nodes=$2::jsonb,updated_at=now()
      where id=$1 and schema_version=156 and nodes=$3::jsonb and edges=$4::jsonb and xmin::text=$5 returning id`,
    [workflowId, JSON.stringify(nextNodes), JSON.stringify(saved.nodes), JSON.stringify(saved.edges), saved.row_revision])
    assert.equal(updated.rowCount, 1, 'Workflow CAS failed')
    // A second, older Vite process may still serve an open browser tab. Its
    // whole-workflow PUT can overwrite this row after the CAS. Enforce the
    // managed schema floor in PostgreSQL itself, including DELETE+INSERT.
    await client.query(`create or replace function guard_sanguo_schema_157()
      returns trigger language plpgsql as $$
      begin
        if TG_OP = 'DELETE' then
          if OLD.id = 'wf-sanguo-history-drama' and OLD.schema_version >= 157 then
            raise exception 'SANGUO_SCHEMA_REGRESSION: 已部署 schema 157，旧页面不得删除三国工作流' using errcode = '23514';
          end if;
          return OLD;
        end if;
        if NEW.id = 'wf-sanguo-history-drama' and NEW.schema_version < 157 then
          raise exception 'SANGUO_SCHEMA_REGRESSION: 三国工作流不得回退至 schema %', NEW.schema_version using errcode = '23514';
        end if;
        return NEW;
      end $$`)
    await client.query(`do $$ begin
      if not exists (select 1 from pg_trigger where tgname = 'guard_sanguo_schema_157_write'
        and tgrelid = 'workflow_configs'::regclass and not tgisinternal) then
        create trigger guard_sanguo_schema_157_write
          before insert or update or delete on workflow_configs
          for each row execute function guard_sanguo_schema_157();
      end if;
    end $$`)
  }
  const after = (await client.query('select schema_version,nodes,edges from workflow_configs where id=$1', [workflowId])).rows[0]
  assert.equal(after.schema_version, apply ? 157 : 156)
  assert.equal(sha(after.edges), sha(saved.edges))
  assert.equal(sha(after.nodes), sha(apply ? nextNodes : saved.nodes))
  const guard = (await client.query(`select count(*)::int as count from pg_trigger
    where tgname='guard_sanguo_schema_157_write' and tgrelid='workflow_configs'::regclass
      and not tgisinternal and tgenabled='O'`)).rows[0].count
  assert.equal(guard, apply ? 1 : 0, 'Expected PostgreSQL schema-regression trigger state')
  assert.deepEqual(await executionRows(), beforeExecutions)
  assert.deepEqual(await paidRows(), beforePaid)
  if (apply) { await client.query('commit'); committed = true }
  else await client.query('rollback')
  const proof = { format: 'dependent-reaction-manual-hold-cas-v1', at: new Date().toISOString(), applied: apply,
    fromSchema: 156, toSchema: 157, beforeHash, savedSchema: after.schema_version,
    changedNodeIds: changed, oldNodeHashes: Object.fromEntries(ids.map(id => [id, sha(saved.nodes.find(node => node.id === id))])),
    newNodeHashes: Object.fromEntries(ids.map(id => [id, sha(nextNodes.find(node => node.id === id))])),
    savedNodeHash: sha(after.nodes), edgeCount: saved.edges.length,
    executionRecordCount: beforeExecutions.length, executionRecordsHash: sha(beforeExecutions),
    modelLedgerCount: beforePaid.length, modelLedgerHash: sha(beforePaid),
    providerProcessingCount: 0, databaseRegressionGuardInstalled: guard === 1,
    executionWrites: 0, modelLedgerWrites: 0, backupPath }
  await mkdir(folder, { recursive: true })
  await writeFile(path.join(folder, `migration-${apply ? 'applied' : 'preview'}.json`), JSON.stringify(proof, null, 2) + '\n')
  console.log(JSON.stringify(proof, null, 2))
} catch (error) {
  if (!committed) await client.query('rollback').catch(() => {})
  throw error
} finally { await client.end() }
