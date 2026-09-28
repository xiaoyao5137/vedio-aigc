#!/usr/bin/env node
// Observes one already archived local triptych with the saved character vision
// text model. Exactly one request per invocation, no new image generation and
// no automatic retry. The manifest and model ledger distinguish a timeout from
// a safely completed review.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import pg from 'pg'

const workflowId = 'wf-sanguo-history-drama'
const assetId = process.argv.find(value => value.startsWith('--asset-id='))?.slice('--asset-id='.length)
const allowed = new Map([
  ['character-mukn7n7k-xzu2tb', { name: '张飞', uri: '/generated/zhang-fei-changban-portrait-20260928-v2.png' }],
  ['character-mukn7n96-esdd71', { name: '刘备', uri: '/generated/liu-bei-changban-portrait-20260928-v2.png' }],
])
if (!allowed.has(assetId)) throw Error('请传入当前两张修订片之一的 --asset-id')
const expected = allowed.get(assetId)
const directory = path.resolve(`logs/dramatic-expression/live-20260928/artistic-identity-migration/review-${assetId}`)
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const post = (body, timeoutMs) => new Promise((resolve, reject) => {
  const bytes = Buffer.from(JSON.stringify(body))
  const request = http.request('http://127.0.0.1:5173/api/builtin-node-run', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': bytes.length }, signal: AbortSignal.timeout(timeoutMs) }, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
  })
  request.on('error', reject)
  request.end(bytes)
})
const save = (name, value) => fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 })

try {
  await fs.mkdir(directory, { recursive: true })
  const asset = (await pool.query(`select id,workflow_id,character_name,asset_type,uri,prompt,metadata,xmin::text as row_version
    from character_assets where id=$1`, [assetId])).rows[0]
  if (!asset || asset.workflow_id !== workflowId || asset.character_name !== expected.name
    || asset.asset_type !== 'three-view' || asset.uri !== expected.uri
    || asset.metadata?.artisticIdentity?.active !== true || asset.metadata?.visualProfile) {
    throw Error('当前修订图状态不符，拒绝重复核验或覆盖已核验图')
  }
  await fs.access(path.join(process.cwd(), 'public', asset.uri))
  const workflow = (await pool.query('select nodes from workflow_configs where id=$1', [workflowId])).rows[0]
  const reviewerId = workflow?.nodes?.find(node => node.id === 'sanguo-character-review')?.modelId
  const model = (await pool.query("select * from model_configs where id=$1 and capability='text'", [reviewerId])).rows[0]
  if (!model || model.provider !== 'Codex') throw Error('当前保存的视觉文本模型不可用')
  const requestKey = `artistic-identity-review-${assetId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const timeoutMs = Math.max(120_000, Number(model.settings?.timeoutMs ?? 900_000) + 120_000)
  const manifest = { assetId, name: expected.name, uri: asset.uri, originalRowVersion: asset.row_version,
    originalMetadataHash: sha(asset.metadata), workflowId, modelId: model.id, provider: model.provider,
    operation: 'character.appearance', requestKey, timeoutMs, submittedAt: new Date().toISOString(),
    modelGeneratedImage: false, humanAcceptance: 'pending' }
  await save('request-manifest.json', manifest)
  const beforeImageCount = Number((await pool.query("select count(*) from model_execution_records where workflow_id=$1 and capability='image'", [workflowId])).rows[0].count)
  const body = { operation: 'character.appearance', model,
    params: { workflowId, qualityDisposition: 'manual-review-v1',
      characters: [{ name: asset.character_name, visualContext: asset.metadata.visualContext }],
      assets: [{ id: asset.id, workflowId, characterName: asset.character_name, url: asset.uri,
        metadata: asset.metadata }] },
    executionContext: { workflowId, nodeId: 'artistic-identity-existing-sheet-review', requestKey } }
  let response
  try { response = await post(body, timeoutMs) }
  catch (error) {
    await save('transport-failure.json', { error: String(error), requestKey, warning: 'Ledger inspection required before any retry' })
    throw error
  }
  const parsed = JSON.parse(response.text)
  await save('response.json', { httpStatus: response.status, body: parsed.body, status: parsed.status })
  const ledger = (await pool.query(`select id,model_id,capability,status,request_data->>'requestKey' as request_key,
    created_at,updated_at,error from model_execution_records where request_data->>'requestKey'=$1 order by created_at`, [requestKey])).rows
  const updated = (await pool.query('select id,uri,metadata,xmin::text as row_version from character_assets where id=$1', [assetId])).rows[0]
  const afterImageCount = Number((await pool.query("select count(*) from model_execution_records where workflow_id=$1 and capability='image'", [workflowId])).rows[0].count)
  const profile = updated?.metadata?.visualProfile ?? null
  const proof = { httpStatus: response.status, nodeStatus: parsed.status, assetId, selectedUriPreserved: updated?.uri === expected.uri,
    selectedIdPreserved: updated?.id === assetId, metadataIdentityPreserved: JSON.stringify(updated?.metadata?.artisticIdentity) === JSON.stringify(asset.metadata.artisticIdentity),
    episodeScopePreserved: JSON.stringify(updated?.metadata?.episodeScope) === JSON.stringify(asset.metadata.episodeScope),
    profileVersion: profile?.version ?? null, profileAppearance: profile?.appearance ?? null,
    profileFingerprintMatches: profile?.sourceFingerprint === crypto.createHash('sha256').update(asset.uri).digest('hex'),
    profileSnapshot: profile?.referenceImage ?? null, reviewLedger: ledger,
    imageModelRequestsAdded: afterImageCount - beforeImageCount, humanAcceptance: 'pending' }
  await save('verification.json', proof)
  console.log(JSON.stringify({assetId, httpStatus: response.status, nodeStatus: parsed.status,
    profileVersion: proof.profileVersion, imageModelRequestsAdded: proof.imageModelRequestsAdded,
    ledgerCount: ledger.length, verificationFile: path.join(directory, 'verification.json')}))
  if (response.status !== 200 || parsed.status >= 400 || !profile || !proof.profileFingerprintMatches
    || !proof.selectedUriPreserved || !proof.metadataIdentityPreserved || proof.imageModelRequestsAdded !== 0) process.exitCode = 1
} finally { await pool.end() }
