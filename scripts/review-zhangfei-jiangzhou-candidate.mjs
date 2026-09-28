#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'

const workflowId = 'wf-sanguo-history-drama'
const directory = path.resolve('logs/zhangfei-jiangzhou-identity-20260928')
const retryArmor = process.argv.includes('--retry-armor')
const local = process.argv.includes('--local')
const candidateFile = path.join(directory, local ? 'mirrored-candidate.json' : retryArmor ? 'generated-candidate-2.json' : 'generated-candidate.json')
const observationFile = path.join(directory, local ? 'actual-appearance-local.json' : retryArmor ? 'actual-appearance-2.json' : 'actual-appearance.json')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })

try {
  const existing = await fs.access(observationFile).then(() => fs.readFile(observationFile, 'utf8')).catch(() => null)
  if (existing) {
    console.log(JSON.stringify({ status: 'observation-reused', path: observationFile }))
    process.exit(0)
  }
  const candidate = JSON.parse(await fs.readFile(candidateFile, 'utf8'))
  if (candidate.status >= 400 || candidate.body?.generatedCount !== 1 || candidate.body?.items?.length !== 1) throw Error('未找到唯一的待归档江州候选')
  const workflow = (await pool.query('select nodes from workflow_configs where id=$1', [workflowId])).rows[0]
  const reviewId = workflow?.nodes?.find(node => node.id === 'sanguo-character-review')?.modelId
  const reviewModel = (await pool.query("select * from model_configs where id=$1 and capability='text'", [reviewId])).rows[0]
  if (!reviewModel || reviewModel.provider === 'Local') throw Error('实际外观观察模型未配置')
  const response = await fetch('http://127.0.0.1:5173/api/builtin-node-run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: 'character.appearance', params: { workflowId,
      assets: candidate.body.items, qualityDisposition: 'manual-review-v1' }, model: reviewModel,
    executionContext: { workflowId, nodeId: 'zhangfei-jiangzhou-identity-observer',
      requestKey: local ? 'zhangfei-jiangzhou-identity-observer-20260928-local' : retryArmor ? 'zhangfei-jiangzhou-identity-observer-20260928-v2' : 'zhangfei-jiangzhou-identity-observer-20260928-v1' } }),
    signal: AbortSignal.timeout(900_000),
  })
  const result = await response.json()
  await fs.writeFile(observationFile, JSON.stringify({ at: new Date().toISOString(), httpStatus: response.status,
    status: result.status, body: result.body }, null, 2), { mode: 0o600 })
  if (!response.ok || result.status >= 400 || result.body?.items?.length !== 1) throw Error(`人物图外观观察未通过：${JSON.stringify(result.body).slice(0, 1000)}`)
  const asset = result.body.items[0]
  console.log(JSON.stringify({ status: 'observed', path: observationFile, assetId: asset.id,
    referenceImage: asset.metadata?.visualProfile?.referenceImage,
    appearance: asset.metadata?.visualProfile?.appearance,
    matchesContext: asset.metadata?.visualProfile?.visualContextEvidence }))
} finally { await pool.end() }
