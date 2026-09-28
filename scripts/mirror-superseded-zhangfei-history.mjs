#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { mirrorGeneratedCharacterImage } from '../server/character-face-consistency.ts'

const ids = [
  'character-070b25d71205797c',
  'character-bea6a650c02fec61',
  'character-ea33d0a323ed1345',
  'character-8d48c0d42d504268',
]
const apply = process.argv.includes('--apply')
const workflowId = 'wf-sanguo-history-drama'
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc',
  ...(apply ? {} : { options: '-c default_transaction_read_only=on' }) })
const sha256 = value => createHash('sha256').update(value).digest('hex')
const outputDir = path.resolve('.runtime/portrait-supersession')
const logsDir = path.resolve('logs/zhangfei-jiangzhou-identity-20260928')

try {
  const rows = (await pool.query(`select id,workflow_id,character_name,asset_type,uri,prompt,version,metadata,created_at,updated_at
    from character_assets where id=any($1::text[]) order by id`, [ids])).rows
  if (rows.length !== ids.length) throw Error(`张飞历史候选数不符：预期 ${ids.length}，实际 ${rows.length}`)
  for (const row of rows) {
    if (row.workflow_id !== workflowId || row.character_name !== '张飞' || row.asset_type !== 'three-view'
      || row.metadata?.portraitLifecycle?.status !== 'superseded') {
      throw Error(`历史候选身份或状态不符：${row.id}`)
    }
  }
  await mkdir(outputDir, { recursive: true })
  await mkdir(logsDir, { recursive: true })
  const stamp = Date.now()
  const backupPath = path.join(outputDir, `history-media-before-${stamp}.json`)
  await writeFile(backupPath, JSON.stringify({ at: new Date().toISOString(), apply, rows }, null, 2), { mode: 0o600, flag: 'wx' })
  const results = []
  for (const row of rows) {
    if (row.metadata?.historicalMediaMirror) {
      results.push({ id: row.id, status: 'already-mirrored', localUri: row.uri })
      continue
    }
    if (!/^https:\/\//.test(row.uri)) {
      results.push({ id: row.id, status: 'skipped-non-remote', originalUriFingerprint: sha256(row.uri) })
      continue
    }
    if (!apply) {
      results.push({ id: row.id, status: 'ready', originalUriFingerprint: sha256(row.uri) })
      continue
    }
    try {
      const mirror = await mirrorGeneratedCharacterImage(row.uri)
      const bytes = await readFile(path.join(process.cwd(), 'public', mirror.localUri))
      if (sha256(bytes) !== mirror.contentSha256) throw Error('本地镜像内容指纹不符')
      const evidence = { version: 'historical-paid-portrait-mirror-v1', originalUri: row.uri,
        originalUriFingerprint: sha256(row.uri), contentSha256: mirror.contentSha256,
        localUri: mirror.localUri, mirroredAt: new Date().toISOString() }
      const changed = await pool.query(`update character_assets
        set uri=$3, metadata=metadata || jsonb_build_object('historicalMediaMirror',$4::jsonb)
        where id=$1 and uri=$2 and metadata=$5::jsonb and workflow_id=$6 and character_name='张飞'
          and asset_type='three-view' and metadata->'portraitLifecycle'->>'status'='superseded'
        returning id,uri,metadata->'portraitLifecycle' as lifecycle,metadata->'historicalMediaMirror' as mirror`,
      [row.id, row.uri, mirror.localUri, JSON.stringify(evidence), JSON.stringify(row.metadata), workflowId])
      if (changed.rowCount !== 1) throw Error('CAS 冲突；原记录已变化，保留当前记录待重新核对')
      results.push({ id: row.id, status: 'mirrored', localUri: mirror.localUri,
        contentSha256: mirror.contentSha256, originalUriFingerprint: evidence.originalUriFingerprint,
        lifecycleStatus: changed.rows[0].lifecycle?.status })
    } catch (error) {
      results.push({ id: row.id, status: 'failed-preserved', originalUriFingerprint: sha256(row.uri),
        reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) })
    }
  }
  const proof = { at: new Date().toISOString(), mode: apply ? 'apply' : 'preview', backupPath, results }
  const proofPath = path.join(logsDir, apply ? 'historical-media-mirror-apply.json' : 'historical-media-mirror-preview.json')
  await writeFile(proofPath, JSON.stringify(proof, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ ...proof, backupPath: path.relative(process.cwd(), backupPath), proofPath: path.relative(process.cwd(), proofPath) }))
  if (apply && results.some(result => result.status === 'failed-preserved')) process.exitCode = 1
} finally { await pool.end() }
