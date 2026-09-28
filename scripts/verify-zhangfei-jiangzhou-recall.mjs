#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'

const workflowId = 'wf-sanguo-history-drama'
const expectedNewId = 'character-2adc61b636f93ba0'
const oldJiangzhouId = 'character-070b25d71205797c'
const keeperId = 'character-mukn7n7k-xzu2tb'
const directory = path.resolve('logs/zhangfei-jiangzhou-identity-20260928')
const baseUrl = process.env.CHARACTER_RECALL_BASE_URL ?? 'http://127.0.0.1:5173'
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc', options: '-c default_transaction_read_only=on' })
const post = async (params, operation = 'character.lookup') => {
  const response = await fetch(`${baseUrl}/api/builtin-node-run`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, params }),
    signal: AbortSignal.timeout(120_000) })
  const result = await response.json()
  if (!response.ok || result.status >= 400) throw Error(`人物召回失败：${JSON.stringify(result.body).slice(0, 900)}`)
  return result.body
}

try {
  const plan = JSON.parse(await fs.readFile(path.join(directory, 'generation-plan-2.json'), 'utf8'))
  const workflow = (await pool.query('select nodes from workflow_configs where id=$1', [workflowId])).rows[0]
  const selections = workflow?.nodes?.find(node => node.id === 'sanguo-input')?.params?.find(param => param.englishName === 'characterAssetSelections')?.value
  if (typeof selections !== 'string') throw Error('当前工作流缺少人物三视图选择字段')
  const configured = JSON.parse(selections)
  const selectedFor = (episode) => Object.fromEntries(Object.entries(configured).filter(([, value]) =>
    value && typeof value === 'object' && Array.isArray(value.episodes) && value.episodes.includes(episode))
    .map(([name, value]) => [name, value.assetId]))
  if (configured.张飞?.assetId !== keeperId || !configured.张飞?.episodes?.includes(518)
    || configured.张飞?.episodes?.includes(610) || Object.values(configured).some(value => value?.assetId === oldJiangzhouId)) {
    throw Error('当前配置的 518 keeper 锁定或江州选择与预期不符，先核对工作流')
  }
  const jiangzhou = await post({ workflowId, episodeNumber: 610, characters: [plan.actor],
    qualityDisposition: 'manual-review-v1', characterAssetSelections: selectedFor(610) })
  if (jiangzhou.items?.[0]?.id !== expectedNewId || jiangzhou.missingCount !== 0) throw Error('第 610 集未默认召回新的同脸江州图')
  const oldExplicit = await post({ workflowId, episodeNumber: 610, characters: [plan.actor],
    qualityDisposition: 'manual-review-v1', characterAssetSelections: { 张飞: oldJiangzhouId } })
  if (oldExplicit.items?.[0]?.id !== oldJiangzhouId) throw Error('历史旧图的显式审计读取未保留')
  const saved = JSON.parse(await fs.readFile(path.resolve('.runtime/portrait-supersession/portraits-before-1790590885014.json'), 'utf8'))
  const checkpointRow = saved.rows.find(row => row.id === oldJiangzhouId)
  if (!checkpointRow || checkpointRow.metadata?.portraitLifecycle) throw Error('旧 checkpoint 快照不符合未标记旧图样本')
  const staleCheckpointAsset = { id: checkpointRow.id, workflowId: checkpointRow.workflow_id,
    characterName: checkpointRow.character_name, assetType: checkpointRow.asset_type,
    url: checkpointRow.uri, metadata: checkpointRow.metadata }
  const resumed = await post({ workflowId, episodeNumber: 610, characters: [plan.actor],
    existingAssets: [staleCheckpointAsset], qualityDisposition: 'manual-review-v1',
    deferArchive: true }, 'character.ensure')
  if (resumed.items?.[0]?.id !== expectedNewId || resumed.generatedCount !== 0) throw Error('旧 checkpoint 缓存重新召回旧脸或触发了图片购买')
  const keeper = (await pool.query('select metadata from character_assets where id=$1', [keeperId])).rows[0]
  const changban = await post({ workflowId, episodeNumber: 518,
    characters: [{ name: '张飞', visualContext: keeper.metadata.visualContext }],
    qualityDisposition: 'manual-review-v1', characterAssetSelections: selectedFor(518) })
  if (changban.items?.[0]?.id !== keeperId) throw Error('第 518 集已确认帅气版未保持锁定')
  const lifecycle = (await pool.query(`select id,metadata->'portraitLifecycle' as lifecycle from character_assets
    where id=any($1::text[]) order by id`, [[oldJiangzhouId, expectedNewId, keeperId]])).rows
  const proof = { at: new Date().toISOString(), status: 'passed', baseUrl, episode610AutomaticId: jiangzhou.items[0].id,
    episode610HistoricalExplicitId: oldExplicit.items[0].id, episode518SelectedId: changban.items[0].id,
    oldCheckpointResumedId: resumed.items[0].id, oldCheckpointNewImages: resumed.generatedCount,
    currentSelections: configured, lifecycle }
  await fs.writeFile(path.join(directory, 'recall-verification.json'), JSON.stringify(proof, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(proof))
} finally { await pool.end() }
