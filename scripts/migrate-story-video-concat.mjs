#!/usr/bin/env node
// Add the rolling video assembly to the saved story workflow. Preview is read-only.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { upgradeStoryVideoConcat } from '../src/story-video-concat-workflow.ts'

const flags = new Set(['--apply', '--expected-nodes-md5', '--expected-edges-md5', '--help'])
const options = { apply: false, expectedNodesMd5: '', expectedEdgesMd5: '', help: false }
const args = process.argv.slice(2)
for (let index = 0; index < args.length; index++) {
  const flag = args[index]
  if (!flags.has(flag)) throw Error(`Unknown argument: ${flag}`)
  if (flag === '--apply' || flag === '--help') {
    if (options[flag === '--apply' ? 'apply' : 'help']) throw Error(`Duplicate argument: ${flag}`)
    options[flag === '--apply' ? 'apply' : 'help'] = true
    continue
  }
  const field = flag === '--expected-nodes-md5' ? 'expectedNodesMd5' : 'expectedEdgesMd5'
  if (options[field] || !args[index + 1] || args[index + 1].startsWith('--')) throw Error(`Missing or duplicate value: ${flag}`)
  options[field] = args[++index]
}
if (options.help) {
  console.log('node scripts/migrate-story-video-concat.mjs [--apply --expected-nodes-md5 MD5 --expected-edges-md5 MD5]')
  process.exit(0)
}
for (const field of ['expectedNodesMd5', 'expectedEdgesMd5']) {
  if (options[field] && !/^[a-f0-9]{32}$/i.test(options[field])) throw Error(`${field} must be a 32-character MD5`)
}
if (options.apply && (!options.expectedNodesMd5 || !options.expectedEdgesMd5)) {
  throw Error('--apply requires --expected-nodes-md5 and --expected-edges-md5 from a fresh preview')
}

const backupDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../logs/story-video-concat/schema4')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
let committed = false
let backupPath = ''
try {
  await db.query(options.apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ'
    : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const before = (await db.query(`SELECT *, xmin::text AS revision,
    md5(nodes::text) AS nodes_md5, md5(edges::text) AS edges_md5
    FROM workflow_configs WHERE id='wf-story'${options.apply ? ' FOR UPDATE' : ''}`)).rows[0]
  assert.ok(before, 'Saved wf-story workflow is missing')
  assert.ok(before.schema_version === 3 || before.schema_version === 4,
    `Unexpected wf-story schema ${before.schema_version}`)
  const current = { id: before.id, schemaVersion: before.schema_version,
    nodes: before.nodes, edges: before.edges }
  const next = upgradeStoryVideoConcat(current)
  assert.equal(next.schemaVersion, 4, 'Story concat migration did not reach schema 4')
  assert.equal(upgradeStoryVideoConcat(next), next, 'Story concat migration is not idempotent')

  const oldNodes = new Map(current.nodes.map(node => [node.id, node]))
  const newNodes = new Map(next.nodes.map(node => [node.id, node]))
  const oldEdges = new Map(current.edges.map(edge => [edge.id, edge]))
  const newEdges = new Map(next.edges.map(edge => [edge.id, edge]))
  assert.equal(oldNodes.size, current.nodes.length, 'Saved workflow has duplicate node IDs')
  assert.equal(newNodes.size, next.nodes.length, 'Target workflow has duplicate node IDs')
  assert.equal(oldEdges.size, current.edges.length, 'Saved workflow has duplicate edge IDs')
  assert.equal(newEdges.size, next.edges.length, 'Target workflow has duplicate edge IDs')
  const addedNodeIds = [...newNodes.keys()].filter(id => !oldNodes.has(id))
  const removedNodeIds = [...oldNodes.keys()].filter(id => !newNodes.has(id))
  const changedNodeIds = [...oldNodes.keys()].filter(id => newNodes.has(id)
    && JSON.stringify(oldNodes.get(id)) !== JSON.stringify(newNodes.get(id)))
  const addedEdgeIds = [...newEdges.keys()].filter(id => !oldEdges.has(id))
  const removedEdgeIds = [...oldEdges.keys()].filter(id => !newEdges.has(id))
  const changedEdgeIds = [...oldEdges.keys()].filter(id => newEdges.has(id)
    && JSON.stringify(oldEdges.get(id)) !== JSON.stringify(newEdges.get(id)))
  assert.deepEqual(removedNodeIds, [], 'Migration must not remove saved nodes')
  assert.deepEqual(removedEdgeIds, [], 'Migration must not remove saved edges')
  assert.deepEqual(changedEdgeIds, [], 'Migration must not rewrite saved edges')
  if (before.schema_version === 3) {
    assert.deepEqual(addedNodeIds, ['node-video-concat'], 'Migration must add only the concat node')
    assert.deepEqual(changedNodeIds, ['node-loop'], 'Migration must change only loop membership')
    assert.deepEqual(addedEdgeIds, ['edge-video-concat'], 'Migration must add only the video-to-concat edge')
    const { childIds: _newChildIds, ...newLoopWithoutChildren } = newNodes.get('node-loop')
    const { childIds: _oldChildIds, ...oldLoopWithoutChildren } = oldNodes.get('node-loop')
    assert.deepEqual(newLoopWithoutChildren, oldLoopWithoutChildren,
      'Migration must preserve every other loop setting')
    assert.deepEqual(newNodes.get('node-loop').childIds, ['node-image', 'node-video', 'node-video-concat'],
      'Loop must contain image, video, and concat in order')
    assert.equal(newEdges.get('edge-video-concat').from, 'node-video')
    assert.equal(newEdges.get('edge-video-concat').to, 'node-video-concat')
  } else {
    assert.deepEqual({ addedNodeIds, changedNodeIds, removedNodeIds, addedEdgeIds, changedEdgeIds, removedEdgeIds },
      { addedNodeIds: [], changedNodeIds: [], removedNodeIds: [], addedEdgeIds: [], changedEdgeIds: [], removedEdgeIds: [] },
      'Schema 4 must already be stable')
    assert.ok(newNodes.has('node-video-concat') && newEdges.has('edge-video-concat'),
      'Schema 4 is missing the staged concat route')
  }

  const targetHashes = (await db.query(`SELECT md5($1::jsonb::text) AS nodes_md5,
    md5($2::jsonb::text) AS edges_md5`, [JSON.stringify(next.nodes), JSON.stringify(next.edges)])).rows[0]
  const recordCountBefore = (await db.query("SELECT count(*)::int AS count FROM execution_records WHERE workflow_id='wf-story'")).rows[0].count
  if (options.apply) {
    assert.equal(before.nodes_md5, options.expectedNodesMd5.toLowerCase(), 'Source nodes MD5 differs from preview')
    assert.equal(before.edges_md5, options.expectedEdgesMd5.toLowerCase(), 'Source edges MD5 differs from preview')
    assert.equal(before.schema_version, 3, 'Saved workflow is already schema 4; no update needed')
    await mkdir(backupDirectory, { recursive: true })
    backupPath = path.join(backupDirectory,
      `wf-story-schema3-${before.nodes_md5}-${Date.now()}.json`)
    await writeFile(backupPath, JSON.stringify({ capturedAt: new Date().toISOString(), workflow: before }, null, 2),
      { flag: 'wx', mode: 0o600 })
    const saved = await db.query(`UPDATE workflow_configs
      SET nodes=$2::jsonb, edges=$3::jsonb, schema_version=$4, updated_at=now()
      WHERE id=$1 AND schema_version=$5 AND md5(nodes::text)=$6
      AND md5(edges::text)=$7 AND xmin::text=$8 RETURNING id`,
    [before.id, JSON.stringify(next.nodes), JSON.stringify(next.edges), next.schemaVersion,
      before.schema_version, before.nodes_md5, before.edges_md5, before.revision])
    assert.equal(saved.rowCount, 1, 'Workflow CAS lost to a concurrent editor')
  }
  const after = (await db.query(`SELECT schema_version,nodes,edges,
    md5(nodes::text) AS nodes_md5, md5(edges::text) AS edges_md5
    FROM workflow_configs WHERE id='wf-story'`)).rows[0]
  assert.equal(after.schema_version, options.apply ? next.schemaVersion : before.schema_version)
  assert.deepEqual(after.nodes, options.apply ? next.nodes : current.nodes)
  assert.deepEqual(after.edges, options.apply ? next.edges : current.edges)
  assert.equal(after.nodes_md5, options.apply ? targetHashes.nodes_md5 : before.nodes_md5)
  assert.equal(after.edges_md5, options.apply ? targetHashes.edges_md5 : before.edges_md5)
  const recordCountAfter = (await db.query("SELECT count(*)::int AS count FROM execution_records WHERE workflow_id='wf-story'")).rows[0].count
  assert.equal(recordCountAfter, recordCountBefore, 'Execution record count changed during migration')
  if (options.apply) { await db.query('COMMIT'); committed = true }
  else await db.query('ROLLBACK')
  console.log(JSON.stringify({ applied: options.apply, committed,
    schemaBefore: before.schema_version, schemaTarget: next.schemaVersion,
    addedNodeIds, changedNodeIds, removedNodeIds,
    addedEdgeIds, changedEdgeIds, removedEdgeIds,
    nodeCountBefore: current.nodes.length, nodeCountTarget: next.nodes.length,
    edgeCountBefore: current.edges.length, edgeCountTarget: next.edges.length,
    nodesMd5Before: before.nodes_md5, nodesMd5Target: targetHashes.nodes_md5,
    edgesMd5Before: before.edges_md5, edgesMd5Target: targetHashes.edges_md5,
    backupPath, executionRecordCount: recordCountAfter, executionRecordWrites: 0,
    providerCalls: 0 }, null, 2))
} catch (error) {
  if (!committed) await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
