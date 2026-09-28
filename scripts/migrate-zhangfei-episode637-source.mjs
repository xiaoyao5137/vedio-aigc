#!/usr/bin/env node
// Preview by default. Applying replaces only the saved workflow's workbook upload.
// Usage: node scripts/migrate-zhangfei-episode637-source.mjs
//        node scripts/migrate-zhangfei-episode637-source.mjs --apply --expected-row-version=<previewed xmin>
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import pg from 'pg'
import readWorkbook from 'read-excel-file/node'

const workflowId = 'wf-sanguo-history-drama'
const uploadName = '三国历史短剧1000集策划总表.xlsx'
const oldCell = '卷九、卷十七、卷十八相关将领传'
const newCell = '卷三十六《关张马黄赵传》及裴松之注；卷九、卷十七、卷十八相关将领传'
const expectedOldSha = '1f793823b93434f950fc631db638faa4dc577e35ea5fc83fe7bb69ee9d961945'
const expectedNewSha = 'e45120b8bf2a0d8524da4b42f585810290f7a1c885c5e6e45d579f9af8667609'
const workbookPath = new URL('../public/data/三国历史短剧1000集策划总表.xlsx', import.meta.url)
const backupPath = new URL('../logs/episode637-source-correction-20260928/workbook-before.xlsx', import.meta.url)
const outputDir = path.resolve('logs/episode637-source-correction-20260928')
const apply = process.argv.includes('--apply')
const versionArg = process.argv.find(value => value.startsWith('--expected-row-version='))
const expectedVersion = versionArg?.split('=')[1]
const sha = data => crypto.createHash('sha256').update(data).digest('hex')
const hashJson = data => sha(JSON.stringify(data))

async function workbookDiff(beforeBytes, afterBytes) {
  const [before, after] = await Promise.all([readWorkbook(beforeBytes), readWorkbook(afterBytes)])
  assert.deepEqual(before.map(sheet => sheet.sheet), after.map(sheet => sheet.sheet), 'Worksheet names/order changed')
  const changes = []
  for (let sheetIndex = 0; sheetIndex < before.length; sheetIndex += 1) {
    const oldSheet = before[sheetIndex]
    const newSheet = after[sheetIndex]
    assert.equal(newSheet.data.length, oldSheet.data.length, `Row count changed in ${oldSheet.sheet}`)
    for (let row = 0; row < oldSheet.data.length; row += 1) {
      const previous = oldSheet.data[row]
      const current = newSheet.data[row]
      assert.equal(current.length, previous.length, `Column count changed in ${oldSheet.sheet} row ${row + 1}`)
      for (let column = 0; column < previous.length; column += 1) {
        if (previous[column] !== current[column]) changes.push({
          sheet: oldSheet.sheet, row: row + 1, column: column + 1,
          before: previous[column], after: current[column],
        })
      }
    }
  }
  assert.deepEqual(changes, [{ sheet: '1000集总表', row: 638, column: 6, before: oldCell, after: newCell }],
    'Candidate workbook must change only F638')
  return { sheetCounts: before.map(sheet => ({ name: sheet.sheet, rows: sheet.data.length })), cellChanges: changes }
}

async function saveImmutable(file, content) {
  try {
    await fs.writeFile(file, content, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    assert.deepEqual(await fs.readFile(file), Buffer.isBuffer(content) ? content : Buffer.from(content),
      `Backup already exists with different content: ${file}`)
  }
}

function attachmentFrom(row) {
  const matches = row.nodes.flatMap(node => (node.uploads ?? []).map((upload, index) => ({ node, upload, index })))
    .filter(item => item.node.id === 'sanguo-context-init' && item.upload.name === uploadName)
  assert.equal(matches.length, 1, 'Expected exactly one production workbook attachment on context-init')
  assert.equal(matches[0].node.kind, 'code', 'Unexpected context-init node kind')
  const dataUrl = matches[0].upload.dataUrl
  assert.match(dataUrl, /^data:application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet;base64,/)
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
  assert.equal(bytes.length, matches[0].upload.size, 'Saved upload length metadata differs from bytes')
  return { ...matches[0], bytes }
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc',
  options: apply ? undefined : '-c default_transaction_read_only=on',
})
await fs.mkdir(outputDir, { recursive: true, mode: 0o700 })
const original = await fs.readFile(backupPath)
const candidate = await fs.readFile(workbookPath)
assert.equal(sha(original), expectedOldSha, 'Immutable baseline workbook hash changed')
assert.equal(sha(candidate), expectedNewSha, 'Corrected workbook hash changed; redo the one-cell audit')
const workbookAudit = await workbookDiff(original, candidate)

if (apply) assert.match(expectedVersion ?? '', /^\d+$/, 'Apply requires --expected-row-version=<xmin from a fresh dry-run>')
await client.connect()
let inTransaction = false
try {
  await client.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  inTransaction = true
  const row = (await client.query(`SELECT *, xmin::text AS row_version FROM workflow_configs WHERE id=$1${apply ? ' FOR UPDATE' : ''}`,
    [workflowId])).rows[0]
  assert.ok(row, 'Production workflow missing')
  if (apply) assert.equal(row.row_version, expectedVersion, 'Workflow row version changed since dry-run; rerun preview')
  const { node, upload, index, bytes: currentUpload } = attachmentFrom(row)
  assert.equal(sha(currentUpload), expectedOldSha, 'Production upload is not the approved original; stop instead of overwriting another version')
  assert.deepEqual(currentUpload, original, 'Saved upload bytes differ from the immutable original workbook backup')

  const oldUrl = upload.dataUrl
  const newUrl = `${oldUrl.slice(0, oldUrl.indexOf(',') + 1)}${candidate.toString('base64')}`
  const nextNodes = row.nodes.map(item => item.id !== node.id ? item : {
    ...item,
    uploads: item.uploads.map((asset, assetIndex) => assetIndex !== index ? asset : {
      ...asset, dataUrl: newUrl, size: candidate.length,
    }),
  })
  assert.equal(nextNodes.length, row.nodes.length)
  const nextNode = nextNodes.find(item => item.id === node.id)
  assert.deepEqual({ ...nextNode, uploads: node.uploads }, node, 'Context-init settings beyond its upload changed')
  assert.deepEqual(nextNodes.filter(item => item.id !== node.id), row.nodes.filter(item => item.id !== node.id),
    'Another workflow node changed')
  const nextUpload = nextNode.uploads[index]
  assert.deepEqual({ ...nextUpload, dataUrl: upload.dataUrl, size: upload.size }, upload,
    'Workbook upload metadata other than bytes/size changed')

  const history = async () => (await client.query(
    'SELECT id,xmin::text AS version,ctid::text AS location FROM execution_records WHERE workflow_id=$1 ORDER BY id',
    [workflowId])).rows
  const historyBefore = await history()
  const workflowBackup = path.join(outputDir, `workflow-before-xmin${row.row_version}.json`)
  const uploadBackup = path.join(outputDir, `workflow-upload-before-${expectedOldSha}.xlsx`)
  // Both backups are written even on dry-run, so the prior production upload is
  // retained before anyone opts into publishing the corrected attachment.
  await saveImmutable(workflowBackup, JSON.stringify(row, null, 2))
  await saveImmutable(uploadBackup, currentUpload)

  let saved = row
  if (apply) {
    const update = await client.query(
      'UPDATE workflow_configs SET nodes=$2::jsonb,updated_at=now() WHERE id=$1 AND xmin::text=$3',
      [workflowId, JSON.stringify(nextNodes), row.row_version])
    assert.equal(update.rowCount, 1, 'Guarded workflow upload update did not affect exactly one row')
    saved = (await client.query('SELECT *, xmin::text AS row_version FROM workflow_configs WHERE id=$1', [workflowId])).rows[0]
    assert.deepEqual(saved.nodes, nextNodes, 'Persisted workflow nodes differ from proposed nodes')
    const stable = value => Object.fromEntries(Object.entries(value).filter(([key]) =>
      !['nodes', 'updated_at', 'row_version'].includes(key)))
    assert.deepEqual(stable(saved), stable(row), 'A workflow property outside nodes/updated_at changed')
  }
  const historyAfter = await history()
  assert.deepEqual(historyAfter, historyBefore, 'An execution row changed during the migration')
  await client.query(apply ? 'COMMIT' : 'ROLLBACK')
  inTransaction = false

  const proof = {
    at: new Date().toISOString(), workflowId, applied: apply,
    workbookPath: path.resolve(workbookPath.pathname), workbookAudit,
    workbookBeforeSha256: expectedOldSha, workbookAfterSha256: expectedNewSha,
    savedUploadBeforeSha256: sha(currentUpload), proposedUploadSha256: sha(candidate),
    savedUploadBeforeBytes: currentUpload.length, proposedUploadBytes: candidate.length,
    savedUploadBackup: uploadBackup, savedWorkflowBackup: workflowBackup,
    previousUploadPreserved: true, previousWorkflowSnapshotPreserved: true,
    workflowName: row.name, workflowSchema: row.schema_version,
    workflowRowVersionBefore: row.row_version,
    workflowRowVersionAfter: saved.row_version,
    changedNodeIds: [node.id], changedUploadFields: ['dataUrl', 'size'],
    graphPreserved: true, nodeCount: row.nodes.length, edgeCount: row.edges.length,
    nodesSha256Before: hashJson(row.nodes), nodesSha256Proposed: hashJson(nextNodes),
    executionRowsPreserved: historyBefore.length, executionVersionsSha256: hashJson(historyBefore),
    executionWrites: 0, modelRequests: 0, mediaGenerated: false,
  }
  const proofPath = path.join(outputDir, apply ? 'migration-applied.json' : 'migration-preview.json')
  await fs.writeFile(proofPath, JSON.stringify(proof, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ proofPath, applied: apply, workflowRowVersionBefore: row.row_version,
    workbookAfterSha256: expectedNewSha, savedUploadBeforeSha256: expectedOldSha,
    proposedUploadSha256: sha(candidate), executionRowsPreserved: historyBefore.length,
    changedNodeIds: [node.id], changedUploadFields: ['dataUrl', 'size'] }))
} catch (error) {
  if (inTransaction) await client.query('ROLLBACK')
  throw error
} finally {
  await client.end()
}
