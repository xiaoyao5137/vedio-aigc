import { collectVideoEvidence } from './video-inspection.ts'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'

type Value = Record<string, unknown>
type Request = {
  params?: Value
  model?: { id: string; provider: string; capability: string; settings: Record<string, string> }
  executionContext?: { requestKey?: string; workflowId?: string; nodeId?: string; nodeName?: string }
}
type Execute = (request: {
  model: NonNullable<Request['model']>; prompt: string; params: Value; operation?: string
  executionContext?: Request['executionContext']
}) => Promise<{ status: number; body: unknown }>
type Evidence = Awaited<ReturnType<typeof collectVideoEvidence>>

const record = (value: unknown): Value | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : undefined

export function validateStorySubtitleReference(value: unknown, evidence: Pick<Evidence, 'duration' | 'sha256' | 'evidenceUrl'>) {
  const result = record(value)
  if (!result || result.version !== 'story-subtitle-reference-v1'
    || result.sourceVideoSha256 !== evidence.sha256 || result.evidenceUrl !== evidence.evidenceUrl
    || !Array.isArray(result.subtitles) || result.subtitles.length > 4) {
    throw Error('STORY_SUBTITLE_INVALID: 字幕结果缺少当前视频证据绑定或字幕列表非法')
  }
  const entries = result.subtitles as unknown[]
  const subtitles = entries.map((entry, index) => {
    const row = record(entry)
    const start = row?.startSecond, end = row?.endSecond, caption = row?.text
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)
      || start < 0 || end <= start || end > evidence.duration + .05
      || typeof caption !== 'string' || !caption.trim() || [...caption].length > 32
      || (index > 0 && start < (record(entries[index - 1])?.endSecond as number))) {
      throw Error(`STORY_SUBTITLE_INVALID: 第 ${index + 1} 条字幕时间或正文非法`)
    }
    return { startSecond: start, endSecond: end, text: caption.trim() }
  })
  return { version: 'story-subtitle-reference-v1', status: subtitles.length ? 'suggested' : 'no_suitable_subtitle',
    sourceVideoSha256: evidence.sha256, evidenceUrl: evidence.evidenceUrl,
    subtitles, videoEmbedded: false, advisoryOnly: true }
}

/** Text inference over sampled source-video frames and the matching shot. No media is changed. */
export async function generateStorySubtitleReference(request: Request, execute: Execute,
  collect: typeof collectVideoEvidence = collectVideoEvidence) {
  const params = request.params ?? {}
  const shot = record(params.shot)
  const video = record(params.video)
  const url = typeof video?.url === 'string' ? video.url : typeof params.video === 'string' ? params.video : ''
  if (!shot || !url || !request.model || request.model.capability !== 'text')
    throw Error('STORY_SUBTITLE_INPUT_INVALID: 需要本镜剧本、已生成视频与文本推理模型')
  let evidence: Evidence
  try {
    evidence = await collect({ url, frameFractions: [0, .2, .4, .6, .8, .95] })
    if (evidence.decoded !== true || !evidence.frames.length || !/^[a-f0-9]{64}$/.test(evidence.sha256))
      throw Error('STORY_SUBTITLE_EVIDENCE_INVALID: 原视频未完成解码与抽帧')
  } catch (error) {
    return { version: 'story-subtitle-reference-v1', status: 'unavailable', subtitles: [], advisoryOnly: true,
      videoEmbedded: false, sourceVideoUrl: url,
      warning: `字幕参考采证未完成：${error instanceof Error ? error.message : String(error)}` }
  }
  const prompt = `【分镜字幕参考生成】附件是已生成分镜视频的按时间顺序抽帧；结合本镜剧本，只为用户提供可选字幕文案。字幕不能写入视频，也不能声称已经在画面中出现。\n`+
    `剧本是意图，画面是实际证据。只概括画面能支持的情绪、处境或剧情推进；若关键动作看不清，不要把剧本意图写成已发生事实。不要编造对白、旁白、人物心理、职业身份或声音内容，不要照抄镜头标题。字幕可少于四条，画面本身足够清楚时可返回空列表。每条不超过32字，避免遮蔽关键动作。\n`+
    `视频证据：${JSON.stringify({ sourceVideoSha256: evidence.sha256, evidenceUrl: evidence.evidenceUrl, duration: evidence.duration,
      frames: evidence.frameTimes.map((second, frameIndex) => ({ frameIndex, second })) })}\n`+
    `本镜剧本：${JSON.stringify({ title: shot.title, topic: shot.topic, content: shot.content,
      visualBeats: shot.visualBeats, duration: shot.duration })}\n`+
    `只输出JSON：{"version":"story-subtitle-reference-v1","sourceVideoSha256":"上述SHA256","evidenceUrl":"上述采证URL","subtitles":[{"startSecond":0,"endSecond":2,"text":"短字幕"}]}。字幕按时间排序且不重叠；无合适字幕输出空数组。`
  try {
    const response = await execute({ model: request.model, prompt,
      params: { reviewImages: evidence.frames, maxTokens: 2048, temperature: 0 },
      operation: 'story.subtitle-reference', executionContext: request.executionContext })
    if (response.status >= 400) throw Error(`HTTP ${response.status}`)
    return { ...validateStorySubtitleReference(parseStructuredJson(extractTextResponse(response.body)), evidence),
      sourceVideoUrl: evidence.url }
  } catch (error) {
    return { version: 'story-subtitle-reference-v1', status: 'unavailable', subtitles: [], advisoryOnly: true,
      videoEmbedded: false, sourceVideoUrl: evidence.url, sourceVideoSha256: evidence.sha256,
      evidenceUrl: evidence.evidenceUrl,
      warning: `字幕参考生成未完成：${error instanceof Error ? error.message : String(error)}` }
  }
}
