#!/usr/bin/env node
// One-time guarded annotation of the two current revised portraits. Run once
// without --apply to preserve the complete pre-change rows; then inspect that
// backup before --apply. No image generation or execution record is touched.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'
import { normalizeCharacterArtisticIdentity } from '../src/character-artistic-identity.ts'

const workflowId = 'wf-sanguo-history-drama'
const targets = [
  { id: 'character-mukn7n7k-xzu2tb', name: '张飞', uri: '/generated/zhang-fei-changban-portrait-20260928-v2.png',
    artisticIdentity: { version: 'character-artistic-identity-v1', active: true,
      face: '方阔而端正的脸形，浓眉、挺直鼻梁与利落下颌，英俊且有武将威仪',
      complexion: '白净偏暖，带自然健康血色',
      frame: '肩背骨架宽阔，胸廓厚实而腰腹收束，体格壮健' } },
  { id: 'character-mukn7n96-esdd71', name: '刘备', uri: '/generated/liu-bei-changban-portrait-20260928-v2.png',
    artisticIdentity: { version: 'character-artistic-identity-v1', active: true,
      face: '端正俊朗的长形脸，眉眼沉静、鼻梁挺直，神情温和而有定力',
      complexion: '肤色较白，保留自然健康血色',
      frame: '身形匀称修长，肩背挺直，气度稳重' } },
]
const directory = path.resolve('logs/dramatic-expression/live-20260928/artistic-identity-migration')
const backupFile = path.join(directory, 'character-assets-before.json')
const apply = process.argv.includes('--apply')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

try {
  await fs.mkdir(directory, { recursive: true })
  for (const target of targets) normalizeCharacterArtisticIdentity(target.artisticIdentity)
  const client = await pool.connect()
  try {
    await client.query('BEGIN READ ONLY')
    const rows = (await client.query(`select id,workflow_id,character_name,asset_type,uri,prompt,version,metadata,
        created_at,updated_at,xmin::text as row_version from character_assets where id=any($1::text[]) order by id`,
    [targets.map(target => target.id)])).rows
    await client.query('COMMIT')
    if (rows.length !== targets.length) throw Error('迁移目标资产不存在或重复')
    for (const target of targets) {
      const row = rows.find(item => item.id === target.id)
      if (!row || row.workflow_id !== workflowId || row.character_name !== target.name || row.asset_type !== 'three-view'
        || row.uri !== target.uri || JSON.stringify(row.metadata?.episodeScope) !== JSON.stringify({ episodes: [518] })) {
        throw Error(`迁移目标身份或集数范围不符：${target.id}`)
      }
      if (row.metadata?.artisticIdentity) throw Error(`目标已存在艺术身份，拒绝覆盖：${target.id}`)
    }
    if (!apply) {
      await fs.writeFile(backupFile, JSON.stringify({ workflowId, rows, sha: sha(rows) }, null, 2), { flag: 'wx', mode: 0o600 })
      console.log(JSON.stringify({ mode: 'backup-only', count: rows.length, backupFile,
        targetIds: targets.map(target => target.id), oldMetadataHashes: rows.map(row => ({ id: row.id, hash: sha(row.metadata) })) }))
    } else {
      const backup = JSON.parse(await fs.readFile(backupFile, 'utf8'))
      if (backup.workflowId !== workflowId || backup.sha !== sha(backup.rows) || backup.rows.length !== rows.length
        || rows.some(row => {
          const before = backup.rows.find(item => item.id === row.id)
          return !before || before.row_version !== row.row_version || sha(before.metadata) !== sha(row.metadata)
        })) throw Error('迁移前记录已变化或备份无效，拒绝覆盖')
      await client.query('BEGIN')
      try {
        for (const target of targets) {
          const before = rows.find(row => row.id === target.id)
          const metadata = { ...before.metadata, artisticIdentity: target.artisticIdentity,
            artisticIdentityReviewStatus: 'pending-user-acceptance' }
          const updated = await client.query(`update character_assets set metadata=$2::jsonb,updated_at=now()
            where id=$1 and xmin::text=$3 and uri=$4 returning id`,
          [target.id, JSON.stringify(metadata), before.row_version, target.uri])
          if (updated.rowCount !== 1) throw Error(`资产并发变化，拒绝覆盖：${target.id}`)
        }
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error }
      console.log(JSON.stringify({ mode: 'applied', count: rows.length, backupFile,
        targetIds: targets.map(target => target.id), humanAcceptance: 'pending' }))
    }
  } finally { client.release() }
} finally { await pool.end() }
