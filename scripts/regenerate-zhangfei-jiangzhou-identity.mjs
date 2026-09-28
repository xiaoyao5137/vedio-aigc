#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'

const workflowId = 'wf-sanguo-history-drama'
const keeperId = 'character-mukn7n7k-xzu2tb'
const previousId = 'character-070b25d71205797c'
const directory = path.resolve('logs/zhangfei-jiangzhou-identity-20260928')
const retryArmor = process.argv.includes('--retry-armor')
const candidateFile = path.join(directory, retryArmor ? 'generated-candidate-2.json' : 'generated-candidate.json')
const planFile = path.join(directory, retryArmor ? 'generation-plan-2.json' : 'generation-plan.json')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })

const loadJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'))
const saveJson = async (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 })
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex')

try {
  await fs.mkdir(directory, { recursive: true })
  const { rows } = await pool.query(`select id,uri,metadata from character_assets where workflow_id=$1
    and character_name='张飞' and id=any($2::text[])`, [workflowId, [keeperId, previousId]])
  const keeper = rows.find(row => row.id === keeperId), previous = rows.find(row => row.id === previousId)
  if (!keeper || !previous || keeper.metadata?.artisticIdentity?.active !== true
    || keeper.metadata?.portraitRevision !== 'changban-handsome-20260928-v2') throw Error('已确认帅气张飞或江州旧资产状态不符，停止生成')
  if (!keeper.metadata?.visualProfile?.sourceFingerprint || !keeper.metadata?.visualProfile?.referenceImage) throw Error('帅气张飞缺少已核验人脸快照')
  if (keeper.metadata.visualProfile.sourceFingerprint !== sha(keeper.uri)) throw Error('帅气张飞图像指纹不符')
  const model = (await pool.query(`select * from model_configs where id='kling-image-3' and capability='image'`)).rows[0]
  if (!model || model.provider === 'Local') throw Error('实际图片生成模型未配置')
  const visualContext = structuredClone(previous.metadata?.visualContext)
  if (visualContext?.look?.key !== 'zhangfei_jiangzhou_campaign' || visualContext.age?.stage !== 'mature') throw Error('旧江州造型契约与预期不同，拒绝修改定义')
  const previousKey = String(previous.metadata?.continuityKey ?? '')
  if (!/-visual-[a-f0-9]{24}-v2$/.test(previousKey)) throw Error('旧江州连续性版本不是 v2，需先核对实际归档')
  const continuityKey = previousKey.replace(/-v2$/, '-v3')
  const actor = { name: '张飞', visualContext, continuityKey, voiceContinuityKey: 'voice:张飞',
    description: '江州时期张飞，人物脸部必须与已核验长坂帅气版是同一演员；黑发高髻木簪、黑色短髭及下颏短须，浓眉直鼻、端正英俊的方阔脸，白净偏暖的自然肤色，宽肩厚臂、腰腹收束。江州穿深褐交领战袍、暗色札甲、皮革腰带与护腕，衣甲略有行军尘土。',
    designPrompt: '真人历史电影定妆摄影，使用唯一脸部参考附件保留同一位张飞演员的五官、脸形、肤色、眉眼、黑色短髭与下颏短须及黑发高髻木簪；同一身份换穿深褐交领战袍和暗色札甲，腰束皮革带、佩深色护腕、着行军靴。健壮宽肩、腰腹收束，成熟俊朗，不变成另一位将领，不变胖或显老，不戴遮住高髻的高冠。输出一张正常彩色、全身正面/90度侧面/背面横向一行三列三视图，三面是同一张脸同一服装，纯色背景、中性站姿，脸部无遮挡，无武器、文字、水印或场景。'
      + (retryArmor ? '【上一候选的明确缺陷，必须修好】上一候选正面胸口只有布袍，侧面和背面才出现甲片，三视图穿着自相矛盾。本次三个视角必须是同一件完整暗色札甲：正面胸口和双肩清晰可见连续暗色甲片，侧面对应同一胸甲、肩甲和胯侧甲，背面对应同一背甲和肩甲；札甲外穿在深褐袍之上，不能让前胸藏在布袍内。每一面胸、肩、腰甲的款式与材料完全一致。身份参考仍只用已确认帅气版张飞的人脸，绝对不要以不合格上一候选整图为参考。' : '') }
  const plan = await fs.access(planFile).then(() => loadJson(planFile)).catch(async () => {
    const created = { at: new Date().toISOString(), workflowId, keeperId, previousId,
      keeperUriFingerprint: sha(keeper.uri), lookKey: visualContext.look.key, continuityKey,
      requestKey: `zhangfei-jiangzhou-same-face${retryArmor ? '-armor-repair' : ''}-${Date.now()}`, episodeNumber: 610,
      maxNewImageRequests: 1, deferredArchive: true, actor }
    await saveJson(planFile, created)
    return created
  })
  if (plan.keeperId !== keeperId || plan.keeperUriFingerprint !== sha(keeper.uri) || plan.lookKey !== visualContext.look.key || plan.continuityKey !== continuityKey) throw Error('既有生成计划与当前人物身份不符')
  const existing = await fs.access(candidateFile).then(() => loadJson(candidateFile)).catch(() => null)
  if (existing?.body?.generatedCount === 1 && existing?.body?.items?.[0]?.url) {
    console.log(JSON.stringify({ status: 'candidate-reused', path: candidateFile, url: existing.body.items[0].url }))
    process.exit(0)
  }
  const before = (await pool.query(`select count(*)::int as count from model_execution_records where request_data->>'requestKey'=$1 and capability='image'`, [plan.requestKey])).rows[0].count
  if (before > 0) throw Error(`已有 ${before} 次同计划图片调用但未保存合格候选；请检查模型账本，不自动再次购买`)
  const request = { operation: 'character.ensure',
    params: { workflowId, episodeNumber: 610, characters: [actor], allCharacters: [actor], existingAssets: [],
      deferArchive: true, validateThreeView: true, qualityDisposition: 'manual-review-v1', maxGenerationAttempts: 1,
      identityReferenceAssetId: keeperId, regenerateAssetId: previousId }, model,
    executionContext: { workflowId, nodeId: 'zhangfei-jiangzhou-identity-repair', requestKey: plan.requestKey } }
  const response = await fetch('http://127.0.0.1:5173/api/builtin-node-run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(900_000),
  })
  const result = await response.json()
  const ledger = (await pool.query(`select id,model_id,status,task_id,created_at,response_data->>'qualityRejected' as quality_rejected,
    request_data->'params'->>'identityReferenceAssetId' as identity_reference_asset_id,
    request_data->'params'->'identityReferenceAnchor'->>'anchorUrl' as anchor_url
    from model_execution_records where request_data->>'requestKey'=$1 and capability='image' order by created_at`, [plan.requestKey])).rows
  await saveJson(path.join(directory, retryArmor ? 'image-request-ledger-2.json' : 'image-request-ledger.json'), ledger)
  await saveJson(candidateFile, { at: new Date().toISOString(), httpStatus: response.status, status: result.status, body: result.body })
  if (!response.ok || result.status >= 400 || result.body?.generatedCount !== 1 || !result.body?.items?.[0]?.url) {
    throw Error(`图片生成未完成：HTTP ${response.status} ${JSON.stringify(result.body).slice(0, 1200)}`)
  }
  console.log(JSON.stringify({ status: 'candidate-created', path: candidateFile, url: result.body.items[0].url,
    generatedCount: result.body.generatedCount, imageRequestCount: ledger.length,
    identityReferenceAssetId: result.body.items[0].metadata?.identityReferenceAssetId,
    anchor: result.body.items[0].metadata?.identityReferenceAnchor?.anchorUrl,
    archived: false }))
} finally { await pool.end() }
