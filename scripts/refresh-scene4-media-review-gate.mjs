#!/usr/bin/env node
// Refresh only the persisted Sanguo media reviewer prompt and the owned
// principle-policy block of the media accept gate. Default: guarded dry-run.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import pg from 'pg'
import { PRINCIPLE_MEDIA_REVIEW_PROMPT } from '../src/principle-media-quality.ts'
import { upgradePrincipleQuality } from '../src/principle-workflow.ts'

const workflowId = 'wf-sanguo-history-drama'
const args = process.argv.slice(2)
const value = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1] }
const out = value('--out'), apply = args.includes('--apply')
if (!out || args.some(arg => arg.startsWith('--') && !['--out', '--apply'].includes(arg))
  || args.filter(arg => arg === '--out').length !== 1 || args.filter(arg => arg === '--apply').length > 1) {
  throw Error('Usage: node scripts/refresh-scene4-media-review-gate.mjs --out NEW_DIR [--apply]')
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const codeBlock = /\/\/ PRINCIPLE_POLICY_START[\s\S]*?\/\/ PRINCIPLE_POLICY_END/g
const exactlyOneBlock = code => [...String(code).matchAll(codeBlock)].length === 1
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  const result = await db.query('SELECT *, xmin::text AS row_version FROM workflow_configs WHERE id=$1', [workflowId])
  const row = result.rows[0]
  if (!row || row.schema_version < 152 || !Array.isArray(row.nodes) || !Array.isArray(row.edges))
    throw Error('Expected a current schema-152-or-newer saved Sanguo workflow')
  const reviewMatches = row.nodes.filter(node => node.id === 'sanguo-media-review')
  const acceptMatches = row.nodes.filter(node => node.id === 'sanguo-media-accept')
  if (reviewMatches.length !== 1 || acceptMatches.length !== 1 || reviewMatches[0].kind !== 'text'
    || acceptMatches[0].kind !== 'code' || !exactlyOneBlock(acceptMatches[0].code))
    throw Error('Expected exactly one media reviewer and one gated accept node with one owned block')
  const review = reviewMatches[0], accept = acceptMatches[0]
  if (!review.prompt.includes('【原则质检 v1】') || !review.prompt.includes('【原则质检结束】')
    || !review.prompt.includes('${video_evidence}') || !PRINCIPLE_MEDIA_REVIEW_PROMPT.includes('持续保有束缚'))
    throw Error('Saved reviewer prompt or refreshed continuity contract is unexpected')
  const upgraded = upgradePrincipleQuality({ id: workflowId, schemaVersion: row.schema_version, nodes: [review, accept] })
  const updatedAcceptCode = upgraded.nodes.find(node => node.id === accept.id)?.code
  if (!updatedAcceptCode || !exactlyOneBlock(updatedAcceptCode)
    || accept.code.replace(codeBlock, '') !== updatedAcceptCode.replace(codeBlock, ''))
    throw Error('Gate update escaped the owned principle-policy block')
  const nodes = row.nodes.map(node => node.id === review.id ? { ...node, prompt: PRINCIPLE_MEDIA_REVIEW_PROMPT }
    : node.id === accept.id ? { ...node, code: updatedAcceptCode } : node)
  const changed = nodes.flatMap((node, i) => {
    if (hash(node) === hash(row.nodes[i])) return []
    return [{ id: node.id, keys: Object.keys(node).filter(key => hash(node[key]) !== hash(row.nodes[i][key])) }]
  })
  if (JSON.stringify(changed) !== JSON.stringify([
    { id: 'sanguo-media-review', keys: ['prompt'] }, { id: 'sanguo-media-accept', keys: ['code'] },
  ])) throw Error(`Unexpected changed node fields: ${JSON.stringify(changed)}`)
  const proof = { format: 'sanguo-media-review-gate-refresh-v1', workflowId, schemaVersion: row.schema_version,
    rowVersion: row.row_version, beforeNodesHash: hash(row.nodes), afterNodesHash: hash(nodes),
    edgesHash: hash(row.edges), changed, beforeReviewHash: hash(review.prompt), afterReviewHash: hash(PRINCIPLE_MEDIA_REVIEW_PROMPT),
    beforeAcceptBlockHash: hash(accept.code.match(codeBlock)?.[0]), afterAcceptBlockHash: hash(updatedAcceptCode.match(codeBlock)?.[0]),
    outsideGateBlockUnchanged: true, topologyUnchanged: true, executionRowsChanged: 0, modelCalls: 0 }
  if (!apply) {
    await mkdir(out, { recursive: false, mode: 0o700 })
    await writeFile(`${out}/backup-private.json`, JSON.stringify({ row, hash: hash(row) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await writeFile(`${out}/dry-run.json`, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ mode: 'dry-run', ...proof }, null, 2))
  } else {
    const backup = JSON.parse(await readFile(`${out}/backup-private.json`, 'utf8'))
    const dryRun = JSON.parse(await readFile(`${out}/dry-run.json`, 'utf8'))
    if (hash(backup.row) !== backup.hash || backup.row.row_version !== row.row_version
      || dryRun.rowVersion !== row.row_version || dryRun.schemaVersion !== row.schema_version
      || dryRun.beforeNodesHash !== hash(row.nodes) || dryRun.afterNodesHash !== hash(nodes)
      || dryRun.edgesHash !== hash(row.edges)) throw Error('Saved workflow changed since dry-run; refuse overwrite')
    const update = await db.query('UPDATE workflow_configs SET nodes=$2::jsonb, updated_at=now() WHERE id=$1 AND xmin::text=$3 RETURNING xmin::text AS row_version',
      [workflowId, JSON.stringify(nodes), row.row_version])
    if (update.rowCount !== 1) throw Error('Workflow row version changed concurrently; refuse overwrite')
    await writeFile(`${out}/applied.json`, JSON.stringify({ ...proof, mode: 'applied', newRowVersion: update.rows[0].row_version }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ mode: 'applied', changed, oldRowVersion: row.row_version, newRowVersion: update.rows[0].row_version }))
  }
} finally { await db.end() }
