#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'

const workflowId = 'wf-sanguo-history-drama'
const keeperId = 'character-mukn7n7k-xzu2tb'
const previousId = 'character-070b25d71205797c'
const directory = path.resolve('logs/zhangfei-jiangzhou-identity-20260928')
const archiveFile = path.join(directory, 'archive.json')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const save = (name, value) => fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 })

try {
  const observed = JSON.parse(await fs.readFile(path.join(directory, 'actual-appearance-local.json'), 'utf8'))
  const plan = JSON.parse(await fs.readFile(path.join(directory, 'generation-plan-2.json'), 'utf8'))
  const item = observed.body?.items?.[0]
  if (observed.status >= 400 || observed.body?.items?.length !== 1
    || item.id !== 'character-2adc61b636f93ba0'
    || item.metadata?.identityReferenceAssetId !== keeperId
    || item.metadata?.sourceMediaProvenance?.localUri !== item.url
    || !item.url.startsWith('/generated/character-portrait-')) throw Error('本地图像、身份引用或媒体来源尚未通过归档前校验')
  const assetIds = [keeperId, previousId, item.id]
  const before = (await pool.query(`select id,uri,metadata,updated_at from character_assets where id=any($1::text[])`, [assetIds])).rows
  const keeper = before.find(row => row.id === keeperId), previous = before.find(row => row.id === previousId)
  if (!keeper || !previous || keeper.metadata?.artisticIdentity?.active !== true
    || before.some(row => row.id === item.id)) throw Error('保留版/旧江州版状态变化或新版已存在，停止重复归档')
  const biography = (await pool.query(`select biography from character_biographies where workflow_id=$1 and character_name='张飞'`, [workflowId])).rows[0]?.biography
  const voicesBefore = (await pool.query(`select id,character_name,continuity_key from voice_characters where workflow_id=$1 and character_name='张飞' order by id`, [workflowId])).rows
  await save('pre-archive-snapshot.json', { at: new Date().toISOString(), assets: before,
    biography, voiceRows: voicesBefore })
  const existing = await fs.access(archiveFile).then(async () => JSON.parse(await fs.readFile(archiveFile, 'utf8'))).catch(() => null)
  if (!existing) {
    const actor = { ...plan.actor, ...(typeof biography === 'string' && biography.trim() ? { biography } : {}) }
    const response = await fetch('http://127.0.0.1:5173/api/builtin-node-run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'character.archive', params: { workflowId, episodeNumber: 610,
        characters: [actor], generatedAssets: { items: [item] }, qualityDisposition: 'manual-review-v1' },
      executionContext: { workflowId, nodeId: 'zhangfei-jiangzhou-identity-archive',
        requestKey: 'zhangfei-jiangzhou-identity-archive-20260928-v3' } }),
      signal: AbortSignal.timeout(120_000),
    })
    const result = await response.json()
    await save('archive.json', { at: new Date().toISOString(), httpStatus: response.status,
      status: result.status, body: result.body })
    if (!response.ok || result.status >= 400 || result.body?.items?.[0]?.id !== item.id
      || result.body.items[0].url !== item.url) throw Error(`本地图像归档未成功：${JSON.stringify(result.body).slice(0, 1000)}`)
  }
  const after = (await pool.query(`select id,uri,metadata,updated_at from character_assets where id=any($1::text[])`, [assetIds])).rows
  const archived = after.find(row => row.id === item.id)
  const oldSame = [keeperId, previousId].every(id => {
    const original = before.find(row => row.id === id), current = after.find(row => row.id === id)
    return original && current && original.uri === current.uri && JSON.stringify(original.metadata) === JSON.stringify(current.metadata)
  })
  const voicesAfter = (await pool.query(`select id,character_name,continuity_key from voice_characters where workflow_id=$1 and character_name='张飞' order by id`, [workflowId])).rows
  const proven = archived?.uri === item.url && archived.metadata?.sourceMediaProvenance?.contentSha256 === item.metadata.sourceMediaProvenance.contentSha256
    && archived.metadata?.identityReferenceAssetId === keeperId && oldSame
    && JSON.stringify(voicesBefore) === JSON.stringify(voicesAfter)
  await save('post-archive-verification.json', { at: new Date().toISOString(), archived, oldSame,
    voiceRowsBefore: voicesBefore, voiceRowsAfter: voicesAfter, proven })
  if (!proven) throw Error('归档后图片来源、旧图或人物声音验证失败')
  console.log(JSON.stringify({ status: 'archived-and-verified', id: archived.id, uri: archived.uri,
    oldAssetsUnchanged: oldSame, voiceRowsUnchanged: true,
    provenance: archived.metadata.sourceMediaProvenance, proof: path.join(directory, 'post-archive-verification.json') }))
} finally { await pool.end() }
