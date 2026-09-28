import { observeCharacterAsset } from '../server/character-appearances.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { HISTORY_QUALITY_VERSION, generateAcceptedHistoricalVideo, characterAppearanceContext, reviewHistoricalMedia } from '../src/history-media.ts'
// Real two-round historical-drama test. Each paid result is saved before QA so
// rerunning the script resumes that result instead of buying it again.
import fs from 'node:fs/promises'
import pg from 'pg'
import { request as httpRequest } from 'node:http'
import { generateHistoricalStoryboard } from '../src/storyboard-runtime.ts'
import { reviewHistoricalContent } from '../src/history-review.ts'
import { retrieveInternetSources } from '../server/web-sources.ts'
import { inspectGeneratedVideo } from '../server/video-inspection.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { SANGUO_FIRST_FRAME_BRANCH_CODE } from '../src/code-node-presets.ts'
const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5173'
const runtime = await (await fetch(`${base}/api/runtime-version`)).json()
if (runtime.historyQualityVersion !== HISTORY_QUALITY_VERSION) throw new Error('Regression server is stale; restart before generating')
const dir = process.env.QUALITY_OUTPUT_DIR ?? 'logs/quality-regression/real-sequence'
await fs.mkdir(dir, { recursive: true })
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const models = (await pool.query('select * from model_configs')).rows
const textModel = models.find(m => m.id === 'claude-opus-4-8')
const videoModel = models.find(m => m.id === 'keling3')
const names = ['周福门生甲', '房植宾客甲']
const assets = (await pool.query('select character_name as "characterName",uri as url,metadata from character_assets where character_name = ANY($1::text[]) order by updated_at desc', [names])).rows
await pool.end()
if (assets.length !== 2) throw new Error('Expected two existing identity assets')
async function cached(file, create) {
  try { return JSON.parse(await fs.readFile(`${dir}/${file}.json`, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const value = await create()
  await fs.writeFile(`${dir}/${file}.json`, JSON.stringify(value, null, 2))
  return value
}
async function call(model, prompt, params, operation, nodeId) {
  const result = await new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/api/node-run`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { text += chunk })
      response.on('end', () => { try { resolve(JSON.parse(text)) } catch (error) { reject(error) } })
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end(JSON.stringify({ model, prompt, params, operation, executionContext: { workflowId: 'history-quality-regression', nodeId, nodeName: '真实连续片段质量回归' } }))
  })
  if (result.status >= 400) throw new Error(JSON.stringify(result))
  return result.body
}
const observedAssets = []
for (const asset of assets) {
  const visualProfile = await observeCharacterAsset(asset, (prompt, reviewImages) => call(textModel, prompt, { reviewImages }, 'history.media-review', 'reference-appearance'))
  observedAssets.push({ ...asset, metadata: { ...asset.metadata, visualProfile } })
}
const characterDesigns = characterAppearanceContext(observedAssets)
const sources = await cached('sources', () => retrieveInternetSources({ query: '甘陵党议 后汉书 卷六十七《党锢列传》', urls: ['https://ctext.org/hou-han-shu/zh'], maxSources: 1, maxPassages: 3 }))
const sourceIndex = sources.citations.findIndex(c => /二家賓客/.test(c.content)) + 1
if (!sourceIndex) throw new Error('Missing actual party-dispute source')
const historicalBasis = `[史料${sourceIndex}] 房植与周福二家宾客互相讥揣，遂各树朋徒，渐成尤隙。`
const adaptationBoundary = '两家宾客在一处宅门前的具体对话、递帖与拒接动作均为拟制；不把台词当作历史人物的史载原话。'
const scenes = [
  { id: 'qa-scene-01', title: '门前问名', sequence: 1, purpose: '党争已形成南北部之后的一次拟制拜访：周福门生甲向房植宾客甲递出拜帖，房植宾客甲看见来者身份后不接，双方僵持。周福门生甲发问：一张拜帖，也要分南北？',
    requiredBeats: [{ id: 'beat-01', description: '递帖未被接下，双方产生隔阂', setting: '甘陵一处宅门前土路', mustShow: ['拜帖', '周福门生甲', '房植宾客甲'] }], continuityFromPrevious: false },
  { id: 'qa-scene-02', title: '收帖成隙', sequence: 2, purpose: '完全续接前镜递帖而对方不接的尾帧。房植宾客甲回应：既来论人，就别只论师门。周福门生甲把无人接的拜帖收回袖中，压住怒气，双方不再相视。',
    requiredBeats: [{ id: 'beat-02', description: '回应质问，收回拜帖，关系恶化', setting: '甘陵一处宅门前土路', mustShow: ['拜帖', '收回', '房植宾客甲'] }], continuityFromPrevious: true },
].map(s => ({ ...s, historicalBasis, adaptationBoundary, targetDuration: 15 }))
const app = await fs.readFile('src/App.tsx', 'utf8')
const template = app.match(/const SANGUO_STORYBOARD_PROMPT = `([\s\S]*?)`\n/)[1].replace(/\\\$/g, '$')
let previous
for (const [index, scene] of scenes.entries()) {
  const context = { scene, input: { episode_title: '甘陵党议', aspect_ratio: '16:9' }, historical_sources: sources, loop: { previous } }
  const prompt = renderWorkflowTemplate(template, context) + `\n【既有角色定妆必须沿用】${JSON.stringify(characterDesigns)}。不能把两人的服装互换。站位与道具由本场决定。`
  const shot = await cached(`shot-${index}`, () => generateHistoricalStoryboard({ prompt: prompt + '\n两位具名角色仅为周福门生甲和房植宾客甲，不添新角色。对白最多一句、20汉字以内。无进出场。',
    expected: { scene, previousShot: previous?.shot_script, requireContinuityContract: true, productionSpeechRate: 3, aspectRatio: '16:9' },
    generate: prompt => call(textModel, prompt, {}, 'history.storyboard', `script-${index}`),
    review: candidate => reviewHistoricalContent({ candidate, scene, characterDesigns, citations: sources.citations, previousShot: previous?.shot_script, generate: prompt => call(textModel, prompt, {}, 'history.review', `review-${index}`) }),
    onAttempt: event => console.log(JSON.stringify({ stage: 'script', index, ...event })),
  }))
  if (shot.__storyboardSegments) throw new Error('Expected a single 15-second test shot')
  const branch = await executeCodeNode({ code: SANGUO_FIRST_FRAME_BRANCH_CODE, context: { shot_script: shot, loop: { previous }, character_lookup: { names, existingAssets: assets } } })
  const params = { ...branch.referenceRequest, ...(previous ? { referenceImage: previous.last_frame.url } : {}), duration: 15, aspectRatio: '16:9', sound: 'on', mode: 'std', multiShot: false }
  console.log(JSON.stringify({ stage: 'video-submit-or-resume', index }))
  const accepted = await cached(`accepted-${index}`, () => generateAcceptedHistoricalVideo({
    shot,
    generate: (prompt, attempt) => cached(`video-${index}${attempt ? '-retake' : ''}`, () => call(videoModel, prompt, params, undefined, `video-${index}`)),
    inspect: (video, attempt) => cached(`inspection-${index}${attempt ? '-retake' : ''}`, () => inspectGeneratedVideo({ url: video.url ?? video.data?.task_result?.videos?.[0]?.url, duration: 15, aspectRatio: '16:9', audioText: shot.audioText, audioType: shot.audioType, videoPrompt: shot.videoPrompt, previousTail: previous?.last_frame.url })),
    review: (inspection, attempt) => cached(`grounded-visual-${index}${attempt ? '-retake' : ''}`, () => reviewHistoricalMedia({ shot, frames: inspection.frames, speechEvidence: inspection.speechValidation, generate: (prompt, frames) => call(textModel, prompt, { reviewImages: frames }, 'history.media-review', `visual-${index}`) })),
    onRejected: async report => {
      await fs.writeFile(`${dir}/rejection-${index}-${report.attempt}.json`, JSON.stringify(report, null, 2))
      console.log(JSON.stringify({ stage: 'media-rejected-retake', index, attempt: report.attempt, error: report.error.slice(0, 250) }))
    },
  }))
  previous = { shot_script: shot, video_shot: accepted, last_frame: { url: accepted.lastFrameUrl, available: true } }
  console.log(JSON.stringify({ stage: 'actual-media-passed', index, video: accepted.url, firstFrameDifference: accepted.firstFrameDifference }))
}
console.log(JSON.stringify({ ok: true, clips: 2, duration: 30, scope: 'actual-media-and-speech', visualReviewPassed: true }))
