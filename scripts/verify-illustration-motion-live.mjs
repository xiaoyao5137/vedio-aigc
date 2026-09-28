#!/usr/bin/env node
import pg from 'pg'
import { compileDurationSchedule } from '../src/duration-schedule.ts'

const base = process.env.APP_URL ?? 'http://127.0.0.1:5173'
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc'
const sourceId = process.argv[2] ?? 'model-run-mtztik2q-btik9et'
const pool = new pg.Pool({ connectionString: databaseUrl })

async function post(path, body) {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const value = await response.json()
  if (!response.ok || Number(value.status) >= 400) throw Error(JSON.stringify(value))
  return value
}

try {
  const config = await fetch(base + '/api/config').then(response => response.json())
  const { rows: [source] } = await pool.query('select model_id, request_data from model_execution_records where id=$1', [sourceId])
  if (!source) throw Error(`source model execution ${sourceId} not found`)
  const imageModel = config.models.find(model => model.id === 'kling-image-3')
  const videoModel = config.models.find(model => model.id === source.model_id)
  if (!imageModel || !videoModel) throw Error('configured image/video model missing')
  const { rows: [character] } = await pool.query("select character_name,uri from character_assets where character_name='张角' and asset_type='three-view' order by updated_at desc limit 1")
  if (!character) throw Error('approved 张角 three-view asset missing')

  const stamp = Date.now()
  const { rows: [completedBackground] } = await pool.query("select response_data from model_execution_records where workflow_id='wf-sanguo-history-drama' and node_id='sanguo-animated-map-first-frame' and status='succeeded' and request_data->>'requestKey' like 'illustration-motion-background-%' order by created_at desc limit 1")
  let backgroundUrl = completedBackground?.response_data?.data?.task_result?.images?.[0]?.url
  if (!backgroundUrl) {
    const background = await post('/api/node-run', {
      model: imageModel,
      operation: 'history.animated-map-frame',
      prompt: '【二维人物插画背景底板】东汉末年的冀州山川与聚落鸟瞰历史地图，电影工笔插画，层次清楚，中央与两侧预留人物卡片位置。画面中绝对不出现人物、头像、剪影、文字、字幕或水印。',
      params: { aspectRatio: '16:9', resolution: '1k', n: 1, referenceImages: [], visualTreatment: 'animated', animationStyle: 'character_illustration', animationAesthetic: 'cinematic_gongbi', frameRole: 'first' },
      executionContext: { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-animated-map-first-frame', nodeName: '可灵动画镜头首帧', requestKey: `illustration-motion-background-${stamp}` },
    })
    backgroundUrl = background.body?.data?.task_result?.images?.[0]?.url
  }
  if (!backgroundUrl) throw Error('background image did not return a URL')

  const params = structuredClone(source.request_data.params)
  Object.assign(params, {
    referenceImage: backgroundUrl,
    endImage: undefined,
    visualTreatment: 'animated',
    animationStyle: 'character_illustration',
    animationAesthetic: 'cinematic_gongbi',
    characters: [character.character_name],
    initialCharacters: [character.character_name],
    presentCharacters: [character.character_name],
    referenceImages: [character.uri],
    referenceMode: 'three-view-all',
    referenceBindings: [{ characterName: character.character_name, role: 'identity' }],
    illustrationLayers: [{ characterName: character.character_name, x: .72, y: .53, scale: .27,
      enterStart: .25, enterDuration: .65, enterFromX: .8, enterFromY: .56, exitStart: Number(params.duration) - .65, exitDuration: .55 }],
    worldState: { settingId: 'drama-01', characters: [{ name: character.character_name, position: { status: 'unknown' }, heldProps: { status: 'unknown' }, pendingAction: { status: 'unknown' } }] },
  })
  params.pacing = { ...params.pacing, beats: params.pacing.beats.map(beat => ['action', 'reaction'].includes(beat.kind)
    ? { ...beat, actorIds: [character.character_name] } : beat) }
  const compiled = compileDurationSchedule({ pacing: params.pacing, duration: params.duration, characters: params.characters,
    presentCharacters: params.presentCharacters, audioType: params.audioType, audioText: params.audioText })
  params.pacing = compiled.pacing
  params.scheduleHash = compiled.scheduleHash
  params.videoTimeline = compiled.videoPrompt
  const timeline = String(params.videoTimeline)
  const prompt = `【本镜影视处理】animated / episode_opening
【动画叙事类型与美术风格】character_illustration / cinematic_gongbi
【场景与开场画面】张角人物插画图层置于东汉冀州历史地图背景；人物素材内部保持静止。
【视觉处理硬约束】人物插画内部的姿态、表情、嘴部和衣物不变；只允许整个人物图层淡入、平移、缩放、停留、淡出，不生成人物走路、转身、说话或肢体动作。
${timeline}
【本镜结束时的自然动作结果】张角人物插画图层淡出，历史地图背景保留。
运镜：固定机位
人声类型：旁白
【音轨文本；环境声模式为空且禁止人声】${params.audioText}`
  const video = await post('/api/node-run', {
    model: videoModel,
    prompt,
    params,
    executionContext: { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-video', nodeName: '参考生视频', requestKey: `first-loop-layered-illustration-${stamp}` },
  })
  const result = video.body?.data?.task_result?.videos?.[0]
  const illustration = video.body?.staticIllustration
  if (!result?.url || illustration?.route !== 'layered-illustration-v1' || illustration?.motion !== 'layered-2d') throw Error('layered illustration route was not exercised')
  console.log(JSON.stringify({ sourceId, backgroundUrl, character: character.character_name, videoUrl: result.url, duration: result.duration,
    route: illustration.route, motion: illustration.motion, characterImages: illustration.characterImages,
    illustrationLayers: illustration.illustrationLayers, metadata: illustration.metadata }, null, 2))
} finally {
  await pool.end()
}
