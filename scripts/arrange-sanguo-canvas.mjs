#!/usr/bin/env node
// Coordinate-only repair. Preview first, then apply the reported before hash.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { projectCanvasNodes, CANVAS_BASE_NODE_HEIGHT, CANVAS_MEDIA_NODE_HEIGHT } from '../src/canvas-media-layout.ts'

const id = 'wf-sanguo-history-drama'
const apply = process.argv.includes('--apply')
const option = name => process.argv[process.argv.indexOf(name) + 1]
const directory = path.resolve(process.argv.includes('--out') ? option('--out') : 'logs/sanguo-canvas-layout')
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const width = 248
const pitch = 350
// Keep execution stages together and leave separate lanes for the conditional
// frame routes. Positions use the saved (media-preview-off) coordinate system.
const lanes = [
  { y: 160, x: 160, ids: ['input', 'context-init', 'knowledge', 'scene-outline', 'scene-outline-review', 'scene-outline-accept', 'scene-outline-accept-error-branch', 'scene-outline-accept-accept-branch'] },
  { y: 460, x: 160, ids: ['scene-loop', 'shot-script', 'shot-script-review', 'shot-script-accept', 'shot-script-accept-error-branch', 'shot-script-accept-accept-branch'] },
  { y: 760, x: 160, ids: ['character-lookup', 'character-portrait', 'character-image', 'character-evidence', 'character-review', 'character-accept', 'character-accept-error-branch', 'character-accept-accept-branch', 'character-archive-voice-design', 'character-archive-voice-archive', 'character-archive'] },
  { y: 1060, x: 160, ids: ['first-frame-branch', 'first-frame-tail'] },
  { y: 1280, x: 510, ids: ['coverage-precheck', 'coverage-source-archive', 'coverage-first-frame', 'coverage-evidence-plan', 'coverage-evidence', 'coverage-review', 'coverage-approval'] },
  { y: 1500, x: 510, ids: ['map-annotation-review', 'map-annotation-approval', 'animated-map-first-frame', 'map-first-evidence', 'map-first-review', 'map-first-accept'] },
  { y: 1720, x: 2260, ids: ['end-frame', 'map-end-evidence', 'map-end-review', 'map-end-accept'] },
  { y: 1940, x: 510, ids: ['video-reference-router', 'video', 'media-request', 'video-evidence', 'media-metrics', 'media-observe', 'requirement-review'] },
  { y: 2160, x: 510, ids: ['media-review', 'media-accept', 'duration-replan', 'media-accept-error-branch', 'media-accept-accept-branch', 'video-concat', 'last-frame'] },
  { y: 2500, x: 2610, ids: ['verify', 'compose', 'episode-evidence', 'episode-review', 'episode-review-accept', 'episode-review-accept-error-branch', 'episode-review-accept-done'] },
]
const positions = new Map(lanes.flatMap(lane => lane.ids.map((suffix, i) => [`sanguo-${suffix}`, { x: lane.x + i * pitch, y: lane.y }])))
const withoutPositions = nodes => nodes.map(({ position, ...node }) => node)
function overlaps(nodes, media) {
  const projected = projectCanvasNodes(nodes, media)
  const height = media ? CANVAS_MEDIA_NODE_HEIGHT : CANVAS_BASE_NODE_HEIGHT
  const pairs = []
  for (let i = 0; i < projected.length; i++) {
    for (let j = i + 1; j < projected.length; j++) {
      const a = projected[i], b = projected[j]
      // Conservatively reserve a full media card for every node, even text/branches.
      const aTop = a.position.y - (a.kind === 'branch' ? 30 : 0)
      const bTop = b.position.y - (b.kind === 'branch' ? 30 : 0)
      if (Math.abs(a.position.x - b.position.x) < width
        && aTop < b.position.y + height && bTop < a.position.y + height) pairs.push([a.id, b.id])
    }
  }
  return pairs
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await client.connect()
try {
  await client.query(apply ? 'begin isolation level repeatable read' : 'begin isolation level repeatable read read only')
  const current = (await client.query(`select id,name,description,nodes,edges,schema_version,voice_policy,updated_at,xmin::text as revision
    from workflow_configs where id=$1${apply ? ' for update' : ''}`, [id])).rows[0]
  assert.ok(current, 'Sanguo workflow missing')
  assert.equal(current.nodes.length, positions.size, 'Node set changed; review stage lanes before applying')
  assert.deepEqual(new Set(current.nodes.map(node => node.id)), new Set(positions.keys()))
  const beforeHash = hash(current)
  const nextNodes = current.nodes.map(node => ({ ...node, position: positions.get(node.id) }))
  assert.deepEqual(withoutPositions(nextNodes), withoutPositions(current.nodes))
  assert.deepEqual(overlaps(nextNodes, false), [], 'Compact cards overlap')
  assert.deepEqual(overlaps(nextNodes, true), [], 'Media cards overlap')
  const loop = nextNodes.find(node => node.id === 'sanguo-scene-loop')
  const children = nextNodes.filter(node => loop.childIds.includes(node.id))
  assert.ok(nextNodes.filter(node => !node.parentId && node.id !== loop.id && node.position.y > loop.position.y)
    .every(node => node.position.y > Math.max(...children.map(child => child.position.y)) + CANVAS_BASE_NODE_HEIGHT + 70), 'Output stage must be outside loop bounds')
  const history = async () => (await client.query(`select id,xmin::text as revision,ctid::text as location,
    pg_column_size(result) as bytes from execution_records where workflow_id=$1 order by id`, [id])).rows
  const executionsBefore = await history()
  const changes = current.nodes.flatMap((node, i) => JSON.stringify(node.position) === JSON.stringify(nextNodes[i].position)
    ? [] : [{ id: node.id, title: node.title, before: node.position, after: nextNodes[i].position }])
  await mkdir(directory, { recursive: true })
  let backup
  if (apply && changes.length) {
    assert.equal(option('--expected-before-sha256'), beforeHash, 'Preview hash is stale; preview current saved workflow again')
    backup = path.join(directory, `before-${Date.now()}.json`)
    await writeFile(backup, JSON.stringify(current, null, 2), { flag: 'wx', mode: 0o600 })
    const updated = await client.query(`update workflow_configs set nodes=$2::jsonb,updated_at=now()
      where id=$1 and xmin::text=$3 returning id`, [id, JSON.stringify(nextNodes), current.revision])
    assert.equal(updated.rowCount, 1, 'Workflow changed concurrently')
  }
  const saved = (await client.query('select nodes,edges,schema_version,voice_policy,name,description from workflow_configs where id=$1', [id])).rows[0]
  assert.deepEqual(saved.nodes, apply ? nextNodes : current.nodes)
  for (const field of ['edges', 'schema_version', 'voice_policy', 'name', 'description']) assert.deepEqual(saved[field], current[field])
  assert.deepEqual(await history(), executionsBefore, 'Execution records changed')
  const report = {
    workflowId: id, applied: apply, beforeSha256: beforeHash, backup,
    nodes: current.nodes.length, edges: current.edges.length, schemaVersion: current.schema_version,
    changedNodes: changes.length, positionsOnly: true, executionRecords: executionsBefore.length, executionWrites: 0,
    providerCalls: 0, nodeWidth: width, horizontalGap: pitch - width,
    beforeOverlapPairs: { compact: overlaps(current.nodes, false), media: overlaps(current.nodes, true) },
    afterOverlapPairs: { compact: overlaps(nextNodes, false), media: overlaps(nextNodes, true) }, changes,
  }
  await client.query(apply ? 'commit' : 'rollback')
  await writeFile(path.join(directory, apply ? 'applied.json' : 'preview.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, changes: undefined, beforeOverlapPairs: Object.fromEntries(Object.entries(report.beforeOverlapPairs).map(([mode, pairs]) => [mode, pairs.length])) }, null, 2))
} catch (error) {
  await client.query('rollback')
  throw error
} finally {
  await client.end()
}
