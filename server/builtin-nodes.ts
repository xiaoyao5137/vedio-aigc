import { readVoiceListeningReview, preservedCharacterVoiceIdentity, existingCharacterVoiceContinuityKey } from './character-voices.ts'
import { stableVoiceContinuityKey, voiceCharacterInputs, type VoiceCharacterInput } from '../src/voice-character-input.ts'
import { archiveVoiceCandidates, lookupArchivedVoices } from './voice-asset-archive.ts'
import type { VoiceCandidate } from './voice-design-inference.ts'
import { ensureOriginalVideoVoice } from './original-voice-video.ts'
import { resolveVoiceGateDecision, voiceReviewTarget } from '../src/voice-review.ts'
import { aggregateConcatReviews, assertConcatSpeechEvidence, assertConcatSubtitleEvidence } from '../src/concat-review.ts'
import { validateDramaOutline, validateExpandedDramaOutline } from '../src/history-drama.ts'
import { resolveRetryAttemptLimit } from '../src/retry-budget.ts'
import { validateDramaturgyReview } from '../src/drama-quality-presets.ts'
import { isCinematicShot, principleMediaEvidenceIssue, principleQualityCanProceed } from '../src/history-cinema.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { HISTORY_PACING_VERSION, narrativeTransitionIssue } from '../src/history-pacing.ts'
import { DURATION_PACING_VERSION } from '../src/duration-policy.ts'
import { verifyDurationSchedule } from '../src/duration-schedule.ts'
import { isManualReview } from '../src/quality-disposition.ts'
import { validateHistoricalMediaReview } from '../src/history-media.ts'
import { historicalCrossingIssue } from '../src/history-motion.ts'
import { isHistoricalImageWorkflow } from './history-image-policy.ts'
import { observeCharacterAsset } from './character-appearances.ts'
import { prepareCharacterIdentityAnchor } from './character-identity-anchor.ts'
import { compareCharacterFaceSheets, mirrorGeneratedCharacterImage } from './character-face-consistency.ts'
import { archiveWorkflowCharacterAsset, readCharacterEquipment } from './character-assets.ts'
import { normalizeCharacterBiography } from '../src/character-asset.ts'
import { biographyNeedsEvidenceCompletion, buildCharacterBiography, extractCharacterBiographicalEvidence, mergeCharacterBiographyEvidence } from '../src/character-biography.ts'
import { characterAssetEpisodeScopeMatches, characterVisualContextFrom, characterVisualContextDesignText, characterVisualContextSignature, characterVisualContextCompatibility, generatedCharacterEpisodeScope, reviewedHairMismatchCanArchive } from '../src/character-visual-context.ts'
import { characterArtisticIdentityDesignText, characterArtisticIdentityFrom } from '../src/character-artistic-identity.ts'
import { historicalContinuityIssue } from '../src/storyboard-runtime.ts'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { modelRequestFingerprint } from './model-request-key.ts'
import type { Pool } from 'pg'
import { runLocalModel } from './local-model.ts'
import { retrieveInternetSources } from './web-sources.ts'
import type { InternetSourceInput, InternetSourceResult } from './web-sources.ts'
import { validateReadableImageReference, validateThreeViewReference } from './image-references.ts'
import { concatenateVideos } from './video-concat.ts'
import { assertConcatCurrentBytes, requireConcatCurrentAcceptance } from './video-concat-acceptance.ts'
import { assertStoryVocalHumanAssets } from './story-vocal-manual-acceptance.ts'
import { reviewStoryShotVideo } from './story-media-review.ts'
import { generateStorySubtitleReference } from './story-subtitle-reference.ts'
import { createStoryScriptSource, readStoryScriptSource, renderStoryShotTimedActions, storyScriptSourcePrompt,
  StoryShotTimingError, validateStoryShotTimingOutput } from '../src/story-shot-timing.ts'
import { STORY_ROOMMATE_PERSONA_CONTRACT, storyRoommatePersonaIssues } from '../src/story-roommate-persona.ts'
import { generatedStoryTopicIssues } from '../src/story-topic-input.ts'
import { validateStoryVocalBeats } from '../src/story-shot-vocals.ts'
import { extractTextResponse, normalizeStructuredTextOutput } from '../src/workflow-core.ts'
import { Converter } from 'opencc-js/cn2t'

export type BuiltinNodeRequest = {
  operation: string
  prompt?: string
  params?: Record<string, unknown>
  model?: {
    id: string
    provider: string
    capability: string
    settings: Record<string, string>
  }
  executionContext?: { requestKey?: string; workflowId?: string; workflowName?: string; nodeId?: string; nodeName?: string }
}

type MediaExecutor = (request: {
  model: NonNullable<BuiltinNodeRequest['model']>
  prompt: string
  params: Record<string, unknown>
  operation?: string
  executionContext?: BuiltinNodeRequest['executionContext']
}) => Promise<{ status: number; body: unknown }>

type BuiltinDependencies = { prepareIdentityAnchor?: typeof prepareCharacterIdentityAnchor; compareFaceSheets?: typeof compareCharacterFaceSheets;
  reviewStoryVideo?: typeof reviewStoryShotVideo }

async function storyScriptReview(request: BuiltinNodeRequest, executeMediaModel?: MediaExecutor) {
  const params = request.params ?? {}
  const requireRoommatePersona = request.executionContext?.workflowId === 'wf-story'
    || params.personaContract === STORY_ROOMMATE_PERSONA_CONTRACT
  const personaIssues = requireRoommatePersona ? storyRoommatePersonaIssues(params.script) : []
  if (personaIssues.length) return {
    version: 'story-script-review-v1', passed: false, code: 'STORY_PERSONA_INVALID',
    issues: personaIssues, repairAttempt: { attempted: false, reason: '角色和剧情身份冲突，必须重新生成完整剧本' },
  }
  let source: ReturnType<typeof readStoryScriptSource> | undefined
  if (params.source !== undefined) {
    try { source = readStoryScriptSource(params.source) }
    catch (error) {
      if (!(error instanceof StoryShotTimingError)) throw error
      return { version: 'story-script-review-v1', passed: false, code: error.code,
        issues: error.issues, repairAttempt: { attempted: false, reason: '原剧本来源绑定无效' } }
    }
  }
  const sourcePersonaIssues = requireRoommatePersona && source ? storyRoommatePersonaIssues(source) : []
  if (sourcePersonaIssues.length) return {
    version: 'story-script-review-v1', passed: false, code: 'STORY_PERSONA_INVALID',
    issues: sourcePersonaIssues, repairAttempt: { attempted: false, reason: '原剧本角色身份已冲突，不能在时间重排中沿用' },
  }
  const options = {
    ...(params.expectedCount === undefined ? {} : { expectedCount: Number(params.expectedCount) }),
    ...(source ? { source } : {}),
    ...(request.executionContext?.workflowId === 'wf-story' ? { requireAnimalInteraction: true } : {}),
  }
  const accept = (candidate: unknown, repairAttempt: Record<string, unknown>) => {
    if (params.topics !== undefined) {
      const topicIssues = generatedStoryTopicIssues(params.topics, candidate)
      if (topicIssues.length) throw new StoryShotTimingError(topicIssues)
    }
    const script = validateStoryShotTimingOutput(candidate, options)
    const candidates = Array.isArray(script) ? script : (script as { shots: unknown[] }).shots
    const shots = candidates.map((candidate) => {
      const shot = candidate as Record<string, unknown>
      return { ...shot, timedActions: renderStoryShotTimedActions(shot) }
    })
    return { version: 'story-script-review-v1', passed: true, shots, items: shots, issues: [], repairAttempt }
  }
  let initialIssues: string[]
  try {
    return accept(params.script, { attempted: false })
  } catch (error) {
    if (!(error instanceof StoryShotTimingError)) throw error
    initialIssues = error.issues
  }
  const failed = (issues: string[], repairAttempt: Record<string, unknown>) => ({
    version: 'story-script-review-v1', passed: false, code: 'STORY_SHOT_TIMING_INVALID',
    issues, initialIssues, repairAttempt,
  })
  if (!params.script || initialIssues.some(issue => issue.includes('expectedCount 必须是正整数'))) {
    return failed(initialIssues, { attempted: false, reason: '初稿或预期分镜数量无效，无法安全修正' })
  }
  const repairableTimingIssue = (issue: string) => [
    /\.duration 必须是 3–15 秒整数/u,
    /\.visualBeats 必须逐项列出有可观察完成状态的动作或反应/u,
    /\.visualBeats\[\d+\] 必须有有效的 startSecond\/endSecond 时间窗/u,
    /\.visualBeats\[\d+\] 必须从 0 秒开始/u,
    /\.visualBeats\[\d+\] 必须从上一动作结束处连续开始/u,
    /\.visualBeats\[\d+\] 只分配 .*少于可读动作最小预算/u,
    /\.visualBeats\[\d+\] 结束于 .*超出分镜时长/u,
    /\.content 已使用数字秒点，须给每项动作标出起始秒点/u,
    /\.visualBeats\[\d+\] 的 content 秒点与 visualBeats\.startSecond\/endSecond 不一致/u,
    /最后一项完成后须保留至少 .*秒可读收尾/u,
  ].some(pattern => pattern.test(issue))
  if (initialIssues.some(issue => !repairableTimingIssue(issue))) {
    return failed(initialIssues, { attempted: false, reason: '剧本存在角色、声音或剧情结构问题，不能只改时间；须重新生成完整剧本' })
  }
  if (!request.model || request.model.capability !== 'text' || !executeMediaModel) {
    return failed(initialIssues, { attempted: false, reason: '未配置可执行的剧本修正模型' })
  }
  // If no archived retry source exists, bind the repair to the exact first
  // draft. Drop only its defective schedule; its title, action text and
  // first-frame premise remain the immutable source for this one retry.
  let repairSource = options.source
  if (!repairSource) {
    try {
      const draft = params.script && typeof params.script === 'object' && !Array.isArray(params.script)
        ? (params.script as Record<string, unknown>).shots : params.script
      const unscheduled = Array.isArray(draft) ? draft.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item
        const { visualBeats: _invalidSchedule, ...story } = item as Record<string, unknown>
        void _invalidSchedule
        return story
      }) : draft
      const digest = createHash('sha256').update(JSON.stringify(draft ?? null)).digest('hex').slice(0, 16)
      repairSource = createStoryScriptSource(unscheduled, {
        sourceExecutionId: `draft-${digest}`, sourceRunId: request.executionContext?.nodeId || 'story.script-review',
      })
    } catch (error) {
      if (!(error instanceof StoryShotTimingError)) throw error
      return failed(initialIssues, { attempted: false, reason: '初稿缺少可绑定的完整动作来源，不能自由改写' })
    }
  }
  const requestKey = `${request.executionContext?.requestKey || `story-script-${createHash('sha256').update(JSON.stringify(params.script ?? null)).digest('hex').slice(0, 16)}`}:repair-1`
  const modelCall = { operation: 'story.script-repair', modelId: request.model.id,
    provider: request.model.provider, requestKey }
  const prompt = `【短视频分镜剧本时长修正】以下初稿未通过独立剧本质检。只输出修正后的完整 JSON 分镜数组或 {"shots":[...]}。逐项处理审核问题，不删减、不合并、不改写原动作和标题；每项可见动作至少 2 秒，全部完成后至少保留 1 秒终态，单镜 duration 为 3–15 秒整数。15 秒放不下时须返回明确 error，不能截断动作。\n审核问题：${JSON.stringify(initialIssues)}\n完整初稿：${JSON.stringify(params.script)}${repairSource ? storyScriptSourcePrompt(repairSource) : ''}`
  let response: Awaited<ReturnType<MediaExecutor>>
  try {
    response = await executeMediaModel({ model: request.model, prompt,
      params: { temperature: 0, maxTokens: 8192 }, operation: 'story.script-repair',
      executionContext: { ...request.executionContext, requestKey } })
  } catch (error) {
    return failed(initialIssues, { attempted: true, modelCall,
      error: error instanceof Error ? error.message : String(error) })
  }
  if (response.status >= 400) {
    return failed(initialIssues, { attempted: true, modelCall, httpStatus: response.status,
      error: '剧本修正模型调用失败' })
  }
  try {
    const normalized = normalizeStructuredTextOutput(response.body, extractTextResponse(response.body), 'legacy-shots')
    const repairedPersonaIssues = requireRoommatePersona ? storyRoommatePersonaIssues(normalized) : []
    if (repairedPersonaIssues.length) return {
      version: 'story-script-review-v1', passed: false, code: 'STORY_PERSONA_INVALID',
      issues: repairedPersonaIssues, initialIssues,
      repairAttempt: { attempted: true, modelCall, httpStatus: response.status,
        sourceExecutionId: repairSource?.sourceExecutionId, sourceRunId: repairSource?.sourceRunId,
        outcome: 'rejected', reason: '时间修正稿违反角色身份' },
    }
    // An archived source remains authoritative. Otherwise the first draft's
    // complete actions become the repair source so the model cannot silently
    // turn two actions into one to satisfy the time budget.
    const repaired = validateStoryShotTimingOutput(normalized, {
      ...options, ...(repairSource ? { source: repairSource } : {}),
    })
    return accept(repaired, { attempted: true, modelCall, httpStatus: response.status,
      sourceExecutionId: repairSource?.sourceExecutionId, sourceRunId: repairSource?.sourceRunId,
      outcome: 'passed' })
  } catch (error) {
    const repairIssues = error instanceof StoryShotTimingError ? error.issues
      : [error instanceof Error ? error.message : String(error)]
    return failed(repairIssues, { attempted: true, modelCall, httpStatus: response.status,
      sourceExecutionId: repairSource?.sourceExecutionId, sourceRunId: repairSource?.sourceRunId,
      outcome: 'rejected', repairIssues })
  }
}

async function storyMediaReview(request: BuiltinNodeRequest, executeMediaModel?: MediaExecutor,
  review: typeof reviewStoryShotVideo = reviewStoryShotVideo) {
  const params = request.params ?? {}
  const video = params.video && typeof params.video === 'object' && !Array.isArray(params.video)
    ? params.video as Record<string, unknown> : {}
  const videoUrl = typeof params.video === 'string' ? params.video
    : typeof video.url === 'string' ? video.url : ''
  const failed = (issue: string) => {
    const storyMediaReview = { version: 'story-shot-media-review-v1', videoUrl, passed: false,
      retryable: false, reviewStatus: 'invalid', issues: [issue], videoEvidence: null }
    return { ...video, url: videoUrl,
      originalUrl: typeof video.originalUrl === 'string' ? video.originalUrl : videoUrl,
      videoEvidence: null, storyMediaReview, passed: false, issues: [issue] }
  }
  if (!videoUrl || !params.shot) return failed('STORY_MEDIA_REVIEW_INPUT_INVALID: 缺少分镜或原视频 URL')
  if (request.executionContext?.workflowId === 'wf-story') {
    const vocalIssues = validateStoryVocalBeats(params.shot, { required: true })
    if (vocalIssues.length) return failed(`ANIMAL_INTERACTION_INVALID: ${vocalIssues.join('；')}`)
  }
  try {
    const model = executeMediaModel && request.model
      ? request.model : { id: '', provider: 'Local', capability: 'text', settings: {} }
    const result = await review({ shot: params.shot, videoUrl, model,
      execute: executeMediaModel ?? (async () => ({ status: 503, body: null })),
      executionContext: request.executionContext,
      ...(typeof params.aspectRatio === 'string' ? { aspectRatio: params.aspectRatio } : {}),
      ...(typeof params.requireAudio === 'boolean' ? { requireAudio: params.requireAudio } : {}),
    })
    const evidence = result.videoEvidence
    const issues = [...result.issues]
    if (request.executionContext?.workflowId === 'wf-story' && result.passed) {
      issues.push('STORY_VOCAL_LISTENING_REQUIRED: 自动画面复核不能代替猫狗叫声与口型的逐声人工确认')
    }
    if (result.passed && (result.reviewStatus !== 'passed' || !evidence?.sha256 || !evidence.evidenceUrl
      || !/^\/generated\/[\w.-]+\.mp4$/.test(evidence.url))) {
      issues.push('STORY_MEDIA_REVIEW_EVIDENCE_INVALID: 通过结论未绑定本地审定视频、散列与逐帧证据')
    }
    const storyMediaReview = issues.length === result.issues.length ? result
      : { ...result, passed: false, retryable: false, reviewStatus: 'invalid' as const, issues }
    return { ...video, url: evidence?.url || videoUrl,
      originalUrl: typeof video.originalUrl === 'string' ? video.originalUrl : videoUrl,
      videoEvidence: evidence ?? null, storyMediaReview,
      passed: storyMediaReview.passed, issues: storyMediaReview.issues }
  } catch (error) {
    return failed(`STORY_MEDIA_REVIEW_FAILED: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object' && 'items' in value) return toArray((value as Record<string, unknown>).items)
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed
    } catch {
      return value.split(/[、，,\n]/).map((item) => item.trim()).filter(Boolean)
    }
  }
  return value === undefined || value === null || value === '' ? [] : [value]
}

function normalizedSourceRequest(input: InternetSourceInput) {
  return {
    query: String(input.query ?? '').trim(),
    sourceDetail: String(input.sourceDetail ?? '').trim(),
    sourceNames: toArray(input.sourceNames).map(String),
    urls: toArray(input.urls).map(String),
    maxSources: Number(input.maxSources ?? 3),
    maxPassages: Number(input.maxPassages ?? 6),
  }
}

function sameSourceRequest(left: InternetSourceInput, right: InternetSourceInput) {
  return JSON.stringify(normalizedSourceRequest(left)) === JSON.stringify(normalizedSourceRequest(right))
}

function legacySourceResultMatches(input: InternetSourceInput, output: InternetSourceResult) {
  const requested = normalizedSourceRequest(input)
  return String(output.query ?? '').trim() === requested.query
    && String(output.sourceDetail ?? '').trim() === requested.sourceDetail
    && requested.urls.every(url => output.attemptedUrls.includes(url))
}

/**
 * Keep transient source-site throttling from invalidating an otherwise reproducible
 * workflow run. The fallback is deliberately narrow: same workflow, same resolved
 * retrieval request, and a previously successful citation payload. Original URLs,
 * fetch timestamps and text remain unchanged and the recovery record is explicit.
 */
export async function retrieveInternetSourcesWithExecutionCache(
  pool: Pool,
  input: InternetSourceInput,
  executionContext?: BuiltinNodeRequest['executionContext'],
  retriever: (value: InternetSourceInput) => Promise<InternetSourceResult> = retrieveInternetSources,
): Promise<InternetSourceResult> {
  try {
    return await retriever(input)
  } catch (error) {
    const workflowId = String(executionContext?.workflowId ?? '').trim()
    if (!workflowId) throw error
    const cached = await pool.query(`select records.id as execution_record_id, run.value as node_run
      from (select id, created_at, result from execution_records where workflow_id=$1 order by created_at desc limit 50) records
      cross join lateral jsonb_array_elements(coalesce(records.result->'nodeRuns','[]'::jsonb)) run(value)
      where run.value->>'status'='success' and run.value->'output'->>'sourceMode'='internet'
      order by records.created_at desc`, [workflowId])
    for (const row of cached.rows as Array<{ execution_record_id: string; node_run: Record<string, unknown> }>) {
      const run = row.node_run
      const output = run?.output as InternetSourceResult | undefined
      const storedInput = run?.inputs as InternetSourceInput | undefined
      const exactInput = output?.request ?? (storedInput && !('slot' in storedInput) ? storedInput : undefined)
      if (!output || !(exactInput ? sameSourceRequest(input, exactInput) : legacySourceResultMatches(input, output))
        || !Array.isArray(output.citations) || output.citations.length === 0) continue
      return {
        ...output,
        cacheRecovery: {
          executionRecordId: row.execution_record_id,
          recoveredAt: new Date().toISOString(),
          onlineError: error instanceof Error ? error.message : String(error),
        },
      }
    }
    throw error
  }
}

function firstUrl(value: unknown): string {
  if (typeof value === 'string' && (/^https?:\/\//.test(value) || value.startsWith('data:') || value.startsWith('/'))) return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstUrl(item)
      if (found) return found
    }
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const found = firstUrl(item)
      if (found) return found
    }
  }
  return ''
}

function mediaUrls(value: unknown): string[] {
  const urls: string[] = []
  const visit = (current: unknown) => {
    if (typeof current === 'string') {
      if (/^https?:\/\//.test(current) || current.startsWith('data:') || current.startsWith('/')) urls.push(current)
      return
    }
    if (Array.isArray(current)) return current.forEach(visit)
    if (current && typeof current === 'object') Object.values(current as Record<string, unknown>).forEach(visit)
  }
  visit(value)
  return [...new Set(urls)]
}

type CharacterIdentity = {
  name: string
  designPrompt: string
  continuityKey?: string
  description?: string
  biography?: string
  historicalPortrait?: Record<string, unknown>
  visualContext?: ReturnType<typeof characterVisualContextFrom>
  equipmentNames?: string[]
  sceneTags?: string[]
  equipmentIds?: string[]
  voiceProfile?: VoiceCharacterInput['voiceProfile']
  voiceContinuityKey?: string
}

function characterIdentity(value: unknown): CharacterIdentity {
  if (typeof value === 'string') return { name: value, designPrompt: '' }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return {
      name: String(record.name ?? record.characterName ?? '').trim(),
      designPrompt: String(record.designPrompt ?? record.prompt ?? ''),
      continuityKey: String(record.continuityKey ?? ''),
      description: String(record.description ?? ''),
      biography: normalizeCharacterBiography(record.biography ?? (record.metadata as Record<string, unknown> | undefined)?.biography),
      historicalPortrait: record.historicalPortrait && typeof record.historicalPortrait === 'object'
        ? record.historicalPortrait as Record<string, unknown>
        : undefined,
      visualContext: characterVisualContextFrom(record),
      ...(Array.isArray(record.equipmentNames) ? { equipmentNames: record.equipmentNames.map(String) } : {}),
      ...(Array.isArray(record.sceneTags) ? { sceneTags: record.sceneTags.map(String) } : {}),
      ...(Array.isArray(record.equipmentIds) ? { equipmentIds: record.equipmentIds.map(String) } : {}),
      ...(record.voiceProfile !== undefined ? { voiceProfile: record.voiceProfile as VoiceCharacterInput['voiceProfile'] } : {}),
      voiceContinuityKey: typeof record.voiceContinuityKey === 'string' ? record.voiceContinuityKey : typeof (record.metadata as Record<string, unknown> | undefined)?.voiceContinuityKey === 'string' ? String((record.metadata as Record<string, unknown>).voiceContinuityKey) : undefined,
    }
  }
  return { name: '', designPrompt: '' }
}

function isGenericCharacterName(name: string) {
  const identity = name.replace(/[甲乙丙丁戊己庚辛壬癸一二三四五六七八九十0-9]+$/, '')
  return /(?:宾客|门生|太学生|书生|朝臣|臣子|长者|观者|行人|游士|童子|乡人|书吏|谒者|无名|某人|众人|众将|百姓|饥民|村民|流民|难民|路人|士兵|兵士|军士|官军|汉军|黄巾军|亲兵|护卫|侍卫|仆从|随从|侍从|仆人|家丁|门客|弟子|信徒|使者|信使|官员|小吏|吏员|郡守|县令|族长|士人|商贩|医者|求评者|老者|老妇|妇人|孩童|少年|少女|农夫|农妇)$/.test(identity)
}

export function shouldRetrieveHistoricalPortrait(name: string) {
  const normalized = name.trim()
  return Boolean(normalized)
    && normalized.length <= 12
    && !isGenericCharacterName(normalized)
    && !/^(?:一名|两名|几名|数名|多名|若干|一群|众|某)/.test(normalized)
}

const appearanceEvidence = /(?:身長|身长|長[七八九一二三四五六十百尺]|长[七八九一二三四五六十百尺]|容貌|姿貌|狀貌|状貌|形貌|體貌|体貌|美姿|雄姿|有姿儀|有姿仪|儀表|仪表|鬚髯|须髯|美髯|髯長|髯长|耳垂|耳大|目能自顧其耳|目能自顾其耳|垂手下膝|異相|异相|骨相|肥白|魁梧|雄壯|雄壮|瞋目|短小|瘦弱)/

const traditionalHistoricalName = Converter({ from: 'cn', to: 't' })

function portraitEvidenceFromSources(name: string, results: InternetSourceResult[]) {
  const citations = extractCharacterBiographicalEvidence(name, results)
  const evidence: Array<{ title: string; url: string; quote: string }> = []
  for (const citation of citations) {
    if (!appearanceEvidence.test(citation.quote)) continue
    const quote = citation.quote
    if (!evidence.some((item) => item.quote === quote)) evidence.push({ title: citation.title, url: citation.url, quote })
  }
  return evidence.slice(0, 4)
}

type PortraitRetriever = (input: Parameters<typeof retrieveInternetSources>[0]) => Promise<InternetSourceResult>

export async function enrichCharactersWithHistoricalPortraits(
  values: unknown[],
  retriever: PortraitRetriever = retrieveInternetSources,
  limits: { maxSources?: number; maxPassages?: number } = {},
  context: { knownSources?: InternetSourceResult[]; sourceDetail?: string } = {},
) {
  const characters = values.map(characterIdentity).filter((item) => item.name)
  const enriched = await Promise.all(characters.map(async (character) => {
    if (!shouldRetrieveHistoricalPortrait(character.name)) {
      return { ...character, historicalPortrait: { status: 'skipped', reason: '群演或职能型小人物，不进行互联网体貌检索', citations: [] } }
    }
    const results: InternetSourceResult[] = [...context.knownSources ?? []]
    const failures: string[] = []
    const knownPortrait = portraitEvidenceFromSources(character.name, results)
    // Life evidence alone does not establish whether a separate appearance
    // passage exists. Continue the lookup until appearance evidence is found.
    for (const source of knownPortrait.length ? [] : ['三國志', '後漢書']) {
      try {
        results.push(await retriever({
          query: traditionalHistoricalName(character.name),
          sourceDetail: context.sourceDetail ?? '',
          sourceNames: [source],
          titlePrefixes: [`${source}/`],
          maxSources: limits.maxSources ?? 2,
          maxPassages: limits.maxPassages ?? 4,
        }))
      } catch (error) {
        failures.push(`${source}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    for (const result of results) for (const failure of result.failures ?? []) {
      failures.push(`${failure.url}：${failure.error}`)
    }
    const citations = portraitEvidenceFromSources(character.name, results)
    const attributableLife = extractCharacterBiographicalEvidence(character.name, results)
    const historicalPortrait = citations.length
      ? { status: 'found', description: citations.map((item) => item.quote).join('；'), citations, failures }
      : failures.length
        ? { status: 'retrieval_failed', description: '', citations: [], failures, reason: '史料检索失败，不能据此断言正史缺载' }
        : { status: 'not_found', description: '', citations: [], failures, reason: '本次已检索来源中未见可归属于该人物的正史体貌记载' }
    const historicalInstruction = citations.length
      ? `正史体貌依据（仅采用下列有来源记载）：${historicalPortrait.description}`
      : historicalPortrait.status === 'retrieval_failed'
        ? '史料检索失败，体貌状态未知；按其时代、身份与剧情年龄作克制的写实设计，不套用《三国演义》脸谱，不把艺术设定表述为史实'
        : '本次已检索正史未见可靠体貌记载；按其时代、身份与剧情年龄作克制的写实设计，不套用《三国演义》脸谱，不把艺术设定表述为史实'
    const sourcedBiography = historicalPortrait.status === 'retrieval_failed' && !attributableLife.length ? undefined
      : buildCharacterBiography({ ...character, historicalPortrait }, results)
    const biography = character.biography === undefined ? sourcedBiography
      : sourcedBiography && biographyNeedsEvidenceCompletion(character.biography)
        ? mergeCharacterBiographyEvidence(character.biography, sourcedBiography) ?? character.biography
        : character.biography
    return {
      ...character,
      historicalPortrait,
      biography,
      designPrompt: [character.designPrompt, historicalInstruction].filter(Boolean).join('。'),
    }
  }))
  return {
    characters: enriched,
    byCharacter: Object.fromEntries(enriched.map((item) => [item.name, item.historicalPortrait])),
    requestedCount: characters.length,
    retrievedCount: enriched.filter((item) => item.historicalPortrait.status !== 'skipped').length,
    foundCount: enriched.filter((item) => item.historicalPortrait.status === 'found').length,
    skippedCount: enriched.filter((item) => item.historicalPortrait.status === 'skipped').length,
  }
}

function workflowCharacterBiography(character: ReturnType<typeof characterIdentity>) {
  if (character.biography !== undefined) return character.biography
  // Older checkpoints already hold their sourced appearance and design details.
  // Retain those without rerunning the retrieval node or inventing a life story.
  if (character.historicalPortrait && character.historicalPortrait.status !== 'skipped'
    || character.description || character.visualContext) return buildCharacterBiography(character, [])
  return undefined
}

function requestedContinuityKey(character: ReturnType<typeof characterIdentity>, params: Record<string, unknown>) {
  const visualContext = character.visualContext
  if (visualContext) {
    const signature = createHash('sha256').update(characterVisualContextSignature(visualContext)).digest('hex').slice(0, 24)
    if (character.continuityKey?.includes(`-visual-${signature}-v`)) return character.continuityKey
    const base = (character.continuityKey || `${character.name}-eastern-han-v1`).replace(/-visual-[a-f0-9]{24}-v\d+$/, '')
    return `${base}-visual-${signature}-v1`
  }
  if (character.continuityKey) return character.continuityKey
  if (!isGenericCharacterName(character.name)) return `${character.name}-eastern-han-v1`
  const episode = String(params.episodeNumber ?? params.episode_number ?? 'unknown').padStart(3, '0')
  return `ep${episode}-${character.name}-v3`
}

function requiresCleanShavenFace(character: ReturnType<typeof characterIdentity>) {
  return /无(?:胡)?须|不留(?:胡)?须|剃净胡须/.test(character.description || character.designPrompt || '')
}

export function threeViewReferencePoseIssue(asset: Record<string, unknown>) {
  const metadata = asset.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata)
    ? asset.metadata as Record<string, unknown> : {}
  const quality = metadata.quality && typeof metadata.quality === 'object' && !Array.isArray(metadata.quality)
    ? metadata.quality as Record<string, unknown> : {}
  const rawReport = quality.rawReport && typeof quality.rawReport === 'object' && !Array.isArray(quality.rawReport)
    ? quality.rawReport as Record<string, unknown> : {}
  // Prompts contain prohibitions such as `禁止手遮挡嘴唇`. They are
  // instructions, not observations, and must never quarantine their own asset.
  const evidence = [metadata.visualProfile,
    ...(Array.isArray(quality.warnings) ? quality.warnings : []),
    ...(Array.isArray(quality.principleIssues) ? quality.principleIssues : []),
    ...(Array.isArray(rawReport.warnings) ? rawReport.warnings : []),
    ...(Array.isArray(rawReport.issues) ? rawReport.issues : []),
  ].map(value => typeof value === 'string' ? value : JSON.stringify(value ?? '')).join('；')
    .replace(/(?:面部|脸部|口鼻|嘴唇?|下巴)(?:完全)?无遮挡/g, '')
    .replace(/(?:未见|没有|并无|无)(?:明显)?[^；。]{0,24}(?:遮脸|遮挡|靠脸|剧情动作|念咒|手势)/g, '')
  // A pose warning must not silently become a second, stricter generation
  // gate. Raised hands, proximity to the face and closed lips are ordinary
  // variation; only observed occlusion or explicitly unusable action blocks.
  const unsafe = /(?:(?:手|衣袖|道具)[^；。]{0,12}(?:遮挡|挡住|遮住)[^；。]{0,8}(?:嘴|唇|口鼻|鼻|眼|脸|面部)|(?:嘴|唇|口鼻|鼻|眼|脸|面部)[^；。]{0,12}(?:被[^；。]{0,6})?(?:遮挡|挡住|遮住)|(?:念咒|诵咒|施术|剧情动作)[^；。]{0,20}(?:无法辨认|无法作为|不能作为|严重妨碍))/
  return unsafe.test(evidence) ? 'CHARACTER_REFERENCE_POSE_INVALID: 三视图实际遮挡面部或剧情动作已明确妨碍身份参考，不能作为可复用人物身份资产' : ''
}

function nextReferenceContinuityKey(key: string, candidates: Record<string, unknown>[]) {
  const match = key.match(/^(.*-v)(\d+)$/)
  if (!match) return key + '-v2'
  const versions = candidates.flatMap(candidate => {
    const metadata = candidate.metadata && typeof candidate.metadata === 'object' && !Array.isArray(candidate.metadata)
      ? candidate.metadata as Record<string, unknown> : {}
    const candidateKey = String(metadata.continuityKey ?? '')
    if (!candidateKey.startsWith(match[1]) || !/^\d+$/.test(candidateKey.slice(match[1].length))) return []
    return [Number(candidateKey.slice(match[1].length))]
  })
  return match[1] + String(Math.max(Number(match[2]), ...versions, 1) + 1)
}

export function buildThreeViewNegativePrompt(character: ReturnType<typeof characterIdentity>) {
  return ['正方形画布，竖版画布，上下结构，上下两排，2x2宫格，九宫格，分镜板，重复人物，重复视角，坐姿，半身，裁切，桌案，室内场景，文字，标签，水印，手靠近脸部，手遮挡嘴唇，手抬至胸口以上，念咒手势，剧情动作',
    requiresCleanShavenFace(character) ? '胡须，短须，山羊胡，胡茬，八字胡，络腮胡，beard，moustache，stubble' : '',
    character.visualContext?.appearanceConstraints?.hair === 'dark' ? '白发，花白头发，white hair，gray hair' : '',
    character.visualContext?.appearanceConstraints?.facialHair === 'dark' ? '白须，花白胡须，white beard，gray beard' : '',
  ].filter(Boolean).join('，')
}

export function buildThreeViewGenerationPrompt(character: ReturnType<typeof characterIdentity>, retryReason = '', hasRepairImage = false) {
  if (hasRepairImage && requiresCleanShavenFace(character)) {
    return '编辑<<<image_1>>>：删除左侧正面人物和中间侧面人物嘴唇上方、嘴角及下巴上的全部胡须，使这些部位呈现清晰、自然、光滑的肤色。保留眉毛和面部五官。只修改上述面部区域，服装、头巾、身体、右侧背面人物、背景及三视图排版保持原样。'
  }
  const identityDescription = character.designPrompt
    || `东汉末年人物定妆三视图，${character.name}，真人历史电影质感，服化道准确。`
  return [
    hasRepairImage ? '修改参考图<<<image_1>>>中同一角色的三视图，保留正面、侧面、背面单行三列与完整全身，以附件为基础落实下述目标外观。' : '',
    identityDescription,
    characterVisualContextDesignText(character.visualContext),
    '【三视图输出硬性版式】只输出一张 16:9 横向人物设定图。画布内必须恰好出现同一个人物三次，并且只能排成从左到右的单行三列：左列正面，中列标准90度侧面，右列背面。三个人物必须完整全身、头脚不裁切、等高等比例、互不遮挡，脸、年龄、体型、发式、冠帽和整套服装完全一致。',
    '【中性姿势硬约束】三个视角都必须直立、双臂自然下垂、双手低于腰部并远离脸和胸口；嘴、鼻、眼、下巴完全无遮挡。禁止念咒、指唇、掩嘴、托腮、持物、结印、挥手或任何剧情动作。',
    '身份描述中如果含有坐姿、桌案、房间、灯具、窗户或镜头景别，只提取人物身份与稳定外观，禁止复现这些场景、动作和道具；统一改为纯色摄影棚背景与中性站姿。',
    '禁止上下结构、上下两排、2×2宫格、九宫格、分镜板、重复视角、第二个正面、半身像、坐姿、环境场景、文字、标签、边框和水印。',
    retryReason ? `【上一次结果已被程序拒绝，必须纠正】${retryReason.startsWith('CHARACTER_APPEARANCE_REJECTED:')
      ? `重新落实目标外观：${character.description || character.designPrompt}。旧图不作为外观依据。` : retryReason}` : '',
    requiresCleanShavenFace(character) ? '【面部外观必须实现】面颊、上唇和下巴均为自然肤色的光洁皮肤，三个视角一致；眉毛、头发与头巾遵循原设计。Clean-shaven face, smooth bare cheeks, upper lip and chin.' : '',
  ].filter(Boolean).join('\n')
}

function storedCharacterAsset(row: Record<string, unknown>) {
  return {
    id: row.id,
    workflowId: row.workflow_id ?? null,
    characterName: row.character_name,
    assetType: row.asset_type,
    url: row.uri,
    prompt: row.prompt,
    description: row.prompt,
    version: row.version,
    metadata: row.metadata,
    cached: true,
  }
}

async function manualCharacterAsset(asset: Record<string, unknown>, checkLayout: boolean) {
  const url = String(asset.url ?? asset.uri ?? '')
  if (!url) throw new Error('IMAGE_INPUT_MISSING: 人物图片缺少可用 URL')
  const decoded = await validateReadableImageReference(url)
  const warnings: string[] = []
  const pose = threeViewReferencePoseIssue(asset)
  if (pose) warnings.push(pose)
  let layout: unknown
  if (checkLayout) {
    try { layout = await validateThreeViewReference(url) }
    catch (error) { warnings.push(error instanceof Error ? error.message : String(error)) }
  }
  const metadata = asset.metadata && typeof asset.metadata === 'object' ? asset.metadata as Record<string, unknown> : {}
  return { ...asset, metadata: { ...metadata, quality: { ...decoded, layout, status: 'needs_attention', canProceed: true,
    qualityDisposition: 'manual-review-v1', manualReviewRequired: true, warnings,
    scope: 'decoded-image-user-review', appearanceVerified: false } } }
}

function selectedCharacterAssetIds(value: unknown): Map<string, string> {
  if (value === undefined || value === null || value === '') return new Map()
  let source = value
  if (typeof source === 'string') {
    try { source = JSON.parse(source) } catch { throw Error('CHARACTER_VISUAL_SELECTION_INVALID: characterAssetSelections 必须是人物名到资产ID的JSON对象') }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw Error('CHARACTER_VISUAL_SELECTION_INVALID: characterAssetSelections 必须是人物名到资产ID的JSON对象')
  const result = new Map<string, string>(), ids = new Set<string>()
  for (const [name, id] of Object.entries(source)) {
    if (!name.trim() || name !== name.trim() || typeof id !== 'string' || !id.trim() || id !== id.trim() || ids.has(id)) throw Error('CHARACTER_VISUAL_SELECTION_INVALID: 所选人物和资产ID必须是唯一的非空文字')
    result.set(name, id); ids.add(id)
  }
  return result
}

type EquipmentBinding = {
  id: string
  characterName: string
  name: string
  kind: string
  description: string
  imageUrl: string
  matchedName: string
  matchReason: 'exact-name' | 'alias'
  requirementSource: 'shot_script.characterEquipment'
}

function requestedEquipmentWords(value: unknown, name: string, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 20 || value.some(item => typeof item !== 'string' || !item.trim() || item !== item.trim() || item.length > 120)
    || new Set(value).size !== value.length) {
    throw Error(`CHARACTER_EQUIPMENT_REQUIREMENT_INVALID: ${name}.${field} 须为不重复的非空名称数组`)
  }
  return value
}

async function requestedCharacterEquipment(pool: Pool, workflowId: string, characters: CharacterIdentity[], allowShared = false) {
  const requests = characters.map(character => ({ character,
    names: requestedEquipmentWords(character.equipmentNames, character.name, 'equipmentNames'),
    sceneTags: requestedEquipmentWords(character.sceneTags, character.name, 'sceneTags') }))
  const requiring = requests.filter(row => row.names.length)
  const byCharacter = new Map<string, EquipmentBinding[]>()
  if (!requiring.length) return byCharacter
  if (!workflowId) throw Error('CHARACTER_EQUIPMENT_WORKFLOW_MISSING: 装备召回须指定人物所属工作流')
  const inventory = await readCharacterEquipment(pool, workflowId, requiring.map(row => row.character.name))
  const equivalent = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()
  for (const { character, names, sceneTags } of requiring) {
    const owned = inventory.filter(item => item.characterName === character.name
      && (item.workflowId === workflowId || allowShared && item.workflowId === null))
    const bindings: EquipmentBinding[] = []
    for (const name of names) {
      const matches = owned.filter(item => equivalent(item.name, name) || item.aliases.some(alias => equivalent(alias, name)))
      if (matches.length === 0) throw Error(`CHARACTER_EQUIPMENT_MISSING: ${character.name} 缺少已归档装备“${name}”；请先在该人物资产下建档，不能换用其他装备`)
      const age = character.visualContext?.age.stage
      const look = character.visualContext?.look.key
      const applicable = matches.filter(item => {
        const rules = item.applicability ?? {}
        return !(rules.ageStages?.length && (!age || !rules.ageStages.includes(age))
          || rules.lookKeys?.length && (!look || !rules.lookKeys.includes(look))
          || rules.sceneTags?.length && !sceneTags.some(tag => rules.sceneTags?.includes(tag)))
      })
      if (!applicable.length) {
        throw Error(`CHARACTER_EQUIPMENT_CONTEXT_MISMATCH: ${character.name} 的装备“${name}”不适用于当前年龄、造型或场景标签`)
      }
      if (applicable.length > 1) throw Error(`CHARACTER_EQUIPMENT_AMBIGUOUS: ${character.name} 的“${name}”在当前年龄和场景仍匹配多个装备资产；请明确唯一版本后重试`)
      const equipment = applicable[0]
      bindings.push({ id: equipment.id, characterName: character.name, name: equipment.name,
        kind: equipment.kind, description: equipment.description, imageUrl: equipment.imageUrl,
        matchedName: name, matchReason: equivalent(equipment.name, name) ? 'exact-name' : 'alias',
        requirementSource: 'shot_script.characterEquipment' })
    }
    byCharacter.set(character.name, bindings)
  }
  return byCharacter
}

function supersededCharacterPortrait(asset: Record<string, unknown>) {
  const metadata = asset.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata)
    ? asset.metadata as Record<string, unknown> : {}
  const lifecycle = metadata.portraitLifecycle && typeof metadata.portraitLifecycle === 'object' && !Array.isArray(metadata.portraitLifecycle)
    ? metadata.portraitLifecycle as Record<string, unknown> : {}
  return lifecycle.status === 'superseded'
}

function pendingCharacterIdentityReview(asset: Record<string, unknown>) {
  const metadata = asset.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata)
    ? asset.metadata as Record<string, unknown> : {}
  const review = metadata.identityConsistency && typeof metadata.identityConsistency === 'object' && !Array.isArray(metadata.identityConsistency)
    ? metadata.identityConsistency as Record<string, unknown> : {}
  return review.status === 'needs_manual_review'
}

function pendingCharacterPortraitReview(asset: Record<string, unknown>) {
  const metadata = asset.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata)
    ? asset.metadata as Record<string, unknown> : {}
  const lifecycle = metadata.portraitLifecycle && typeof metadata.portraitLifecycle === 'object' && !Array.isArray(metadata.portraitLifecycle)
    ? metadata.portraitLifecycle as Record<string, unknown> : {}
  const decision = metadata.portraitReviewDecision && typeof metadata.portraitReviewDecision === 'object' && !Array.isArray(metadata.portraitReviewDecision)
    ? metadata.portraitReviewDecision as Record<string, unknown> : {}
  if ((decision.version === 'manual-portrait-review-v1' && decision.decision === 'reject')
    || (decision.version === 'manual-portrait-abandon-v1' && decision.decision === 'abandon')) return false
  if (decision.version === 'manual-portrait-review-v1' && decision.decision === 'accept' && lifecycle.status === 'active') return false
  return pendingCharacterIdentityReview(asset) || lifecycle.status === 'pending-review' || lifecycle.status === 'pending-unrecoverable'
}

function rejectedCharacterPortraitReview(asset: Record<string, unknown>) {
  const metadata = asset.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata)
    ? asset.metadata as Record<string, unknown> : {}
  const decision = metadata.portraitReviewDecision && typeof metadata.portraitReviewDecision === 'object' && !Array.isArray(metadata.portraitReviewDecision)
    ? metadata.portraitReviewDecision as Record<string, unknown> : {}
  return (decision.version === 'manual-portrait-review-v1' && decision.decision === 'reject')
    || (decision.version === 'manual-portrait-abandon-v1' && decision.decision === 'abandon')
}

async function lookupCharacterAssets(pool: Pool, request: BuiltinNodeRequest) {
  const params = request.params ?? {}
  const selections = selectedCharacterAssetIds(params.characterAssetSelections)
  const identities = toArray(params.characters ?? params.names).map(characterIdentity).filter((item) => item.name)
  const characters = [...new Map(identities.map((item) => [item.name, {
    ...item,
    continuityKey: requestedContinuityKey(item, params),
  }])).values()]
  if (!characters.length && params.includeVoices !== true) {
    return { characters: [], names: [], items: [], urls: [], byCharacter: {}, descriptions: {}, missingCharacters: [], foundCount: 0, missingCount: 0 }
  }
  const workflowId = String(params.workflowId ?? '').trim()
  const equipmentByName = await requestedCharacterEquipment(pool, workflowId, characters, params.allowSharedEquipment === true)
  const result = await pool.query(
    `select id, workflow_id, character_name, asset_type, uri, prompt, version, metadata, created_at, updated_at
       from character_assets
      where character_name = any($1::text[]) and asset_type = 'three-view'
        and ($2 = '' or workflow_id = $2 or workflow_id is null)
      order by character_name, (workflow_id = $2) desc, updated_at desc`,
    [characters.map((item) => item.name), workflowId],
  )
  const candidatesByName = new Map<string, Record<string, unknown>[]>()
  result.rows.forEach((row) => {
    const name = String(row.character_name)
    candidatesByName.set(name, [...(candidatesByName.get(name) ?? []), storedCharacterAsset(row)])
  })
  const byName = new Map<string, Record<string, unknown>>()
  const rejectedAssets: Array<{ id: string; characterName: string; reason: string }> = []
  for (const character of characters) {
    const candidates = candidatesByName.get(character.name) ?? []
    const selectedId = selections.get(character.name)
    const selected = selectedId ? candidates.filter(candidate => candidate.id === selectedId && candidate.workflowId === workflowId
      && candidate.characterName === character.name && candidate.assetType === 'three-view') : []
    if (selectedId && (!workflowId || selected.length !== 1)) throw Error(`CHARACTER_VISUAL_SELECTION_MISMATCH: ${character.name} 所选三视图 ${selectedId} 不存在或不属于当前工作流与人物；不能替换或重新生成`)
    const exact = candidates.filter((candidate) => {
      const metadata = candidate.metadata && typeof candidate.metadata === 'object' ? candidate.metadata as Record<string, unknown> : {}
      return metadata.continuityKey === character.continuityKey
    })
    // Named actors have one reusable appearance library across scenes. The
    // request's default v1 key is not an instruction to retry that first asset
    // forever; walk newest-to-oldest and reuse the newest valid reviewed sheet.
    const eligible = selectedId ? selected : isGenericCharacterName(character.name) && !character.visualContext ? exact : candidates
    for (const candidate of eligible) {
      if (selectedId && rejectedCharacterPortraitReview(candidate)) {
        throw Error(`CHARACTER_PORTRAIT_REVIEW_REJECTED: ${character.name} 所选三视图 ${selectedId} 已被人工拒绝，不能进入工作流`)
      }
      if (selectedId && pendingCharacterPortraitReview(candidate)) {
        const kind = pendingCharacterIdentityReview(candidate) ? 'CHARACTER_IDENTITY_REVIEW_REQUIRED' : 'CHARACTER_PORTRAIT_REVIEW_REQUIRED'
        throw Error(`${kind}: ${character.name} 所选三视图 ${selectedId} 尚未完成核验，不能进入工作流；请在人物库只读查看并完成审核`)
      }
      if (!selectedId && (supersededCharacterPortrait(candidate) || pendingCharacterPortraitReview(candidate))) {
        rejectedAssets.push({ id: String(candidate.id ?? ''), characterName: character.name,
          reason: supersededCharacterPortrait(candidate) ? 'CHARACTER_PORTRAIT_SUPERSEDED: 历史候选不能自动召回'
            : pendingCharacterIdentityReview(candidate) ? 'CHARACTER_IDENTITY_REVIEW_REQUIRED: 人脸一致性待人工核验，不能自动召回'
              : 'CHARACTER_PORTRAIT_REVIEW_REQUIRED: 本批次审核未完成，不能自动召回' })
        continue
      }
      if (!selectedId && !characterAssetEpisodeScopeMatches(candidate, params.episodeNumber)) {
        rejectedAssets.push({ id: String(candidate.id ?? ''), characterName: character.name, reason: 'CHARACTER_EPISODE_SCOPE_MISMATCH: 三视图所属剧情集数与当前集数不同' })
        continue
      }
      const compatibility = characterVisualContextCompatibility(character.visualContext, candidate)
      if (!compatibility.matches) {
        if (selectedId) throw Error(`CHARACTER_VISUAL_SELECTION_MISMATCH: ${character.name} 所选三视图 ${selectedId} 与当前造型不符：${compatibility.reason}；不能替换或重新生成`)
        rejectedAssets.push({ id: String(candidate.id ?? ''), characterName: character.name, reason: compatibility.reason })
        continue
      }
      if (selectedId) {
        try { await validateReadableImageReference(String(candidate.url ?? '')) }
        catch (error) { throw Error(`CHARACTER_VISUAL_SELECTION_MISMATCH: ${character.name} 所选三视图 ${selectedId} 图片不可用；不能替换或重新生成`, { cause: error }) }
      }
      if (isManualReview(params)) {
        try { byName.set(character.name, await manualCharacterAsset(candidate, params.includeVoices === true)); break }
        catch (error) {
          if (selectedId) throw Error(`CHARACTER_VISUAL_SELECTION_MISMATCH: ${character.name} 所选三视图 ${selectedId} 无法使用；不能替换或重新生成`, { cause: error })
          rejectedAssets.push({ id: String(candidate.id ?? ''), characterName: character.name, reason: error instanceof Error ? error.message : String(error) }); continue
        }
      }
      const poseIssue = threeViewReferencePoseIssue(candidate)
      if (poseIssue) {
        if (selectedId) throw Error(`CHARACTER_VISUAL_SELECTION_MISMATCH: ${character.name} 所选三视图 ${selectedId} 无法作为身份参考：${poseIssue}；不能替换或重新生成`)
        rejectedAssets.push({ id: String(candidate.id ?? ''), characterName: character.name, reason: poseIssue })
        continue
      }
      // The video voice element API splits the stored sheet into FRONT/SIDE/BACK.
      // A legacy/recovered portrait can therefore pass a subjective appearance
      // review yet still be unusable at the provider boundary. Reject it during
      // lookup so the normal missing-character branch regenerates it, rather than
      // failing later after TTS work has already completed.
      if (params.includeVoices === true) {
        try {
          await validateThreeViewReference(String(candidate.url ?? ''))
        } catch (error) {
          if (selectedId) throw Error(`CHARACTER_VISUAL_SELECTION_MISMATCH: ${character.name} 所选三视图 ${selectedId} 三视图校验失败；不能替换或重新生成`, { cause: error })
          rejectedAssets.push({
            id: String(candidate.id ?? ''),
            characterName: character.name,
            reason: error instanceof Error ? error.message : String(error),
          })
          continue
        }
      }
      byName.set(character.name, candidate)
      break
    }
    if (!selectedId && !byName.has(character.name)) {
      const blocked = eligible.find(candidate => (pendingCharacterPortraitReview(candidate)
        || (rejectedCharacterPortraitReview(candidate) && candidate.id !== params.regenerateAssetId))
        && characterAssetEpisodeScopeMatches(candidate, params.episodeNumber)
        && characterVisualContextCompatibility(character.visualContext, candidate).matches)
      if (blocked) {
        const kind = rejectedCharacterPortraitReview(blocked) ? 'CHARACTER_PORTRAIT_REVIEW_REJECTED'
          : pendingCharacterIdentityReview(blocked) ? 'CHARACTER_IDENTITY_REVIEW_REQUIRED' : 'CHARACTER_PORTRAIT_REVIEW_REQUIRED'
        throw Error(`${kind}: ${character.name} 的相容候选 ${blocked.id} 已付费生成但尚不可用；请在人物库审核，或对人工拒绝图显式发起修订`)
      }
    }
  }
  const items = characters.flatMap((character): Record<string, unknown>[] => {
    const asset = byName.get(character.name)
    return asset ? [{ ...asset, equipment: equipmentByName.get(character.name) ?? [] }] : []
  })
  const resolvedCharacters = characters.map(character => {
    const asset = byName.get(character.name)
    const metadata = asset?.metadata as Record<string, unknown> | undefined
    return asset ? { ...character, equipmentIds: (equipmentByName.get(character.name) ?? []).map(item => item.id),
      continuityKey: String(metadata?.continuityKey ?? asset.id), description: String(metadata?.description ?? character.description ?? ''),
      ...(typeof metadata?.voiceContinuityKey === 'string' ? { voiceContinuityKey: metadata.voiceContinuityKey } : {}) } : character
  })
  if (params.includeVoices === true) for (const character of resolvedCharacters) {
    if (!character.visualContext || character.voiceContinuityKey) continue
    const asset = byName.get(character.name), metadata = asset?.metadata as Record<string, unknown> | undefined
    const originalVoice = metadata?.originalVoice as Record<string, unknown> | undefined
    character.voiceContinuityKey = await existingCharacterVoiceContinuityKey(pool, { workflowId, characterName: character.name,
      visualKey: character.continuityKey, ...(typeof originalVoice?.characterId === 'string' ? { originalCharacterId: originalVoice.characterId } : {}) })
  }
  for (const character of resolvedCharacters) if (character.voiceContinuityKey) await preservedCharacterVoiceIdentity(pool, workflowId, character.name, character.voiceContinuityKey)
  const missingCharacters = resolvedCharacters.filter((character) => !byName.has(character.name)).map(character => {
    const rejected = rejectedAssets.some(asset => asset.characterName === character.name)
    const needsDefinitionReview = rejectedAssets.some(asset => asset.characterName === character.name && asset.reason.startsWith('CHARACTER_VISUAL_LOOK_DEFINITION_CONFLICT:'))
    const existingLookDefinitions = needsDefinitionReview ? (candidatesByName.get(character.name) ?? []).flatMap(asset => {
      try { const context = characterVisualContextFrom(asset); return context ? [{ assetId: asset.id, visualContext: context }] : [] } catch { return [] }
    }) : []
    return rejected ? { ...character, equipmentIds: (equipmentByName.get(character.name) ?? []).map(item => item.id),
      continuityKey: nextReferenceContinuityKey(character.continuityKey, candidatesByName.get(character.name) ?? []), ...(needsDefinitionReview ? { requiresVisualContextReview: true, existingLookDefinitions } : {}) }
      : { ...character, equipmentIds: (equipmentByName.get(character.name) ?? []).map(item => item.id) }
  })
  const voiceCharacters = voiceCharacterInputs(resolvedCharacters, params.shot && typeof params.shot === 'object' ? params.shot as Record<string, unknown> : {}, { qualityDisposition: params.qualityDisposition })
  const existingVoices = params.includeVoices === true ? await lookupArchivedVoices(pool, workflowId, voiceCharacters.map(c => c.continuityKey)) : undefined
  return {
    characters: resolvedCharacters,
    ...(existingVoices ? { existingVoices, voiceCharacters } : {}),
    names: characters.map((item) => item.name),
    items,
    urls: items.map((item) => String(item?.url ?? '')).filter(Boolean),
    byCharacter: Object.fromEntries(items.map((item) => [String(item?.characterName), item])),
    equipmentBindings: [...equipmentByName.values()].flat(),
    equipmentByCharacter: Object.fromEntries([...equipmentByName]),
    descriptions: Object.fromEntries(items.map((item) => [String(item?.characterName), String(item?.description ?? item?.prompt ?? '')])),
    missingCharacters,
    rejectedAssets,
    foundCount: items.length,
    missingCount: missingCharacters.length,
  }
}

async function ensureCharacterAssets(pool: Pool, request: BuiltinNodeRequest, executeMediaModel?: MediaExecutor, dependencies: BuiltinDependencies = {}) {
  const params = request.params ?? {}
  const manual = isManualReview(params)
  const shouldValidate = params.validateThreeView === true || params.validateThreeView === 'true'
  const characters = toArray(params.characters ?? params.names).map(characterIdentity).filter((item) => item.name)
  const allCharacters = toArray(params.allCharacters).map(characterIdentity).filter((item) => item.name)
  const workflowId = String(params.workflowId ?? '').trim()
  const regenerateAssetId = typeof params.regenerateAssetId === 'string' ? params.regenerateAssetId.trim() : ''
  if (params.regenerateAssetId !== undefined && !regenerateAssetId) throw Error('CHARACTER_PORTRAIT_REGENERATION_INVALID: 旧三视图资产 ID 不能为空')
  if (regenerateAssetId) {
    if (!workflowId || characters.length !== 1 || !characters[0].visualContext) throw Error('CHARACTER_PORTRAIT_REGENERATION_INVALID: 修订三视图须指定同工作流、唯一人物及已归档年龄造型')
    const { rows } = await pool.query(`select id,workflow_id,character_name,asset_type,metadata from character_assets where id=$1`, [regenerateAssetId])
    const previous = rows[0]
    if (!previous || previous.workflow_id !== workflowId || previous.character_name !== characters[0].name || previous.asset_type !== 'three-view'
      || !characterVisualContextCompatibility(characters[0].visualContext, storedCharacterAsset(previous)).matches) {
      throw Error('CHARACTER_PORTRAIT_REGENERATION_INVALID: 旧资产须属于同人物同工作流，且年龄造型定义原样保持')
    }
    const previousKey = String(previous.metadata?.continuityKey ?? '')
    const nextKey = requestedContinuityKey(characters[0], params)
    const previousRevision = previousKey.match(/-visual-[a-f0-9]{24}-v(\d+)$/)
    const nextRevision = nextKey.match(/-visual-[a-f0-9]{24}-v(\d+)$/)
    if (!previousRevision || !nextRevision || Number(nextRevision[1]) <= Number(previousRevision[1])
      || previousKey.replace(/-v\d+$/, '') !== nextKey.replace(/-v\d+$/, '')) {
      throw Error('CHARACTER_PORTRAIT_REGENERATION_INVALID: 修订须沿用原造型签名，并显式递增三视图连续性版本')
    }
  }
  await requestedCharacterEquipment(pool, workflowId,
    [...new Map([...allCharacters, ...characters].map(character => [character.name, character])).values()], params.allowSharedEquipment === true)
  const existingAssets = toArray(params.existingAssets).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
  const selections = selectedCharacterAssetIds(params.characterAssetSelections)
  if (regenerateAssetId && selections.has(characters[0].name)) throw Error('CHARACTER_PORTRAIT_REGENERATION_INVALID: 指定旧图修订与锁定旧图使用不可同时请求')
  const existingIds = [...new Set(existingAssets.map(asset => String(asset.id ?? '')).filter(Boolean))]
  const currentLifecycle = new Map<string, boolean>()
  if (existingIds.length) {
    const current = await pool.query(`select id,metadata from character_assets where id=any($1::text[])`, [existingIds])
    for (const row of current.rows) currentLifecycle.set(String(row.id), supersededCharacterPortrait(row) || pendingCharacterPortraitReview(row))
  }
  const selectedCharacters = [...new Map([...allCharacters, ...characters].map(character => [character.name, character])).values()].filter(character => selections.has(character.name))
  if (selectedCharacters.length) {
    const selected = await lookupCharacterAssets(pool, { ...request, params: { ...params, characters: selectedCharacters, includeVoices: false } })
    existingAssets.splice(0, existingAssets.length, ...existingAssets.filter(asset => !selections.has(String(asset.characterName ?? asset.name ?? ''))), ...selected.items as Record<string, unknown>[])
  }
  const preserveCachedVoice = async (character: ReturnType<typeof characterIdentity>, asset: Record<string, unknown>) => {
    const metadata = asset.metadata as Record<string, unknown> | undefined
    const preferredKey = character.voiceContinuityKey || (typeof metadata?.voiceContinuityKey === 'string' ? metadata.voiceContinuityKey : undefined)
    if (!character.visualContext && !preferredKey) return asset
    const originalVoice = metadata?.originalVoice as Record<string, unknown> | undefined
    const voiceContinuityKey = await existingCharacterVoiceContinuityKey(pool, { workflowId, characterName: character.name,
      visualKey: String(metadata?.continuityKey ?? requestedContinuityKey(character, params)), preferredKey,
      ...(typeof originalVoice?.characterId === 'string' ? { originalCharacterId: originalVoice.characterId } : {}) })
    return voiceContinuityKey ? { ...asset, metadata: { ...metadata, voiceContinuityKey } } : asset
  }
  const suppliedByName = new Map<string, Record<string, unknown>>()
  for (const item of existingAssets) {
    const name = String(item.characterName ?? item.name ?? '')
    if (!name) continue
    if (selections.has(name) && item.id !== selections.get(name)) continue
    if (!selections.has(name) && (item.id === regenerateAssetId || supersededCharacterPortrait(item) || pendingCharacterPortraitReview(item) || currentLifecycle.get(String(item.id ?? '')) === true)) continue
    if (!selections.has(name) && !characterAssetEpisodeScopeMatches(item, params.episodeNumber)) continue
    const requested = [...characters, ...allCharacters].find(character => character.name === name)
    if (!requested || !characterVisualContextCompatibility(requested.visualContext, item).matches) continue
    if (manual) {
      try { suppliedByName.set(name, await manualCharacterAsset(item, shouldValidate)) } catch { /* An unreadable cached asset must be replaced. */ }
      continue
    }
    if (threeViewReferencePoseIssue(item)) continue
    if (shouldValidate) {
      try { await validateThreeViewReference(String(item.url ?? item.uri ?? '')) }
      catch { continue }
    }
    suppliedByName.set(name, item)
  }
  for (const character of selectedCharacters) {
    if (!suppliedByName.has(character.name)) throw Error(`CHARACTER_VISUAL_SELECTION_MISMATCH: ${character.name} 所选三视图 ${selections.get(character.name)} 未通过使用校验；不能替换或重新生成`)
  }
  if (!characters.length) {
    if (params.allowEmpty === true || params.allowEmpty === 'true') {
      const items: Record<string, unknown>[] = []
      for (const character of allCharacters) {
        const asset = suppliedByName.get(character.name)
        if (asset) items.push(await preserveCachedVoice(character, asset))
      }
      return {
        items,
        urls: items.map((item) => String(item?.url ?? '')).filter(Boolean),
        byCharacter: Object.fromEntries(items.map((item) => [String(item?.characterName ?? item?.name), item])),
        generated: [],
        generatedCount: 0,
        cachedCount: items.length,
        count: items.length,
      }
    }
    throw new Error('角色资产节点未收到 characters/names')
  }
  const names = characters.map((item) => item.name)
  const stored = await pool.query(
    `select id, workflow_id, character_name, asset_type, uri, prompt, version, metadata, created_at, updated_at
       from character_assets
      where character_name = any($1::text[]) and asset_type = 'three-view'
        and ($2 = '' or workflow_id = $2 or workflow_id is null)
      order by (workflow_id = $2) desc, updated_at desc`,
    [names, workflowId],
  )
  const byName = new Map<string, Record<string, unknown>>(suppliedByName)
  for (const row of stored.rows) {
    if (byName.has(row.character_name)) continue
    const character = characters.find((item) => item.name === row.character_name)
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata as Record<string, unknown> : {}
    if (row.id === regenerateAssetId) continue
    if (!selections.has(String(row.character_name)) && (supersededCharacterPortrait(storedCharacterAsset(row)) || pendingCharacterPortraitReview(storedCharacterAsset(row)))) continue
    if (!selections.has(String(row.character_name)) && !characterAssetEpisodeScopeMatches(storedCharacterAsset(row), params.episodeNumber)) continue
    const requestedKey = character ? requestedContinuityKey(character, params) : ''
    if (character?.visualContext ? !characterVisualContextCompatibility(character.visualContext, storedCharacterAsset(row)).matches
      : requestedKey && metadata.continuityKey !== requestedKey) continue
    const stored = storedCharacterAsset(row)
    if (manual) {
      try { byName.set(row.character_name, await manualCharacterAsset(stored, shouldValidate)) } catch { /* Keep unusable bytes out of generation inputs. */ }
      continue
    }
    if (threeViewReferencePoseIssue(stored)) continue
    if (shouldValidate) {
      try { await validateThreeViewReference(String(stored.url ?? '')) }
      catch { continue }
    }
    byName.set(row.character_name, stored)
  }
  const generated: Record<string, unknown>[] = []
  for (const character of characters) {
    const cached = byName.get(character.name)
    if (cached) { byName.set(character.name, await preserveCachedVoice(character, cached)); continue }
    const pendingIdentity = [...existingAssets,
      ...stored.rows.filter(row => row.character_name === character.name).map(storedCharacterAsset)]
      .find(asset => String(asset.characterName ?? ('name' in asset ? asset.name : '') ?? '') === character.name
        && (pendingCharacterPortraitReview(asset) || (rejectedCharacterPortraitReview(asset) && asset.id !== regenerateAssetId))
        && characterAssetEpisodeScopeMatches(asset, params.episodeNumber)
        && characterVisualContextCompatibility(character.visualContext, asset).matches)
    if (pendingIdentity && !selections.has(character.name)) {
      const kind = rejectedCharacterPortraitReview(pendingIdentity) ? 'CHARACTER_PORTRAIT_REVIEW_REJECTED'
        : pendingCharacterIdentityReview(pendingIdentity) ? 'CHARACTER_IDENTITY_REVIEW_REQUIRED' : 'CHARACTER_PORTRAIT_REVIEW_REQUIRED'
      throw Error(`${kind}: ${character.name} 的相容候选 ${pendingIdentity.id} 已付费生成但不可自动使用；保留候选，禁止自动再购买图片`)
    }
    // Validate before any paid image request. A new Sanguo costume sheet may
    // be reused within its episode, but must not enter the global actor pool.
    const episodeScope = generatedCharacterEpisodeScope(workflowId, params.episodeNumber)
    const alternateCandidates = [...stored.rows.filter(row => row.character_name === character.name).map(storedCharacterAsset), ...existingAssets.filter(asset => String(asset.characterName ?? asset.name ?? '') === character.name)]
    for (const asset of alternateCandidates) {
      const compatibility = characterVisualContextCompatibility(character.visualContext, asset)
      if (compatibility.reason.startsWith('CHARACTER_VISUAL_LOOK_DEFINITION_CONFLICT:')) throw Error(compatibility.reason)
    }
    // A new age/costume sheet still depicts the same actor. The current
    // explicitly archived art direction supplies the face, even when that
    // sheet is episode-scoped for costume. Only a visually verified sheet may
    // become the image reference; caller-provided URLs cannot replace it.
    const identityRows = stored.rows.filter(row => row.workflow_id === workflowId && row.character_name === character.name)
    const requestedIdentityId = typeof params.identityReferenceAssetId === 'string' ? params.identityReferenceAssetId.trim() : ''
    const activeIdentityRows = identityRows.filter(row => !supersededCharacterPortrait(storedCharacterAsset(row))
      && !pendingCharacterPortraitReview(storedCharacterAsset(row)) && characterArtisticIdentityFrom(storedCharacterAsset(row)))
    if (activeIdentityRows.length > 1) throw Error(`CHARACTER_ARTISTIC_IDENTITY_CONFLICT: ${character.name} 有多个跨集当前身份图，请先明确唯一版本`)
    const activeIdentity = activeIdentityRows[0] ? characterArtisticIdentityFrom(storedCharacterAsset(activeIdentityRows[0])) : undefined
    const identitySearch = requestedIdentityId ? identityRows.filter(row => row.id === requestedIdentityId)
      : activeIdentityRows.length ? activeIdentityRows : identityRows.filter(row => !supersededCharacterPortrait(storedCharacterAsset(row))
        && !pendingCharacterPortraitReview(storedCharacterAsset(row)))
    const identityProfile = (row: Record<string, unknown>) => {
      if (requestedIdentityId && row.id !== requestedIdentityId) return undefined
      const metadata = row.metadata as Record<string, unknown> | undefined
      const full = metadata?.visualProfile as Record<string, unknown> | undefined
      const facial = metadata?.identityVisualProfile as Record<string, unknown> | undefined
      const profile = /^actual-reference-v\d/.test(String(full?.version ?? '')) ? full
        : facial?.version === 'actual-facial-identity-v1' && facial.scope === 'facial-identity-only'
          && facial.valid === true && facial.fullDesignMatched === false
          && typeof facial.observationLedgerId === 'string' && typeof facial.observationResponseHash === 'string'
          && /^[a-f0-9]{64}$/.test(facial.observationResponseHash)
          && Array.isArray(facial.issues) && facial.issues.length > 0 ? facial : undefined
      return !threeViewReferencePoseIssue(storedCharacterAsset(row))
        && typeof profile?.appearance === 'string' && profile.appearance.trim().length >= (profile.version === 'actual-facial-identity-v1' ? 16 : 20)
        && profile.sourceFingerprint === createHash('sha256').update(String(row.uri)).digest('hex') ? profile : undefined
    }
    const identityCandidate = identitySearch.find(row => identityProfile(row))
    if (requestedIdentityId && !identityCandidate) throw Error('CHARACTER_IDENTITY_REFERENCE_INVALID: 指定身份参考必须是同一工作流、同一人物且有实际图像核对的已归档三视图')
    if (!requestedIdentityId && activeIdentityRows.length && !identityCandidate) throw Error(`CHARACTER_IDENTITY_REFERENCE_UNREVIEWED: ${character.name} 当前选用的跨集身份图尚无实际图像核验，禁止改用旧脸生成新年龄或服装版本`)
    const referenceMetadata = identityCandidate?.metadata as Record<string, unknown> | undefined
    const referenceProfile = identityCandidate ? identityProfile(identityCandidate) : undefined
    let identityReference: { assetId: string; url: string; transportUrl: string } | undefined
    if (identityCandidate) {
      const url = String(identityCandidate.uri), profile = referenceProfile as Record<string, unknown>
      const snapshot = `/generated/appearance-${createHash('sha256').update(url).digest('hex').slice(0, 24)}.jpg`
      // Providers may fail to fetch signed CDN URLs that our own observer can
      // read. Use only the exact local snapshot created from this archived URI;
      // an arbitrary caller-supplied local path is never an identity reference.
      const hasBoundSnapshot = profile.referenceImage === snapshot
      if (profile.referenceImage && !hasBoundSnapshot) throw Error('CHARACTER_IDENTITY_REFERENCE_SNAPSHOT_INVALID: 人物核验快照路径与原图指纹不符，请重新核验原人物图')
      if (/^https?:\/\//i.test(url) && !hasBoundSnapshot) throw Error('CHARACTER_IDENTITY_REFERENCE_SNAPSHOT_MISSING: 远程人物图缺少已核验本地快照，请先重新外观核验/读图，不能直接重发签名URL购买新图')
      const transportUrl = hasBoundSnapshot ? snapshot : url
      try { await validateReadableImageReference(transportUrl) }
      catch (error) { throw Error(`CHARACTER_IDENTITY_REFERENCE_SNAPSHOT_MISSING: 人物参考快照缺失或不可解码，请先重新核验/读图：${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
      identityReference = { assetId: String(identityCandidate.id), url, transportUrl }
    }
    const identityContext = identityCandidate ? characterVisualContextFrom(storedCharacterAsset(identityCandidate)) : undefined
    const sameAdultStage = Boolean(identityContext && character.visualContext
      && identityContext.age.stage === character.visualContext.age.stage
      && ['young_adult', 'adult', 'mature'].includes(character.visualContext.age.stage)
      && (!identityContext.age.years || !character.visualContext.age.years
        || identityContext.age.years.min <= character.visualContext.age.years.max && character.visualContext.age.years.min <= identityContext.age.years.max))
    const identityAnchor = identityReference && character.visualContext ? await (dependencies.prepareIdentityAnchor ?? prepareCharacterIdentityAnchor)({
      assetId: identityReference.assetId, sourceUrl: identityReference.url, snapshotUrl: identityReference.transportUrl,
      sourceFingerprint: String(referenceProfile?.sourceFingerprint),
    }, { mode: sameAdultStage ? 'full-face' : 'upper-face' }) : undefined
    const identityTransportUrl = identityAnchor?.anchorUrl ?? identityReference?.transportUrl
    let voiceContinuityKey = character.voiceContinuityKey || (typeof referenceMetadata?.voiceContinuityKey === 'string' ? referenceMetadata.voiceContinuityKey : undefined)
    const originalVoice = referenceMetadata?.originalVoice as Record<string, unknown> | undefined
    if (character.visualContext || voiceContinuityKey) voiceContinuityKey = await existingCharacterVoiceContinuityKey(pool, {
      workflowId, characterName: character.name, visualKey: requestedContinuityKey(character, params), preferredKey: voiceContinuityKey,
      ...(typeof originalVoice?.characterId === 'string' ? { originalCharacterId: originalVoice.characterId } : {}),
    })
    const designPrompt = character.designPrompt || `东汉末年人物三视图，${character.name}，真人历史电影质感，正面、侧面、背面，服化道准确，纯色背景，无文字无水印。`
    let generatedBody: unknown
    let uri = ''
    let quality: unknown
    let visualProfile: Record<string, unknown> | undefined
    let identityConsistency: Awaited<ReturnType<typeof compareCharacterFaceSheets>> | undefined
    let sourceMediaProvenance: Record<string, unknown> | undefined
    const maxAttempts = manual ? 1 : shouldValidate ? resolveRetryAttemptLimit(params.maxGenerationAttempts) : 1
    // Old checkpoints may still carry the retired Ofox fallback.
    const fallbackId = manual || isHistoricalImageWorkflow(request) ? '' : String(params.fallbackModelId ?? '').trim()
    const fallbackModel = shouldValidate && fallbackId && fallbackId !== request.model?.id
      ? (await pool.query("select * from model_configs where id=$1 and capability='image' and provider <> 'Local'", [fallbackId])).rows[0] as BuiltinNodeRequest['model']
      : undefined
    if (shouldValidate && fallbackId && fallbackId !== request.model?.id && !fallbackModel) throw new Error(`备用图片模型未配置：${fallbackId}`)
    const primaryAttemptLimit = fallbackModel ? Math.max(1, maxAttempts - 1) : maxAttempts
    let lastValidationError = ''
    let repairImage = ''
    let primaryFailures = 0
    let fallbackFailures = 0
    let effectiveModel = request.model
    let generationFingerprint = ''
    if (!manual && shouldValidate && request.executionContext?.requestKey) {
      const rejections = await pool.query(`select model_id,response_data from model_execution_records
        where request_data->>'requestKey'=$1 and request_data->'params'->>'characterName'=$2
          and request_data->>'operation'='character.three-view' and response_data->>'qualityRejected'='true'
        order by created_at desc`, [request.executionContext.requestKey, character.name])
      primaryFailures = rejections.rows.filter((row) => row.model_id === request.model?.id).length
      fallbackFailures = rejections.rows.filter((row) => row.model_id === fallbackModel?.id).length
      const rejected = rejections.rows.find((row) => row.model_id === request.model?.id)?.response_data
      lastValidationError = String(rejected?.qualityRejection ?? '')
      if (lastValidationError.startsWith('CHARACTER_APPEARANCE_REJECTED:')) repairImage = firstUrl(rejected)
      if (fallbackFailures) lastValidationError = String(rejections.rows.find((row) => row.model_id === fallbackModel?.id)?.response_data?.qualityRejection ?? lastValidationError)
    }
    // Limits belong to the logical execution, including checkpoint resumes.
    // A fallback starts fresh: repeated edits of a rejected image degrade it.
    for (let attempt = primaryFailures + fallbackFailures; attempt < maxAttempts; attempt += 1) {
      const useFallback = primaryFailures >= primaryAttemptLimit
      if (useFallback && (!fallbackModel || fallbackFailures >= 1)) break
      effectiveModel = useFallback ? fallbackModel : request.model
      // An explicit age/look redesign keeps only its clean upper-face anchor on
      // every retry. Editing the rejected full sheet would lock its old beard,
      // age and costume back into the supposedly redesigned variant.
      const useRepairImage = !useFallback && Boolean(repairImage) && !identityAnchor
      const retryFeedback = [params.retryFeedback, lastValidationError].filter(Boolean).join('\n')
      const basePrompt = params.generationPromptTemplate ? [renderWorkflowTemplate(String(params.generationPromptTemplate).replace(/\{\{([^}]+)\}\}/g, (_, key: string) => '${' + key + '}'), { character, feedback: retryFeedback }), characterVisualContextDesignText(character.visualContext)].filter(Boolean).join('\n') : buildThreeViewGenerationPrompt(character, lastValidationError, useRepairImage)
      const identityRedesign = identityReference && !useRepairImage ? [
        (identityAnchor as Record<string, unknown> | undefined)?.scope === 'full-face-identity-only'
          ? '【同年龄阶段完整脸部身份附件≠输出构图】附件是已核验同一人物的彩色完整脸部局部，只继承五官、面部轮廓、肤色与现阶段稳定须发，使新造型仍像同一位演员；服饰与背景只按本次设计，不得复制旧衣袍。输出仍是完整全身正面、侧面、背面水平一行三列三视图，禁止脸部特写或贴图。'
          : identityAnchor ? '【跨年龄上脸身份附件≠输出构图】附件只包含已核验同一人物的眉眼、鼻与上脸骨相，并已灰度化，只用于五官相对几何与人物身份；不用于输出肤色、色调、年龄或服装。输出仍是彩色真人角色，年龄、肤色与须发严格按当前设计，完整全身正面、侧面、背面水平一行三列。' : '',
        identityAnchor && (identityAnchor as Record<string, unknown>).scope === 'full-face-identity-only'
          ? '【同年龄阶段换装】保留附件所示同一演员的脸形、眉眼鼻嘴、自然肤色、黑发与黑色短须，年龄阶段和体格按本次视觉契约；只将衣甲、配饰及场合换为本次设计。不得随机换脸、改变原人物的清朗五官、变胖或显老，也不得复刻旧整套服装。'
          : '【跨年龄身份参考与造型重设计】这是在同一人物上脸骨相与五官关系基础上修改年龄与造型，不是复刻旧整图；不继承旧图肤色、须发颜色、服装或场景。当前明确年龄、肤色、须发、体型与稳定服装设计优先；必须在实际画面落实重设计，不得随机换脸。',
        character.visualContext?.appearanceConstraints?.hair === 'dark' ? '头发改为均匀深色，完全去除原图所有白色与花白发丝。' : '',
        character.visualContext?.appearanceConstraints?.facialHair === 'dark' ? '胡须改为均匀深色，完全去除所有灰白须丝，尤其检查下颌、胡须边缘和鬓角，不得残留旧图灰白胡须。' : '',
      ].filter(Boolean).join('\n') : ''
      const generationPrompt = [basePrompt, characterArtisticIdentityDesignText(activeIdentity), identityRedesign].filter(Boolean).join('\n')
      if (effectiveModel?.provider === 'Local' || !executeMediaModel || !effectiveModel) {
        generatedBody = runLocalModel({ capability: 'image', operation: 'character.three-view', prompt: generationPrompt, params: { characterName: character.name } })
      } else {
        const generationRequest = {
          model: effectiveModel,
          prompt: generationPrompt,
          params: {
            aspectRatio: '16:9',
            size: '1536x1024',
            n: 1,
            characterName: character.name,
            ...(character.visualContext ? { visualContext: character.visualContext } : {}),
            ...(useRepairImage ? { referenceImage: repairImage, imageEdit: true } : {}),
            ...(!useRepairImage && identityReference ? { referenceImages: [identityTransportUrl], identityReferenceAssetId: identityReference.assetId, identityReferenceRole: 'facial-identity-only', ...(identityAnchor ? { identityReferenceAnchor: identityAnchor } : {}), ...(character.visualContext ? { imageEdit: true } : {}) } : {}),
            negativePrompt: buildThreeViewNegativePrompt(character),
          },
          operation: 'character.three-view',
          executionContext: request.executionContext,
        }
        generationFingerprint = modelRequestFingerprint(generationRequest)
        const response = await executeMediaModel(generationRequest)
        if (response.status >= 400) throw new Error(`角色 ${character.name} 三视图生成失败：${JSON.stringify(response.body)}`)
        generatedBody = response.body
      }
      uri = firstUrl(generatedBody)
      if (!uri) throw new Error(`角色 ${character.name} 三视图未返回可用 URL`)
      if (shouldValidate && (identityAnchor as Record<string, unknown> | undefined)?.scope === 'full-face-identity-only') {
        identityConsistency = await (dependencies.compareFaceSheets ?? compareCharacterFaceSheets)({
          sourceAssetId: identityReference!.assetId,
          sourceSnapshotUrl: String((identityAnchor as Record<string, unknown>).sourceSnapshotUrl ?? ''),
          sourceSnapshotFingerprint: String((identityAnchor as Record<string, unknown>).sourceSnapshotFingerprint ?? ''),
          candidateUrl: uri,
        })
        if (identityConsistency.candidateLocalUri) uri = identityConsistency.candidateLocalUri
        sourceMediaProvenance = identityConsistency.sourceMediaProvenance
      }
      if (identityConsistency?.status === 'needs_manual_review') {
        // The paid result is retained below, but this run must stop before a
        // first-frame or video node can consume a face that has not passed.
        if (!identityConsistency.candidateLocalUri) {
          // Do not use the ordinary image reader on a URL that the safe
          // mirror refused: it may redirect to a private address.
          quality = { status: 'needs_attention', canProceed: false, manualReviewRequired: true,
            warnings: ['CHARACTER_IDENTITY_REVIEW_REQUIRED: 生成图片未能安全镜像，仅保留模型调用账本和候选 URL'] }
        } else if (manual) {
          quality = (await manualCharacterAsset({ url: uri, characterName: character.name }, shouldValidate)).metadata.quality
        } else {
          let layout: unknown, layoutWarning = ''
          try { layout = await validateThreeViewReference(uri) }
          catch (error) { layoutWarning = error instanceof Error ? error.message : String(error) }
          quality = { status: 'needs_attention', canProceed: false, manualReviewRequired: true,
            layout, warnings: layoutWarning ? [layoutWarning] : [] }
        }
        const provisionalQuality = quality as Record<string, unknown>
        quality = { ...provisionalQuality, canProceed: false, manualReviewRequired: true,
          warnings: [...(Array.isArray(provisionalQuality.warnings) ? provisionalQuality.warnings : []),
            `CHARACTER_IDENTITY_REVIEW_REQUIRED: 同年龄阶段面孔一致性待人工核验（${identityConsistency.reason}）`] }
        break
      }
      if (manual) {
        quality = (await manualCharacterAsset({ url: uri, characterName: character.name }, shouldValidate)).metadata.quality
        break
      }
      if (!shouldValidate || effectiveModel?.provider === 'Local') break
      try {
        quality = await validateThreeViewReference(uri)
        // Deferred workflows have a separate evidence-backed appearance review.
        // Keep the mechanical sheet-layout gate here, but do not run a second
        // subjective observer inside the image generation node.
        if (workflowId === 'wf-sanguo-history-drama' && executeMediaModel
          && params.deferArchive !== true && params.deferArchive !== 'true') {
          visualProfile = await observeCharacterAsset({ characterName: character.name, url: uri, visualContext: character.visualContext }, await characterObserver(pool, executeMediaModel, request), { expectedDesign: [character.description || character.designPrompt, characterVisualContextDesignText(character.visualContext)].filter(Boolean).join('\n') })
        }
        lastValidationError = ''
        break
      } catch (error) {
        lastValidationError = error instanceof Error ? error.message : String(error)
        if (/HTTP |fetch failed|network|timeout|MODEL_TRANSPORT|REVIEW_INVALID/i.test(lastValidationError)) throw error
        // A completed image survives review transport failures. Only an actual
        // quality rejection makes that image ineligible for checkpoint reuse.
        const imageTaskId = (generatedBody as { data?: { task_id?: string } })?.data?.task_id
        const rejection = JSON.stringify({ qualityRejected: true, qualityRejection: lastValidationError })
        if (request.executionContext?.requestKey && generationFingerprint) {
          await pool.query(`update model_execution_records set response_data = response_data || $3::jsonb
            where request_data->>'requestKey'=$1 and request_data->>'fingerprint'=$2
              and request_data->>'operation'='character.three-view'`,
          [request.executionContext.requestKey, generationFingerprint, rejection])
        } else if (imageTaskId) {
          await pool.query(`update model_execution_records set response_data = response_data || $2::jsonb
            where task_id=$1 and request_data->>'operation'='character.three-view'`, [imageTaskId, rejection])
        }
        if (useFallback) fallbackFailures += 1
        else primaryFailures += 1
        repairImage = lastValidationError.startsWith('CHARACTER_APPEARANCE_REJECTED:') ? uri : ''
        uri = ''
      }
    }
    if (!uri && lastValidationError) throw new Error(`角色 ${character.name} 三视图质量检查失败：${lastValidationError}`)
    if (!uri) throw new Error(`角色 ${character.name} 三视图未返回可用 URL`)
    const assetScope = workflowId || 'global'
    const continuityKey = requestedContinuityKey(character, params)
    const id = `character-${createHash('sha1').update(`${assetScope}:${continuityKey}:three-view`).digest('hex').slice(0, 16)}`
    const metadata = {
      continuityKey,
      generatedBy: effectiveModel?.id ?? 'local-image-simulator',
      quality,
      visualProfile,
      description: character.description,
      historicalPortrait: character.historicalPortrait,
      biography: workflowCharacterBiography(character),
      visualContext: character.visualContext,
      ...(episodeScope ? { episodeScope } : {}),
      ...(character.visualContext ? { visualContextSource: 'generation-request-v1', visualContextRequestSignature: createHash('sha256').update(characterVisualContextSignature(character.visualContext)).digest('hex'), visualContextImageFingerprint: createHash('sha256').update(uri).digest('hex') } : {}),
      voiceContinuityKey,
      generationLedger: { requestKey: request.executionContext?.requestKey,
        fingerprint: generationFingerprint,
        taskId: (generatedBody as { data?: { task_id?: string } })?.data?.task_id },
      identityReferenceAssetId: identityReference?.assetId,
      identityReferenceUrl: identityReference?.url,
      identityReferenceTransportUrl: identityTransportUrl,
      identityReferenceAnchor: identityAnchor,
      identityConsistency,
      sourceMediaProvenance,
    }
    const pendingFaceReview = identityConsistency?.status === 'needs_manual_review'
    const biography = params.deferArchive !== true && params.deferArchive !== 'true' && !pendingFaceReview
      ? await archiveWorkflowCharacterAsset(pool, { id, workflowId: workflowId || null, characterName: character.name, uri,
        prompt: designPrompt, metadata, biography: metadata.biography }) : metadata.biography
    const item = { id, workflowId: workflowId || null, characterName: character.name, assetType: 'three-view', url: uri, prompt: designPrompt, version: 1, metadata, ...(biography !== undefined ? { biography } : {}), cached: false }
    byName.set(character.name, item)
    generated.push(item)
    if (pendingFaceReview) {
      // All paid sheets in this batch must survive the interrupted run, even
      // when the ordinary path would have archived only the current sheet.
      for (const paid of generated) {
          const unfinished = paid.id !== id
          let mirror: Awaited<ReturnType<typeof mirrorGeneratedCharacterImage>> | undefined
          let mirrorError = ''
          try { mirror = await mirrorGeneratedCharacterImage(String(paid.url)) }
          catch (error) { mirrorError = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) }
          const paidMetadata: Record<string, unknown> = { ...(paid.metadata as Record<string, unknown>),
            ...(mirror?.sourceMediaProvenance ? { sourceMediaProvenance: mirror.sourceMediaProvenance } : {}),
            ...(mirror && typeof (paid.metadata as Record<string, unknown>).visualContextImageFingerprint === 'string'
              ? { visualContextImageFingerprint: createHash('sha256').update(mirror.localUri).digest('hex') } : {}),
          }
          const previousQuality = paidMetadata.quality && typeof paidMetadata.quality === 'object'
            ? paidMetadata.quality as Record<string, unknown> : {}
          const metadataToArchive = unfinished ? { ...paidMetadata,
            portraitLifecycle: { status: mirror ? 'pending-review' : 'pending-unrecoverable',
              reason: mirror ? 'deferred-batch-interrupted' : 'candidate-mirror-unavailable',
              at: new Date().toISOString(), ...(mirror ? { candidateContentSha256: mirror.contentSha256 } : {
                originalUri: String(paid.url), originalUriFingerprint: createHash('sha256').update(String(paid.url)).digest('hex'),
                candidateTaskId: ((paid.metadata as Record<string, unknown>).generationLedger as Record<string, unknown> | undefined)?.taskId,
                diagnostic: mirrorError }) },
            quality: { ...previousQuality, canProceed: false, manualReviewRequired: true,
              warnings: [...(Array.isArray(previousQuality.warnings) ? previousQuality.warnings : []),
                'CHARACTER_PORTRAIT_REVIEW_REQUIRED: 同批次人物审核链未完成'] },
          } : { ...paidMetadata,
            identityConsistency: { ...(paidMetadata.identityConsistency as Record<string, unknown> | undefined),
              ...(mirror ? { candidateContentSha256: mirror.contentSha256, candidateLocalUri: mirror.localUri } : { diagnostic: mirrorError }) },
            portraitLifecycle: { status: mirror ? 'pending-review' : 'pending-unrecoverable',
              reason: mirror ? 'identity-review-required' : 'candidate-mirror-unavailable',
              at: new Date().toISOString(), ...(mirror ? { candidateContentSha256: mirror.contentSha256 } : {
                originalUri: String(paid.url), originalUriFingerprint: createHash('sha256').update(String(paid.url)).digest('hex'),
                candidateTaskId: ((paid.metadata as Record<string, unknown>).generationLedger as Record<string, unknown> | undefined)?.taskId,
                diagnostic: mirrorError }) } }
          await archiveWorkflowCharacterAsset(pool, { id: String(paid.id), workflowId: workflowId || null,
            characterName: String(paid.characterName), uri: mirror?.localUri ?? String(paid.url), prompt: String(paid.prompt),
            metadata: metadataToArchive,
            biography: typeof paid.biography === 'string' ? paid.biography : undefined })
      }
      throw Error(`CHARACTER_IDENTITY_REVIEW_REQUIRED: ${character.name} 的候选 ${id} 已归档待人工核验；当前工作流停止，禁止进入首帧或视频生成`)
    }
  }
  const requestedOrder = allCharacters.length ? allCharacters : characters
  const items = requestedOrder.map((character) => byName.get(character.name)).filter(Boolean)
  return {
    items,
    urls: items.map((item) => String(item?.url ?? '')).filter(Boolean),
    byCharacter: Object.fromEntries(items.map((item) => [String(item?.characterName), item])),
    generated,
    generatedCount: generated.length,
    cachedCount: items.length - generated.length,
    count: items.length,
  }
}

async function archiveCharacterAssets(pool: Pool, request: BuiltinNodeRequest) {
  const params = request.params ?? {}
  const selections = selectedCharacterAssetIds(params.characterAssetSelections)
  if (params.characters === undefined || params.characters === null) throw new Error('人物资产归档节点未收到 characters')
  const characters = toArray(params.characters).map(characterIdentity).filter((item) => item.name)
  const generatedValue = params.generatedAssets ?? params.images
  const structuredItems = toArray(generatedValue).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
  const structuredByName = new Map(structuredItems
    .map((item) => [String(item.characterName ?? item.name ?? ''), item] as const)
    .filter(([name]) => Boolean(name)))
  const legacyUrls = structuredByName.size ? [] : mediaUrls(generatedValue)
  const workflowId = String(params.workflowId ?? '').trim()
  if (!workflowId) throw new Error('人物资产归档缺少 workflowId')
  await requestedCharacterEquipment(pool, workflowId, characters, params.allowSharedEquipment === true)
  const candidates = toArray(params.voiceAssets) as VoiceCandidate[]
  const shot = params.shot && typeof params.shot === 'object' && !Array.isArray(params.shot) ? params.shot as Record<string, unknown> : undefined
  const requiredVoices = shot ? voiceCharacterInputs(characters.map(character => ({ ...character, continuityKey: requestedContinuityKey(character, params) })), shot, { qualityDisposition: params.qualityDisposition }) : undefined
  const requiredNamedVoices = requiredVoices ? new Set(requiredVoices.filter(role => role.name !== '旁白' && role.audioRole !== 'offscreen-dialogue').map(role => role.name)) : undefined
  // A picture-only actor is not a voice obligation. Conversely, an explicit
  // speaking role must not pass merely because voiceAssets is an empty array.
  for (const role of requiredVoices ?? []) {
    if (!candidates.some(candidate => candidate.workflowId === workflowId && candidate.characterName === role.name)) throw Error(`VOICE_ARCHIVE_INPUT: 人物 ${role.name} 缺少已归档音色`)
  }
  const items: Record<string, unknown>[] = []
  for (const [index, character] of characters.entries()) {
    const generated = structuredByName.get(character.name)
    const generatedMetadata = generated?.metadata as Record<string, unknown> | undefined
    let voiceContinuityKey = character.voiceContinuityKey || (typeof generatedMetadata?.voiceContinuityKey === 'string' ? generatedMetadata.voiceContinuityKey : undefined)
    const uri = generated ? firstUrl(generated) : legacyUrls[index]
    const selectedId = selections.get(character.name)
    if (selectedId) {
      const chosen = await lookupCharacterAssets(pool, { ...request, params: { ...params, characters: [character], includeVoices: false } })
      const asset = chosen.items[0] as Record<string, unknown>
      const suppliedUrls = generated ? ['url', 'uri', 'image_url', 'imageUrl', 'threeViewUrl', 'dataUrl', 'data_url']
        .map(key => generated[key]).filter((value): value is string => typeof value === 'string' && Boolean(value.trim())) : []
      if ((uri && (!generated || generated.id !== selectedId || uri !== asset.url)) || suppliedUrls.some(url => url !== asset.url)) throw Error(`CHARACTER_VISUAL_SELECTION_MISMATCH: ${character.name} 归档输入不能替换所选三视图 ${selectedId} 的原图`)
      const metadata = asset.metadata as Record<string, unknown>, originalVoice = metadata.originalVoice as Record<string, unknown> | undefined
      const preferredKey = character.voiceContinuityKey || (typeof metadata.voiceContinuityKey === 'string' ? metadata.voiceContinuityKey : undefined)
      if (character.visualContext || preferredKey) {
        const retained = await existingCharacterVoiceContinuityKey(pool, { workflowId, characterName: character.name,
          visualKey: String(metadata.continuityKey ?? asset.id), preferredKey,
          ...(typeof originalVoice?.characterId === 'string' ? { originalCharacterId: originalVoice.characterId } : {}) })
        if (retained) asset.metadata = { ...metadata, voiceContinuityKey: retained }
      }
      // Selection reuses the archived original. Voice metadata is still bound
      // below through the existing sound contract; no image row is rewritten.
      items.push(asset); continue
    }
    if (!uri && params.voiceAssets) {
      const existing = (await pool.query(`select * from character_assets where workflow_id=$1 and asset_type='three-view' and (metadata->>'continuityKey'=$2 or id=$2) order by updated_at desc limit 1`, [workflowId, requestedContinuityKey(character, params)])).rows[0]
      if (existing && characterAssetEpisodeScopeMatches(storedCharacterAsset(existing), params.episodeNumber)
        && characterVisualContextCompatibility(character.visualContext, storedCharacterAsset(existing)).matches) {
        const asset = storedCharacterAsset(existing), metadata = asset.metadata as Record<string, unknown>
        const originalVoice = metadata.originalVoice as Record<string, unknown> | undefined
        const preferredKey = voiceContinuityKey || (typeof metadata.voiceContinuityKey === 'string' ? metadata.voiceContinuityKey : undefined)
        if (character.visualContext || preferredKey) {
          const retained = await existingCharacterVoiceContinuityKey(pool, { workflowId, characterName: character.name,
            visualKey: String(metadata.continuityKey ?? asset.id), preferredKey,
            ...(typeof originalVoice?.characterId === 'string' ? { originalCharacterId: originalVoice.characterId } : {}) })
          if (retained) asset.metadata = { ...metadata, voiceContinuityKey: retained }
        }
        items.push(asset); continue
      }
    }
    if (!uri) throw new Error(`人物资产归档缺少“${character.name}”的具名生成结果`)
    const episodeScope = generatedCharacterEpisodeScope(workflowId, params.episodeNumber)
    if (episodeScope && generatedMetadata?.episodeScope !== undefined
      && JSON.stringify(generatedMetadata.episodeScope) !== JSON.stringify(episodeScope)) {
      throw Error(`CHARACTER_EPISODE_SCOPE_MISMATCH: ${character.name} 生成图所属集数与当前归档集数不同`)
    }
    if (character.visualContext) {
      if (!generated) throw Error('CHARACTER_VISUAL_CONTEXT_PROVENANCE_MISSING: 明确年龄/造型要求不能给裸图片URL盖章；须保留生成上下文或独立实际观察')
      const compatibility = characterVisualContextCompatibility(character.visualContext, generated)
      const signature = createHash('sha256').update(characterVisualContextSignature(character.visualContext)).digest('hex')
      const profile = generatedMetadata?.visualProfile as Record<string, unknown> | undefined
      const generatedContext = generatedMetadata?.visualContextSource === 'generation-request-v1' && generatedMetadata.visualContextRequestSignature === signature
        && generatedMetadata.visualContextImageFingerprint === createHash('sha256').update(uri).digest('hex')
      // A paid sheet with a confirmed hair/beard discrepancy remains archived
      // with its observation for manual repair. It will not match later lookup;
      // gross age, identity, era and required costume failures never use this
      // exception. Only this exact URL and generation request qualify.
      if (!compatibility.matches && !(generatedContext && reviewedHairMismatchCanArchive(generated, compatibility.reason))) throw Error(compatibility.reason)
      const evidence = profile?.visualContextEvidence as Record<string, unknown> | undefined
      const ageCategory = (stage: unknown) => ['young_adult', 'adult', 'mature'].includes(String(stage)) ? 'adult' : stage
      // A new generation retains its explicit design request even when an
      // observer cannot reliably separate neighbouring adult stages. Relabeling
      // an older image requires positive observation of all explicit visible
      // requirements; an unknown observation never supplies new age metadata.
      const ageObserved = character.visualContext.age.stage === 'unknown' || (evidence?.ageStage && evidence.ageStage !== 'unknown'
        && ageCategory(evidence.ageStage) === ageCategory(character.visualContext.age.stage))
      const hairObserved = (['hair', 'facialHair'] as const).every(key => {
        const wanted = character.visualContext?.appearanceConstraints?.[key]
        return !wanted || wanted === 'unknown' || evidence?.[key] === wanted
      })
      const observedContext = profile?.version === 'actual-reference-v2-age-context' && profile.visualContextHash === signature
        && profile.sourceFingerprint === createHash('sha256').update(uri).digest('hex')
        && ageObserved && hairObserved && !character.visualContext.age.years
      if (!generatedContext && !observedContext) throw Error('CHARACTER_VISUAL_CONTEXT_PROVENANCE_MISSING: 图片没有与当前年龄/造型及实际URL绑定的生成或观察证据，不能仅凭请求写入年龄标签')
    }
    const sourceMediaProvenance = generatedMetadata?.sourceMediaProvenance as Record<string, unknown> | undefined
    if (sourceMediaProvenance) {
      const originalUri = String(sourceMediaProvenance.originalUri ?? '')
      const contentSha256 = String(sourceMediaProvenance.contentSha256 ?? '')
      if (sourceMediaProvenance.version !== 'generated-media-mirror-v1'
        || !/^\/generated\/character-portrait-[a-f0-9]{32}\.(?:png|jpg|jpeg|webp)$/.test(uri)
        || sourceMediaProvenance.localUri !== uri
        || !/^https:\/\//.test(originalUri)
        || sourceMediaProvenance.originalUriFingerprint !== createHash('sha256').update(originalUri).digest('hex')
        || !/^[a-f0-9]{64}$/.test(contentSha256)) throw Error('CHARACTER_MEDIA_PROVENANCE_INVALID: 本地人物图与远端生成来源绑定无效')
      let bytes: Buffer
      try { bytes = await readFile(path.join(process.cwd(), 'public', uri)) }
      catch { throw Error('CHARACTER_MEDIA_PROVENANCE_INVALID: 本地人物原图缺失') }
      if (createHash('sha256').update(bytes).digest('hex') !== contentSha256) throw Error('CHARACTER_MEDIA_PROVENANCE_INVALID: 本地人物原图内容指纹不符')
    }
    const designPrompt = character.designPrompt || `东汉末年人物三视图，${character.name}，真人历史电影质感，正面、侧面、背面，服化道准确，纯色背景，无文字无水印。`
    const continuityKey = requestedContinuityKey(character, params)
    const originalVoice = generatedMetadata?.originalVoice as Record<string, unknown> | undefined
    if (character.visualContext || voiceContinuityKey) voiceContinuityKey = await existingCharacterVoiceContinuityKey(pool, { workflowId, characterName: character.name, visualKey: continuityKey, preferredKey: voiceContinuityKey,
      ...(typeof originalVoice?.characterId === 'string' ? { originalCharacterId: originalVoice.characterId } : {}) })
    const id = `character-${createHash('sha1').update(`${workflowId}:${continuityKey}:three-view`).digest('hex').slice(0, 16)}`
    const metadata = {
      continuityKey,
      generatedBy: String(params.generatedBy ?? 'workflow-image-node'),
      archivedFromNodeId: request.executionContext?.nodeId ?? null,
      visualProfile: (generated?.metadata as Record<string, unknown> | undefined)?.visualProfile,
      visualContextAssessment: generatedMetadata?.visualContextAssessment,
      description: character.description,
      historicalPortrait: character.historicalPortrait,
      biography: character.biography ?? normalizeCharacterBiography(generated?.biography ?? generatedMetadata?.biography)
        ?? workflowCharacterBiography(character),
      visualContext: character.visualContext,
      ...(episodeScope ? { episodeScope } : {}),
      visualContextSource: generatedMetadata?.visualContextSource,
      visualContextRequestSignature: generatedMetadata?.visualContextRequestSignature,
      visualContextImageFingerprint: generatedMetadata?.visualContextImageFingerprint,
      voiceContinuityKey,
      identityReferenceAssetId: (generated?.metadata as Record<string, unknown> | undefined)?.identityReferenceAssetId,
      identityReferenceUrl: (generated?.metadata as Record<string, unknown> | undefined)?.identityReferenceUrl,
      identityReferenceTransportUrl: generatedMetadata?.identityReferenceTransportUrl,
      identityReferenceAnchor: generatedMetadata?.identityReferenceAnchor,
      identityConsistency: generatedMetadata?.identityConsistency,
      sourceMediaProvenance,
      quality: generated?.metadata && typeof generated.metadata === 'object'
        ? (generated.metadata as Record<string, unknown>).quality
        : undefined,
    }
    const biography = await archiveWorkflowCharacterAsset(pool, { id, workflowId, characterName: character.name, uri,
      prompt: designPrompt, metadata, biography: metadata.biography })
    items.push({ id, workflowId, characterName: character.name, assetType: 'three-view', url: uri, prompt: designPrompt, version: 1, metadata, ...(biography !== undefined ? { biography } : {}), cached: false })
  }
  const voiceAssets = []
  if (candidates.length) {
    for (const item of items) {
      if (requiredNamedVoices && !requiredNamedVoices.has(String(item.characterName ?? ''))) continue
      const metadata = item.metadata as Record<string, unknown> | undefined
      const visualContinuityKey = String(metadata?.continuityKey ?? item.id)
      const voiceContinuityKey = stableVoiceContinuityKey({
        name: String(item.characterName ?? ''),
        continuityKey: visualContinuityKey,
        ...(typeof metadata?.voiceContinuityKey === 'string' ? { voiceContinuityKey: metadata.voiceContinuityKey } : {}),
      })
      const candidate = candidates.find(v => v.workflowId === workflowId && v.continuityKey === voiceContinuityKey)
      if (!candidate) throw Error(`VOICE_ARCHIVE_INPUT: 人物 ${item.characterName} 缺少已归档音色`)
      const saved = (await pool.query(`select v.* from original_character_voices v join voice_characters c on c.id=v.character_id where c.workflow_id=$1 and c.continuity_key=$2 and v.voice_id=$3 and v.status='ready'`, [workflowId, candidate.continuityKey, candidate.voiceId])).rows[0]
      if (!saved) throw Error('VOICE_ARCHIVE_INPUT: 音色尚未归档，不能写入人物库关联')
      const originalVoice = { characterId: saved.character_id, voiceId: saved.voice_id, modelId: saved.model_id, version: 1 }
      await pool.query(`update character_assets set metadata=jsonb_set(coalesce(metadata,'{}'::jsonb),'{originalVoice}',$2::jsonb) where id=$1`, [item.id, JSON.stringify(originalVoice)])
      item.metadata = { ...metadata, originalVoice }
      let videoVoice
      if (params.videoModelId) {
        const tts = (await pool.query('select id,provider,capability,settings from model_configs where id=$1', [saved.model_id])).rows[0]
        const video = (await pool.query("select id,provider,capability,settings from model_configs where id=$1 and capability='video'", [params.videoModelId])).rows[0]
        if (!tts || !video) throw Error('VOICE_PROVIDER_UNSUPPORTED: 人物声音映射缺少模型配置')
        const deadline = Date.now() + 180000
        do {
          videoVoice = await ensureOriginalVideoVoice(pool, String(item.id), tts, video)
          if (videoVoice.status === 'ready') break
          await new Promise(resolve => setTimeout(resolve, 5000))
        } while (Date.now() < deadline)
        if (videoVoice.status !== 'ready') throw Error('VOICE_DESIGN_PENDING: 人物声音映射处理中，重试继续查询原任务')
      }
      voiceAssets.push({ ...candidate, characterId: saved.character_id, videoBinding: videoVoice?.binding })
    }
    // Narration has no portrait or Kling on-screen element. Preserve its archived
    // original TTS identity for the independent off-screen audio route.
    for (const candidate of candidates.filter(v => v.continuityKey === '__narrator__')) {
      if (candidate.workflowId !== workflowId || candidate.characterName !== '旁白') throw Error('VOICE_ARCHIVE_INPUT: 旁白音色身份不一致')
      const saved = (await pool.query(`select v.character_id from original_character_voices v join voice_characters c on c.id=v.character_id where c.workflow_id=$1 and c.continuity_key='__narrator__' and v.voice_id=$2 and v.account_scope=$3 and v.status='ready'`, [workflowId, candidate.voiceId, candidate.accountScope])).rows[0]
      if (!saved) throw Error('VOICE_ARCHIVE_INPUT: 旁白音色尚未归档')
      voiceAssets.push({ ...candidate, characterId: saved.character_id, audioRole: 'narration' })
    }
    // Anonymous off-screen dialogue is a voice role, never an invented portrait
    // or a narrator. Preserve its source-scene identity for independent mixing.
    for (const candidate of candidates.filter(v => v.audioRole === 'offscreen-dialogue')) {
      if (candidate.workflowId !== workflowId || !candidate.continuityKey.startsWith('anonymous-voice:') || candidate.characterName === '旁白' || !candidate.actorGroupId) throw Error('VOICE_ARCHIVE_INPUT: 匿名画外角色音色身份不一致')
      const saved = (await pool.query(`select v.character_id from original_character_voices v join voice_characters c on c.id=v.character_id
        where c.workflow_id=$1 and c.continuity_key=$2 and c.character_name=$3 and v.voice_id=$4 and v.account_scope=$5 and v.status='ready'`,
      [workflowId, candidate.continuityKey, candidate.characterName, candidate.voiceId, candidate.accountScope])).rows[0]
      if (!saved) throw Error('VOICE_ARCHIVE_INPUT: 匿名画外角色音色尚未归档')
      voiceAssets.push({ ...candidate, characterId: saved.character_id })
    }
  }
  return {
    items,
    ...(params.voiceAssets !== undefined ? { voiceAssets } : {}),
    urls: items.map((item) => item.url),
    byCharacter: Object.fromEntries(items.map((item) => [String(item.characterName), item])),
    archivedCount: items.length,
    count: items.length,
  }
}

async function generateFrameImage(request: BuiltinNodeRequest, prompt: string, params: Record<string, unknown>, executeMediaModel?: MediaExecutor) {
  let body: unknown
  if (request.model?.provider === 'Local' || !executeMediaModel || !request.model) {
    body = runLocalModel({ capability: 'image', prompt, params })
  } else {
    const response = await executeMediaModel({ model: request.model, prompt, params, executionContext: request.executionContext })
    if (response.status >= 400) throw new Error(`帧图生成失败：${JSON.stringify(response.body)}`)
    body = response.body
  }
  const url = firstUrl(body)
  if (!url) throw new Error('帧图生成未返回可用 URL')
  return { url, body }
}

export function resolveFirstFramePrompt(request: Pick<BuiltinNodeRequest, 'prompt' | 'params'>) {
  const params = request.params ?? {}
  return String(request.prompt ?? '').trim() || String(params.firstFramePrompt ?? params.prompt ?? '').trim()
}

async function resolveFirstFrame(request: BuiltinNodeRequest, executeMediaModel?: MediaExecutor) {
  const params = request.params ?? {}
  const requestedMode = String(params.mode ?? 'generate')
  const previousLastFrame = firstUrl(params.previousLastFrame)
  if (requestedMode === 'reuse_previous_tail' && previousLastFrame) {
    return {
      url: previousLastFrame,
      requestedMode,
      resolvedMode: 'reuse_previous_tail',
      generated: false,
      source: 'previous-shot-tail',
    }
  }
  const prompt = resolveFirstFramePrompt(request)
  if (!prompt) throw new Error('首帧生成缺少 firstFramePrompt')
  const generated = await generateFrameImage(request, prompt, params, executeMediaModel)
  return {
    url: generated.url,
    requestedMode,
    resolvedMode: 'generate',
    generated: true,
    source: 'image-model',
    fallbackReason: requestedMode === 'reuse_previous_tail' ? '前一镜没有可用尾帧，已回退为生成新首帧' : undefined,
  }
}

async function resolveTailFrame(request: BuiltinNodeRequest, executeMediaModel?: MediaExecutor) {
  const params = request.params ?? {}
  const videoLastFrame = firstUrl(params.videoLastFrame)
  if (videoLastFrame) {
    return { url: videoLastFrame, generated: false, source: 'video-output-tail' }
  }
  const prompt = String(request.prompt ?? params.prompt ?? '')
  if (!prompt.trim()) throw new Error('视频未返回尾帧，且节点缺少 lastFramePrompt，无法建立下一镜衔接锚点')
  const generated = await generateFrameImage(request, prompt, params, executeMediaModel)
  return { url: generated.url, generated: true, source: 'image-model-fallback' }
}

async function buildTimeline(params: Record<string, unknown>, pool: Pool) {
  const storyboards = toArray(params.storyboards ?? params.shots)
  const videos = toArray(params.videos ?? params.videoClips)
  const audios = toArray(params.audios ?? params.audioClips)
  const voiceReviews = new Map<number, unknown>()
  for (const [index, video] of videos.entries()) {
    const target = voiceReviewTarget(video)
    if (target) {
      const review = await readVoiceListeningReview(pool, target)
      voiceReviews.set(index, resolveVoiceGateDecision(target, review))
    }
  }
  const cinematic = storyboards.some(shot => isCinematicShot(shot as Record<string, unknown>))
  const verification = params.historicalVerification as Record<string, unknown> | undefined
  const policyAccepted = verification?.qualityPolicy === 'principle-v1' ? principleQualityCanProceed(verification)
    : (verification?.reviewSummary as Record<string, unknown>)?.segmentMedia === 'passed'
  if (cinematic && (verification?.passed !== true || verification.contentContractVersion !== 'cinematic-v1' || !policyAccepted)) throw new Error('HISTORY_PUBLICATION_REJECTED: 新契约整集缺少已通过的史实、叙事与实际媒体检查')
  if (verification?.qualityPolicy === 'principle-v1') {
    if (videos.length !== storyboards.length) throw new Error('HISTORY_PUBLICATION_REJECTED: 合成素材数量与已审分镜不符')
    videos.forEach((value, index) => {
      const video = value as Record<string, unknown>
      if (video?.qualityPolicy === 'principle-v1') {
        const issue = principleMediaEvidenceIssue(video, storyboards[index] as Record<string, unknown>)
        if (issue) throw new Error(`HISTORY_PUBLICATION_REJECTED: ${issue}`)
      } else if (!video?.url || video.decoded !== true) throw new Error('HISTORY_PUBLICATION_REJECTED: 合成缺少实际解码视频')
    })
  }
  const clips = storyboards.map((storyboard, index) => {
    const shot = storyboard && typeof storyboard === 'object' ? storyboard as Record<string, unknown> : {}
    const video = videos[index] && typeof videos[index] === 'object' ? videos[index] as Record<string, unknown> : {}
    const audio = audios[index] && typeof audios[index] === 'object' ? audios[index] as Record<string, unknown> : {}
    const audioUrl = String(audio.url ?? '')
    const hasEmbeddedAudio = video.audioEmbedded === true || video.sound === 'on'
    return {
      index: index + 1,
      shotId: shot.id ?? `shot-${index + 1}`,
      title: shot.title ?? `镜头 ${index + 1}`,
      duration: Number(cinematic ? video.duration : shot.duration ?? video.duration ?? 5),
      videoUrl: video.url ?? '',
      audioUrl,
      audioSource: audioUrl ? 'external' : hasEmbeddedAudio ? 'video-native' : 'unspecified',
      ...(voiceReviews.has(index) ? { voiceConsistency: voiceReviews.get(index) } : {}),
      transcript: shot.audioText ?? audio.transcript ?? '',
      ...(cinematic ? { audioMode: video.audioMode, transcriptSource: 'planned-script', actualTranscript: video.transcript ?? [], contentContractVersion: shot.contentContractVersion } : {}),
    }
  })
  return {
    status: 'ready',
    format: String(params.format ?? 'mp4'),
    aspectRatio: String(params.aspectRatio ?? '9:16'),
    resolution: String(params.resolution ?? '1080x1920'),
    clips,
    clipCount: clips.length,
    ...(cinematic ? { contentContractVersion: 'cinematic-v1', reviewSummary: verification?.reviewSummary,
      ...(verification?.qualityPolicy === 'principle-v1' ? { qualityPolicy: verification.qualityPolicy, qualityReview: verification.qualityReview, ...(isManualReview(verification) ? { qualityDisposition: 'manual-review-v1', manualReviewRequired: true } : {}) } : {}),
      episodePlayback: { status: 'not-reviewed', fullVideoWatched: false } } : {}),
    totalDuration: clips.reduce((total, clip) => total + clip.duration, 0),
    note: '已生成可交给媒体渲染器的时间线清单；远程视频任务完成后可用同一清单替换 URL 并合成。',
  }
}

async function concatenateAcceptedVideos(params: Record<string, unknown>, pool: Pool, workflowId?: string) {
  assertConcatSubtitleEvidence(params)
  assertConcatSpeechEvidence(params)
  const current = params.currentVideo && typeof params.currentVideo === 'object' && !Array.isArray(params.currentVideo)
    ? params.currentVideo as Record<string, unknown> : {}
  const acceptance = requireConcatCurrentAcceptance(current, workflowId, params.reviewDecision)
  if (current.humanVocalAcceptance !== undefined) await assertStoryVocalHumanAssets(current)
  const target = voiceReviewTarget(current)
  let voiceConsistency
  if (target) {
    const review = await readVoiceListeningReview(pool, target)
    voiceConsistency = resolveVoiceGateDecision(target, review)
  }
  const output = await concatenateVideos(params)
  assertConcatCurrentBytes(acceptance.sourceSha256, output.sourceSha256)
  return { ...output, ...aggregateConcatReviews({ ...params, currentVideo: { ...current,
    ...(acceptance.riskReminder ? { riskReminder: acceptance.riskReminder } : {}),
    ...(voiceConsistency ? { voiceConsistency } : {}) } }, output.clips) }
}

function verifyHistoricalBoundaries(params: Record<string, unknown>) {
  const citations = toArray(params.citations)
  const shots = toArray(params.shots ?? params.storyboards)
  const manual = isManualReview(params)
  const violations: Array<{ shot: number; message: string }> = []
  const technicalViolations: typeof violations = []
  const technicalIssue = (shot: number, message: string) => { const issue = { shot, message }; violations.push(issue); technicalViolations.push(issue) }
  let totalDuration = 0
  const videos = toArray(params.videos)
  const versions = [...new Set(shots.map(shot => String((shot as Record<string, unknown>)?.contentContractVersion ?? 'legacy')))]
  const cinematic = versions.includes('cinematic-v1')
  if (versions.some(version => !['cinematic-v1', 'legacy'].includes(version)) || (cinematic && versions.length !== 1)) technicalIssue(0, '不能混用旧内容或未知内容契约与 cinematic-v1')
  let dramaturgyPassed = cinematic
  const expandedOutline = (params.sceneOutline ?? params.outline) as Record<string, unknown> | undefined
  const outline = (params.approvedSceneOutline ?? expandedOutline) as Record<string, unknown> | undefined
  const principleItems = [outline, ...shots, ...videos].filter(item => (item as Record<string, unknown>)?.qualityPolicy === 'principle-v1') as Record<string, unknown>[]
  if (cinematic) {
    try { validateDramaOutline(outline, { requireDramaContract: true }); validateExpandedDramaOutline(expandedOutline, outline, shots) } catch (error) { violations.push({ shot: 0, message: error instanceof Error ? error.message : String(error) }) }
    if (outline?.qualityPolicy === 'principle-v1') {
      if (outline.contentContractVersion !== 'cinematic-v1' || !principleQualityCanProceed(outline)) violations.push({ shot: 0, message: '大纲原则审查未允许继续' })
      dramaturgyPassed = false
    } else {
      if (outline?.contentContractVersion !== 'cinematic-v1' || (outline.factualReview as Record<string, unknown>)?.passed !== true) violations.push({ shot: 0, message: '缺少同一新内容契约的大纲史实审查' })
      try { if (!outline || validateDramaturgyReview(outline, outline.dramaturgyReview).passed !== true) throw new Error('大纲叙事未通过') } catch (error) { dramaturgyPassed = false; violations.push({ shot: 0, message: error instanceof Error ? error.message : String(error) }) }
    }
  }
  shots.forEach((shot, index) => {
    const record = shot && typeof shot === 'object' ? shot as Record<string, unknown> : {}
    const historicalBasis = String(record.historicalBasis ?? '')
    const citationIndexes = [...historicalBasis.matchAll(/\[史料(\d+)\]/g)].map((match) => Number(match[1]))
    if (!citationIndexes.length) violations.push({ shot: index + 1, message: 'historicalBasis 缺少 [史料N] 引用' })
    if (citationIndexes.some((citationIndex) => citationIndex < 1 || citationIndex > citations.length)) violations.push({ shot: index + 1, message: 'historicalBasis 引用了不存在的史料编号' })
    if (!record.adaptationBoundary) violations.push({ shot: index + 1, message: '缺少 adaptationBoundary' })
    const duration = Number(record.duration)
    if (!Number.isInteger(duration) || duration < 3 || duration > 15) technicalIssue(index + 1, 'duration 必须为动态预估的 3–15 秒整数')
    if (!Array.isArray(record.characters)) technicalIssue(index + 1, 'characters 必须是数组')
    if (params.requireQualityEvidence === true) {
      const pacingVersion = (record.pacing as Record<string, unknown>)?.version
      if (pacingVersion === DURATION_PACING_VERSION) {
        try { verifyDurationSchedule(record, { qualityDisposition: params.qualityDisposition }) } catch (error) { technicalIssue(index + 1, error instanceof Error ? error.message : String(error)) }
      } else if (pacingVersion !== HISTORY_PACING_VERSION) technicalIssue(index + 1, '旧固定15秒分镜未通过新的动态节奏验收')
      const scriptCheck = record.scriptValidation as Record<string, unknown> | undefined
      const contentCheck = (isCinematicShot(record) ? record.factualReview : record.contentReview) as Record<string, unknown> | undefined
      const video = toArray(params.videos)[index] as Record<string, unknown> | undefined
      const principleVideo = video?.qualityPolicy === 'principle-v1'
      const principleScript = record.qualityPolicy === 'principle-v1'
      const progress = record.storyProgress as Record<string, unknown> | undefined
      const previousShot = shots[index - 1] as Record<string, unknown> | undefined
      const previousVideo = videos[index - 1] as Record<string, unknown> | undefined
      const previousProgress = previousShot?.storyProgress as Record<string, unknown> | undefined
      const continuous = record.firstFrameMode === 'reuse_previous_tail' || (record.continuity as Record<string, unknown>)?.mode === 'coverage_cut'
      const narrativeIssue = previousVideo?.qualityPolicy === 'principle-v1'
        ? (!previousProgress || (previousProgress.status === 'continuing' && (progress?.unitId !== previousProgress.unitId || !continuous)) ? '前镜剧情尚未结束，必须继续原剧情单元，禁止换场' : undefined)
        : narrativeTransitionIssue({ dramaticUnitId: progress?.unitId, continuityFromPrevious: continuous }, previousShot, previousVideo)
      if (narrativeIssue) violations.push({ shot: index + 1, message: narrativeIssue })
      const technical = video?.technicalValidation as Record<string, unknown> | undefined
      const visual = video?.visualReview as Record<string, unknown> | undefined
      if (!principleVideo) {
        try { validateHistoricalMediaReview(visual ?? {}, record) } catch (error) { violations.push({shot:index+1,message:error instanceof Error ? error.message : String(error)}) }
      }
      if (index === shots.length - 1 && progress?.status !== 'complete') violations.push({shot:index+1,message:'整集结束时仍有未完成的剧情单元'})
      if (principleScript ? !principleQualityCanProceed(record) : scriptCheck?.passed !== true || contentCheck?.passed !== true) violations.push({ shot: index + 1, message: '缺少分镜与史料内容审查证据，或原则审查未允许继续' })
      if (!video?.url || video.decoded !== true || !Number.isFinite(video.duration) || Number(video.duration) <= 0) technicalIssue(index + 1, '缺少可解码成片或有效时长')
      const ambient = isCinematicShot(record) && record.audioType === '环境声' && record.audioText === ''
      const audioAccepted = ambient ? video?.audioMode === 'ambient' && video.hasAudio === true && technical?.speechVerified === false && !video.speechValidation : technical?.speechVerified === true
      if (principleVideo) {
        const mediaIssue = principleMediaEvidenceIssue(video, record)
        if (mediaIssue) technicalIssue(index + 1, mediaIssue)
      } else if (!video?.url || technical?.passed !== true || !audioAccepted || visual?.passed !== true) violations.push({ shot: index + 1, message: '缺少可解码成片、实际音轨或画面审查证据；环境声不能伪造ASR' })
      if (isCinematicShot(record)) {
        if (principleScript) dramaturgyPassed = false
        else { try { if (validateDramaturgyReview(record, record.dramaturgyReview).passed !== true) throw new Error('分镜叙事未通过') } catch (error) { dramaturgyPassed = false; violations.push({ shot: index + 1, message: error instanceof Error ? error.message : String(error) }) } }
        if (video?.decoded !== true || !video.evidenceUrl || video.hasAudio !== true || !Array.isArray(video.frames) || !video.frames.length || !Number.isFinite(video.duration) || Number(video.duration) <= 0) violations.push({ shot: index + 1, message: '新契约缺少实际解码、抽帧、音轨和时长采证' })
        if (!principleVideo && Number.isFinite(video?.duration) && Math.abs(Number(video?.duration) - duration) > 0.5) violations.push({ shot: index + 1, message: '实际媒体时长与批准分镜不一致' })
      }
      const crossingIssue = principleVideo ? undefined : historicalCrossingIssue(record, video)
      if (crossingIssue) violations.push({ shot: index + 1, message: crossingIssue })
      const continuityIssue = historicalContinuityIssue(record, video, shots[index - 1], toArray(params.videos)[index - 1] as Record<string, unknown> | undefined)
      if (continuityIssue) violations.push({ shot: index + 1, message: continuityIssue })
    }
    const measuredDuration = cinematic ? Number((videos[index] as Record<string, unknown>)?.duration) : duration
    totalDuration += Number.isFinite(measuredDuration) ? measuredDuration : 0
  })
  if (!shots.length) technicalIssue(0, '场景短分镜不能为空')
  if (params.requireQualityEvidence === true && videos.length !== shots.length) technicalIssue(0, '实际视频数量与分镜数量不符')
  if (!citations.length) violations.unshift({ shot: 0, message: '没有挂载任何史料引用' })
  const expectedSceneCount = Number(params.expectedSceneCount ?? params.sceneCount)
  if (Number.isFinite(expectedSceneCount) && shots.length !== expectedSceneCount) violations.push({ shot: 0, message: `短分镜数量应为剧情规划的 ${expectedSceneCount} 个，实际为 ${shots.length} 个` })
  const expectedTotalDuration = Number(params.expectedTotalDuration ?? params.targetDuration)
  const policyReviews = principleItems.map(item => item.qualityReview as Record<string, unknown>)
  const blockingViolations = manual ? technicalViolations : violations
  const policyStatus = blockingViolations.length ? 'rejected' : policyReviews.some(review => review?.status === 'unavailable') ? 'unavailable'
    : (manual && violations.length) || policyReviews.some(review => review?.status === 'needs_attention') ? 'needs_attention' : 'passed'
  // expectedTotalDuration is an outline estimate; the composition sums validated shot durations.
  return {
    passed: blockingViolations.length === 0,
    ...(manual ? { qualityDisposition: 'manual-review-v1', manualReviewRequired: true, blockingViolations, qualityWarnings: violations } : {}),
    contentContractVersion: versions.length === 1 ? versions[0] : 'mixed',
    ...(principleItems.length || manual ? { qualityPolicy: 'principle-v1', qualityReview: { status: policyStatus,
      canProceed: params.requireQualityEvidence === true && blockingViolations.length === 0, principleIssues: violations,
      ...(manual ? { manualReviewRequired: true, blockingIssues: blockingViolations } : {}),
      warnings: policyReviews.flatMap(review => Array.isArray(review?.warnings) ? review.warnings : []), rawReport: policyReviews } } : {}),
    reviewSummary: {
      scriptFacts: (!cinematic || (outline?.factualReview as Record<string, unknown>)?.passed === true) && shots.every(shot => ((isCinematicShot(shot as Record<string, unknown>) ? (shot as Record<string, unknown>).factualReview : (shot as Record<string, unknown>).contentReview) as Record<string, unknown>)?.passed === true) ? 'passed' : 'not-reviewed',
      scriptDramaturgy: cinematic && dramaturgyPassed && params.requireQualityEvidence === true && shots.every(shot => ((shot as Record<string, unknown>).dramaturgyReview as Record<string, unknown>)?.passed === true) ? 'passed' : 'not-reviewed',
      segmentMedia: params.requireQualityEvidence === true ? principleItems.length || manual ? policyStatus : violations.length ? 'failed' : 'passed' : 'not-reviewed',
      ...(principleItems.length || manual ? { reviewScope: manual ? 'manual-review' : 'principle-policy', detailedQuality: 'not-certified' } : {}),
      episodePlayback: 'not-reviewed', fullVideoWatched: false,
    },
    citationCount: citations.length,
    shotCount: shots.length,
    totalDuration,
    expectedSceneCount: Number.isFinite(expectedSceneCount) ? expectedSceneCount : undefined,
    expectedTotalDuration: Number.isFinite(expectedTotalDuration) ? expectedTotalDuration : undefined,
    durationDelta: Number.isFinite(expectedTotalDuration) ? totalDuration - expectedTotalDuration : undefined,
    violations,
    policy: String(params.policy ?? '史事节点需有来源；对白、微动作和场面调度作为合理拟制。'),
  }
}

async function characterObserver(pool: Pool, execute: MediaExecutor, request: BuiltinNodeRequest) {
  const usable = (model: BuiltinNodeRequest['model'] | undefined) => Boolean(model?.id && model.capability === 'text' && model.provider && model.provider !== 'Local')
  let model: BuiltinNodeRequest['model']
  if (request.model?.capability === 'text') {
    if (!usable(request.model)) throw new Error('CHARACTER_OBSERVER_MODEL_INVALID: 显式人物外观核验模型必须是实际文本视觉服务，不能使用Local模拟器')
    model = request.model
  } else {
    const params = request.params ?? {}
    let modelId = typeof params.appearanceReviewModelId === 'string' ? params.appearanceReviewModelId.trim() : ''
    if (params.appearanceReviewModelId !== undefined && !modelId) throw new Error('CHARACTER_OBSERVER_MODEL_INVALID: appearanceReviewModelId必须为有效模型标识')
    if (!modelId) {
      const workflowId = String(params.workflowId ?? request.executionContext?.workflowId ?? '').trim()
      if (workflowId) {
        const workflow = (await pool.query('select nodes from workflow_configs where id=$1', [workflowId])).rows[0]
        const nodes = toArray(workflow?.nodes).filter((node): node is Record<string, unknown> => Boolean(node && typeof node === 'object' && !Array.isArray(node)))
        const bound = nodes.filter(node => {
          const metadata = node.metadata as Record<string, unknown> | undefined
          return metadata?.reviewRole === 'character-appearance' || node.operation === 'character.appearance-review'
        })
        const candidates = bound.length ? bound : nodes.filter(node => node.id === 'sanguo-character-review')
        const ids = [...new Set(candidates.map(node => typeof node.modelId === 'string' ? node.modelId.trim() : '').filter(Boolean))]
        if (candidates.length && ids.length !== 1) throw new Error('CHARACTER_OBSERVER_MODEL_INVALID: 工作流人物视觉审核节点缺少唯一模型绑定')
        modelId = ids[0] ?? ''
      }
    }
    // Legacy workflows without a configured reviewer retain their old model.
    // An unavailable configured model is an actionable gap, never a reason to
    // send the same image to an unrelated provider automatically.
    modelId ||= 'claude-opus-4-8'
    model = (await pool.query("select * from model_configs where id=$1 and capability='text' and provider <> 'Local'", [modelId])).rows[0] as BuiltinNodeRequest['model']
    if (!usable(model)) throw new Error(`CHARACTER_OBSERVER_MODEL_INVALID: 人物外观核验模型未配置或不是实际文本服务：${modelId}`)
  }
  const observerModel = model as NonNullable<BuiltinNodeRequest['model']>
  return async (prompt: string, frames: string[]) => {
    const response = await execute({ model: observerModel, prompt, params: { reviewImages: frames }, operation: 'history.media-review', executionContext: request.executionContext })
    if (response.status >= 400) throw new Error(`HTTP ${response.status}: ${JSON.stringify(response.body)}`)
    return response.body
  }
}

export async function executeBuiltinNode(pool: Pool, request: BuiltinNodeRequest, executeMediaModel?: MediaExecutor, dependencies: BuiltinDependencies = {}) {
  const params = request.params ?? {}
  if (request.operation === 'story.script-review') return storyScriptReview(request, executeMediaModel)
  if (request.operation === 'story.media-review') return storyMediaReview(request, executeMediaModel, dependencies.reviewStoryVideo)
  if (request.operation === 'story.subtitle-reference') {
    if (!executeMediaModel) throw Error('STORY_SUBTITLE_MODEL_REQUIRED: 缺少推理模型执行器')
    return generateStorySubtitleReference(request, executeMediaModel)
  }
  if (request.operation === 'internet.retrieve' || request.operation === 'historical.web.retrieve') {
    return retrieveInternetSourcesWithExecutionCache(pool, {
      query: String(params.query ?? request.prompt ?? ''),
      sourceDetail: String(params.sourceDetail ?? ''),
      sourceNames: toArray(params.sourceNames).map(String),
      urls: toArray(params.urls).map(String),
      maxSources: Number(params.maxSources ?? 3),
      maxPassages: Number(params.maxPassages ?? 6),
    }, request.executionContext)
  }
  if (request.operation === 'character.lookup') return lookupCharacterAssets(pool, request)
  if (request.operation === 'character.voice-archive') return archiveVoiceCandidates(pool, String(params.workflowId ?? request.executionContext?.workflowId ?? ''), toArray(params.candidates) as VoiceCandidate[])
  if (request.operation === 'character.appearance') {
    if (!executeMediaModel) throw new Error('人物外观核验缺少实际视觉模型')
    const supplied = params.assets === undefined ? undefined : toArray(params.assets).filter((asset): asset is Record<string, unknown> => Boolean(asset && typeof asset === 'object' && !Array.isArray(asset)))
    const lookup = supplied ? { items: supplied } : await lookupCharacterAssets(pool, request)
    if (params.readOnly === true) return lookup
    const generate = await characterObserver(pool, executeMediaModel, request)
    const items = []
    const requested = toArray(params.characters ?? params.names).map(characterIdentity)
    for (const asset of lookup.items) {
      if (!asset) continue
      const characterName = String(asset.characterName ?? asset.name ?? '')
      if (!characterName) throw Error('CHARACTER_IDENTITY_REFERENCE_INVALID: 外观核对候选必须保留具名人物身份')
      if (typeof asset.workflowId === 'string' && typeof params.workflowId === 'string' && asset.workflowId !== params.workflowId) throw Error('CHARACTER_IDENTITY_REFERENCE_INVALID: 外观核对候选属于其他工作流')
      const character = requested.find(person => person.name === characterName)
      const visualContext = character?.visualContext ?? characterVisualContextFrom(asset)
      if (character?.visualContext && characterVisualContextFrom(asset)) {
        const compatibility = characterVisualContextCompatibility(character.visualContext, asset)
        if (!compatibility.matches) throw Error(compatibility.reason)
      }
      const expectedDesign = [typeof params.expectedDesign === 'string' ? params.expectedDesign : character?.description || character?.designPrompt, characterVisualContextDesignText(visualContext)].filter(Boolean).join('\n') || undefined
      const profile = await observeCharacterAsset({ ...asset, ...(visualContext ? { visualContext } : {}) }, generate, { expectedDesign })
      if (asset.id) await pool.query(`update character_assets set metadata=jsonb_set(coalesce(metadata,'{}'::jsonb),'{visualProfile}',$2::jsonb) where id=$1 and uri=$3 and character_name=$4`, [asset.id, JSON.stringify(profile), asset.url, characterName])
      const metadata = asset.metadata as Record<string, unknown> | undefined
      const contextSignature = visualContext ? createHash('sha256').update(characterVisualContextSignature(visualContext)).digest('hex') : undefined
      const generatedContext = visualContext && metadata?.visualContextSource === 'generation-request-v1'
        && metadata.visualContextRequestSignature === contextSignature
        && metadata.visualContextImageFingerprint === createHash('sha256').update(firstUrl(asset)).digest('hex')
      items.push({ ...asset, metadata: { ...asset.metadata as object, visualProfile: profile,
        ...(visualContext ? { visualContext, visualContextSource: generatedContext ? 'generation-request-v1' : 'actual-reference-review-v1', visualContextRequestSignature: contextSignature } : {}) } })
    }
    return { ...lookup, items }
  }
  if (request.operation === 'character.historical-portrait') {
    const allCharacters = toArray(params.allCharacters ?? params.characters ?? params.names).map(characterIdentity).filter((item) => item.name)
    const missingCharacters = toArray(params.characters ?? params.names).map(characterIdentity).filter((item) => item.name)
    const missingNames = new Set(missingCharacters.map(item => item.name))
    const workflowId = String(params.workflowId ?? request.executionContext?.workflowId ?? '').trim()
    const profiles = workflowId && allCharacters.length ? await pool.query(
      `select character_name,biography from character_biographies where workflow_id=$1 and character_name=any($2::text[])`,
      [workflowId, allCharacters.map(item => item.name)],
    ) : { rows: [] as Array<{ character_name: string; biography: string }> }
    const savedBiography = new Map(profiles.rows.map(row => [row.character_name, row.biography]))
    const candidates = allCharacters.filter(item => missingNames.has(item.name)
      || biographyNeedsEvidenceCompletion(savedBiography.get(item.name)))
      .map(item => ({ ...item, biography: savedBiography.has(item.name) ? undefined : item.biography }))
    const provided = params.historicalSources && typeof params.historicalSources === 'object'
      ? params.historicalSources as InternetSourceResult : undefined
    const knownSources = provided && Array.isArray(provided.citations) ? [provided] : []
    const portraitResult = await enrichCharactersWithHistoricalPortraits(candidates, retrieveInternetSources, {
      maxSources: Number(params.maxSources ?? 2),
      maxPassages: Number(params.maxPassages ?? 4),
    }, { knownSources, sourceDetail: String(params.sourceDetail ?? provided?.request?.sourceDetail ?? '') })
    const enrichedByName = new Map(portraitResult.characters.map((item) => [item.name, item]))
    const biographyUpdates: Array<{ name: string; status: string }> = []
    if (workflowId && params.readOnly !== true) for (const item of portraitResult.characters) {
      const sourced = item.biography
      if (typeof sourced !== 'string' || !sourced.includes('来源：') || !savedBiography.has(item.name) && missingNames.has(item.name)) continue
      const before = savedBiography.get(item.name)
      const merged = mergeCharacterBiographyEvidence(before, sourced)
      if (!merged) continue
      const result = before === undefined
        ? await pool.query(`insert into character_biographies(workflow_id,character_name,biography)
            values($1,$2,$3) on conflict(workflow_id,character_name) do nothing returning character_name`, [workflowId, item.name, merged])
        : await pool.query(`update character_biographies set biography=$3,updated_at=now()
            where workflow_id=$1 and character_name=$2 and biography=$4 returning character_name`, [workflowId, item.name, merged, before])
      biographyUpdates.push({ name: item.name, status: result.rowCount ? 'updated' : 'concurrent_edit_preserved' })
    }
    return {
      ...portraitResult,
      characters: missingCharacters.map(item => enrichedByName.get(item.name) ?? item),
      allCharacters: allCharacters.map((item) => enrichedByName.get(item.name) ?? item),
      biographyUpdates,
    }
  }
  if (request.operation === 'character.ensure') return ensureCharacterAssets(pool, request, executeMediaModel, dependencies)
  if (request.operation === 'character.archive') return archiveCharacterAssets(pool, request)
  if (request.operation === 'frame.first.resolve') return resolveFirstFrame(request, executeMediaModel)
  if (request.operation === 'frame.tail.resolve') return resolveTailFrame(request, executeMediaModel)
  if (request.operation === 'history.verify') return verifyHistoricalBoundaries(params)
  if (request.operation === 'video.concat') return concatenateAcceptedVideos(params, pool, request.executionContext?.workflowId)
  if (request.operation === 'timeline.compose') return buildTimeline(params, pool)
  throw new Error(`不支持的内置节点操作：${request.operation}`)
}
