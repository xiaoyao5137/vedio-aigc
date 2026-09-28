import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import sharp from 'sharp'
import { buildKlingImageRequest, callKlingImage, fetchModelEndpoint } from '../server/model-adapters.ts'
import { decodeExecutionState } from '../src/execution-storage.ts'

const sourceRecordId = 'record-sand-table-opening-20260928-v3'
const workflowId = 'wf-sanguo-history-drama'
const modelId = 'kling-image-3'
const execute = process.argv.includes('--execute')
const routeClarity = process.argv.includes('--route-clarity')
const unknownFlags = process.argv.slice(2).filter((arg) => !['--execute', '--route-clarity'].includes(arg))
if (unknownFlags.length) throw new Error(`不支持参数：${unknownFlags.join(', ')}`)

function fail(message) { throw new Error(message) }
function requireValue(value, message) { return value ?? fail(message) }

function firstImageUrl(body) {
  return body?.data?.task_result?.images?.[0]?.url
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
let record
let model
let workflow
try {
  ;[record, model, workflow] = await Promise.all([
    pool.query('select result from execution_records where id=$1', [sourceRecordId]).then(({ rows }) => rows[0]),
    pool.query('select id,name,provider,capability,settings from model_configs where id=$1', [modelId]).then(({ rows }) => rows[0]),
    pool.query('select schema_version,nodes from workflow_configs where id=$1', [workflowId]).then(({ rows }) => rows[0]),
  ])
} finally {
  await pool.end()
}
requireValue(record, `缺少已保存史料执行 ${sourceRecordId}`)
requireValue(model, `缺少图片模型 ${modelId}`)
requireValue(workflow, `缺少工作流 ${workflowId}`)
const state = decodeExecutionState(record.result)
const outline = state.context?.approved_scene_outline
const scene = outline?.scenes?.[0]
if (state.context?.scene_outline_review?.decision !== 'pass' || scene?.id !== 'scene-01'
    || scene?.editorialRole !== 'episode_opening' || scene?.animationStyle !== 'historical_map'
    || scene?.visualTreatment !== 'animated' || scene?.cast?.length) {
  fail('518 开场审定大纲不符合无人像历史地图预览条件')
}
const citation = state.context?.historical_sources?.citations?.find((item) => item.index === 2)
if (citation?.title !== '三國志/卷36' || !citation.content?.includes('曹公追之，一日一夜，及於當陽之長阪')) {
  fail('保存的 [史料2] 缺少当阳长阪追击原文')
}
if (model.provider !== 'Kling' || model.capability !== 'image' || model.settings?.model !== 'kling-v3'
    || !model.settings?.endpoint || !(model.settings?.apiKey || (model.settings?.accessKey && model.settings?.secretKey))) {
  fail('当前 kling-image-3 模型配置不足，停止预览')
}
const imageNode = workflow.nodes?.find((node) => node.id === 'sanguo-animated-map-first-frame')
if (imageNode?.modelId !== modelId || imageNode?.operation !== 'history.animated-map-frame'
    || !imageNode?.prompt?.includes('禁止实体盘框') || imageNode.prompt.includes('实体沙盘表达合同')) {
  fail('持久化工作流首帧节点尚未启用古代历史地理地图合同')
}

// This one-frame probe reuses the approved historical facts, not the old
// physical-sand-table shot prompt. Geographic details remain schematic.
const firstPrompt = [
  '【三国历史地图首帧·独立风格验证】生成完整 16:9 全画幅二维古代历史地理示意地图，一张地图上的一个静态时刻。',
  '史料范围：汉末刘表死后，刘备奔江南；曹军追赶，一日一夜，在当阳长阪追及。',
  '以当阳长坂附近与南撤方向为局部地理范围，上北下南，刘备一方已在南撤路线上，曹军一方从后方逼近，开场尚留一段清楚的追逃间隔。只示意相对方向与关系，不伪称精确行军路线、距离、年份、疆界或水道名称。',
  '画面语言参考古代历史地理图：温润宣纸底色、墨线绘山势与道路、淡设色地形晕染、自然蓝色水系；地形与路线清楚可辨。两方以贴合地图的克制蓝红区域设色和细路线表示，起点与前后位置可读，颜色不遮盖地理。全画面为平面绘制，不是摄影场景。',
  '只画这段史料支持的追逃关系，不增加人物、兵力、战斗、桥梁事件或具体行政边界。地图底图不画人物肖像，人物由后期单独叠层。',
  '禁止玩具、实体沙盘、盘框、砂土颗粒、微缩城堡、兵偶、木棋子、棋盘、桌面摄影、悬浮三维箭头、发光线条、游戏界面。',
  '本张首帧不放字幕、标题、地名文字、数字、水印、Logo 或伪字。',
].join('\n')
const routeClarityPrompt = [
  '【三国历史地理地图首帧·追逃方位验证】只生成一张完整16:9横幅的二维古代历史地理示意图，正上方为北，正下方为南，俯视地图而非斜拍山水场景。',
  '唯一史实关系：汉末刘表死后刘备奔江南，曹军从后追赶，一日一夜后在当阳长阪追及。此画面是追及之前的一个静态时刻，不画战斗。',
  '画面布局必须一眼看出同一条南北行进走廊：刘备一方在画面下半部、靠南、领先；曹军一方在画面上半部、靠北、落后。两条克制的平面路线短箭头都从上向下指向南方，红色曹军箭头在后，蓝色刘备箭头在前；两条路线不相交、不横向改道、不指向北方或右方。两方间隔清楚。',
  '地图中央用一个简洁城址图符示意当阳长阪附近的地理锚点，不写文字。地图绘制完整地域轮廓、山丘、平地、道路；不凭空画巨大的河流、桥梁、城墙或行政疆界，不伪称精确历史测绘。',
  '成熟的古代历史地理图视觉语言：宣纸底、墨线、柔和矿物设色、平面地图图符与轻微地形晕染。路线贴在图面上，不遮挡地形。地图里无人，后期才叠加静态肖像。',
  '绝对不是玩具或微缩实体沙盘：没有盘框、砂土、城堡模型、兵偶、旗杆、棋子、桌面摄影、立体箭头、游戏界面。全图无字幕、标题、地名文字、数字、水印、Logo或伪字。',
].join('\n')
const prompt = routeClarity ? routeClarityPrompt : firstPrompt
const params = { aspectRatio: '16:9', resolution: '1k', n: 1, referenceImages: [],
  visualTreatment: 'animated', animationStyle: 'historical_map', animationAesthetic: 'historical_cartography', frameRole: 'first' }
const providerRequest = buildKlingImageRequest(model, prompt, params)
const dryRun = {
  mode: execute ? 'execute' : 'dry-run', variant: routeClarity ? 'route-clarity' : 'style', sourceRecordId, sourceRefs: ['[史料2] 三國志/卷36'],
  approvedScene: { id: scene.id, title: scene.title, role: scene.editorialRole,
    timePlace: scene.contextPayload?.timePlace, geographicFocus: scene.contextPayload?.geographicFocus,
    narration: scene.contextPayload?.narration },
  workflowId, workflowSchemaVersion: workflow.schema_version, nodeId: imageNode.id,
  model: { id: model.id, name: model.name, provider: model.provider, modelName: model.settings.model,
    endpoint: model.settings.endpoint, credentialConfigured: true },
  providerRequest,
  note: '独立首帧风格探针；不修改原工作流执行，不代表历史地理精度或成片质量已验收。',
}
if (!execute) {
  console.log(JSON.stringify(dryRun, null, 2))
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').replace('Z', '')
const prefix = `historical-map-518-${routeClarity ? 'route-clarity' : 'first-frame'}-${stamp}-${randomUUID().slice(0, 8)}`
const directory = path.resolve('public/generated')
await mkdir(directory, { recursive: true })
const manifestPath = path.join(directory, `${prefix}.json`)
let taskId = ''
try {
  const result = await callKlingImage(model, prompt, params, {
    onTaskSubmitted: async (submitted) => { taskId = String(submitted.body?.data?.task_id ?? taskId) },
  })
  const url = firstImageUrl(result.body)
  if (result.status >= 400 || !/^https:\/\//.test(String(url))) {
    fail(`Kling 首帧未成功：HTTP ${result.status}，task_id=${taskId || '无'}，${JSON.stringify(result.body?.error ?? result.body?.data?.task_status_msg ?? '')}`)
  }
  const response = await fetchModelEndpoint(url)
  if (!response.ok) fail(`首帧 URL 下载失败：HTTP ${response.status}，task_id=${taskId || '无'}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) fail('首帧图像大小不在 1B 至 20MB 范围')
  const image = await sharp(bytes, { failOn: 'error' }).metadata()
  if (!image.width || !image.height || Math.abs(image.width / image.height - 16 / 9) > 0.08) {
    fail(`首帧尺寸不符合 16:9：${image.width}x${image.height}`)
  }
  const extension = image.format === 'jpeg' ? 'jpg' : image.format === 'webp' ? 'webp' : 'png'
  const imagePath = path.join(directory, `${prefix}.${extension}`)
  await writeFile(imagePath, bytes, { flag: 'wx' })
  await writeFile(manifestPath, JSON.stringify({ ...dryRun, providerTaskId: taskId,
    providerUnitDeduction: result.body?.data?.final_unit_deduction,
    image: { path: imagePath, url: `/generated/${path.basename(imagePath)}`, width: image.width, height: image.height, bytes: bytes.length } }, null, 2), { flag: 'wx' })
  console.log(JSON.stringify({ ok: true, imagePath, manifestPath, providerTaskId: taskId,
    providerUnitDeduction: result.body?.data?.final_unit_deduction }, null, 2))
} catch (error) {
  await writeFile(manifestPath, JSON.stringify({ ...dryRun, providerTaskId: taskId,
    error: error instanceof Error ? error.message : String(error) }, null, 2), { flag: 'wx' })
  console.error(JSON.stringify({ ok: false, manifestPath, providerTaskId: taskId,
    error: error instanceof Error ? error.message : String(error) }, null, 2))
  process.exitCode = 1
}
