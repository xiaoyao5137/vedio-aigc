#!/usr/bin/env node
// Make the story script and media checks visible workflow nodes. Preview is read-only.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import {
  STORY_SCRIPT_REVIEW_NODE_ID,
  STORY_VIDEO_REVIEW_NODE_ID,
  upgradeStoryQualityWorkflow,
} from '../src/story-quality-workflow.ts'

const options = { apply: false, expectedNodesMd5: '', expectedEdgesMd5: '' }
const args = process.argv.slice(2)
for (let index = 0; index < args.length; index++) {
  const flag = args[index]
  if (flag === '--help') {
    console.log('node scripts/migrate-story-quality-workflow.mjs [--apply --expected-nodes-md5 MD5 --expected-edges-md5 MD5]')
    process.exit(0)
  }
  if (flag === '--apply') {
    if (options.apply) throw Error('Duplicate argument: --apply')
    options.apply = true
    continue
  }
  const field = flag === '--expected-nodes-md5' ? 'expectedNodesMd5'
    : flag === '--expected-edges-md5' ? 'expectedEdgesMd5' : undefined
  if (!field) throw Error(`Unknown argument: ${flag}`)
  if (options[field] || !args[index + 1] || args[index + 1].startsWith('--')) {
    throw Error(`Missing or duplicate value: ${flag}`)
  }
  options[field] = args[++index].toLowerCase()
}
for (const field of ['expectedNodesMd5', 'expectedEdgesMd5']) {
  if (options[field] && !/^[a-f0-9]{32}$/.test(options[field])) throw Error(`${field} must be a 32-character MD5`)
}
if (options.apply && (!options.expectedNodesMd5 || !options.expectedEdgesMd5)) {
  throw Error('--apply requires fresh --expected-nodes-md5 and --expected-edges-md5 values from a read-only preview')
}

const byId = (items, label) => {
  const mapped = new Map(items.map(item => [item.id, item]))
  assert.equal(mapped.size, items.length, `${label} has duplicate IDs`)
  return mapped
}
const param = (node, name) => {
  const matches = node.params.filter(item => (item.englishName || item.name) === name)
  assert.equal(matches.length, 1, `${node.id} must have exactly one ${name} input`)
  return matches[0]
}
const route = (edges, from, to) => edges.filter(edge => edge.from === from && edge.to === to && !edge.branch)

function assertQualityGraph(workflow) {
  assert.equal(workflow.schemaVersion, 5, 'Story quality migration did not reach schema 5')
  const nodes = byId(workflow.nodes, 'Target nodes')
  byId(workflow.edges, 'Target edges')
  const script = nodes.get('node-script')
  const scriptReview = nodes.get(STORY_SCRIPT_REVIEW_NODE_ID)
  const loop = nodes.get('node-loop')
  const video = nodes.get('node-video')
  const videoReview = nodes.get(STORY_VIDEO_REVIEW_NODE_ID)
  const concat = nodes.get('node-video-concat')
  for (const [label, node] of Object.entries({ script, scriptReview, loop, video, videoReview, concat })) {
    assert.ok(node, `Target graph is missing ${label}`)
  }
  assert.equal(scriptReview.kind, 'validation')
  assert.equal(scriptReview.operation, 'story.script-review')
  assert.equal(scriptReview.resultVar, 'script_review')
  assert.equal(param(scriptReview, 'script').value, `\${${script.resultVar}}`)
  assert.equal(param(scriptReview, 'expectedCount').value, '${input.vedio_count}')
  assert.equal(param(scriptReview, 'source').value, '${storyScriptSource}')
  assert.equal(loop.loop.sourcePath, 'script_review.shots')
  assert.equal(loop.loop.fallbackCount, 0)
  assert.deepEqual(loop.childIds, ['node-image', 'node-video', STORY_VIDEO_REVIEW_NODE_ID, 'node-video-concat'])
  assert.equal(videoReview.kind, 'validation')
  assert.equal(videoReview.operation, 'story.media-review')
  assert.equal(videoReview.resultVar, 'video_review')
  assert.equal(videoReview.parentId, loop.id)
  assert.equal(param(videoReview, 'shot').value, '${shot}')
  assert.equal(param(videoReview, 'video').value, `\${${video.resultVar}}`)
  assert.equal(param(video, 'requiredPromptText').value, '${shot.timedActions}')
  assert.equal(param(video, 'promptOverflowPolicy').value, 'reject')
  assert.equal(param(video, 'duration').value, '${shot.duration}')
  assert.equal(param(video, 'expectedDuration').value, '${shot.duration}')
  assert.equal(param(video, 'requiredSound').value, 'on')
  assert.ok(video.prompt.includes('${shot.timedActions}'), 'Video prompt does not bind the checked beats')
  assert.ok(!video.prompt.includes('${shotTimedActions}'), 'Video prompt still depends on hidden executor injection')
  assert.equal(param(concat, 'currentVideo').value, '${video_review}')
  for (const [from, to] of [
    [script.id, scriptReview.id], [scriptReview.id, loop.id],
    [video.id, videoReview.id], [videoReview.id, concat.id],
  ]) assert.equal(route(workflow.edges, from, to).length, 1, `Expected exactly one ${from} -> ${to} edge`)
  assert.equal(route(workflow.edges, script.id, loop.id).length, 0, 'Script bypasses its review')
  assert.equal(route(workflow.edges, video.id, concat.id).length, 0, 'Video bypasses its review')
  const orderedIds = workflow.nodes.map(node => node.id)
  assert.ok(orderedIds.indexOf(script.id) < orderedIds.indexOf(scriptReview.id)
    && orderedIds.indexOf(scriptReview.id) < orderedIds.indexOf(loop.id), 'Script review node order is invalid')
  assert.ok(orderedIds.indexOf(video.id) < orderedIds.indexOf(videoReview.id)
    && orderedIds.indexOf(videoReview.id) < orderedIds.indexOf(concat.id), 'Video review node order is invalid')
}

function assertMigrationScope(current, next) {
  const oldNodes = byId(current.nodes, 'Saved nodes')
  const newNodes = byId(next.nodes, 'Target nodes')
  const oldEdges = byId(current.edges, 'Saved edges')
  const newEdges = byId(next.edges, 'Target edges')
  const addedNodeIds = [...newNodes.keys()].filter(id => !oldNodes.has(id))
  const removedNodeIds = [...oldNodes.keys()].filter(id => !newNodes.has(id))
  const changedNodeIds = [...oldNodes.keys()].filter(id => newNodes.has(id)
    && JSON.stringify(oldNodes.get(id)) !== JSON.stringify(newNodes.get(id)))
  const addedEdgeIds = [...newEdges.keys()].filter(id => !oldEdges.has(id))
  const removedEdgeIds = [...oldEdges.keys()].filter(id => !newEdges.has(id))
  const changedEdgeIds = [...oldEdges.keys()].filter(id => newEdges.has(id)
    && JSON.stringify(oldEdges.get(id)) !== JSON.stringify(newEdges.get(id)))
  const diff = { addedNodeIds, changedNodeIds, removedNodeIds, addedEdgeIds, changedEdgeIds, removedEdgeIds }
  if (current.schemaVersion === 5) {
    assert.deepEqual(diff, { addedNodeIds: [], changedNodeIds: [], removedNodeIds: [],
      addedEdgeIds: [], changedEdgeIds: [], removedEdgeIds: [] }, 'Schema 5 must be idempotent')
    return diff
  }
  assert.deepEqual(addedNodeIds, [STORY_SCRIPT_REVIEW_NODE_ID, STORY_VIDEO_REVIEW_NODE_ID])
  assert.deepEqual(changedNodeIds.sort(), ['node-loop', 'node-video', 'node-video-concat'].sort())
  assert.deepEqual(removedNodeIds, [])
  assert.deepEqual(addedEdgeIds.sort(), ['edge-script-review-loop', 'edge-video-review-concat'].sort())
  assert.deepEqual(removedEdgeIds, [])
  const directScriptEdge = route(current.edges, 'node-script', 'node-loop')
  const directVideoEdge = route(current.edges, 'node-video', 'node-video-concat')
  assert.equal(directScriptEdge.length, 1, 'Saved graph has no unique script-to-loop edge')
  assert.equal(directVideoEdge.length, 1, 'Saved graph has no unique video-to-concat edge')
  assert.deepEqual(changedEdgeIds.sort(), [directScriptEdge[0].id, directVideoEdge[0].id].sort())
  assert.deepEqual(newEdges.get(directScriptEdge[0].id), { ...directScriptEdge[0], to: STORY_SCRIPT_REVIEW_NODE_ID })
  assert.deepEqual(newEdges.get(directVideoEdge[0].id), { ...directVideoEdge[0], to: STORY_VIDEO_REVIEW_NODE_ID })
  return diff
}

const backupDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../logs/story-quality/schema4')
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
  assert.ok(before.schema_version === 4 || before.schema_version === 5,
    `Unexpected wf-story schema ${before.schema_version}`)
  const current = { id: before.id, schemaVersion: before.schema_version,
    nodes: before.nodes, edges: before.edges }
  const next = upgradeStoryQualityWorkflow(current)
  assertQualityGraph(next)
  assert.equal(upgradeStoryQualityWorkflow(next), next, 'Story quality migration is not idempotent')
  const diff = assertMigrationScope(current, next)
  const targetHashes = (await db.query(`SELECT md5($1::jsonb::text) AS nodes_md5,
    md5($2::jsonb::text) AS edges_md5`, [JSON.stringify(next.nodes), JSON.stringify(next.edges)])).rows[0]
  const recordSql = `SELECT count(*)::int AS count,
    md5(coalesce(string_agg(er.id || ':' || md5(to_jsonb(er)::text), ',' ORDER BY er.id), '')) AS fingerprint
    FROM execution_records er WHERE er.workflow_id='wf-story'`
  const recordsBefore = (await db.query(recordSql)).rows[0]
  if (options.apply) {
    assert.equal(before.schema_version, 4, 'Saved workflow is already schema 5; no update needed')
    assert.equal(before.nodes_md5, options.expectedNodesMd5, 'Source nodes MD5 differs from preview')
    assert.equal(before.edges_md5, options.expectedEdgesMd5, 'Source edges MD5 differs from preview')
    await mkdir(backupDirectory, { recursive: true })
    backupPath = path.join(backupDirectory, `wf-story-schema4-${before.nodes_md5}-${Date.now()}.json`)
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
  const recordsAfter = (await db.query(recordSql)).rows[0]
  assert.deepEqual(recordsAfter, recordsBefore, 'Saved execution records changed during migration')
  if (options.apply) { await db.query('COMMIT'); committed = true }
  else await db.query('ROLLBACK')
  console.log(JSON.stringify({ applied: options.apply, committed,
    schemaBefore: before.schema_version, schemaTarget: next.schemaVersion, ...diff,
    nodeCountBefore: current.nodes.length, nodeCountTarget: next.nodes.length,
    edgeCountBefore: current.edges.length, edgeCountTarget: next.edges.length,
    nodesMd5Before: before.nodes_md5, nodesMd5Target: targetHashes.nodes_md5,
    edgesMd5Before: before.edges_md5, edgesMd5Target: targetHashes.edges_md5,
    backupPath, executionRecordCount: recordsAfter.count,
    executionRecordsFingerprint: recordsAfter.fingerprint, executionRecordWrites: 0,
    providerCalls: 0 }, null, 2))
} catch (error) {
  if (!committed) await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
