import { DEFAULT_DURATION_POLICY } from './duration-policy.ts'
import { DURATION_STORYBOARD_PROMPT, DURATION_VIDEO_ENDING, DURATION_REFERENCE_REVIEW, DURATION_SCRIPT_REVIEW, refreshDurationMediaReviewPrompt } from './duration-prompts.ts'
import { SANGUO_CINEMATIC_STORYBOARD_PROMPT, SANGUO_STORYBOARD_PROMPT_BEFORE_TRUSTED_TAIL_STATE } from './storyboard-prompt.ts'
import { deriveDurationMetrics } from './duration-observability.ts'
import { assessDurationCompletion } from './duration-completion.ts'
import { MAX_NODE_ATTEMPTS } from './retry-budget.ts'

type Value = Record<string, unknown>
type Param = { id: string; name: string; englishName?: string; type: string; value: string; required: boolean }
type Node = { id: string; title: string; kind: string; prompt: string; params: Param[]; code?: string; resultVar: string;
  childIds?: string[]; parentId?: string; position: { x: number; y: number } }
type Edge = { id: string; from: string; to: string; branch?: 'true' | 'false' }
type Fragments = { requirements: string; reviewInputs: string; reviewView: string; uncertainty: string; defects: string; completionPrompt: string;
  refreshDramaturgyGate: (code: string) => string; refreshDramaturgyPrompt: (prompt: string) => string }

export function durationMediaRequest(context: Value, params: Value) {
  const shot = context.shot_script as Value, pacing = shot.pacing as Value
  const video = context.video_take as Value
  if (pacing.version !== 'duration-v2' || typeof pacing.scheduleHash !== 'string' || !Array.isArray(pacing.speechWindows)
    || !Array.isArray(pacing.sampleTimes)) throw Error('DURATION_CONTRACT_INVALID: 缺少已编译排程；从分镜节点重新规划')
  const maxFrames = Number(params.maxSamplingFrames ?? 24)
  const sampleTimes = pacing.sampleTimes as number[]
  if (sampleTimes.length > maxFrames || maxFrames > 24) throw Error('DURATION_SAMPLING_LIMIT: 原始节拍采样超过配置预算，不能删减要求')
  let samplingPlan: Value = { duration: shot.duration, maxFrames, sampleTimes: [...sampleTimes] }
  const retry = context.mediaSamplingRetry as Value | undefined
  if (retry && retry.sourceUrl === video.url) {
    if (!Number.isSafeInteger(retry.round) || Number(retry.round) < 1 || !Array.isArray(retry.sampleTimes)
      || retry.sampleTimes.length > maxFrames || retry.sampleTimes[0] !== 0
      || retry.sampleTimes.some((t, i, all) => !Number.isFinite(t) || Number(t) < 0 || Number(t) > Number(shot.duration) + .5 || i > 0 && Number(t) <= Number(all[i - 1]))) {
      throw Error('DURATION_SAMPLING_RETRY_INVALID: 同素材补采计划无效')
    }
    samplingPlan = { ...samplingPlan, sampleTimes: [...retry.sampleTimes], sourceUrl: retry.sourceUrl, adaptiveRound: retry.round, nativeSequence: retry.nativeSequence }
  }
  const policy = pacing.timingPolicy as Value
  const reserve = Number(policy.endingReadabilityReserve ?? policy.endingReadabilitySeconds ?? .4)
  return { pacingVersion: 'duration-v2', scheduleHash: pacing.scheduleHash,
    audioText: shot.audioText, audioType: shot.audioType, speechRequired: pacing.speechWindows.length > 0,
    speechWindows: pacing.speechWindows, latestSpeechEnd: Number(shot.duration) - reserve,
    sampleTimes: samplingPlan.sampleTimes, samplingPlan, nativeSequence: samplingPlan.nativeSequence,
    previousTail: (shot.continuity as Value)?.mode === 'tail_continuation' ? (context.first_frame as Value)?.url : '',
    vocalizationRequirements: ((pacing.beats ?? []) as Value[]).filter(beat => beat.kind === 'vocalization'),
  }
}

/** Preserve every existing sample and decode the unresolved actual action range. */
export function durationCompletionRecovery(context: Value, completion: Value, params: Value) {
  const evidence = context.video_evidence as Value, video = context.video_take as Value
  const reasons = completion.reasons as unknown[] | undefined
  const base = { durationCompletion: completion, passed: false, issues: [], retryPrompt: (reasons ?? []).join('；') }
  if (completion.route === 'replan') return { ...base, routeError: 'DURATION_REPLAN_REQUIRED: ' + JSON.stringify({ remainingMandatoryBeats: completion.remainingMandatoryBeats,
    minimumAdditionalSeconds: completion.minimumAdditionalSeconds, reasons }),
    durationRepair: { previousCandidate: context.shot_script, durationCompletion: completion, sourceVideo: evidence.url,
      issues: ['保留原台词与剧情节拍，根据实际时间缺口重新安排时长、声部与依赖，禁止复用原失败排程'] } }
  const requests = (completion.evidenceRequests ?? []) as Value[]
  const audio = requests.some(request => request.kind === 'audio-review')
  if (audio && (evidence.nativeSequence || !requests.some(request => request.kind === 'native-sequence' || request.modality === 'audio-visual'))) return { ...base, routeError: 'DURATION_AUDIO_REVIEW_REQUIRED: 本镜声音完成证据不足；复核同一视频的句尾或无词声部，不能重复购买视频',
    audioReviewRequest: { sourceUrl: evidence.url, evidenceRef: evidence.evidenceUrl, requests } }
  const previous = context.mediaSamplingRetry as Value | undefined
  if (requests.length && requests.every(request => request.kind === 'report-review')) return { ...base,
    routeError: 'REVIEW_RESULT_INVALID: duration-v2 完成报告需要绑定现有声画证据：' + (reasons ?? []).join('；') }
  const round = previous && previous.sourceUrl === video.url ? Number(previous.round) + 1 : 1
  // This function is serialized into code nodes and must remain self-contained.
  if (round > Number(params.maxAdaptiveSamplingRounds ?? 5) || evidence.nativeSequence) return { ...base,
    routeError: 'DURATION_EVIDENCE_EXHAUSTED: 已完成有界同素材采证，剩余动作完成状态仍不确定；保留素材并人工复核' }
  const duration = Number(evidence.duration)
  const times = evidence.frameTimes as number[]
  if (!Array.isArray(times) || times.length > 24 || !Number.isFinite(duration)) return { ...base, routeError: 'DURATION_EVIDENCE_INVALID: 缺少同素材有效时间范围' }
  const windows = requests.map(request => {
    const start = Number(request.startSecond ?? request.start ?? 0)
    const end = Number(request.endSecond ?? request.end ?? duration)
    return { start: Math.max(0, Math.min(start, duration)), end: Math.max(0, Math.min(end, duration)) }
  }).filter(window => window.end > window.start)
  if (!windows.length) windows.push({ start: Math.max(0, duration - 3), end: duration })
  return { ...base, routeError: 'REVIEW_RESULT_INVALID: duration-v2 必需动作缺少实际完成证据，按samplingRetryPlan复核同一素材',
    samplingRetryPlan: { sourceUrl: video.url, round, sampleTimes: [...times], requirementIds: completion.remainingMandatoryBeats,
      nativeSequence: { enabled: true, windows, reviewMaxFrames: Math.max(256, Number(params.maxNativeReviewFrames ?? 256)) } } }
}

const param = (name: string, value: string, type = 'json', required = true): Param => ({ id: 'duration-v2-' + name, name, englishName: name, type, value, required })
function addParams<N extends Node>(node: N, params: Param[]): N {
  return { ...node, params: [...node.params.filter(p => !params.some(next => next.englishName === (p.englishName || p.name))), ...params] }
}
function replaceManaged(code: string, marker: string, replacement: string) {
  const pattern = new RegExp('// ' + marker + '\\n[\\s\\S]*?// /' + marker)
  if (!pattern.test(code)) throw Error('DURATION_MIGRATION_CONFLICT: 缺少受管理片段 ' + marker)
  return code.replace(pattern, () => replacement)
}

/** New runs opt in; the old code is retained verbatim for historical v1 evidence. */
export function upgradeDurationWorkflow<N extends Node, W extends { id: string; schemaVersion?: number; nodes: N[]; edges: Edge[] }>(workflow: W, fragments: Fragments): W {
  // A browser may have persisted the first v2 draft while the app was open.
  // Recover its verbatim legacy branch, then regenerate all managed v2 code.
  if (workflow.id === 'wf-sanguo-history-drama' && workflow.schemaVersion === 114) {
    const nodes = workflow.nodes.filter(node => node.id !== 'sanguo-duration-replan').map(node => {
      const next = { ...node }
      if (node.id === 'sanguo-shot-script') next.prompt = node.prompt
        .replace(/时间与声音（duration-v2）：[\s\S]*?\n画面：/, () => SANGUO_CINEMATIC_STORYBOARD_PROMPT.match(/时间与声音：[\s\S]*?\n画面：/)![0])
        .replace('"pacing":{"version":"duration-v2","timingPolicy":"使用params.timingPolicy完整对象","actorGroups":[],"beats":[]}',
          '"pacing":{"version":"dynamic-v1","actionSeconds":1,"reactionSeconds":0.7}')
        .replaceAll('endSecond不得超过duration-pacing.timingPolicy.endingReadabilityReserve', 'endSecond不得超过duration-0.3')
      if (['sanguo-media-request', 'sanguo-media-metrics', 'sanguo-media-accept'].includes(node.id)) {
        const marker = node.id === 'sanguo-media-request' ? '\nconst shot = context.shot_script;' : '\nconst storyboardTimelineMatches = '
        const boundary = '// duration-v2-preserved-legacy\n'
        const explicit = node.code?.indexOf(boundary) ?? -1
        const index = node.code?.lastIndexOf(marker) ?? -1
        if (explicit < 0 && index < 0) throw Error('DURATION_MIGRATION_CONFLICT: 缺少原封保存的历史代码 ' + node.id)
        next.code = explicit >= 0 ? node.code!.slice(explicit + boundary.length) : node.code!.slice(index + (node.id === 'sanguo-media-request' ? 0 : 1))
      }
      if (node.id === 'sanguo-media-review') next.prompt = node.prompt.replace(/\n【duration-v2逐节拍完成证据】[\s\S]*$/, '')
      if (node.id === 'sanguo-requirement-review') next.prompt = node.prompt.replace(/\n【duration-v2时间解释】[\s\S]*$/, '')
      if (node.id === 'sanguo-shot-script-review') next.prompt = node.prompt.replace(/\n【duration-v2分镜审核契约】[\s\S]*$/, '')
      if (next.childIds) next.childIds = next.childIds.filter(id => id !== 'sanguo-duration-replan')
      return next
    })
    const edges = workflow.edges.filter(edge => edge.from !== 'sanguo-duration-replan').map(edge => edge.to === 'sanguo-duration-replan'
      ? { ...edge, to: 'sanguo-media-accept-error-branch' } : edge)
    return upgradeDurationWorkflow({ ...workflow, schemaVersion: 113, nodes, edges }, fragments)
  }
  if (workflow.id !== 'wf-sanguo-history-drama' || workflow.schemaVersion !== 113) return workflow
  const requiredIds = ['sanguo-shot-script', 'sanguo-video', 'sanguo-media-request', 'sanguo-media-metrics', 'sanguo-media-review', 'sanguo-media-accept', 'sanguo-media-accept-error-branch']
  if (requiredIds.some(id => workflow.nodes.filter(n => n.id === id).length !== 1)) return workflow
  const writer = workflow.nodes.find(n => n.id === 'sanguo-shot-script')!
  const writerAnchors = [SANGUO_CINEMATIC_STORYBOARD_PROMPT, SANGUO_STORYBOARD_PROMPT_BEFORE_TRUSTED_TAIL_STATE]
    .flatMap(anchor => Array.from({ length: writer.prompt.split(anchor).length - 1 }, () => anchor))
  if (writerAnchors.length !== 1) throw Error('DURATION_MIGRATION_CONFLICT: 分镜提示词已自定义或存在多个版本，无法精确替换旧时间契约')
  const writerAnchor = writerAnchors[0]
  const gate = workflow.nodes.find(n => n.id === 'sanguo-media-accept')!
  const replanId = 'sanguo-duration-replan'
  if (workflow.nodes.some(n => n.id === replanId)) throw Error('DURATION_MIGRATION_CONFLICT: 重排分支已存在于旧版本')
  const replan = { ...gate, id: replanId, title: '时长不足重新排镜', kind: 'branch', resultVar: 'duration_replan_branch',
    prompt: '确证时长或依赖不足时有界返回分镜重排；保留原视频与诊断。证据不足交给同素材复核。',
    code: `const report=context.video_shot;\nif(report?.durationCompletion?.route!=='replan')return true;\nif(branch.counts.false+1>=Number(params.maxAttempts))throw Error('DURATION_REPLAN_LIMIT: 已达时长重排上限，保留当前素材和诊断');\nreturn {value:false,feedback:report.durationRepair,contextPatch:{durationRepair:report.durationRepair}};`,
    params: [param('maxAttempts', String(MAX_NODE_ATTEMPTS), 'number')], position: { x: gate.position.x + 140, y: gate.position.y + 180 } } as N
  const nodes = workflow.nodes.flatMap(node => {
    let next = node
    if (node.id === writer.id) next = addParams({ ...node, prompt: node.prompt.replace(writerAnchor, () => DURATION_STORYBOARD_PROMPT)
      + (node.prompt.includes('【实际时长重排反馈】') ? '' : '\n【实际时长重排反馈】${durationRepair}\n若有已确认缺口，保留原剧情和台词，修改失败依赖或声部排程后重新编译。证据未知不得据此加长或重拍。') },
      [param('pacingVersion', 'duration-v2', 'text'), param('timingPolicy', JSON.stringify(DEFAULT_DURATION_POLICY))])
    if (node.id === writer.id) next = { ...next, prompt: next.prompt.replaceAll('endSecond不得超过duration-0.3', 'endSecond不得超过duration-pacing.timingPolicy.endingReadabilityReserve') }
    if (node.id === 'sanguo-video') next = addParams({ ...node, prompt: node.prompt.replace(/以自然语速完整说出台词[^\n]*$/, DURATION_VIDEO_ENDING) },
      [param('pacing', '${shot_script.pacing}'), param('scheduleHash', '${shot_script.pacing.scheduleHash}', 'text'),
        param('videoTimeline', '${shot_script.videoPrompt}', 'text'), param('characters', '${shot_script.characters}')])
    if (node.id === 'sanguo-media-request') next = { ...node, code: `// duration-v2-media-request\nif(context.shot_script?.pacing?.version==='duration-v2')return (${durationMediaRequest.toString()})(context,params);\n// duration-v2-preserved-legacy\n${node.code}` }
    if (node.id === 'sanguo-media-metrics') {
      let body = replaceManaged(node.code!, 'media-requirement-list-v1', fragments.requirements)
      body = replaceManaged(body, 'media-requirement-review-input-v1', fragments.reviewInputs)
      next = { ...node, code: `// duration-v2-media-metrics\nif(context.shot_script?.pacing?.version==='duration-v2'){\nconst metrics=(()=>{${body}\n})();\nreturn (${deriveDurationMetrics.toString()})(context.shot_script,context.video_evidence,metrics);\n}\n// duration-v2-preserved-legacy\n${node.code}` }
    }
    if (node.id === 'sanguo-media-review') next = { ...node,
      prompt: refreshDurationMediaReviewPrompt(node.prompt) + '\n' + fragments.completionPrompt + DURATION_REFERENCE_REVIEW,
      params: node.params.filter(p => !['minSpeechRate', 'tailSeconds'].includes(p.englishName || p.name)).map(p => {
        if ((p.englishName || p.name) !== 'reviewPolicySource') return p
        const source = JSON.parse(p.value) as { fields: string[] }
        // The v2 gate overrides its legacy tail reserve at runtime. Do not send
        // the old configured number alongside the shot's shared policy.
        return { ...p, value: JSON.stringify({ ...source, fields: source.fields.filter(field => !['minSpeechRate', 'tailSeconds'].includes(field)) }) }
      }) }
    if (node.id === 'sanguo-requirement-review') next = { ...node, prompt: node.prompt + DURATION_REFERENCE_REVIEW }
    if (node.id === 'sanguo-shot-script-review') next = addParams({ ...node, prompt: fragments.refreshDramaturgyPrompt(node.prompt) + DURATION_SCRIPT_REVIEW },
      [param('promptInputMode', 'normalized-results', 'text')])
    if (node.id === 'sanguo-shot-script-accept' && node.code) next = { ...node, code: fragments.refreshDramaturgyGate(node.code) }
    if (node.id === gate.id) {
      let body = replaceManaged(node.code!, 'independent-media-review-view-v1', fragments.reviewView)
      body = replaceManaged(body, 'media-uncertainty-diagnostic-v2', fragments.uncertainty)
      body = replaceManaged(body, 'media-defect-evidence-v3', fragments.defects)
      body = body.replace('performanceChecks:pacing.performanceChecks,maxIdleTailSeconds:',
        'performanceChecks:pacing.performanceChecks,durationCompletion:params.durationCompletion,maxIdleTailSeconds:')
      next = { ...node, code: `// duration-v2-completion-gate\nif(context.shot_script?.pacing?.version==='duration-v2'){\nif(context.video_take?.params?.scheduleHash!==context.shot_script.pacing.scheduleHash)return {routeError:'DURATION_CONTRACT_INVALID: 视频不属于当前排程，禁止沿用旧素材验收'};\nif(context.video_evidence?.originalUrl!==context.video_take?.url)return {routeError:'DURATION_CONTRACT_INVALID: 采证不属于当前视频'};\nconst completion=(${assessDurationCompletion.toString()})(context.shot_script,context.video_evidence,context.media_review);\nif(!completion.passed)return (${durationCompletionRecovery.toString()})(context,completion,params);\nconst accepted=((context,params)=>{${body}\n})({...context,media_review:{...context.media_review,durationCompletion:completion,lastMeaningfulActionSecond:Math.max(Number(context.media_review.lastMeaningfulActionSecond)||0,completion.actualCompletionInterval.upper)}},{...params,tailSeconds:context.shot_script.pacing.timingPolicy.endingReadabilityReserve,timingTolerance:0,durationCompletion:completion});\nreturn {...accepted,durationCompletion:completion};\n}\n// duration-v2-preserved-legacy\n${node.code}` }
    }
    if (next.childIds?.includes(gate.id)) next = { ...next, childIds: next.childIds.flatMap(id => id === gate.id ? [id, replanId] : [id]) }
    return node.id === gate.id ? [next, replan] : [next]
  })
  const edges = workflow.edges.map(edge => edge.from === gate.id && edge.to === 'sanguo-media-accept-error-branch' ? { ...edge, to: replanId } : edge)
  edges.push({ id: replanId + '-true', from: replanId, to: 'sanguo-media-accept-error-branch', branch: 'true' },
    { id: replanId + '-false', from: replanId, to: writer.id, branch: 'false' })
  return { ...workflow, schemaVersion: 115, nodes, edges }
}
