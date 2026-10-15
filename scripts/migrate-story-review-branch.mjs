#!/usr/bin/env node
// Add the visible, bounded story-video review return route. A preview never writes.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { upgradeStoryQualityWorkflow } from '../src/story-quality-workflow.ts'
import { hasCanonicalStoryMediaRetakeEdges } from '../src/story-media-retake-workflow.ts'
import { branchConfigurationErrors } from '../src/workflow-branch.ts'

const WORKFLOW_ID = 'wf-story'
const BRANCH_ID = 'node-video-review-result-branch'
const BRANCH_PASS_EDGE_ID = 'edge-video-review-pass'
const BRANCH_RETAKE_EDGE_ID = 'edge-video-review-retake'
const REVIEW_CONTINUATION_EDGE_ID = 'edge-video-review-concat'
const md5 = value => typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value)
const backupDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../logs/story-review-branch/schema5')

export function parseMigrationArgs(args) {
  const options = { apply: false, expectedNodesMd5: '', expectedEdgesMd5: '' }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--help') { options.help = true; continue }
    if (flag === '--apply') {
      if (options.apply) throw Error('Duplicate argument: --apply')
      options.apply = true
      continue
    }
    const key = { '--expected-nodes-md5': 'expectedNodesMd5', '--expected-edges-md5': 'expectedEdgesMd5' }[flag]
    if (!key || options[key] || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw Error(`Unknown, duplicate or incomplete argument: ${flag}`)
    }
    options[key] = args[++index].toLowerCase()
    if (!md5(options[key])) throw Error(`${flag} must be a 32-character MD5`)
  }
  if (options.apply && (!options.expectedNodesMd5 || !options.expectedEdgesMd5)) {
    throw Error('--apply requires fresh --expected-nodes-md5 and --expected-edges-md5 from a reviewed preview')
  }
  return options
}

function indexed(items, label) {
  assert.ok(Array.isArray(items), `${label} must be an array`)
  const entries = new Map(items.map(item => [item?.id, item]))
  assert.equal(entries.size, items.length, `${label} contains duplicate IDs`)
  assert.ok(!entries.has(undefined), `${label} contains an item without an ID`)
  return entries
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

function assertNewGraph(workflow) {
  assert.equal(workflow.schemaVersion, 6, 'Story review branch migration did not reach schema 6')
  const nodes = indexed(workflow.nodes, 'Target nodes')
  indexed(workflow.edges, 'Target edges')
  const loop = nodes.get('node-loop')
  const branch = nodes.get(BRANCH_ID)
  assert.equal(branch?.kind, 'branch')
  assert.equal(branch?.parentId, loop?.id)
  const children = loop?.childIds ?? []
  for (const id of ['node-video', 'node-video-review', BRANCH_ID, 'node-video-concat']) {
    assert.ok(children.includes(id), `Story loop lacks ${id}`)
  }
  assert.ok(children.indexOf('node-video') < children.indexOf('node-video-review')
    && children.indexOf('node-video-review') < children.indexOf(BRANCH_ID)
    && children.indexOf(BRANCH_ID) < children.indexOf('node-video-concat'),
  'Story review branch is outside the video/review/concat order')
  const route = (from, to, port) => workflow.edges.filter(edge => edge.from === from
    && edge.to === to && edge.branch === port)
  assert.equal(route('node-video-review', BRANCH_ID, undefined).length, 1)
  assert.equal(route(BRANCH_ID, 'node-video-concat', 'true').length, 1)
  assert.equal(route(BRANCH_ID, 'node-video', 'false').length, 1)
  assert.equal(route('node-video-review', 'node-video-concat', undefined).length, 0)
  assert.deepEqual(branchConfigurationErrors(workflow), [], 'Story branch route is invalid')
}

/** Reject any migration that edits generator contracts or unrelated saved routes. */
export function assertMigrationScope(current, next) {
  assert.equal(current.id, WORKFLOW_ID)
  assert.equal(next.id, WORKFLOW_ID)
  assert.ok(current.schemaVersion === 5 || current.schemaVersion === 6,
    `Unexpected wf-story schema ${current.schemaVersion}`)
  assertNewGraph(next)
  const oldNodes = indexed(current.nodes, 'Saved nodes')
  const newNodes = indexed(next.nodes, 'Target nodes')
  const oldEdges = indexed(current.edges, 'Saved edges')
  const newEdges = indexed(next.edges, 'Target edges')
  const diff = {
    addedNodeIds: [...newNodes.keys()].filter(id => !oldNodes.has(id)),
    removedNodeIds: [...oldNodes.keys()].filter(id => !newNodes.has(id)),
    changedNodeIds: [...oldNodes.keys()].filter(id => newNodes.has(id) && !same(oldNodes.get(id), newNodes.get(id))),
    addedEdgeIds: [...newEdges.keys()].filter(id => !oldEdges.has(id)),
    removedEdgeIds: [...oldEdges.keys()].filter(id => !newEdges.has(id)),
    changedEdgeIds: [...oldEdges.keys()].filter(id => newEdges.has(id) && !same(oldEdges.get(id), newEdges.get(id))),
  }
  if (current.schemaVersion === 6) {
    assert.deepEqual(diff, { addedNodeIds: [], removedNodeIds: [], changedNodeIds: [],
      addedEdgeIds: [], removedEdgeIds: [], changedEdgeIds: [] }, 'Schema 6 must be idempotent')
    return diff
  }
  assert.ok(hasCanonicalStoryMediaRetakeEdges(current.edges), 'Saved schema 5 has noncanonical edges')
  assert.deepEqual(diff.addedNodeIds, [BRANCH_ID])
  assert.deepEqual(diff.removedNodeIds, [])
  assert.deepEqual(diff.addedEdgeIds.sort(), [BRANCH_PASS_EDGE_ID, BRANCH_RETAKE_EDGE_ID].sort())
  assert.deepEqual(diff.removedEdgeIds, [])
  assert.deepEqual(diff.changedEdgeIds, [REVIEW_CONTINUATION_EDGE_ID])
  assert.deepEqual(newEdges.get(REVIEW_CONTINUATION_EDGE_ID), {
    ...oldEdges.get(REVIEW_CONTINUATION_EDGE_ID), to: BRANCH_ID,
  })
  assert.deepEqual(newEdges.get(BRANCH_PASS_EDGE_ID), {
    id: BRANCH_PASS_EDGE_ID, from: BRANCH_ID, to: 'node-video-concat', branch: 'true',
  })
  assert.deepEqual(newEdges.get(BRANCH_RETAKE_EDGE_ID), {
    id: BRANCH_RETAKE_EDGE_ID, from: BRANCH_ID, to: 'node-video', branch: 'false',
  })
  for (const [id, before] of oldNodes) {
    const after = newNodes.get(id)
    assert.equal(after.position?.y, before.position?.y, `${id} vertical layout changed`)
    assert.ok(after.position?.x >= before.position?.x, `${id} shifted left`)
    const withoutPosition = node => { const { position, ...rest } = node; return rest }
    if (id === 'node-loop') {
      assert.deepEqual(after.childIds, before.childIds.flatMap(child => child === 'node-video-review'
        ? [child, BRANCH_ID] : [child]), 'Story loop changed beyond the review branch')
      const { childIds: _oldChildren, ...oldRest } = withoutPosition(before)
      const { childIds: _newChildren, ...newRest } = withoutPosition(after)
      assert.deepEqual(newRest, oldRest, 'Story loop execution contract changed')
    } else {
      assert.deepEqual(withoutPosition(after), withoutPosition(before), `${id} execution contract changed`)
    }
  }
  return diff
}

export function prepareStoryReviewBranchMigration(row) {
  assert.equal(row?.id, WORKFLOW_ID, 'Saved wf-story workflow is missing')
  const current = { id: row.id, schemaVersion: row.schema_version,
    nodes: row.nodes, edges: row.edges }
  const next = upgradeStoryQualityWorkflow(current)
  const diff = assertMigrationScope(current, next)
  assert.deepEqual(upgradeStoryQualityWorkflow(next), next, 'Schema 6 upgrade is not idempotent')
  return { current, next, diff }
}

const nodeView = node => ({ id: node.id, kind: node.kind, resultVar: node.resultVar,
  operation: node.operation, parentId: node.parentId, childIds: node.childIds,
  position: node.position, acceptance: node.acceptance, errorRetry: node.errorRetry })

export async function migrateStoryReviewBranch(db, options, backupRoot = backupDirectory) {
  if (options.apply && (!md5(options.expectedNodesMd5) || !md5(options.expectedEdgesMd5))) {
    throw Error('--apply requires reviewed nodes and edges MD5 values')
  }
  await db.query(options.apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ'
    : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  let committed = false
  let backupPath = ''
  try {
    const before = (await db.query(`SELECT *, xmin::text AS revision,
      md5(nodes::text) AS nodes_md5, md5(edges::text) AS edges_md5
      FROM workflow_configs WHERE id=$1${options.apply ? ' FOR UPDATE' : ''}`, [WORKFLOW_ID])).rows[0]
    const { current, next, diff } = prepareStoryReviewBranchMigration(before)
    if (options.expectedNodesMd5 && before.nodes_md5 !== options.expectedNodesMd5) {
      throw Error('Source nodes MD5 differs from the reviewed preview')
    }
    if (options.expectedEdgesMd5 && before.edges_md5 !== options.expectedEdgesMd5) {
      throw Error('Source edges MD5 differs from the reviewed preview')
    }
    const targetHashes = (await db.query(`SELECT md5($1::jsonb::text) AS nodes_md5,
      md5($2::jsonb::text) AS edges_md5`, [JSON.stringify(next.nodes), JSON.stringify(next.edges)])).rows[0]
    const recordSql = `SELECT count(*)::int AS count,
      md5(coalesce(string_agg(er.id || ':' || md5(to_jsonb(er)::text), ',' ORDER BY er.id), '')) AS fingerprint
      FROM execution_records er WHERE er.workflow_id=$1`
    const recordsBefore = (await db.query(recordSql, [WORKFLOW_ID])).rows[0]
    let applied = false
    if (options.apply && current.schemaVersion === 5) {
      await mkdir(backupRoot, { recursive: true })
      backupPath = path.join(backupRoot, `wf-story-schema5-${before.nodes_md5}-${before.edges_md5}-${Date.now()}-${randomUUID().slice(0, 8)}.json`)
      await writeFile(backupPath, JSON.stringify({ capturedAt: new Date().toISOString(), workflow: before }, null, 2),
        { flag: 'wx', mode: 0o600 })
      const saved = await db.query(`UPDATE workflow_configs
        SET nodes=$2::jsonb, edges=$3::jsonb, schema_version=$4, updated_at=now()
        WHERE id=$1 AND schema_version=$5 AND md5(nodes::text)=$6
          AND md5(edges::text)=$7 AND xmin::text=$8 RETURNING id`,
      [WORKFLOW_ID, JSON.stringify(next.nodes), JSON.stringify(next.edges), next.schemaVersion,
        current.schemaVersion, before.nodes_md5, before.edges_md5, before.revision])
      assert.equal(saved.rowCount, 1, 'Workflow CAS lost to a concurrent editor')
      applied = true
    }
    const after = (await db.query(`SELECT schema_version,nodes,edges,
      md5(nodes::text) AS nodes_md5, md5(edges::text) AS edges_md5
      FROM workflow_configs WHERE id=$1`, [WORKFLOW_ID])).rows[0]
    assert.equal(after.schema_version, applied ? 6 : current.schemaVersion)
    assert.deepEqual(after.nodes, applied ? next.nodes : current.nodes)
    assert.deepEqual(after.edges, applied ? next.edges : current.edges)
    assert.equal(after.nodes_md5, applied ? targetHashes.nodes_md5 : before.nodes_md5)
    assert.equal(after.edges_md5, applied ? targetHashes.edges_md5 : before.edges_md5)
    const recordsAfter = (await db.query(recordSql, [WORKFLOW_ID])).rows[0]
    assert.deepEqual(recordsAfter, recordsBefore, 'Saved execution records changed during migration')
    if (applied) { await db.query('COMMIT'); committed = true }
    else await db.query('ROLLBACK')
    const currentById = indexed(current.nodes, 'Saved nodes')
    const targetById = indexed(next.nodes, 'Target nodes')
    return { applied, committed, schemaBefore: current.schemaVersion, schemaTarget: next.schemaVersion,
      ...diff, nodesBefore: current.nodes.map(nodeView), nodesTarget: next.nodes.map(nodeView),
      addedNodes: diff.addedNodeIds.map(id => targetById.get(id)),
      changedNodes: diff.changedNodeIds.map(id => ({ id, before: currentById.get(id), target: targetById.get(id) })),
      edgesBefore: current.edges, edgesTarget: next.edges,
      nodesMd5Before: before.nodes_md5, nodesMd5Target: targetHashes.nodes_md5,
      edgesMd5Before: before.edges_md5, edgesMd5Target: targetHashes.edges_md5,
      backupPath, executionRecordCount: recordsAfter.count,
      executionRecordsFingerprint: recordsAfter.fingerprint, executionRecordWrites: 0, providerCalls: 0 }
  } catch (error) {
    if (!committed) await db.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

async function main() {
  const options = parseMigrationArgs(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/migrate-story-review-branch.mjs [--apply --expected-nodes-md5 MD5 --expected-edges-md5 MD5]\nDefault: read-only schema 5→6 preview. --apply updates only wf-story after reviewed nodes/edges MD5 checks; schema 6 repeats are no-ops.')
    return
  }
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  try {
    await db.connect()
    console.log(JSON.stringify(await migrateStoryReviewBranch(db, options), null, 2))
  } finally { await db.end().catch(() => undefined) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
