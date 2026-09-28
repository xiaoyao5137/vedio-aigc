#!/usr/bin/env node
// Preview or apply only the managed Sanguo character equipment contract.
// The preview rehearses the update in a temporary table; --apply saves a
// recoverable configuration snapshot before a compare-and-swap update.
import pg from 'pg'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { upgradeCharacterVisualWorkflow, upgradePersistedSanguoCharacterWorkflow } from '../src/character-visual-workflow.ts'

const workflowId = 'wf-sanguo-history-drama'
const apply = process.argv.includes('--apply')
const outputAt = process.argv.indexOf('--out')
const outputDir = path.resolve(outputAt >= 0 ? process.argv[outputAt + 1] : '.runtime/character-equipment-workflow-migration')
const hash = value => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
const permitted = new Map([
  ['sanguo-scene-outline', ['prompt']],
  ['sanguo-shot-script', ['prompt']],
  ['sanguo-character-lookup', ['code']],
  ['sanguo-first-frame-branch', ['code']],
  ['sanguo-video', ['params']],
])
const db = new pg.Client({connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc'})
await db.connect()
try {
  const read = async lock => (await db.query(`select *, xmin::text as row_version from workflow_configs where id=$1${lock ? ' for update' : ''}`,[workflowId])).rows[0]
  const executionSnapshot = async () => (await db.query('select id,xmin::text as revision from execution_records where workflow_id=$1 order by id',[workflowId])).rows
  const before = await read(false)
  assert.ok(before && before.schema_version >= 150, 'Current Sanguo workflow is missing or too old')
  const upgrade = workflow => upgradePersistedSanguoCharacterWorkflow(workflow, upgradeCharacterVisualWorkflow)
  const desired = upgrade({id: workflowId, schemaVersion: before.schema_version, nodes: before.nodes})
  assert.equal(desired.nodes.length, before.nodes.length)
  assert.deepEqual(upgrade(desired), desired, 'Upgrade must be idempotent')
  const changes = desired.nodes.flatMap((node,index) => {
    const old = before.nodes[index]
    assert.equal(node.id, old.id, `Node order changed at ${index}`)
    const keys = [...new Set([...Object.keys(node),...Object.keys(old)])].filter(key => hash(node[key]) !== hash(old[key]))
    if (!keys.length) return []
    const allowed = permitted.get(node.id) ?? []
    assert.ok(keys.every(key => allowed.includes(key)), `Unexpected config change: ${node.id}/${keys.join(',')}`)
    return [{id:node.id,keys,beforeSha256:hash(old),afterSha256:hash(node)}]
  })
  assert.deepEqual(desired.nodes.map(node => node.id),before.nodes.map(node => node.id))
  const historyBefore = await executionSnapshot()
  // Exercise the exact JSONB write against an isolated temporary copy.
  await db.query('begin')
  try {
    await db.query('create temporary table character_equipment_workflow_probe (like workflow_configs including defaults) on commit drop')
    await db.query('insert into character_equipment_workflow_probe select * from workflow_configs where id=$1',[workflowId])
    await db.query('update character_equipment_workflow_probe set nodes=$2::jsonb,schema_version=$3 where id=$1',
      [workflowId,JSON.stringify(desired.nodes),desired.schemaVersion])
    const rehearsed=(await db.query('select nodes,edges,schema_version from character_equipment_workflow_probe where id=$1',[workflowId])).rows[0]
    assert.equal(hash(rehearsed.nodes),hash(desired.nodes))
    assert.equal(hash(rehearsed.edges),hash(before.edges))
    assert.equal(rehearsed.schema_version,desired.schemaVersion)
  } finally { await db.query('rollback') }
  let backupFile
  const changedSchema = desired.schemaVersion !== before.schema_version
  if (apply && (changes.length || changedSchema)) {
    await db.query('begin')
    try {
      const locked=await read(true)
      assert.equal(locked.row_version,before.row_version,'Workflow changed since preview; retry from a fresh snapshot')
      assert.equal(locked.schema_version,before.schema_version,'Workflow schema changed since preview')
      assert.equal(hash(locked.nodes),hash(before.nodes),'Workflow nodes changed since preview')
      assert.equal(hash(locked.edges),hash(before.edges),'Workflow graph changed since preview')
      await fs.mkdir(outputDir,{recursive:true})
      backupFile=path.join(outputDir,`workflow-before-${Date.now()}.json`)
      await fs.writeFile(backupFile,JSON.stringify(locked,null,2),{flag:'wx',mode:0o600})
      const result=await db.query('update workflow_configs set nodes=$2::jsonb,schema_version=$3,updated_at=now() where id=$1 and xmin::text=$4 returning id',
        [workflowId,JSON.stringify(desired.nodes),desired.schemaVersion,locked.row_version])
      assert.equal(result.rowCount,1,'Concurrent workflow edit prevented the migration')
      assert.equal(hash(await executionSnapshot()),hash(historyBefore),'Execution history changed during config migration')
      await db.query('commit')
    } catch (error) { await db.query('rollback'); throw error }
  }
  const persisted=await read(false)
  assert.equal(hash(persisted.nodes),hash(apply ? desired.nodes : before.nodes))
  assert.equal(persisted.schema_version,apply ? desired.schemaVersion : before.schema_version)
  assert.equal(hash(persisted.edges),hash(before.edges))
  assert.equal(hash(await executionSnapshot()),hash(historyBefore),'Execution history was modified')
  const report={mode:apply?'apply':'preview',workflowId,schemaBefore:before.schema_version,targetSchemaVersion:desired.schemaVersion,schemaAfter:persisted.schema_version,changedSchema,
    nodeCount:persisted.nodes.length,edgeCount:persisted.edges.length,executionCount:historyBefore.length,
    executionRowsSha256:hash(historyBefore),graphSha256:hash(before.edges),changedNodes:changes,changed:changes.length>0 || changedSchema,
    noOp:changes.length===0 && !changedSchema,backupFile:backupFile??null,isolatedTempTableRehearsal:true}
  await fs.mkdir(outputDir,{recursive:true})
  await fs.writeFile(path.join(outputDir,apply?'applied.json':'preview.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify(report,null,2))
} finally { await db.end() }
