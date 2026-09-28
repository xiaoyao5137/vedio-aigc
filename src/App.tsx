import { BailianVoicePicker } from './BailianVoicePicker'
import WorkflowLibrary from './WorkflowLibrary'
import { CanvasNodeMedia } from './CanvasNodeMedia'
import { canvasMediaKind, resolveCanvasMedia, type CanvasMedia } from './canvas-media'
import { canvasMediaScale, projectCanvasNodes, CANVAS_MEDIA_NODE_HEIGHT } from './canvas-media-layout'
import VoiceListeningReview from './VoiceListeningReview'
import { voiceReviewSource, voiceReviewTarget } from './voice-review'
import { assertVoiceRuntime, knownVoiceSpeakers } from './character-voice'
import { voiceCandidateOutput, withApprovedVoiceCasting } from './voice-character-input'
import { newExecutionVoicePolicy, voicePolicyLabel, type VoicePolicy } from './voice-policy'
import { addOriginalVoiceNode } from './original-voice-workflow'
import VoiceUpgradePanel, { type VoiceUpgradePlan } from './VoiceUpgradePanel'
import { InspectorDisclosure, InspectorEntries } from './InspectorDisclosure'
import { decodeExecutionState, encodeExecutionState } from './execution-storage'
import { createExecutionSaveQueue, ExecutionPersistenceError, requireExecutionCheckpoint, type PersistenceResult } from './execution-persistence'
import { SANGUO_SCENE_OUTLINE_PROMPT } from './scene-outline-prompt'
import { branchSceneIncludesRun, branchSceneIndicesForRun } from './branch-scenes'
import { RunDuration } from './RunDuration'
import { BranchNodeShape } from './BranchNodeShape'
import { branchOutputOffset } from './branch-node-geometry'
import { BranchConnections } from './BranchConnections'
import { migrateBranchWorkflow, migrateBranchRuns } from './branch-migration'
import { DEFAULT_BRANCH_CODE, branchConfigurationErrors, executionRouteEdges, orderRouteNodes, retryBranchRun, routeBranch, setBranchEdge, setBranchLoop, type BranchState, type BranchPort, type RouteEdge } from './workflow-branch'
import { fitDagZoom, wheelDagZoom, zoomDagAt } from './dag-zoom'
import { expandSelection, moveSelection, nodesInSelection, selectionRect, type NodeBounds, type Point } from './canvas-selection'
import { historicalInspectorRunIndex, nextInspectorRunIndex } from './debug-inspector-selection'
import { mapNodeInputs, type MapInput } from './node-map'
import { type ErrorRetryPolicy, type AcceptancePolicy } from './node-retry'
import { EDITORIAL_VIDEO_PROMPT, upgradeActorlessSettingEstablishment, upgradeLiveActionExceptSandTable, upgradeQualityWorkflow } from './quality-node-presets'
import { upgradePrincipleQuality } from './principle-workflow'
import { upgradeLeanPrincipleQuality, upgradeManualReviewQuality, setQualityDisposition } from './principle-quality-budget'
import { runPrincipleReview } from './principle-review-runtime'
import { PrincipleQualitySummary } from './PrincipleQualitySummary'
import { requestJson, requestNodeJson } from './node-transport'
import { DurationDiagnostics } from './DurationDiagnostics'
import { SANGUO_CINEMATIC_STORYBOARD_PROMPT } from './storyboard-prompt'
import { normalizeDramaOutline, storyboardDramaContext } from './history-drama'
import { cinematicContinuityIssue } from './history-cinema'
import { applyScopedDramaRepair, attachDramaRepairProvenance } from './drama-repair'
import { createDramaGenerationBudget, resolveDramaGenerationLimit } from './drama-generation-budget'
import { historicalSourceReviewContext } from './history-source-review'
import { nodePromptInputContext } from './review-input'
import { videoPromptInputContext } from './video-prompt-input'
import { resolveNodePolicy } from './node-policy-input'
import { renderRetryFeedbackPrompt, renderWorkflowTemplate, resolveTemplateJsonValue, stringifyTemplateValue } from './workflow-template'
import { refreshDramaticExpressionPrompt, upgradeDramaticExpression } from './dramatic-expression'
import { parseEpisodeBoundary, refreshEpisodeBoundaryPrompt, upgradeEpisodeBoundary, validateEpisodeNarrativeBoundary } from './episode-boundary'
import { upgradeSandTableWorkflow } from './sand-table-workflow'
import { CHARACTER_VISUAL_CONTEXT_RUNTIME_VERSION, assertSelectedCharacterVisuals, characterArtisticIdentityCatalog, characterEquipmentCatalog, characterEquipmentPrompt, characterInputsForShot, characterSelectionsForEpisode, characterVisualCatalog, resolveCharacterVisualSelections, upgradeCharacterVisualWorkflow, upgradePersistedSanguoCharacterWorkflow } from './character-visual-workflow'
import { CHARACTER_BIOGRAPHY_SOURCE_PARAM, upgradeCharacterBiographyWorkflow } from './character-biography-workflow'
import { upgradeCoverageCutFrameWorkflow } from './coverage-cut-frame-gate'
import { loadSanguoDefaultWorkflow } from './sanguo-default-workflow'
import { isManualReview } from './quality-disposition'
import { validateHistoricalProductionPlan, validateHistoricalAgency } from './history-content-guards'
import { orderLoopPlaceholders, runWorkflowToCompletion, historicalVideoRetryIndexes, requiresManualMediaDecision, newlyRequiredManualMediaDecision } from './workflow-runner'
import { prepareWorkflowRunContext } from './workflow-run-context'
import { manualRetryRuns } from './run-invalidation'
import { createFailedTextCandidateBinding, failedTextCandidateFromLedger, failedTextCandidatePrefixHashAlgorithm, failedTextCandidateRequestPrefix, failedTextCandidateWriterInputs, FailedTextCandidateError, isFailedTextCandidateValidationMessage, isRecoverableFailedTextNode, readFailedTextCandidate, withFailedTextCandidate, withoutFailedTextCandidate, type FailedTextCandidateBinding } from './failed-text-candidate'
import { executeFailedTextCandidate, executeRecoveredHistoricalStoryboard } from './failed-text-execution'
import type { LoopRerunMetadata } from './loop-rerun'
import { breakpointRollbackCandidates, forkBreakpointRollback, planBreakpointRollback, previousBreakpointRollbackCandidate, type BreakpointRollbackMetadata } from './breakpoint-rollback'
import { HISTORY_QUALITY_VERSION, characterAppearanceContext } from './history-media.ts'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import {
  Activity,
  Bot,
  BookOpenText,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Clapperboard,
  Code2,
  Copy,
  Download,
  ExternalLink,
  FlaskConical,
  FileSpreadsheet,
  Globe2,
  Image as ImageIcon,
  Layers,
  ListPlus,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Pencil,
  Play,
  Plus,
  Repeat,
  RefreshCw,
  RotateCcw,
  Settings,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UserRoundSearch,
  UsersRound,
  Volume2,
  X,
  XCircle,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import './App.css'
import { DEFAULT_CODE_NODE_SCRIPT, SANGUO_CHARACTER_LOOKUP_CODE, SANGUO_CONTEXT_INIT_CODE, SANGUO_FIRST_FRAME_BRANCH_CODE, SANGUO_REUSE_TAIL_CODE, SANGUO_TAIL_FRAME_CODE } from './code-node-presets'
import { animatedMapEndFrameNode, animatedMapFirstFrameNode } from './animated-map-frames'
import { STORYBOARD_SEGMENTS_KEY, sceneFromStoryboardSegment, storyboardContinuityContext } from './storyboard-runtime'
import { createStoryboardSplitPlan, readStoryboardSplitCandidate, storyboardSplitCandidateRef, isManagedStoryboardSplitNode,
  type StoryboardSplitPlanEvidence, type StoryboardSplitCandidateReference } from './storyboard-split-candidate'
import { MAX_NODE_ATTEMPTS } from './retry-budget'
import { contextWithGenerationAttempt } from './generation-request-context'
import { captureVideoTailFrame } from './video-tail-frame'
import CharacterLibrary from './CharacterLibrary'
import { isSharedCredentialKey, sharedCredentialModelIds, syncSharedModelCredentials } from './model-config'
import { inspectExperienceResponse, modelExperienceFields, parseModelExperienceParams, restoreModelExperienceRequest } from './model-experience'
import type { ExperienceField, ExperienceMedia, ExperienceResponseInspection, ExperienceValue } from './model-experience'
import { aggregateLoopOutputs, applyNodeOutputToContext, availableLoopIterations, buildSceneOutlineRepairSuffix, buildVariableMetadata, canAdvanceStep, containsUnicodeReplacementCharacter, extractTextResponse, findInspectableNodeRunIndex, findLoopSnapshotRunIndex, firstBlockingRunIndex, hasExecutionPlanMismatch, isDisplayedRunCompletedBeforeStep, isDurationPolicyTransition, refreshPendingExecutionNodes, missingRequiredParamNames, normalizeStructuredTextOutput, recoverInterruptedNodeRuns, resolveVariableMetadata, scopedLoopNodes, serializedValuesDiffer, shouldSkipStep, validateHistoricalStructuredOutput } from './workflow-core'
import { loadAppViewState, saveAppViewState } from './app-view-state'
import { createWorkflowBreakpointResolver, formatBreakpointValue, loadWorkflowBreakpoints, parseBreakpointValue, removeWorkflowBreakpoint, saveWorkflowBreakpoints, setWorkflowBreakpoint, shouldPauseBeforeRun, toggleWorkflowBreakpoint, type BreakpointOperator, type WorkflowBreakpoint } from './workflow-breakpoints'
import type { AppPage, RunnerTab, WorkflowView } from './app-view-state'
import { assetDownloadUrl } from './asset-download'
import { repairSanguoVideoMediaRoute, upgradeSanguoVideoConcat } from './video-concat-workflow'
import { applyVideoOutputProfile, VIDEO_OUTPUT_PROFILE_VERSION, type VideoExecutionMode } from './video-output-profile'

type NodeKind = 'input' | 'image' | 'video' | 'videoConcat' | 'text' | 'code' | 'loop' | 'internet' | 'validation' | 'knowledge' | 'asset' | 'audio' | 'compose' | 'http' | 'branch'
type ParamType = 'text' | 'number' | 'boolean' | 'image' | 'images' | 'json'
type ModelCapability = 'text' | 'image' | 'video' | 'audio'
type ModelProvider = 'Bailian' | 'Anthropic' | 'OpenAI' | 'Codex' | 'Ofox' | 'Kling' | 'Local' | 'Custom'
type TextOutputMode = 'legacy-shots' | 'array' | 'json' | 'text'

type WorkflowParam = { id: string; name: string; englishName?: string; type: ParamType; required: boolean; value: string }
type UploadedAsset = { id: string; name: string; dataUrl: string; mimeType?: string; size?: number }
type LoopConfig = { enabled: boolean; sourcePath: string; fallbackCount: number; itemVar: string }
type WorkflowNode = {
  id: string
  title: string
  kind: NodeKind
  modelId?: string
  resultVar: string
  prompt: string
  params: WorkflowParam[]
  uploads: UploadedAsset[]
  loop: LoopConfig
  position: { x: number; y: number }
  parentId?: string
  childIds?: string[]
  operation?: string
  outputMode?: TextOutputMode
  code?: string
  runIf?: { path: string; equals: unknown }
  request?: { url: string; method: 'POST' | 'GET' }
  acceptance?: AcceptancePolicy
  errorRetry?: ErrorRetryPolicy
  mapInput?: MapInput
  captureTail?: boolean
  loopResultMode?: 'collect' | 'latest'
}
type WorkflowEdge = RouteEdge
type Workflow = { id: string; name: string; description: string; nodes: WorkflowNode[]; edges: WorkflowEdge[]; schemaVersion?: number; voicePolicy?: VoicePolicy }
type ModelConfig = {
  id: string
  name: string
  provider: ModelProvider
  capability: ModelCapability
  settings: Record<string, string>
  testInput: string
  testResult: string
}
type AppConfig = { models: ModelConfig[]; workflows: Workflow[] }
type ModelView = { mode: 'list' } | { mode: 'detail'; modelId: string } | { mode: 'runs' }
type ModelExecutionRecord = {
  id: string
  channel: 'experience' | 'workflow'
  modelId: string
  modelName: string
  provider: string
  capability: ModelCapability
  status: 'processing' | 'succeeded' | 'failed' | string
  httpStatus?: number
  taskId?: string
  workflowId?: string
  workflowName?: string
  nodeId?: string
  nodeName?: string
  requestData: unknown
  responseData?: unknown
  error?: string
  durationMs: number
  createdAt?: string
  updatedAt?: string
}
type ModelExecutionFilters = { channel: string; modelId: string; status: string; capability: string; keyword: string }
type ExperienceSource = { record: ModelExecutionRecord; omittedFields: string[] }
type NodeRunRequestContext = { voiceExecutionId?: string; voicePolicy?: string; requestKey?: string; workflowId?: string; workflowName?: string; nodeId?: string; nodeName?: string }
type ExperienceRunPhase = 'submitting' | 'processing' | 'paused' | 'succeeded' | 'failed'
type ExperienceRun = {
  phase: ExperienceRunPhase
  startedAt: number
  updatedAt: number
  httpStatus?: number
  taskId?: string
  queryMode?: string
  providerStatus?: string
  message?: string
  media: ExperienceMedia[]
  rawBody?: unknown
  error?: string
}
type InspectableMediaKind = 'image' | 'video'
type MediaPreviewState = { url: string; kind: InspectableMediaKind; label: string; filename: string }
type TextPreviewTarget =
  | { type: 'context'; path: string[] }
  | { type: 'node'; nodeId: string; field: 'prompt' | 'code' }
  | { type: 'param'; nodeId: string; paramId: string }
type TextPreviewState = { value: string; title: string; eyebrow: string; editable: boolean; target: TextPreviewTarget }
const EXPERIENCE_RUNS_STORAGE_KEY = 'vedio-aigc:model-experience-runs:v1'
const experienceTimestamp = () => Math.round(performance.timeOrigin + performance.now())

function loadStoredExperienceRuns(): Record<string, ExperienceRun> {
  if (typeof window === 'undefined') return {}
  try {
    const value = JSON.parse(window.localStorage.getItem(EXPERIENCE_RUNS_STORAGE_KEY) ?? '{}')
    return value && typeof value === 'object' ? value as Record<string, ExperienceRun> : {}
  } catch {
    return {}
  }
}
type RunMode = 'run' | 'step'
type RunnerInspectorTab = 'config' | 'input' | 'output'
type WorkflowDebugState = { stepIndex: number }
type BreakpointEditorState = { workflowId: string; nodeId: string; conditional: boolean; path: string; operator: BreakpointOperator; value: string }
const breakpointOperatorLabels: Record<BreakpointOperator, string> = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' }
type StepTask = { failedCandidateBinding?: FailedTextCandidateBinding; storyboardSplitCandidate?: ReturnType<typeof readStoryboardSplitCandidate>; knownVoiceInputs?: unknown[]; voiceExecutionId?: string; voicePolicy?: string; executionId?: string; executionMode?: VideoExecutionMode; node: WorkflowNode; policyNodes?: WorkflowNode[]; loopNode?: WorkflowNode; loopItem?: unknown; loopIndex?: number; loopPrevious?: Record<string, unknown>; label?: string }
const STORYBOARD_SPLIT_SOURCE_KEY = '__storyboardSplitSource'
type StoryboardSplitSourceEnvelope = {
  source: NonNullable<Awaited<ReturnType<typeof executeRecoveredHistoricalStoryboard>>['source']>
  expected: Record<string, unknown>
}
type NodeRunResult = {
  node: WorkflowNode
  output: unknown
  context: Record<string, unknown>
  inputs?: Record<string, unknown>
  inputContext?: Record<string, unknown>
  label?: string
}
type NodeRunStatus = 'idle' | 'running' | 'success' | 'failed' | 'skipped'
type NodeRunState = NodeRunResult & {
  id: string
  status: NodeRunStatus
  durationMs: number
  error?: string
  startedAt?: number
  loopNode?: WorkflowNode
  loopItem?: unknown
  loopIndex?: number
  loopPrevious?: Record<string, unknown>
  loopGroupId?: string
  loopIsLast?: boolean
  attempt?: number
  errorAttempt?: number
  revision?: number
  retryFeedback?: unknown
  storyboardSplitPlan?: StoryboardSplitPlanEvidence
  storyboardSplitCandidate?: StoryboardSplitCandidateReference
  branchState?: BranchState
  branchEntryTarget?: string
  branchCarry?: Record<string, { loopIndex?: number; state: BranchState; paramOverrides?: Record<string, string> }>
  routeInputContext?: Record<string, unknown>
  routeInputOverrides?: Record<string, unknown>
  paramOverrides?: Record<string, string>
  attempts?: Array<Record<string, unknown>>
}
type ExecutionState = {
  generationScopeId?: string
  loopRerun?: LoopRerunMetadata
  breakpointRollback?: BreakpointRollbackMetadata
  breakpointRollbackHistory?: BreakpointRollbackMetadata[]
  voiceUpgrade?: { sourceExecutionId: string; characterVersions: Array<{ characterId: string; from: number; to: number }>; invalidatedRunIds: string[] }
  voicePolicy?: 'strict' | 'preview'
  id: string
  requestScopeId?: string
  mode: RunMode
  workflowId: string
  workflowName: string
  runtimeInputs: Record<string, unknown>
  nodeRuns: NodeRunState[]
  context: Record<string, unknown>
  logs: string[]
  selectedNodeId?: string
  historical?: boolean
  persistenceError?: string
  branchHistory?: Array<Record<string, unknown>>
}
type ExecutionRecord = {
  id: string
  workflowId: string
  workflowName: string
  mode: RunMode
  title: string
  runtimeInputs: Record<string, unknown>
  result: ExecutionState
  createdAt?: string
}
type ExecutionRecordListItem = Omit<ExecutionRecord, 'runtimeInputs' | 'result'> & {
  runtimeInputs?: Record<string, unknown>
  result?: ExecutionState
  succeededCount: number
  failedCount: number
  totalCount: number
}
type WorkflowDebugSnapshot = {
  steps: NodeRunResult[]
  runs: NodeRunResult[]
  currentRun?: NodeRunResult
  context: Record<string, unknown>
  logs: string[]
}
type GraphDrag =
  | { type: 'node'; start: Point; origins: Record<string, Point> }
  | { type: 'selection'; start: Point; end: Point; bounds: NodeBounds[] }
  | { type: 'edge'; from: string; branch?: BranchPort; x: number; y: number }
  | null

const PARAM_VALUE_VISIBLE_LIMIT = 50

function getParamValueRows(value: string) {
  const characters = Array.from(value)
  if (characters.length > PARAM_VALUE_VISIBLE_LIMIT) return 3
  return Math.max(
    1,
    value.split(/\r?\n/).reduce((rows, line) => rows + Math.max(1, Math.ceil(Array.from(line).length / 20)), 0),
  )
}

const nodeMeta: Record<NodeKind, { label: string; icon: typeof Pencil }> = {
  http: { label: 'HTTP 请求节点', icon: Globe2 },
  input: { label: '输入节点', icon: ListPlus },
  text: { label: '文本推理节点', icon: Bot },
  image: { label: '图片生成节点', icon: ImageIcon },
  video: { label: '视频生成节点', icon: Clapperboard },
  videoConcat: { label: '视频拼接', icon: Clapperboard },
  code: { label: '代码执行节点', icon: Code2 },
  branch: { label: '分支判断节点', icon: SlidersHorizontal },
  loop: { label: '循环控制节点', icon: Repeat },
  internet: { label: '互联网检索节点', icon: Globe2 },
  validation: { label: '规则校验节点', icon: ShieldCheck },
  knowledge: { label: '知识库检索节点（兼容旧版）', icon: BookOpenText },
  asset: { label: '角色资产节点', icon: UserRoundSearch },
  audio: { label: '音频生成节点', icon: Volume2 },
  compose: { label: '时间线合成节点', icon: Clapperboard },
}

const runStatusLabels: Record<NodeRunStatus, string> = {
  idle: '待执行',
  running: '执行中',
  success: '已完成',
  failed: '执行失败',
  skipped: '分支跳过',
}

const createId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`
const defaultLoop = (): LoopConfig => ({ enabled: false, sourcePath: 'script_fragments.items', fallbackCount: 8, itemVar: 'item' })

const initialModels: ModelConfig[] = [
  {
    id: 'bailian-qwen-audio-tts', name: '百炼 Qwen Audio TTS Flash', provider: 'Bailian', capability: 'audio',
    settings: { endpoint: '', apiKey: '', model: 'qwen-audio-3.0-tts-flash', voice: 'longanhuan_v3.6', instruction: '', rate: '1', pitch: '1', sampleRate: '24000', seed: '0' },
    testInput: '诸位先坐下，我们慢慢商量。今天的事情，总能找到办法。', testResult: '',
  },
  {
    id: 'claude-opus-4-8',
    name: 'claude 4.8 opus',
    provider: 'Anthropic',
    capability: 'text',
    settings: {
      endpoint: 'https://api.anthropic.com/v1/messages',
      apiKey: '',
      model: 'claude-opus-4-8',
    },
    testInput: '请基于“城市夜跑”生成一个 15 秒短视频脚本。',
    testResult: '',
  },
  {
    id: 'gpt-image-2',
    name: 'gpt image2',
    provider: 'OpenAI',
    capability: 'image',
    settings: {
      endpoint: 'https://api.openai.com/v1/images/generations',
      apiKey: '',
      model: 'gpt-image-2',
    },
    testInput: '赛博朋克风格的城市夜跑者，霓虹灯，写实摄影',
    testResult: '',
  },
  {
    id: 'qwen-image-3-pro',
    name: 'Qwen Image 3.0 Pro（免费）',
    provider: 'Ofox',
    capability: 'image',
    settings: {
      endpoint: 'https://api.ofox.ai/v1/images/generations',
      apiKey: '',
      model: 'bailian/qwen-image-3.0-pro:free',
    },
    testInput: '电影感的东汉末年村落清晨，薄雾与自然光，人物服饰符合史实，竖屏构图',
    testResult: '',
  },
  {
    id: 'keling3',
    name: 'Kling Video 3.0',
    provider: 'Kling',
    capability: 'video',
    settings: {
      endpoint: 'https://api-singapore.klingai.com/v1/videos',
      apiKey: '',
      accessKey: '',
      secretKey: '',
      model: 'kling-v3',
      pollIntervalMs: '3000',
      taskTimeoutMs: '900000',
    },
    testInput: '让夜跑者从镜头左侧跑入，镜头轻微跟随，霓虹反光。',
    testResult: '',
  },
  {
    id: 'kling-image-3',
    name: '可灵 Image 3.0',
    provider: 'Kling',
    capability: 'image',
    settings: {
      endpoint: 'https://api-beijing.klingai.com/v1/images/generations',
      apiKey: '',
      accessKey: '',
      secretKey: '',
      model: 'kling-v3',
      pollIntervalMs: '3000',
      taskTimeoutMs: '900000',
    },
    testInput: '电影感的雨夜城市街头，一位穿黄色雨衣的年轻人站在霓虹灯下，竖屏构图，真实摄影质感',
    testResult: '',
  },
  {
    id: 'local-history-llm',
    name: '本地史剧结构化模拟器',
    provider: 'Local',
    capability: 'text',
    settings: { model: 'local-history-v1', fixtureMode: 'true' },
    testInput: '为“符水与饥民”生成场景大纲。',
    testResult: '',
  },
  {
    id: 'local-image-simulator',
    name: '本地图片联调模拟器',
    provider: 'Local',
    capability: 'image',
    settings: { model: 'local-svg-preview-v1' },
    testInput: '东汉末年乡野，写实历史电影首帧。',
    testResult: '',
  },
  {
    id: 'local-video-simulator',
    name: '本地视频任务模拟器',
    provider: 'Local',
    capability: 'video',
    settings: { model: 'local-video-dry-run-v1' },
    testInput: '人物缓慢走入村庄，镜头跟随。',
    testResult: '',
  },
  {
    id: 'local-audio-simulator',
    name: '本地音频联调模拟器',
    provider: 'Local',
    capability: 'audio',
    settings: { model: 'local-silent-wav-v1' },
    testInput: '大疫与饥荒之间，百姓先等来的，不是官粮。',
    testResult: '',
  },
]

const storyNodes: WorkflowNode[] = [
  {
    id: 'node-input',
    title: '项目输入',
    kind: 'input',
    resultVar: 'input',
    prompt: '',
    params: [
      { id: 'topic', name: '主题', englishName: 'topic', type: 'json', required: true, value: '["买早餐", "公司午睡"]' },
      { id: 'platform', name: '平台', englishName: 'platform', type: 'text', required: true, value: '抖音' },
      { id: 'vedio_count', name: '视频数量', englishName: 'vedio_count', type: 'number', required: true, value: '2' },
    ],
    uploads: [],
    loop: defaultLoop(),
    position: { x: 50, y: 170 },
  },
  {
    id: 'node-model-images',
    title: '模特图生成',
    kind: 'image',
    resultVar: 'model_images',
    prompt: '手工上传的模特参考图，供剧本生成和首帧图生成使用。',
    params: [],
    uploads: [],
    loop: defaultLoop(),
    position: { x: 330, y: 100 },
  },
  {
    id: 'node-script',
    title: '剧本生成',
    kind: 'text',
    modelId: 'claude-opus-4-8',
    resultVar: 'script_generation',
    prompt: '按顺序基于主题数组"${input.topic}"，为平台"${input.platform}"生成${input.vedio_count}个短视频分镜剧本。\n模特参考图数组：${model_images.items}\n只返回 JSON 数组，不要 Markdown，每个数组对象必须包含：title、content、duration、camera、mood、firstFramePrompt。每个视频只使用主题数组中对应序号的一个主题，并保持模特参考图中的角色特征一致。',
    params: [],
    uploads: [],
    loop: defaultLoop(),
    position: { x: 620, y: 100 },
  },
  {
    id: 'node-loop',
    title: '按分镜数量循环',
    kind: 'loop',
    resultVar: 'shot_loop',
    prompt: '',
    params: [],
    uploads: [],
    loop: { enabled: true, sourcePath: 'script_generation.shots', fallbackCount: 8, itemVar: 'shot' },
    position: { x: 910, y: 200 },
  },
  {
    id: 'node-image',
    title: '首帧图生成',
    kind: 'image',
    modelId: 'gpt-image-2',
    resultVar: 'first_frame',
    prompt: '你是千万粉丝级"真实动物拟人化"短视频金牌UI设计师，请设计以下短视频剧情的4:3比例的首帧图，用于贴给可灵生成短视频。\n剧情如下：\n${shot.content}',
    params: [
      { id: 'referenceImages', name: '参考图（可上传或引用变量）', englishName: 'referenceImages', type: 'images', required: false, value: '${model_images.items}' },
      { id: 'size', name: '尺寸', englishName: 'size', type: 'text', required: true, value: '1024x1024' },
    ],
    uploads: [],
    loop: defaultLoop(),
    position: { x: 1160, y: 100 },
  },
  {
    id: 'node-video',
    title: '分镜生成',
    kind: 'video',
    modelId: 'keling3',
    resultVar: 'video_shot',
    prompt: '根据剧本生成视频：${shot.content}',
    params: [
      { id: 'referenceImage', name: '首帧参考图', englishName: 'referenceImage', type: 'image', required: false, value: '${first_frame}' },
      { id: 'duration', name: '时长（秒）', englishName: 'duration', type: 'number', required: true, value: '3' },
      { id: 'camera', name: '镜头运动', englishName: 'camera', type: 'text', required: false, value: '${shot.camera}' },
      { id: 'mood', name: '氛围', englishName: 'mood', type: 'text', required: false, value: '${shot.mood}' },
    ],
    uploads: [],
    loop: defaultLoop(),
    position: { x: 1460, y: 180 },
  },
]

const sanguoWorkbookUpload: UploadedAsset = {
  id: 'sanguo-episodes-workbook',
  name: '三国历史短剧1000集策划总表.xlsx',
  dataUrl: '/data/三国历史短剧1000集策划总表.xlsx',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  size: 78431,
}

const sanguoContextNode: WorkflowNode = {
  id: 'sanguo-context-init',
  title: '剧集上下文初始化',
  kind: 'code',
  resultVar: 'episode_context',
  prompt: '节点代码负责解析 Excel、按输入集数匹配记录、转换字段，并通过 contextPatch 写入流程上下文。',
  code: SANGUO_CONTEXT_INIT_CODE,
  params: [],
  uploads: [sanguoWorkbookUpload],
  loop: defaultLoop(),
  position: { x: 330, y: 210 },
}


const sanguoNodes: WorkflowNode[] = [
  {
    id: 'sanguo-input',
    title: '选择集数',
    kind: 'input',
    resultVar: 'input',
    prompt: '',
    params: [
      { id: 'sg-episode-number', name: '集数', englishName: 'episode_number', type: 'number', required: true, value: '41' },
    ],
    uploads: [],
    loop: defaultLoop(),
    position: { x: 40, y: 210 },
  },
  sanguoContextNode,
  {
    id: 'sanguo-knowledge',
    title: '互联网史料原文查询',
    kind: 'internet',
    operation: 'internet.retrieve',
    resultVar: 'historical_sources',
    prompt: '',
    params: [
      { id: 'sg-k-query', name: '查询词', englishName: 'query', type: 'text', required: true, value: '${episode_context.internetRequest.query}' },
      { id: 'sg-k-urls', name: '目标 URL', englishName: 'urls', type: 'json', required: false, value: '${episode_context.internetRequest.urls}' },
      { id: 'sg-k-max-sources', name: '最多来源', englishName: 'maxSources', type: 'number', required: true, value: '${episode_context.internetRequest.maxSources}' },
      { id: 'sg-k-max-passages', name: '最多结果片段', englishName: 'maxPassages', type: 'number', required: true, value: '${episode_context.internetRequest.maxPassages}' },
    ],
    uploads: [],
    loop: defaultLoop(),
    position: { x: 620, y: 80 },
  },
  {
    id: 'sanguo-scene-outline',
    title: '本集场景大纲',
    kind: 'text',
    operation: 'history.scene-outline',
    outputMode: 'json',
    modelId: 'claude-opus-4-8',
    resultVar: 'scene_outline',
    prompt: SANGUO_SCENE_OUTLINE_PROMPT,
    params: [],
    uploads: [],
    loop: defaultLoop(),
    position: { x: 910, y: 120 },
  },
  {
    id: 'sanguo-scene-loop',
    title: '逐场景生成',
    kind: 'loop',
    resultVar: 'scene_loop',
    prompt: '',
    params: [],
    uploads: [],
    loop: { enabled: true, sourcePath: 'scene_outline.scenes', fallbackCount: 0, itemVar: 'scene' },
    childIds: ['sanguo-shot-script', 'sanguo-character-lookup', 'sanguo-character-portrait', 'sanguo-character-image', 'sanguo-character-archive', 'sanguo-first-frame-branch', 'sanguo-first-frame-tail', 'sanguo-animated-map-first-frame', 'sanguo-end-frame', 'sanguo-video', 'sanguo-last-frame'],
    position: { x: 1200, y: 240 },
  },
  {
    id: 'sanguo-shot-script',
    title: '场景短分镜',
    kind: 'text',
    operation: 'history.storyboard',
    outputMode: 'json',
    modelId: 'claude-opus-4-8',
    resultVar: 'shot_script',
    prompt: SANGUO_CINEMATIC_STORYBOARD_PROMPT,
    params: [],
    uploads: [],
    loop: defaultLoop(),
    parentId: 'sanguo-scene-loop',
    position: { x: 1490, y: 60 },
  },
  {
    id: 'sanguo-character-lookup',
    title: '人物检索',
    kind: 'code',
    operation: 'character.lookup',
    resultVar: 'character_lookup',
    prompt: '查询当前短分镜全部出场人物，并整理已存在人物、缺失人物和是否需要生成的字段。',
    code: SANGUO_CHARACTER_LOOKUP_CODE,
    params: [],
    uploads: [],
    loop: defaultLoop(),
    parentId: 'sanguo-scene-loop',
    position: { x: 1770, y: 60 },
  },
  {
    id: 'sanguo-character-portrait',
    title: '人物史料画像提取',
    kind: 'internet',
    operation: 'character.historical-portrait',
    resultVar: 'character_portraits',
    prompt: '对本镜具名人物补充可核对的正史生平与体貌资料；优先复用本集已检索史料。已有三视图也检查自动占位自传，仅替换缺证据段落；区分检索失败和确实缺载，不将小说外形或剧情造型写成正史。',
    params: [
      { id: 'sg-cp-characters', name: '待提取人物', englishName: 'characters', type: 'json', required: true, value: '${character_lookup.missingCharacters}' },
      { id: 'sg-cp-all', name: '全部出场人物', englishName: 'allCharacters', type: 'json', required: true, value: '${character_lookup.characters}' },
      CHARACTER_BIOGRAPHY_SOURCE_PARAM,
      { id: 'sg-cp-max-sources', name: '每种史书最多来源', englishName: 'maxSources', type: 'number', required: true, value: '2' },
      { id: 'sg-cp-max-passages', name: '每种史书最多片段', englishName: 'maxPassages', type: 'number', required: true, value: '4' },
    ],
    uploads: [],
    loop: defaultLoop(),
    parentId: 'sanguo-scene-loop',
    position: { x: 2050, y: 60 },
  },
  {
    id: 'sanguo-character-image',
    title: '人物图片生成',
    kind: 'image',
    operation: 'character.ensure',
    modelId: 'kling-image-3',
    resultVar: 'character_assets',
    prompt: '逐一生成缺失人物的定妆三视图，并以角色名称和连续性标识返回结构化结果。',
    runIf: { path: 'character_lookup.shouldGenerate', equals: true },
    params: [
      { id: 'sg-ci-characters', name: '待生成人物', englishName: 'characters', type: 'json', required: true, value: '${character_portraits.characters}' },
      { id: 'sg-ci-all', name: '全部出场人物', englishName: 'allCharacters', type: 'json', required: true, value: '${character_portraits.allCharacters}' },
      { id: 'sg-ci-existing', name: '已有人物资产', englishName: 'existingAssets', type: 'json', required: false, value: '${character_lookup.existingAssets}' },
      { id: 'sg-ci-validate', name: '三视图质量检查', englishName: 'validateThreeView', type: 'boolean', required: true, value: 'true' },
      { id: 'sg-ci-fallback', name: '质量失败备用图片模型（历史工作流已禁用）', englishName: 'fallbackModelId', type: 'text', required: false, value: '' },
      { id: 'sg-ci-attempts', name: '质量失败重试次数', englishName: 'maxGenerationAttempts', type: 'number', required: true, value: String(MAX_NODE_ATTEMPTS) },
    ],
    uploads: [],
    loop: defaultLoop(),
    parentId: 'sanguo-scene-loop',
    position: { x: 2330, y: 60 },
  },
  {
    id: 'sanguo-character-archive',
    title: '人物资产归档',
    kind: 'asset',
    operation: 'character.archive',
    resultVar: 'archived_character_assets',
    prompt: '将人物图片生成结果与缺失人物逐一对应并写入人物库。',
    runIf: { path: 'character_lookup.shouldGenerate', equals: true },
    params: [
      { id: 'sg-ca-characters', name: '待归档人物', englishName: 'characters', type: 'json', required: true, value: '${character_portraits.characters}' },
      { id: 'sg-ca-images', name: '生成结果', englishName: 'generatedAssets', type: 'json', required: true, value: '${character_assets}' },
    ],
    uploads: [],
    loop: defaultLoop(),
    parentId: 'sanguo-scene-loop',
    position: { x: 2610, y: 60 },
  },
  {
    id: 'sanguo-first-frame-branch',
    title: '续接首帧判断',
    kind: 'code',
    resultVar: 'first_frame_branch',
    prompt: '整理人物资产参考图；默认参考生视频，仅在上一镜内容未表达完整时复用其尾帧。',
    code: SANGUO_FIRST_FRAME_BRANCH_CODE,
    params: [],
    uploads: [],
    loop: defaultLoop(),
    parentId: 'sanguo-scene-loop',
    position: { x: 2610, y: 60 },
  },
  {
    id: 'sanguo-first-frame-tail',
    title: '复用上一镜尾帧',
    kind: 'code',
    resultVar: 'first_frame',
    prompt: '将前镜尾帧作为当前镜头首帧，不调用图片模型。',
    code: SANGUO_REUSE_TAIL_CODE,
    runIf: { path: 'first_frame_branch.shouldReusePreviousTail', equals: true },
    params: [],
    uploads: [],
    loop: defaultLoop(),
    parentId: 'sanguo-scene-loop',
    position: { x: 2890, y: 200 },
  },
  {
    ...animatedMapFirstFrameNode,
    loop: defaultLoop(),
  } as WorkflowNode,
  {
    ...animatedMapEndFrameNode,
    loop: defaultLoop(),
  } as WorkflowNode,
  {
    id: 'sanguo-video',
    title: '参考生视频',
    kind: 'video',
    modelId: 'local-video-simulator',
    resultVar: 'video_shot',
    prompt: EDITORIAL_VIDEO_PROMPT,
    params: [
      { id: 'sg-v-image', name: '续接首帧（仅连续镜头）', englishName: 'referenceImage', type: 'image', required: false, value: '${first_frame.url}' },
      { id: 'sg-v-end-image', name: '动画镜头目标尾帧', englishName: 'endImage', type: 'image', required: false, value: '${end_frame.url}' },
      { id: 'sg-v-animation-style', name: '动画叙事类型', englishName: 'animationStyle', type: 'text', required: false, value: '${shot_script.animationStyle}' },
      { id: 'sg-v-animation-aesthetic', name: '动画美术风格', englishName: 'animationAesthetic', type: 'text', required: false, value: '${shot_script.animationAesthetic}' },
      { id: 'sg-v-character-refs', name: '人物三视图', englishName: 'referenceImages', type: 'images', required: false, value: '${first_frame_branch.referenceRequest.referenceImages}' },
      { id: 'sg-v-ref-mode', name: '人物参考处理', englishName: 'referenceMode', type: 'text', required: false, value: '${first_frame_branch.referenceRequest.referenceMode}' },
      { id: 'sg-v-ref-bindings', name: '人物参考绑定', englishName: 'referenceBindings', type: 'json', required: false, value: '${first_frame_branch.referenceRequest.referenceBindings}' },
      { id: 'sg-v-characters', name: '本镜人物', englishName: 'characters', type: 'json', required: false, value: '${shot_script.characters}' },
      { id: 'sg-v-character-equipment', name: '本镜人物装备需求', englishName: 'characterEquipment', type: 'json', required: false, value: '${shot_script.characterEquipment}' },
      { id: 'sg-v-equipment-bindings', name: '已归档装备绑定', englishName: 'equipmentBindings', type: 'json', required: false, value: '${character_lookup.equipmentBindings}' },
      { id: 'sg-v-illustration-layers', name: '二维人物图层编排', englishName: 'illustrationLayers', type: 'json', required: false, value: '${shot_script.illustrationLayers}' },
      { id: 'sg-v-ratio', name: '画幅比例', englishName: 'aspectRatio', type: 'text', required: true, value: '16:9' },
      { id: 'sg-v-duration', name: '动态时长', englishName: 'duration', type: 'number', required: true, value: '${shot_script.duration}' },
      { id: 'sg-v-pacing', name: '节奏规划版本', englishName: 'pacingVersion', type: 'text', required: true, value: '${shot_script.pacing.version}' },
      { id: 'sg-v-mode', name: '生成模式', englishName: 'mode', type: 'text', required: true, value: 'std' },
      { id: 'sg-v-sound', name: '原生音频', englishName: 'sound', type: 'text', required: true, value: 'on' },
      { id: 'sg-v-negative', name: '负向提示词', englishName: 'negativePrompt', type: 'text', required: false, value: '画面闪烁、人物变形、身份漂移、服饰突变、未按二维图层编排的人物出现或消失、纯色背景、摄影棚背景、幕布背景、舞台布景、三视图背景复现、人物抠图感、空洞背景、现代物件、字幕、水印、低幼卡通、游戏CG、玄幻光效、AI塑料感' },
    ],
    uploads: [],
    loop: defaultLoop(),
    parentId: 'sanguo-scene-loop',
    position: { x: 3450, y: 60 },
  },
  {
    id: 'sanguo-last-frame',
    title: '尾帧结果整理',
    kind: 'code',
    resultVar: 'last_frame',
    prompt: '整理视频模型明确返回的尾帧，供下一镜连续性分支使用；不调用角色资产或图片生成能力。',
    code: SANGUO_TAIL_FRAME_CODE,
    params: [],
    uploads: [],
    loop: defaultLoop(),
    parentId: 'sanguo-scene-loop',
    position: { x: 3730, y: 60 },
  },
  {
    id: 'sanguo-verify',
    title: '史料引用与改编边界检查',
    kind: 'validation',
    operation: 'history.verify',
    resultVar: 'historical_verification',
    prompt: '确定性检查：核对每个短分镜的史料编号、改编边界和动态 3–15 秒时长和剧情闭合；核对总时长为各镜实际时长之和；不调用大模型。',
    params: [
      { id: 'sg-check-citations', name: '史料引用', englishName: 'citations', type: 'json', required: true, value: '${historical_sources.citations}' },
      { id: 'sg-check-shots', name: '分镜', englishName: 'shots', type: 'json', required: true, value: '${shot_script.items}' },
      { id: 'sg-check-videos', name: '成片质量证据', englishName: 'videos', type: 'json', required: true, value: '${video_shot.items}' },
      { id: 'sg-check-quality', name: '要求真实质量检查', englishName: 'requireQualityEvidence', type: 'boolean', required: true, value: 'true' },
      { id: 'sg-check-policy', name: '改编规则', englishName: 'policy', type: 'text', required: true, value: '${input.adaptation_policy}' },
      { id: 'sg-check-scene-count', name: '剧情规划镜头数', englishName: 'expectedSceneCount', type: 'number', required: true, value: '${scene_outline.count}' },
      { id: 'sg-check-duration', name: '剧情规划总时长', englishName: 'expectedTotalDuration', type: 'number', required: true, value: '${scene_outline.totalDuration}' },
    ],
    uploads: [],
    loop: defaultLoop(),
    position: { x: 4010, y: 160 },
  },
  {
    id: 'sanguo-compose',
    title: '整集合成清单',
    kind: 'compose',
    operation: 'timeline.compose',
    resultVar: 'episode_timeline',
    prompt: '汇总每个场景自带原生音频的视频，生成可渲染的整集时间线。',
    params: [
      { id: 'sg-m-shots', name: '分镜', englishName: 'storyboards', type: 'json', required: true, value: '${shot_script.items}' },
      { id: 'sg-m-videos', name: '视频片段', englishName: 'videos', type: 'json', required: true, value: '${video_shot.items}' },
      { id: 'sg-m-ratio', name: '画幅', englishName: 'aspectRatio', type: 'text', required: true, value: '${input.aspect_ratio}' },
      { id: 'sg-m-resolution', name: '分辨率', englishName: 'resolution', type: 'text', required: true, value: '1920x1080' },
      { id: 'sg-m-format', name: '格式', englishName: 'format', type: 'text', required: true, value: 'mp4' },
    ],
    uploads: [],
    loop: defaultLoop(),
    position: { x: 4290, y: 160 },
  },
]

const sanguoEdges: WorkflowEdge[] = [
  { id: 'sg-e-input-context', from: 'sanguo-input', to: 'sanguo-context-init' },
  { id: 'sg-e-context-k', from: 'sanguo-context-init', to: 'sanguo-knowledge' },
  { id: 'sg-e-k-so', from: 'sanguo-knowledge', to: 'sanguo-scene-outline' },
  { id: 'sg-e-so-loop', from: 'sanguo-scene-outline', to: 'sanguo-scene-loop' },
  { id: 'sg-e-loop-shot', from: 'sanguo-scene-loop', to: 'sanguo-shot-script' },
  { id: 'sg-e-shot-lookup', from: 'sanguo-shot-script', to: 'sanguo-character-lookup' },
  { id: 'sg-e-lookup-portrait', from: 'sanguo-character-lookup', to: 'sanguo-character-portrait' },
  { id: 'sg-e-portrait-image', from: 'sanguo-character-portrait', to: 'sanguo-character-image' },
  { id: 'sg-e-image-archive', from: 'sanguo-character-image', to: 'sanguo-character-archive' },
  { id: 'sg-e-archive-branch', from: 'sanguo-character-archive', to: 'sanguo-first-frame-branch' },
  { id: 'sg-e-branch-tail', from: 'sanguo-first-frame-branch', to: 'sanguo-first-frame-tail' },
  { id: 'sg-e-branch-animated-map-first', from: 'sanguo-first-frame-branch', to: 'sanguo-animated-map-first-frame' },
  { id: 'sg-e-animated-map-first-end', from: 'sanguo-animated-map-first-frame', to: 'sanguo-end-frame' },
  { id: 'sg-e-animated-map-end-video', from: 'sanguo-end-frame', to: 'sanguo-video' },
  { id: 'sg-e-branch-video', from: 'sanguo-first-frame-branch', to: 'sanguo-video' },
  { id: 'sg-e-tail-video', from: 'sanguo-first-frame-tail', to: 'sanguo-video' },
  { id: 'sg-e-video-last-frame', from: 'sanguo-video', to: 'sanguo-last-frame' },
  { id: 'sg-e-last-frame-verify', from: 'sanguo-last-frame', to: 'sanguo-verify' },
  { id: 'sg-e-verify-compose', from: 'sanguo-verify', to: 'sanguo-compose' },
]

const initialWorkflows: Workflow[] = [
  {
    id: 'wf-sanguo-history-drama',
    schemaVersion: 59,
    name: '三国原著史料短剧（分步生成）',
    description: '按对白、动作和反应动态估算 3–15 秒镜头；剧情未完成先续拍，确认动作与回应完成后才能转场。',
    nodes: sanguoNodes,
    edges: sanguoEdges,
  },
  {
    id: 'wf-story',
    name: '打工猫短视频分镜生成',
    description: '脚本生成后由代码节点拆取 JSON 数组，循环节点按数组长度逐段生成首帧和视频分镜。',
    nodes: storyNodes,
    edges: [
      { id: 'edge-input-model-images', from: 'node-input', to: 'node-model-images' },
      { id: 'edge-model-images-script', from: 'node-model-images', to: 'node-script' },
      { id: 'edge-script-loop', from: 'node-script', to: 'node-loop' },
      { id: 'edge-loop-image', from: 'node-loop', to: 'node-image' },
      { id: 'edge-image-video', from: 'node-image', to: 'node-video' },
    ],
  },
  {
    id: 'wf-cover',
    name: '封面图生成',
    description: '单独生成封面图，可在画布上继续加视频节点。',
    nodes: [
      { ...storyNodes[0], id: 'cover-input', position: { x: 90, y: 180 } },
      {
        id: 'cover-image',
        title: '封面图',
        kind: 'image',
        modelId: 'gpt-image-2',
        resultVar: 'cover_image',
        prompt: '根据主题"${input.topic}"生成短视频封面图。',
        params: [
          { id: 'cover-size', name: '尺寸', englishName: 'size', type: 'text', required: true, value: '1024x1024' },
        ],
        uploads: [],
        loop: defaultLoop(),
        position: { x: 440, y: 180 },
      },
    ],
    edges: [{ id: 'cover-edge', from: 'cover-input', to: 'cover-image' }],
  },
]

function loadConfigFromDatabase() {
  return requestJson<AppConfig>('/api/config')
}

function saveModelsToDatabase(models: ModelConfig[]) {
  return requestJson<{ ok: boolean; models: number }>('/api/config/models', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ models }),
  })
}

function saveWorkflowsToDatabase(workflows: Workflow[]) {
  return requestJson<{ ok: boolean; workflows: number }>('/api/config/workflows', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflows }),
  })
}

function loadExecutionRecords(workflowId: string) {
  return requestJson<{ records: ExecutionRecordListItem[] }>(`/api/execution-records?workflowId=${encodeURIComponent(workflowId)}`)
}

async function loadExecutionRecord(id: string) {
  const response = await requestJson<{ record: ExecutionRecord }>(`/api/execution-records/${encodeURIComponent(id)}`)
  return { ...response, record: { ...response.record, result: decodeExecutionState<ExecutionState>(response.record.result) } }
}

async function saveExecutionRecord(record: ExecutionRecord) {
  return requestJson<{ ok: boolean; id: string }>('/api/execution-records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ record: { ...record, result: encodeExecutionState(record.result) } }),
  })
}

function loadModelExecutionRecords(filters: Partial<ModelExecutionFilters> & { workflowId?: string; nodeId?: string; operation?: string; requestKeyPrefix?: string; limit?: string }) {
  const query = new URLSearchParams()
  Object.entries(filters).forEach(([key, value]) => {
    if (value.trim()) query.set(key, value.trim())
  })
  return requestJson<{ records: ModelExecutionRecord[] }>(`/api/model-executions?${query.toString()}`)
}

function runModelNode(model: ModelConfig, prompt: string, params: Record<string, unknown>, operation?: string, executionContext?: NodeRunRequestContext) {
  return requestNodeJson<{ status: number; body: unknown }>('/api/node-run', { model, prompt, params, operation, executionContext }, executionContext?.requestKey)
}

function runBuiltinNode(operation: string, prompt: string, params: Record<string, unknown>, model?: ModelConfig, executionContext?: NodeRunRequestContext) {
  return requestNodeJson<{ status: number; body: unknown }>('/api/builtin-node-run', { operation, prompt, params, model, executionContext }, executionContext?.requestKey)
}

function runCodeNode(code: string, prompt: string, params: Record<string, unknown>, files: UploadedAsset[], context: Record<string, unknown>) {
  return requestJson<{ status: number; body: unknown }>('/api/code-node-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, prompt, params, files, context }),
  })
}

function assetDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'))
    reader.readAsDataURL(blob)
  })
}

async function materializeUpload(asset: UploadedAsset) {
  if (asset.dataUrl.startsWith('data:')) return asset
  const response = await fetch(asset.dataUrl)
  if (!response.ok) throw new Error(`无法读取节点附件 ${asset.name}：HTTP ${response.status}`)
  const blob = await response.blob()
  return {
    ...asset,
    dataUrl: await assetDataUrl(blob),
    mimeType: asset.mimeType || blob.type,
    size: asset.size ?? blob.size,
  }
}

function resolvePath(source: Record<string, unknown>, path: string) {
  return path.split('.').reduce<unknown>((value, key) => {
    if (value && typeof value === 'object' && key in value) return (value as Record<string, unknown>)[key]
    return undefined
  }, source)
}

const stringifyValue = stringifyTemplateValue
const interpolate = renderWorkflowTemplate

function paramValue(param: WorkflowParam) {
  if (param.type === 'number') return Number(param.value || 0)
  if (param.type === 'boolean') return param.value === 'true'
  if (param.type === 'json') {
    try {
      return JSON.parse(param.value || '{}')
    } catch {
      return param.value
    }
  }
  return param.value
}

function paramKey(param: WorkflowParam) {
  return param.englishName?.trim() || param.name
}

function nodeParamValues(node: WorkflowNode, context?: Record<string, unknown>) {
  return Object.fromEntries(node.params.map((param) => [paramKey(param), context ? resolveParamValue(param, context) : paramValue(param)]))
}

function nodeParamAliases(node: WorkflowNode, values: Record<string, unknown>) {
  return Object.fromEntries(
    node.params.flatMap((param) => {
      const key = paramKey(param)
      const value = values[key]
      return param.englishName && param.englishName !== param.name ? [[param.name, value], [param.englishName, value]] : [[param.name, value]]
    }),
  )
}

function resolveParamValue(param: WorkflowParam, context: Record<string, unknown>) {
  const exactReference = param.value.trim().match(/^\$\{([^}]+)\}$/)
  if (exactReference) return resolvePath(context, exactReference[1].trim())
  // A json parameter is not automatically placeholder-free: 【对数组逐项执行】 (mapInput) only puts the
  // item into the per-item context, so a template like `["${frame.url}"]` has to be resolved the same
  // way a text parameter is. Returning the raw template made the literal string `${frame.url}` reach
  // the vision review, and every 独立画面观察 frame of a finished clip then failed with
  // “审查只接受 /generated/ 下的本地 JPEG 帧” (record-ys8pde 第 1 轮 / record-htfg6s).
  if (param.type === 'json') {
    if (!param.value.includes('${')) return paramValue(param)
    // Shipped configs use two shapes: a quoted placeholder (`["${frame.url}"]`) that already parses as
    // JSON, and a bare splice (`[${scene.beatIds}]`) that only becomes JSON once resolved. The first is
    // walked as parsed data so arrays and objects keep their structure; the second falls back to text
    // interpolation.
    try {
      return resolveTemplateJsonValue(JSON.parse(param.value), context)
    } catch {
      return paramValue({ ...param, value: interpolate(param.value, context) })
    }
  }
  const interpolated = interpolate(param.value, context)
  return paramValue({ ...param, value: interpolated })
}

function uploadedImageOutput(node: WorkflowNode) {
  const items = node.uploads.map((asset) => ({ name: asset.name, url: asset.dataUrl }))
  return {
    items,
    urls: items.map((item) => item.url),
    uploads: node.uploads.map((asset) => asset.name),
    count: items.length,
  }
}

function getExecutionOrder(workflow: Workflow) {
  return orderRouteNodes(workflow)
}

function runNode(node: WorkflowNode, context: Record<string, unknown>, loopItem?: unknown, loopIndex?: number) {
  const values = nodeParamValues(node, context)
  const aliases = nodeParamAliases(node, values)
  const localContext = {
    ...context,
    ...aliases,
    [node.loop.itemVar]: loopItem,
    loop: loopIndex === undefined ? undefined : { index: loopIndex + 1, zeroIndex: loopIndex },
    uploads: node.uploads.map((asset) => asset.name),
  }
  const promptContext = node.kind === 'text' ? nodePromptInputContext(localContext, values.promptInputMode)
    : node.kind === 'video' ? videoPromptInputContext(localContext, values.promptInputMode) : localContext
  const prompt = interpolate(node.prompt, promptContext)
  if (node.kind === 'input') return { ...values, prompt, uploads: node.uploads.map((asset) => asset.name) }
  if (node.kind === 'text') {
    const count = Math.max(1, Number(resolvePath(context, 'input.vedio_count') ?? values.vedio_count ?? 3))
    const topicValue = resolvePath(context, 'input.topic')
    const topics = Array.isArray(topicValue) ? topicValue.map((item) => stringifyValue(item)) : [stringifyValue(topicValue)]
    const shots = Array.from({ length: count }, (_, index) => ({
      title: `分镜 ${index + 1}`,
      topic: topics[index] || '',
      content: `第 ${index + 1} 段剧情：围绕“${topics[index] || '短视频剧情'}”展开完整分镜，不混用其他主题。`,
      duration: 3,
      camera: index % 2 === 0 ? '轻微推进' : '横向跟拍',
      mood: index % 2 === 0 ? '轻松明亮' : '紧张有趣',
      firstFramePrompt: `第 ${index + 1} 段首帧图`,
    }))
    return { ...values, text: `已生成文本：${prompt}`, shots, model: node.modelId }
  }
  if (node.kind === 'image' && !node.modelId) return { ...uploadedImageOutput(node), prompt, model: undefined, params: values }
  if (node.kind === 'image') return { url: node.uploads[loopIndex ?? 0]?.dataUrl ?? `${node.resultVar}-${(loopIndex ?? 0) + 1}.png`, prompt, model: node.modelId, params: values }
  if (node.kind === 'video') return { url: `${node.resultVar}-${(loopIndex ?? 0) + 1}.mp4`, prompt, duration: values.duration, model: node.modelId }
  if (node.kind === 'audio') return { url: `${node.resultVar}-${(loopIndex ?? 0) + 1}.mp3`, prompt, duration: values.duration, model: node.modelId }
  return { operation: node.operation ?? node.kind, prompt, params: values }
}

function getLoopNodes(workflow: Workflow, loopNodeId: string, ordered = getExecutionOrder(workflow).ordered) {
  return scopedLoopNodes({ ...workflow, edges: executionRouteEdges(workflow) }, loopNodeId, ordered)
}

function getLoopItems(context: Record<string, unknown>, loopNode: WorkflowNode) {
  const source = resolvePath(context, loopNode.loop.sourcePath)
  return Array.isArray(source) ? source : Array.from({ length: loopNode.loop.fallbackCount }, (_, index) => `片段 ${index + 1}`)
}

function storyboardSegments(output: unknown) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return []
  const segments = (output as Record<string, unknown>)[STORYBOARD_SEGMENTS_KEY]
  return Array.isArray(segments) ? segments.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : []
}

function publicStoryboardOutput(output: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(output).filter(([key]) => ![STORYBOARD_SEGMENTS_KEY, STORYBOARD_SPLIT_SOURCE_KEY].includes(key)))
}

function expandedSceneOutline(context: Record<string, unknown>, sourceScene: unknown, segments: Record<string, unknown>[]) {
  const outline = context.scene_outline
  if (!outline || typeof outline !== 'object' || Array.isArray(outline)) return context
  const record = outline as Record<string, unknown>
  if (!Array.isArray(record.scenes)) return context
  const source = sourceScene && typeof sourceScene === 'object' && !Array.isArray(sourceScene) ? sourceScene as Record<string, unknown> : {}
  const sourceIndex = record.scenes.findIndex((item) => item === sourceScene || (item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).id === source.id))
  if (sourceIndex < 0) return context
  const replacements = segments.map((segment, index) => sceneFromStoryboardSegment(sourceScene, segment, index, segments.length))
  const scenes = [...record.scenes.slice(0, sourceIndex), ...replacements, ...record.scenes.slice(sourceIndex + 1)]
    .map((scene, index) => scene && typeof scene === 'object' && !Array.isArray(scene) ? { ...scene as Record<string, unknown>, sequence: index + 1 } : scene)
  const loop = context.scene_loop && typeof context.scene_loop === 'object' && !Array.isArray(context.scene_loop)
    ? context.scene_loop as Record<string, unknown>
    : undefined
  return {
    ...context,
    ...(record.contentContractVersion === 'cinematic-v1' ? { approved_scene_outline: context.approved_scene_outline ?? record } : {}),
    scene_outline: { ...record, scenes, count: scenes.length, totalDuration: scenes.reduce((sum, scene) => sum + Number((scene as Record<string, unknown>).targetDuration), 0) },
    ...(loop ? { scene_loop: { ...loop, count: scenes.length } } : {}),
  }
}

function runNodeInLoop(node: WorkflowNode, context: Record<string, unknown>, loopNode: WorkflowNode, loopItem: unknown, loopIndex: number) {
  const currentLoop = context.loop && typeof context.loop === 'object' && !Array.isArray(context.loop) ? context.loop as Record<string, unknown> : {}
  const loopContext = {
    ...context,
    [loopNode.loop.itemVar]: loopItem,
    loop: { ...currentLoop, index: loopIndex + 1, zeroIndex: loopIndex },
  }
  const values = nodeParamValues(node, loopContext)
  const aliases = nodeParamAliases(node, values)
  const localContext = {
    ...loopContext,
    ...aliases,
    uploads: node.uploads.map((asset) => asset.name),
  }
  const promptContext = node.kind === 'text' ? nodePromptInputContext(localContext, values.promptInputMode)
    : node.kind === 'video' ? videoPromptInputContext(localContext, values.promptInputMode) : localContext
  const prompt = interpolate(node.prompt, promptContext)
  if (node.kind === 'input') return { ...values, prompt, uploads: node.uploads.map((asset) => asset.name) }
  if (node.kind === 'text') return { ...values, text: `已生成文本：${prompt}`, model: node.modelId }
  if (node.kind === 'image' && !node.modelId) return { ...uploadedImageOutput(node), prompt, model: undefined, params: values }
  if (node.kind === 'image') return { url: node.uploads[loopIndex]?.dataUrl ?? `${node.resultVar}-${loopIndex + 1}.png`, prompt, model: node.modelId, params: values }
  if (node.kind === 'video') return { url: `${node.resultVar}-${loopIndex + 1}.mp4`, prompt, duration: values.duration, model: node.modelId }
  if (node.kind === 'audio') return { url: `${node.resultVar}-${loopIndex + 1}.mp3`, prompt, duration: values.duration, model: node.modelId }
  return { item: loopItem, prompt }
}

function executeWorkflow(workflow: Workflow) {
  const context: Record<string, unknown> = {}
  const logs: string[] = []
  const { ordered, hasCycle } = getExecutionOrder(workflow)
  const skippedLoopChildren = new Set<string>()
  ordered.forEach((node) => {
    if (skippedLoopChildren.has(node.id)) return
    if (node.kind === 'loop' && node.loop.enabled) {
      const loopNodes = getLoopNodes(workflow, node.id, ordered)
      const loopItems = getLoopItems(context, node)
      const loopResults: Record<string, unknown>[] = []
      const collectedByResultVar: Record<string, unknown[]> = {}
      loopItems.forEach((item, index) => {
        const iterationContext = { ...context, [node.loop.itemVar]: item, loop: { index: index + 1, zeroIndex: index, previous: loopResults.at(-1) } }
        const iterationResult: Record<string, unknown> = { [node.loop.itemVar]: item }
        loopNodes.forEach((loopChild) => {
          const output = runNodeInLoop(loopChild, iterationContext, node, item, index)
          iterationContext[loopChild.resultVar] = output
          iterationResult[loopChild.resultVar] = output
          collectedByResultVar[loopChild.resultVar] = [...(collectedByResultVar[loopChild.resultVar] ?? []), output]
        })
        loopResults.push(iterationResult)
      })
      Object.entries(collectedByResultVar).forEach(([resultVar, items]) => {
        context[resultVar] = { items, count: items.length, loopSource: node.loop.sourcePath }
      })
      context[node.resultVar] = { items: loopResults, count: loopResults.length, loopSource: node.loop.sourcePath }
      loopNodes.forEach((loopChild) => skippedLoopChildren.add(loopChild.id))
      logs.push(`${node.title} -> ${node.resultVar} 循环执行 ${loopItems.length} 次，包含 ${loopNodes.map((item) => item.title).join('、')}`)
      return
    }
    if ((node.kind === 'image' || node.kind === 'video') && node.loop.enabled) {
      const loopItems = getLoopItems(context, node)
      const items = loopItems.map((item, index) => runNode(node, context, item, index))
      context[node.resultVar] = { items, count: items.length, loopSource: node.loop.sourcePath, model: node.modelId }
      logs.push(`${node.title} -> ${node.resultVar} 循环 ${items.length} 次`)
      return
    }
    context[node.resultVar] = runNode(node, context)
    logs.push(`${node.title} -> ${node.resultVar}`)
  })
  if (hasCycle) logs.unshift('检测到循环依赖，已按画布节点顺序模拟执行')
  return { context, logs }
}

function createWorkflowDebugSnapshot(workflow: Workflow, state: WorkflowDebugState): WorkflowDebugSnapshot {
  const { ordered, hasCycle } = getExecutionOrder(workflow)
  const context: Record<string, unknown> = {}
  const steps: NodeRunResult[] = []
  const logs: string[] = []
  const skippedLoopChildren = new Set<string>()

  ordered.forEach((node) => {
    if (skippedLoopChildren.has(node.id)) return
    if (node.kind === 'loop' && node.loop.enabled) {
      const loopNodes = getLoopNodes(workflow, node.id, ordered)
      const loopItems = getLoopItems(context, node)
      const loopStart = {
        count: loopItems.length,
        loopSource: node.loop.sourcePath,
        itemVar: node.loop.itemVar,
        nodes: loopNodes.map((item) => item.title),
      }
      const loopInputContext = { ...context }
      steps.push({ node, output: loopStart, context: { ...context, [node.resultVar]: loopStart }, inputs: {}, inputContext: loopInputContext, label: `${node.title} -> ${node.resultVar}` })
      let previousIteration: Record<string, unknown> | undefined
      loopItems.forEach((item, itemIndex) => {
        const iterationContext = { ...context, [node.loop.itemVar]: item, loop: { index: itemIndex + 1, zeroIndex: itemIndex, previous: previousIteration } }
        const iterationResult: Record<string, unknown> = {}
        loopNodes.forEach((loopChild) => {
          const inputContext = { ...iterationContext }
          const inputs = nodeParamValues(loopChild, inputContext)
          const output = runNodeInLoop(loopChild, iterationContext, node, item, itemIndex)
          iterationContext[loopChild.resultVar] = output
          iterationResult[loopChild.resultVar] = output
          steps.push({ node: loopChild, output, context: { ...iterationContext }, inputs, inputContext, label: `第 ${itemIndex + 1} 轮 / ${loopChild.title} -> ${loopChild.resultVar}` })
        })
        previousIteration = iterationResult
      })
      loopNodes.forEach((loopChild) => skippedLoopChildren.add(loopChild.id))
      return
    }
    const inputContext = { ...context }
    const inputs = nodeParamValues(node, inputContext)
    const output = runNode(node, context)
    context[node.resultVar] = output
    steps.push({ node, output, context: { ...context }, inputs, inputContext, label: `${node.title} -> ${node.resultVar}` })
  })

  const currentStepIndex = Math.max(0, Math.min(state.stepIndex, Math.max(0, steps.length - 1)))
  const runs = steps.slice(0, currentStepIndex + 1)
  runs.forEach((run) => logs.push(run.label ?? `${run.node.title} -> ${run.node.resultVar}`))
  if (hasCycle) logs.unshift('检测到循环依赖，已按画布节点顺序模拟执行')
  return { steps, runs, currentRun: runs.at(-1), context: runs.at(-1)?.context ?? {}, logs }
}

function collectRuntimeInputs(workflow: Workflow) {
  const inputs: Record<string, unknown> = {}
  workflow.nodes.filter((node) => node.kind === 'input').forEach((node) => {
    inputs[node.resultVar] = Object.fromEntries(node.params.map((param) => [param.englishName || param.name, paramValue(param)]))
  })
  return inputs
}

function createStaticNodeRuns(workflow: Workflow) {
  return orderLoopPlaceholders(workflow, getExecutionOrder(workflow).ordered).map<NodeRunState>((node, index) => ({
    id: `${node.id}-${index}`,
    node,
    output: undefined,
    context: {},
    inputs: {},
    inputContext: {},
    label: `${node.title} -> ${node.resultVar}`,
    status: 'idle',
    durationMs: 0,
  }))
}

function createExecutionState(workflow: Workflow, mode: RunMode, nodeRuns = createStaticNodeRuns(workflow)): ExecutionState {
  return {
    id: createId('record'),
    voicePolicy: newExecutionVoicePolicy(workflow.voicePolicy),
    mode,
    workflowId: workflow.id,
    workflowName: workflow.name,
    runtimeInputs: collectRuntimeInputs(workflow),
    nodeRuns,
    context: {},
    logs: [],
    selectedNodeId: undefined,
  }
}

function nodeWithRunOverrides(run: NodeRunState): WorkflowNode {
  return { ...run.node, params: run.node.params.map(p => ({ ...p, value: run.paramOverrides?.[p.id] ?? p.value })) }
}

function prepareStepRun(state: ExecutionState, index: number) {
  const prepared = prepareWorkflowRunContext(state.nodeRuns, index)
  if (!prepared) return undefined
  return { ...prepared, inputs: nodeParamValues(nodeWithRunOverrides(prepared.run), prepared.inputContext) }
}

function failedTextRunBinding(state: ExecutionState, index: number, inputContext: Record<string, unknown>, inputs: Record<string, unknown>, node = nodeWithRunOverrides(state.nodeRuns[index])) {
  const run = state.nodeRuns[index]
  if (!isRecoverableFailedTextNode(node, inputs)) return undefined
  // Bind the actual writer params, including the accepted prior tail image.
  // The storyboard writer adds this attachment after its read-only projection;
  // omitting it here would let a retry carry a draft across different media.
  const writerInputs = failedTextCandidateWriterInputs(node.operation ?? '', inputs, inputContext)
  return createFailedTextCandidateBinding({ executionId: state.id, requestScopeId: state.requestScopeId ?? state.id,
    generationScopeId: state.generationScopeId ?? state.requestScopeId ?? state.id, workflowId: state.workflowId,
    nodeId: node.id, runId: run.id, operation: node.operation ?? '', modelId: node.modelId ?? '', nodePrompt: node.prompt,
    attempt: run.attempt ?? 1, revision: run.revision ?? 0, loopGroupId: run.loopGroupId, loopIndex: run.loopIndex,
    sceneId: String(resolvePath(inputContext, 'scene.id') ?? ''), runtimeInputs: state.runtimeInputs,
    successfulPrefix: state.nodeRuns.slice(0, index), successfulPrefixHashAlgorithm: failedTextCandidatePrefixHashAlgorithm(run.retryFeedback),
    inputContext, inputs: writerInputs })
}

function validateRuntimeInputs(workflow: Workflow) {
  for (const node of workflow.nodes.filter((item) => item.kind === 'input')) {
    const topicParam = node.params.find((param) => param.englishName === 'topic' || param.name === '主题')
    const countParam = node.params.find((param) => param.englishName === 'vedio_count' || param.name === '视频数量')
    if (!topicParam || !countParam) continue
    const topics = paramValue(topicParam)
    const count = Number(paramValue(countParam))
    if (!Array.isArray(topics)) return `${node.title}：主题字段必须是 JSON 数组，例如 ["买早餐", "公司午睡"]`
    if (!Number.isFinite(count) || count <= 0) return `${node.title}：视频数量必须是大于 0 的数字`
    if (topics.length !== count) return `${node.title}：视频数量 ${count} 与主题数量 ${topics.length} 不一致，请一一对应`
    if (topics.some((topic) => !stringifyValue(topic).trim())) return `${node.title}：主题数组中不能包含空值`
  }
  return ''
}

function failInputNodeRuns(nodeRuns: NodeRunState[], error: string) {
  const inputIndex = Math.max(0, nodeRuns.findIndex((run) => run.node.kind === 'input'))
  const failedRun = nodeRuns[inputIndex]
  return {
    nodeRuns: nodeRuns.map((run, index) =>
      index === inputIndex ? { ...run, status: 'failed' as NodeRunStatus, durationMs: 0, error, inputs: nodeParamValues(run.node, {}), inputContext: {}, context: { ...run.context, error }, output: { error } } : { ...run, status: 'idle' as NodeRunStatus, durationMs: 0 },
    ),
    context: failedRun ? { ...failedRun.context, error } : { error },
    logs: [`${failedRun?.node.title ?? '输入节点'} -> 校验失败：${error}`],
    selectedNodeId: failedRun?.node.id,
    selectedRunIndex: inputIndex,
  }
}

function isMediaUrl(value: unknown) {
  if (typeof value !== 'string') return false
  if (value.startsWith('data:')) return true
  return /\.(png|jpe?g|webp|gif|svg|mp4|mov|webm|mp3|wav|m4a|aac|ogg)(\?|$)/i.test(value)
}

function inspectableMediaKind(value: string, key = ''): InspectableMediaKind | undefined {
  const dataMime = value.match(/^data:(image|video)\//i)?.[1]?.toLowerCase()
  if (dataMime === 'image' || dataMime === 'video') return dataMime
  if (/\.(png|jpe?g|webp|gif|svg|avif|bmp)(?:[?#]|$)/i.test(value)) return 'image'
  if (/\.(mp4|mov|m4v|webm|mkv)(?:[?#]|$)/i.test(value)) return 'video'
  if (!/^(?:https?:\/\/|\/|blob:)/i.test(value)) return undefined
  if (/(?:^|[?&])(?:content[-_]?type|mime)=image(?:%2f|\/)/i.test(value)) return 'image'
  if (/(?:^|[?&])(?:content[-_]?type|mime)=video(?:%2f|\/)/i.test(value)) return 'video'
  if (/image|picture|thumbnail|poster|cover|frame/i.test(key)) return 'image'
  if (/video|clip/i.test(key)) return 'video'
  return undefined
}

function mediaFilename(url: string, kind: InspectableMediaKind, key: string) {
  const dataMime = url.match(/^data:[^/]+\/([^;,]+)/i)?.[1]?.toLowerCase()
  const dataExtension = dataMime === 'jpeg' ? 'jpg' : dataMime === 'svg+xml' ? 'svg' : dataMime === 'quicktime' ? 'mov' : dataMime
  let sourceName = ''
  if (/^https?:\/\//i.test(url)) {
    try {
      sourceName = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? ''
    } catch {
      sourceName = ''
    }
  } else if (!url.startsWith('data:') && !url.startsWith('blob:')) {
    sourceName = url.split(/[?#]/)[0].split('/').filter(Boolean).at(-1) ?? ''
  }
  const safeKey = key.split('.').filter(Boolean).at(-1)?.replace(/[^\w\u4e00-\u9fff-]+/g, '-') || kind
  const fallbackExtension = dataExtension || (kind === 'image' ? 'png' : 'mp4')
  const candidate = sourceName
    ? /\.[a-z0-9]{2,8}$/i.test(sourceName) ? sourceName : `${sourceName}.${fallbackExtension}`
    : `${safeKey}.${fallbackExtension}`
  return candidate.replace(/[^\w.\-\u4e00-\u9fff]/g, '_')
}

function mediaDownloadUrl(url: string, filename: string) {
  return assetDownloadUrl(url, filename)
}

function cloneWithPath(source: unknown, path: string[], value: unknown): unknown {
  if (!path.length) return value
  const [key, ...rest] = path
  if (Array.isArray(source)) {
    const next = [...source]
    next[Number(key)] = cloneWithPath(next[Number(key)], rest, value)
    return next
  }
  const object = source && typeof source === 'object' ? { ...(source as Record<string, unknown>) } : {}
  object[key] = cloneWithPath(object[key], rest, value)
  return object
}

function extractFirstUrl(value: unknown): string {
  if (typeof value === 'string') return isMediaUrl(value) ? value : ''
  if (Array.isArray(value)) return value.map(extractFirstUrl).find(Boolean) || ''
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    for (const key of ['url', 'video_url', 'image_url']) {
      const found = extractFirstUrl(object[key])
      if (found) return found
    }
    for (const child of Object.values(object)) {
      const found = extractFirstUrl(child)
      if (found) return found
    }
  }
  return ''
}

function extractMediaUrls(value: unknown): string[] {
  const urls: string[] = []
  const visit = (current: unknown) => {
    if (typeof current === 'string') {
      if (isMediaUrl(current)) urls.push(current)
      return
    }
    if (Array.isArray(current)) {
      current.forEach(visit)
      return
    }
    if (current && typeof current === 'object') Object.values(current as Record<string, unknown>).forEach(visit)
  }
  visit(value)
  return [...new Set(urls)]
}

function recoverableVideoTaskId(output: unknown) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return ''
  const record = output as Record<string, unknown>
  if (typeof record.url === 'string' && isMediaUrl(record.url)) return ''
  const raw = record.raw && typeof record.raw === 'object' && !Array.isArray(record.raw) ? record.raw as Record<string, unknown> : {}
  const data = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data as Record<string, unknown> : {}
  const taskId = data.task_id ?? raw.task_id ?? raw.taskId
  const providerStatus = String(data.task_status ?? raw.task_status ?? raw.status ?? '').toLowerCase()
  return typeof taskId === 'string' && taskId.trim() && !/fail|error|cancel/.test(providerStatus) ? taskId.trim() : ''
}

function sanitizeBase64(value: unknown): unknown {
  if (typeof value === 'string') return value.startsWith('data:') || value.length > 8000 ? '[base64 hidden]' : value
  if (Array.isArray(value)) return value.map(sanitizeBase64)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, sanitizeBase64(child)]))
  return value
}

function displayEntries(object: Record<string, unknown>) {
  return Object.entries(object).filter(([key, value], index, entries) => {
    if (/^[\w.-]+$/.test(key)) return true
    return !entries.some(([otherKey, otherValue], otherIndex) => otherIndex !== index && /^[\w.-]+$/.test(otherKey) && stringifyValue(otherValue) === stringifyValue(value))
  })
}

function hasDamagedSanguoCanonicalText(workflow: Workflow) {
  if (workflow.id !== 'wf-sanguo-history-drama') return false
  const canonicalNodeIds = new Set(sanguoNodes.map((node) => node.id))
  return workflow.nodes.some((node) => canonicalNodeIds.has(node.id) && containsUnicodeReplacementCharacter({
    title: node.title,
    prompt: node.prompt,
    code: node.code,
    params: node.params,
  }))
}

function migrateSanguoWorkflow(workflow: Workflow): Workflow {
  if ((workflow.schemaVersion ?? 0) >= 60) return workflow
  const hasContextNode = workflow.nodes.some((node) => node.id === sanguoContextNode.id)
  const hasConfigurableCode = workflow.nodes.some((node) => node.id === sanguoContextNode.id && Boolean(node.code?.trim()))
  const canonicalNodeIds = new Set(sanguoNodes.map((node) => node.id))
  const hasCanonicalOrder = workflow.nodes
    .filter((node) => canonicalNodeIds.has(node.id))
    .every((node, index) => node.id === sanguoNodes[index]?.id)
  const hasV39Topology = workflow.nodes.some((node) => node.id === 'sanguo-knowledge' && node.kind === 'internet' && node.operation === 'internet.retrieve'
      && node.params.every((param) => param.englishName !== 'sourceDetail' && param.englishName !== 'sourceNames'))
    && workflow.nodes.some((node) => node.id === 'sanguo-verify' && node.kind === 'validation' && node.operation === 'history.verify')
    && workflow.nodes.some((node) => node.id === 'sanguo-scene-outline' && node.kind === 'text' && node.params.length === 0)
    && workflow.nodes.some((node) => node.id === 'sanguo-shot-script' && node.kind === 'text' && node.params.length === 0)
    && workflow.nodes.some((node) => node.id === 'sanguo-character-lookup' && node.kind === 'code' && node.operation === 'character.lookup' && node.params.length === 0)
    && workflow.nodes.some((node) => node.id === 'sanguo-character-portrait' && node.kind === 'internet' && node.operation === 'character.historical-portrait'
      && node.params.every((param) => ['characters', 'allCharacters', 'maxSources', 'maxPassages'].includes(param.englishName ?? '')))
    && workflow.nodes.some((node) => node.id === 'sanguo-character-image' && node.kind === 'image' && node.operation === 'character.ensure'
      && node.params.length === 6
      && node.params.every((param) => ['characters', 'allCharacters', 'existingAssets', 'validateThreeView', 'maxGenerationAttempts', 'fallbackModelId'].includes(param.englishName ?? '')))
    && workflow.nodes.some((node) => node.id === 'sanguo-character-archive' && node.kind === 'asset' && node.operation === 'character.archive'
      && node.params.every((param) => ['characters', 'generatedAssets'].includes(param.englishName ?? '')))
    && workflow.nodes.some((node) => node.id === 'sanguo-first-frame-branch' && node.kind === 'code' && node.params.length === 0)
    && workflow.nodes.some((node) => node.id === 'sanguo-first-frame-tail' && node.kind === 'code' && node.params.length === 0)
    && workflow.nodes.some((node) => node.id === 'sanguo-end-frame' && node.kind === 'image' && !node.operation
      && node.runIf?.path === 'disabled_target_end_frame.enabled' && node.runIf.equals === true
      && node.params.every((param) => ['referenceImages', 'size', 'referenceMode', 'referenceBindings'].includes(param.englishName ?? '')))
    && workflow.nodes.some((node) => node.id === 'sanguo-video' && node.kind === 'video'
      && node.params.length === 10
      && node.params.every((param) => ['referenceImage', 'referenceImages', 'referenceMode', 'referenceBindings', 'aspectRatio', 'duration', 'mode', 'sound', 'negativePrompt', 'pacingVersion'].includes(param.englishName ?? ''))
      && node.params.some((param) => param.englishName === 'referenceImage' && !param.required)
      && node.params.some((param) => param.englishName === 'duration' && param.value === '${shot_script.duration}'))
    && workflow.nodes.some((node) => node.id === 'sanguo-last-frame' && node.kind === 'code' && node.params.length === 0 && Boolean(node.code?.trim()))
    && !workflow.nodes.some((node) => node.id === 'sanguo-audio')
    && !workflow.nodes.some((node) => node.id === 'sanguo-first-frame')
    && workflow.edges.some((edge) => edge.from === 'sanguo-first-frame-branch' && edge.to === 'sanguo-first-frame-tail')
    && workflow.edges.some((edge) => edge.from === 'sanguo-first-frame-branch' && edge.to === 'sanguo-video')
    && !workflow.edges.some((edge) => edge.from === 'sanguo-end-frame' || edge.to === 'sanguo-end-frame')
    && workflow.edges.some((edge) => edge.from === 'sanguo-first-frame-tail' && edge.to === 'sanguo-video')
    && workflow.edges.some((edge) => edge.from === 'sanguo-video' && edge.to === 'sanguo-last-frame')
    && workflow.edges.some((edge) => edge.from === 'sanguo-last-frame' && edge.to === 'sanguo-verify')
  const usesRealHistoricalModels = workflow.nodes
    .filter((node) => node.id === 'sanguo-scene-outline' || node.id === 'sanguo-shot-script')
    .every((node) => node.modelId === 'claude-opus-4-8')
  const hasDamagedCanonicalText = hasDamagedSanguoCanonicalText(workflow)
  if ((workflow.schemaVersion ?? 1) >= 59 && hasContextNode && hasConfigurableCode && hasV39Topology && hasCanonicalOrder && usesRealHistoricalModels && !hasDamagedCanonicalText) return workflow

  let migratedWorkflow = workflow
  if ((workflow.schemaVersion ?? 1) < 4 || !hasContextNode || !hasConfigurableCode) {
    const inputNode = workflow.nodes.find((node) => node.id === 'sanguo-input')
    const existingEpisodeParam = inputNode?.params.find((param) => param.englishName === 'episode_number' || param.name === '集数')
    const episodeParam: WorkflowParam = {
      id: existingEpisodeParam?.id ?? 'sg-episode-number',
      name: '集数',
      englishName: 'episode_number',
      type: 'number',
      required: true,
      value: existingEpisodeParam?.value || '41',
    }
    const existingContextNode = workflow.nodes.find((node) => node.id === sanguoContextNode.id)
    const contextNode: WorkflowNode = {
      ...sanguoContextNode,
      ...existingContextNode,
      operation: undefined,
      resultVar: 'episode_context',
      code: SANGUO_CONTEXT_INIT_CODE,
      params: [],
      uploads: existingContextNode?.uploads.length ? existingContextNode.uploads : [{ ...sanguoWorkbookUpload }],
      loop: existingContextNode?.loop ?? defaultLoop(),
      position: { ...sanguoContextNode.position },
    }
    const positions: Record<string, { x: number; y: number }> = Object.fromEntries(sanguoNodes.map((node) => [node.id, node.position]))
    const migratedNodes: WorkflowNode[] = []
    for (const node of workflow.nodes) {
      if (node.id === sanguoContextNode.id) continue
      const migrated = node.id === 'sanguo-input'
        ? { ...node, title: '选择集数', params: [episodeParam], uploads: [], position: positions[node.id] ?? node.position }
        : { ...node, position: positions[node.id] ?? node.position }
      migratedNodes.push(migrated)
      if (node.id === 'sanguo-input') migratedNodes.push(contextNode)
    }
    if (!migratedNodes.some((node) => node.id === sanguoContextNode.id)) migratedNodes.unshift(contextNode)
    const edgeKeys = new Set<string>()
    const edges = workflow.edges
      .filter((edge) => !(edge.from === 'sanguo-input' && edge.to === 'sanguo-knowledge'))
      .concat([
        { id: 'sg-e-input-context', from: 'sanguo-input', to: 'sanguo-context-init' },
        { id: 'sg-e-context-k', from: 'sanguo-context-init', to: 'sanguo-knowledge' },
      ])
      .filter((edge) => {
        const key = `${edge.from}->${edge.to}`
        if (edgeKeys.has(key)) return false
        edgeKeys.add(key)
        return true
      })
    migratedWorkflow = {
      ...workflow,
      schemaVersion: 4,
      nodes: migratedNodes,
      edges,
    }
  }

  const canonicalRefreshNodeIds = new Set([
    'sanguo-context-init',
    'sanguo-knowledge',
    'sanguo-scene-outline',
    'sanguo-scene-loop',
    'sanguo-shot-script',
    'sanguo-character-lookup',
    'sanguo-character-portrait',
    'sanguo-character-image',
    'sanguo-character-archive',
    'sanguo-first-frame-branch',
    'sanguo-first-frame',
    'sanguo-first-frame-tail',
    'sanguo-end-frame',
    'sanguo-video',
    'sanguo-last-frame',
    'sanguo-verify',
    'sanguo-compose',
  ])
  const defaultsById = new Map(sanguoNodes.map((node) => [node.id, node]))
  const nodes = migratedWorkflow.nodes.map((node) => {
    const defaultNode = defaultsById.get(node.id)
    if (!defaultNode || !canonicalRefreshNodeIds.has(node.id)) return node
    return {
      ...node,
      title: defaultNode.title,
      kind: defaultNode.kind,
      operation: defaultNode.operation,
      resultVar: defaultNode.resultVar,
      outputMode: defaultNode.outputMode,
      modelId: node.id === 'sanguo-character-lookup' || node.id === 'sanguo-character-portrait' || node.id === 'sanguo-first-frame-branch' || node.id === 'sanguo-first-frame-tail' || node.id === 'sanguo-last-frame'
        ? undefined
        : node.id === 'sanguo-scene-outline' || node.id === 'sanguo-shot-script' || defaultNode.kind === 'image'
          ? defaultNode.modelId
          : node.modelId ?? defaultNode.modelId,
      prompt: defaultNode.prompt,
      params: node.id === 'sanguo-character-image'
        ? defaultNode.params.map((param) => param.englishName === 'maxGenerationAttempts'
          ? node.params.find((existing) => existing.englishName === param.englishName) ?? param : param)
        : defaultNode.params,
      code: defaultNode.code ?? node.code,
      runIf: defaultNode.runIf,
      loop: defaultNode.loop,
      parentId: defaultNode.parentId,
      childIds: defaultNode.childIds,
      position: defaultNode.position,
    }
  })
  const legacyReplacedNodeIds = new Set(['sanguo-character-plan', 'sanguo-character-assets', 'sanguo-audio', 'sanguo-first-frame'])
  const existingNodeIds = new Set(nodes.filter((node) => !legacyReplacedNodeIds.has(node.id)).map((node) => node.id))
  const allNodes = [...nodes.filter((node) => !legacyReplacedNodeIds.has(node.id)), ...sanguoNodes.filter((node) => !existingNodeIds.has(node.id))]
  const nodesById = new Map(allNodes.map((node) => [node.id, node]))
  const completedNodes = [
    ...sanguoNodes.map((node) => nodesById.get(node.id) ?? node),
    ...allNodes.filter((node) => !canonicalNodeIds.has(node.id)),
  ]
  const finalNodeIds = new Set(completedNodes.map((node) => node.id))
  const preservedCustomEdges = migratedWorkflow.edges.filter((edge) =>
    finalNodeIds.has(edge.from)
    && finalNodeIds.has(edge.to)
    && (!canonicalNodeIds.has(edge.from) || !canonicalNodeIds.has(edge.to)),
  )
  return {
    ...migratedWorkflow,
    schemaVersion: 59,
    description: '按对白、动作和反应动态估算 3–15 秒镜头；剧情未完成先续拍，确认动作与回应完成后才能转场。',
    nodes: completedNodes,
    edges: [...preservedCustomEdges, ...sanguoEdges],
  }
}

function workflowQualityDisposition(workflow: Workflow): 'manual-review-v1' | 'strict-v1' | undefined {
  for (const node of workflow.nodes) {
    const value = node.params.find(param => (param.englishName || param.name) === 'qualityDisposition')?.value
    if (value === 'manual-review-v1' || value === 'strict-v1') return value
  }
  return undefined
}

// Kept visible to the real cold-start graph regression; dev HMR is disabled.
// eslint-disable-next-line react-refresh/only-export-components
export function normalizeWorkflow(workflow: Workflow): Workflow {
  const base: Workflow = {
    ...workflow,
    schemaVersion: workflow.schemaVersion ?? 1,
    nodes: (workflow.nodes ?? []).map((node, index) => ({
      ...node,
      resultVar: node.resultVar || `node_${index + 1}`,
      prompt: node.prompt ?? '',
      params: node.params ?? [],
      uploads: node.uploads ?? [],
      loop: node.loop ?? defaultLoop(),
      position: node.position ?? { x: 80 + index * 280, y: 120 },
      outputMode: node.kind === 'text' ? node.outputMode ?? 'legacy-shots' : node.outputMode,
      code: node.kind === 'branch' ? node.code ?? DEFAULT_BRANCH_CODE : node.kind === 'code' ? node.code ?? DEFAULT_CODE_NODE_SCRIPT : node.code,
    })),
    edges: workflow.edges ?? [],
  }
  if (workflow.id === 'wf-sanguo-history-drama') return upgradeCoverageCutFrameWorkflow(upgradeCharacterBiographyWorkflow(
    upgradePersistedSanguoCharacterWorkflow(base, legacy =>
      upgradeEpisodeBoundary(upgradeSandTableWorkflow(upgradeCharacterVisualWorkflow(upgradeDramaticExpression(upgradeManualReviewQuality(upgradeLeanPrincipleQuality(migrateBranchWorkflow(upgradeActorlessSettingEstablishment(repairSanguoVideoMediaRoute(upgradeLiveActionExceptSandTable(upgradeSanguoVideoConcat(upgradePrincipleQuality(upgradeQualityWorkflow(migrateSanguoWorkflow(legacy)))))))))))))))))
  if (workflow.id !== 'wf-story') return migrateBranchWorkflow(base)
  const modelImageNode: WorkflowNode = {
    id: 'node-model-images',
    title: '模特图生成',
    kind: 'image',
    resultVar: 'model_images',
    prompt: '手工上传的模特参考图，供剧本生成和首帧图生成使用。',
    params: [],
    uploads: [],
    loop: defaultLoop(),
    position: { x: 330, y: 100 },
  }
  const hasModelImageNode = base.nodes.some((node) => node.id === modelImageNode.id)
  const nodes = (hasModelImageNode ? base.nodes : [...base.nodes, modelImageNode]).map((node) => {
    if (node.id === 'node-input') return { ...node, position: node.position ?? { x: 50, y: 170 } }
    if (node.id === 'node-model-images') return { ...modelImageNode, ...node, modelId: undefined, params: [], prompt: node.prompt || modelImageNode.prompt }
    if (node.id === 'node-script') return { ...node, position: node.position.x < 500 ? { ...node.position, x: 620 } : node.position }
    if (node.id === 'node-loop') return { ...node, position: node.position.x < 800 ? { ...node.position, x: 910 } : node.position }
    if (node.id === 'node-image') return { ...node, position: node.position.x < 1000 ? { ...node.position, x: 1160 } : node.position }
    if (node.id === 'node-video') return { ...node, position: node.position.x < 1300 ? { ...node.position, x: 1460 } : node.position }
    return node
  })
  const edgeKeys = new Set<string>()
  const edges = base.edges
    .filter((edge) => !(edge.from === 'node-input' && edge.to === 'node-script'))
    .concat([
      { id: 'edge-input-model-images', from: 'node-input', to: 'node-model-images' },
      { id: 'edge-model-images-script', from: 'node-model-images', to: 'node-script' },
    ])
    .filter((edge) => {
      const key = `${edge.from}->${edge.to}:${edge.branch ?? "normal"}`
      if (edgeKeys.has(key)) return false
      edgeKeys.add(key)
      return true
    })
  return migrateBranchWorkflow({
    ...base,
    nodes: nodes.map((node) => {
      if (node.id === 'node-input') {
        return {
          ...node,
          params: node.params.map((param) => {
            if (param.englishName !== 'topic') return param
            if (param.type === 'json') return param
            const topics = param.value.split(/[,\n，、]/).map((item) => item.trim()).filter(Boolean)
            return { ...param, type: 'json' as ParamType, value: JSON.stringify(topics.length ? topics : ['买早餐', '公司午睡'], null, 2) }
          }),
        }
      }
      if (node.id === 'node-script') {
        return {
          ...node,
          prompt: '按顺序基于主题数组"${input.topic}"，为平台"${input.platform}"生成${input.vedio_count}个短视频分镜剧本。\n模特参考图数组：${model_images.items}\n只返回 JSON 数组，不要 Markdown，每个数组对象必须包含：title、content、duration、camera、mood、firstFramePrompt。每个视频只使用主题数组中对应序号的一个主题，并保持模特参考图中的角色特征一致。',
        }
      }
      if (node.id === 'node-image') {
        return {
          ...node,
          params: node.params.map((param) => (param.englishName === 'referenceImages' ? { ...param, value: '${model_images.items}' } : param)),
        }
      }
      return node
    }),
    edges,
  })
}

function mergeDefaultModels(stored: ModelConfig[]) {
  const ids = new Set(stored.map((model) => model.id))
  return syncSharedModelCredentials([...stored, ...initialModels.filter((model) => !ids.has(model.id))])
}

// The regression executes this same production merge with an empty database.
// eslint-disable-next-line react-refresh/only-export-components
export async function mergeDefaultWorkflows(stored: Workflow[], fetcher: typeof fetch = fetch): Promise<Workflow[]> {
  const ids = new Set(stored.map((workflow) => workflow.id))
  // A new database gets the reviewed graph. Existing Sanguo rows, including
  // user edits and paid-history topology, never take this cold-start path.
  const sanguoDefault = ids.has('wf-sanguo-history-drama')
    ? [] : [await loadSanguoDefaultWorkflow<Workflow>(fetcher)]
  const otherDefaults = initialWorkflows.filter((workflow) =>
    workflow.id !== 'wf-sanguo-history-drama' && !ids.has(workflow.id))
  return [...stored, ...sanguoDefault, ...otherDefaults]
    .map(normalizeWorkflow)
    .map(workflow => addOriginalVoiceNode(workflow, 'bailian-qwen-audio-tts-plus'))
}

function App() {
  const restoredViewRef = useRef(loadAppViewState(window.sessionStorage))
  const viewportRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const canvasPanRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const canvasViewRef = useRef({ zoom: 1, x: 0, y: 0 })
  const runnerViewportRef = useRef<HTMLDivElement>(null)
  const runnerPanelRef = useRef<HTMLElement>(null)
  const runnerFullscreenActiveRef = useRef(false)
  const runnerPanRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null)
  const runnerViewRef = useRef({ zoom: 1, x: 0, y: 0 })
  const modelTestAbortRef = useRef<Record<string, AbortController>>({})
  const legacyVideoRecoveryRef = useRef(new Set<string>())
  const workflowInfoOpenRef = useRef(false)
  const stepExecutionLockRef = useRef(false)
  const failedTextRetryLockRef = useRef(false)
  const [failedTextRetryLoading, setFailedTextRetryLoading] = useState(false)
  const fullExecutionLockRef = useRef(false)
  const fullPauseRequestedRef = useRef(false)
  const [fullPauseRequested, setFullPauseRequested] = useState(false)
  const runnerAutoFollowRef = useRef(true)
  const [navCollapsed, setNavCollapsed] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [page, setPageState] = useState<AppPage>(restoredViewRef.current.page ?? 'workflow')
  const setPage = (next: AppPage) => { setInspectorOpen(false); setPageState(next) }
  const [workflows, setWorkflowsState] = useState<Workflow[]>(initialWorkflows)
  const [models, setModelsState] = useState<ModelConfig[]>(initialModels)
  const [draftModels, setDraftModels] = useState<ModelConfig[]>(initialModels)
  const restoredWorkflow = workflows.find((workflow) => workflow.id === restoredViewRef.current.activeWorkflowId) ?? workflows[0]
  const [activeWorkflowId, setActiveWorkflowId] = useState(restoredViewRef.current.activeWorkflowId ?? restoredWorkflow?.id ?? '')
  const activeWorkflowIdRef = useRef(activeWorkflowId)
  activeWorkflowIdRef.current = activeWorkflowId
  const [selectedNodeId, setSelectedNodeId] = useState(restoredWorkflow?.nodes[0]?.id ?? '')
  const [modelTab, setModelTab] = useState<ModelCapability>('text')
  const [modelView, setModelView] = useState<ModelView>({ mode: 'list' })
  const [modelTestParams, setModelTestParams] = useState<Record<string, Record<string, ExperienceValue>>>({})
  const [modelTestRuns, setModelTestRuns] = useState<Record<string, ExperienceRun>>(loadStoredExperienceRuns)
  const [modelTaskIds, setModelTaskIds] = useState<Record<string, string>>({})
  const [modelExecutionRecords, setModelExecutionRecords] = useState<ModelExecutionRecord[]>([])
  const [modelExecutionFilters, setModelExecutionFilters] = useState<ModelExecutionFilters>({ channel: '', modelId: '', status: '', capability: '', keyword: '' })
  const [modelExecutionLoading, setModelExecutionLoading] = useState(false)
  const [modelExecutionRefresh, setModelExecutionRefresh] = useState(0)
  const [experienceSource, setExperienceSource] = useState<ExperienceSource | null>(null)
  const [workflowView, setWorkflowViewState] = useState<WorkflowView>(restoredViewRef.current.workflowView ?? 'list')
  const setWorkflowView = (next: WorkflowView) => { setInspectorOpen(false); setWorkflowViewState(next) }
  const workflowViewRef = useRef(workflowView)
  workflowViewRef.current = workflowView
  const [workflowInfoOpen, setWorkflowInfoOpen] = useState(false)
  const [workflowInfoDraft, setWorkflowInfoDraft] = useState(() => ({
    name: workflows[0]?.name ?? '',
    description: workflows[0]?.description ?? '',
  }))
  const [workflowInfoError, setWorkflowInfoError] = useState('')
  const [workflowInfoSaving, setWorkflowInfoSaving] = useState(false)
  const [runnerTab, setRunnerTab] = useState<RunnerTab>(restoredViewRef.current.runnerTab ?? 'execute')
  const [canvasSelection, setCanvasSelection] = useState<{ workflowId: string; ids: string[] } | null>(null)
  const [drag, setDrag] = useState<GraphDrag>(null)
  const [isCanvasPanning, setIsCanvasPanning] = useState(false)
  const [showCanvasMedia, setShowCanvasMedia] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [canvasOffset, setCanvasOffset] = useState({ x: 0, y: 0 })
  const [runnerZoom, setRunnerZoom] = useState(1)
  const [runnerOffset, setRunnerOffset] = useState({ x: 0, y: 0 })
  const [isRunnerPanning, setIsRunnerPanning] = useState(false)
  const [isRunnerFullscreen, setIsRunnerFullscreen] = useState(false)
  const [runnerFullscreenError, setRunnerFullscreenError] = useState('')
  const [storageDiagnostic, setStorageDiagnostic] = useState('')
  const [configLoaded, setConfigLoaded] = useState(false)
  const [configLoadError, setConfigLoadError] = useState('')
  const [configStatus, setConfigStatus] = useState('正在连接 PostgreSQL 配置库...')
  const [runMode, setRunMode] = useState<RunMode>('step')
  const [workflowDebug, setWorkflowDebug] = useState<WorkflowDebugState | null>(null)
  const suspendedExecutionViewRef = useRef<{ executionId: string; debug: WorkflowDebugState | null } | null>(null)
  const [workflowBreakpoints, setWorkflowBreakpoints] = useState(() => loadWorkflowBreakpoints(window.sessionStorage))
  const workflowBreakpointsRef = useRef(workflowBreakpoints)
  workflowBreakpointsRef.current = workflowBreakpoints
  const [breakpointEditor, setBreakpointEditor] = useState<BreakpointEditorState | null>(null)
  const [debugContinueRunning, setDebugContinueRunning] = useState(false)
  const [runtimePanelOpen, setRuntimePanelOpen] = useState(true)
  const [runnerInspectorTab, setRunnerInspectorTab] = useState<RunnerInspectorTab>('config')
  const activeWorkflow = workflows.find((workflow) => workflow.id === activeWorkflowId) ?? workflows[0]
  const selectedCanvasIds = canvasSelection?.workflowId === activeWorkflow.id ? canvasSelection.ids : [selectedNodeId]
  const expandCanvasSelection = (ids: string[]) => expandSelection(ids, (id) => activeWorkflow.nodes.find(node => node.id === id)?.kind === 'loop' ? getLoopNodes(activeWorkflow, id).map(node => node.id) : [])
  const selectCanvasNodes = (ids: string[]) => setCanvasSelection({ workflowId: activeWorkflow.id, ids })
  const selectedNode = activeWorkflow.nodes.find((node) => node.id === selectedNodeId) ?? activeWorkflow.nodes[0]
  const workflowDebugSnapshot = useMemo(() => (workflowView === 'edit' && workflowDebug ? createWorkflowDebugSnapshot(activeWorkflow, workflowDebug) : undefined), [activeWorkflow, workflowDebug, workflowView])
  const [, setRunResult] = useState(() => executeWorkflow(activeWorkflow))
  const [executionState, setExecutionState] = useState<ExecutionState>(() => {
    const state = createExecutionState(activeWorkflow, 'step')
    return restoredViewRef.current.executionId ? { ...state, id: restoredViewRef.current.executionId } : state
  })
  const executionStateIdRef = useRef(executionState.id)
  executionStateIdRef.current = executionState.id
  const [executionRecords, setExecutionRecords] = useState<ExecutionRecordListItem[]>([])
  const [executionRecordLoadingId, setExecutionRecordLoadingId] = useState('')
  const [selectedRunIndex, setSelectedRunIndex] = useState(0)
  const [rollbackDialog, setRollbackDialog] = useState<{ executionId: string; targetRunId: string; mode: 'previous' | 'specific'; error?: string } | null>(null)
  const [rollbackSaving, setRollbackSaving] = useState(false)
  const rollbackSaveLock = useRef(false)
  const [selectedLoopSnapshot, setSelectedLoopSnapshot] = useState<{ groupId: string; loopIndex: number } | null>(null)
  const [branchSceneSelection, setBranchSceneSelection] = useState<{ executionId: string; index: number } | null>(null)
  const [runnerAutoFollow, setRunnerAutoFollow] = useState(true)
  const [mediaPreview, setMediaPreview] = useState<MediaPreviewState | null>(null)
  const [textPreview, setTextPreview] = useState<TextPreviewState | null>(null)
  const [legacyVideoRecoveryStatus, setLegacyVideoRecoveryStatus] = useState<Record<string, string>>({})
  const selectedCapability: ModelCapability | undefined = selectedNode?.kind === 'asset' && selectedNode.operation !== 'character.lookup'
    ? 'image'
    : selectedNode?.kind === 'text' || selectedNode?.kind === 'image' || selectedNode?.kind === 'video' || selectedNode?.kind === 'audio'
      ? selectedNode.kind
      : undefined
  const availableModels = models.filter((model) => selectedCapability && model.capability === selectedCapability)
  const executionOrder = getExecutionOrder(activeWorkflow)
  const debugLoopInfo = workflowDebug
    ? executionState.nodeRuns[workflowDebug.stepIndex]?.inputContext?.loop ?? executionState.nodeRuns[workflowDebug.stepIndex]?.context?.loop
    : undefined
  const debugLoopLabel =
    debugLoopInfo && typeof debugLoopInfo === 'object' && 'index' in debugLoopInfo ? `，第 ${String(debugLoopInfo.index)} 轮` : ''
  const isWorkflowDetail = workflowView === 'detail'
  const canvasNodes = useMemo(() => projectCanvasNodes(activeWorkflow.nodes, showCanvasMedia), [activeWorkflow.nodes, showCanvasMedia])
  const canvasYScale = canvasMediaScale(showCanvasMedia)
  const canvasWorkflow = { ...activeWorkflow, nodes: canvasNodes }
  const graphWidth = Math.max(1300, ...canvasNodes.map((node) => node.position.x + 280))
  const graphHeight = Math.max(560, ...canvasNodes.map((node) => node.position.y + (showCanvasMedia ? CANVAS_MEDIA_NODE_HEIGHT + 120 : 260)))
  const branchScenes = (executionState.branchHistory ?? []).filter(entry => entry.backwards && Array.isArray(entry.scene))
  const branchSceneIndex = branchSceneSelection?.executionId === executionState.id ? branchSceneSelection.index : undefined
  const historicalBranchScene = branchSceneIndex !== undefined ? branchScenes[branchSceneIndex] : undefined
  const viewingBranchHistory = Boolean(historicalBranchScene)
  const inspectedRuns = historicalBranchScene ? historicalBranchScene.scene as NodeRunState[] : executionState.nodeRuns
  const selectedRun = inspectedRuns[selectedRunIndex] ?? inspectedRuns.find((run) => run.node.id === executionState.selectedNodeId && run.status !== 'idle')
  const visibleBranchSceneIndices = branchSceneIndicesForRun(branchScenes, selectedRun)
  const loopGroupIds = useMemo(
    () => [...new Set(inspectedRuns.map((run) => run.loopGroupId).filter((groupId): groupId is string => Boolean(groupId)))],
    [inspectedRuns],
  )
  const activeLoopGroupId = selectedLoopSnapshot && loopGroupIds.includes(selectedLoopSnapshot.groupId)
    ? selectedLoopSnapshot.groupId
    : selectedRun?.loopGroupId
  const activeLoopIterations = activeLoopGroupId ? availableLoopIterations(inspectedRuns, activeLoopGroupId) : []
  const latestLoopIteration = inspectedRuns.find(run => run.loopGroupId === activeLoopGroupId && run.status === 'running')?.loopIndex
    ?? inspectedRuns.find(run => run.loopGroupId === activeLoopGroupId && run.status === 'failed')?.loopIndex
    ?? activeLoopIterations.find(index => inspectedRuns.some(run => run.loopGroupId === activeLoopGroupId && run.loopIndex === index && run.status === 'idle'))
    ?? activeLoopIterations.at(-1)
  let activeLoopIteration = latestLoopIteration
  if (selectedLoopSnapshot && selectedLoopSnapshot.groupId === activeLoopGroupId) {
    activeLoopIteration = selectedLoopSnapshot.loopIndex
  } else if (selectedRun?.loopGroupId && selectedRun.loopGroupId === activeLoopGroupId) {
    activeLoopIteration = selectedRun.loopIndex
  }
  const viewingHistoricalLoopSnapshot = activeLoopIteration !== undefined && latestLoopIteration !== undefined && activeLoopIteration !== latestLoopIteration
  // Use the exact displayed run, including loop/branch history. Never infer output from aggregate context.
  const canvasRunsByNode = useMemo(() => {
    const result = new Map<string, NodeRunState>()
    if (executionState.workflowId !== activeWorkflow.id) return result
    for (const node of activeWorkflow.nodes) {
      const runs = inspectedRuns.filter(run => run.node.id === node.id)
      const isRepeated = Boolean(activeLoopGroupId && runs.some(run => run.loopGroupId === activeLoopGroupId))
      const run = isRepeated
        ? runs.find(run => run.loopGroupId === activeLoopGroupId && run.loopIndex === activeLoopIteration)
        : runs.find(run => run.status === 'running') ?? runs.filter(run => run.status !== 'idle').at(-1) ?? runs[0]
      if (run) result.set(node.id, run)
    }
    return result
  }, [activeWorkflow.id, activeWorkflow.nodes, executionState.workflowId, inspectedRuns, activeLoopGroupId, activeLoopIteration])
  const canvasMediaByNode = useMemo(() => {
    const staticContext: Record<string, unknown> = {}
    for (const node of activeWorkflow.nodes) {
      if (node.kind === 'input') {
        const values = nodeParamValues(node)
        Object.assign(staticContext, nodeParamAliases(node, values), { [node.resultVar]: values })
      } else if (node.kind === 'image' && !node.modelId && node.uploads.length) {
        staticContext[node.resultVar] = uploadedImageOutput(node)
      }
    }
    return new Map(activeWorkflow.nodes.map(node => {
      const run = canvasRunsByNode.get(node.id)
      if (workflowView === 'run' && run && run.status !== 'idle') {
        return [node.id, resolveCanvasMedia(run.node, { run })]
      }
      // Config previews update immediately with edits; outputs still belong to the selected run.
      const references = resolveCanvasMedia(workflowView === 'run' && run ? run.node : node, { context: workflowView === 'run' && run?.inputContext ? { ...staticContext, ...run.inputContext } : staticContext })
      const outputs = run ? resolveCanvasMedia(run.node, { run }).filter(item => item.source === 'output') : []
      return [node.id, [...outputs, ...references]]
    }))
  }, [activeWorkflow.nodes, canvasRunsByNode, workflowView])
  const hasCanvasMedia = (node: WorkflowNode) => showCanvasMedia && node.kind !== 'branch' && node.kind !== 'loop' && Boolean(canvasMediaKind(node) || canvasMediaByNode.get(node.id)?.length)
  const canvasNodeHeight = (node: WorkflowNode) => hasCanvasMedia(node) ? CANVAS_MEDIA_NODE_HEIGHT : 154
  const openCanvasMedia = (item: CanvasMedia) => {
    if (item.kind === 'audio') return
    setMediaPreview({ url: item.url, kind: item.kind, label: item.label, filename: item.filename ?? `preview.${item.kind === 'image' ? 'png' : 'mp4'}` })
  }
  const renderCanvasMedia = (node: WorkflowNode) => hasCanvasMedia(node) ? <CanvasNodeMedia
    key={`${executionState.workflowId === activeWorkflow.id ? executionState.id : activeWorkflow.id}:${canvasRunsByNode.get(node.id)?.id ?? node.id}`}
    items={canvasMediaByNode.get(node.id) ?? []} kind={canvasMediaKind(node)}
    status={canvasRunsByNode.get(node.id)?.status} nodeTitle={node.title} onPreview={openCanvasMedia}
  /> : null
  const runtimeInputNodes = activeWorkflow.nodes.filter((node) => node.kind === 'input')
  const runtimeParamCount = runtimeInputNodes.reduce((count, node) => count + node.params.length, 0)
  const isStepDebugActive = runMode === 'step' && workflowDebug !== null
  const breakpointByNodeId = useMemo(
    () => new Map((workflowBreakpoints[activeWorkflow.id] ?? []).filter((breakpoint) => breakpoint.enabled).map((breakpoint) => [breakpoint.nodeId, breakpoint])),
    [activeWorkflow.id, workflowBreakpoints],
  )
  const breakpointNodeIds = useMemo(() => new Set(breakpointByNodeId.keys()), [breakpointByNodeId])
  const resolveActiveBreakpoint = useMemo(
    () => createWorkflowBreakpointResolver(() => workflowBreakpointsRef.current, activeWorkflow.id),
    [activeWorkflow.id],
  )
  const currentStepRun = workflowDebug ? executionState.nodeRuns[workflowDebug.stepIndex] : undefined
  const isStepExecuting = executionState.nodeRuns.some((run) => run.status === 'running')
  const isDebugBusy = isStepExecuting || debugContinueRunning || rollbackSaving || failedTextRetryLoading
  const hasUnsavedExecution = Boolean(executionState.persistenceError)
  const canMoveToNextStep = !isDebugBusy && !hasUnsavedExecution && workflowDebug
    ? currentStepRun?.status === 'idle' || canAdvanceStep(currentStepRun?.status, workflowDebug.stepIndex, executionState.nodeRuns.length)
    : false
  const canContinueToBreakpoint = !isDebugBusy && !hasUnsavedExecution && Boolean(workflowDebug) && currentStepRun?.status !== 'failed'
  const rollbackBreakpoints = useMemo(() => [...breakpointByNodeId.values()], [breakpointByNodeId])
  const rollbackTargets = useMemo(
    () => breakpointRollbackCandidates(executionState.nodeRuns, rollbackBreakpoints),
    [executionState.nodeRuns, rollbackBreakpoints],
  )
  const previousRollbackTarget = useMemo(
    () => previousBreakpointRollbackCandidate(executionState.nodeRuns, rollbackBreakpoints,
      runMode === 'step' ? workflowDebug?.stepIndex : undefined),
    [executionState.nodeRuns, rollbackBreakpoints, runMode, workflowDebug?.stepIndex],
  )
  const rollbackDialogActive = rollbackDialog?.executionId === executionState.id && executionState.workflowId === activeWorkflow.id
  const rollbackTarget = rollbackDialogActive ? rollbackTargets.find(target => target.run.id === rollbackDialog.targetRunId
    && (rollbackDialog.mode === 'specific' || previousRollbackTarget?.run.id === target.run.id)) : undefined
  let rollbackImpact: ReturnType<typeof planBreakpointRollback> | undefined
  let rollbackError = ''
  if (rollbackDialogActive && rollbackTarget) {
    try { rollbackImpact = planBreakpointRollback(executionState.nodeRuns, rollbackBreakpoints, rollbackTarget.run.id) }
    catch (error) { rollbackError = error instanceof Error ? error.message : String(error) }
  }

  const persistWorkflowBreakpoints = (next: typeof workflowBreakpoints) => {
    // Save at the user action, before an execution update or page remount.
    // Breakpoints belong to workflow nodes, not to the moving step cursor.
    // Update the ref synchronously so an already-running continue loop sees it
    // at the next node boundary, before React has to commit another render.
    workflowBreakpointsRef.current = next
    try {
      saveWorkflowBreakpoints(window.sessionStorage, next)
    } catch {
      setStorageDiagnostic('断点已在当前页面生效，但浏览器存储不可用，刷新后可能丢失。')
    }
    setWorkflowBreakpoints(next)
  }

  const toggleBreakpoint = (nodeId: string) => {
    persistWorkflowBreakpoints(toggleWorkflowBreakpoint(workflowBreakpoints, activeWorkflow.id, nodeId))
  }

  const openBreakpointEditor = (nodeId: string) => {
    const breakpoint = breakpointByNodeId.get(nodeId)
    if (!breakpoint) {
      toggleBreakpoint(nodeId)
      return
    }
    setBreakpointEditor({
      workflowId: activeWorkflow.id,
      nodeId,
      conditional: Boolean(breakpoint.condition),
      path: breakpoint.condition?.path ?? 'loop.index',
      operator: breakpoint.condition?.operator ?? 'eq',
      value: breakpoint.condition ? formatBreakpointValue(breakpoint.condition.value) : '1',
    })
  }

  const saveBreakpointEditor = () => {
    if (!breakpointEditor || !breakpointEditor.path.trim()) return
    const breakpoint: WorkflowBreakpoint = {
      nodeId: breakpointEditor.nodeId,
      enabled: true,
      ...(breakpointEditor.conditional ? { condition: {
        path: breakpointEditor.path.trim(),
        operator: breakpointEditor.operator,
        value: parseBreakpointValue(breakpointEditor.value),
      } } : {}),
    }
    persistWorkflowBreakpoints(setWorkflowBreakpoint(workflowBreakpoints, breakpointEditor.workflowId, breakpoint))
    setBreakpointEditor(null)
  }

  const deleteBreakpointEditor = () => {
    if (!breakpointEditor) return
    persistWorkflowBreakpoints(removeWorkflowBreakpoint(workflowBreakpoints, breakpointEditor.workflowId, breakpointEditor.nodeId))
    setBreakpointEditor(null)
  }

  const setRunnerFollowMode = (enabled: boolean) => {
    runnerAutoFollowRef.current = enabled
    setRunnerAutoFollow(enabled)
  }

  const followExecutionInInspector = (runIndex: number) => {
    setSelectedRunIndex((currentIndex) => nextInspectorRunIndex(currentIndex, runIndex, runnerAutoFollowRef.current))
  }

  const inspectLoopIteration = (loopIndex: number) => {
    if (!activeLoopGroupId) return
    const runIndex = findLoopSnapshotRunIndex(inspectedRuns, activeLoopGroupId, loopIndex, selectedRun?.node.id)
    if (runIndex < 0) return
    const run = inspectedRuns[runIndex]
    setRunnerFollowMode(false)
    setSelectedLoopSnapshot({ groupId: activeLoopGroupId, loopIndex })
    setSelectedRunIndex(runIndex)
    setExecutionState((current) => ({ ...current, selectedNodeId: run.node.id }))
    setRunnerInspectorTab('input')
  }

  const returnToCurrentLoopIteration = () => {
    if (!activeLoopGroupId || latestLoopIteration === undefined) return
    const runIndex = findLoopSnapshotRunIndex(inspectedRuns, activeLoopGroupId, latestLoopIteration, selectedRun?.node.id)
    setRunnerFollowMode(true)
    setSelectedLoopSnapshot({ groupId: activeLoopGroupId, loopIndex: latestLoopIteration })
    if (runIndex < 0) return
    const run = inspectedRuns[runIndex]
    setSelectedRunIndex(runIndex)
    setExecutionState((current) => ({ ...current, selectedNodeId: run.node.id }))
  }

  const inspectRunnerNode = (nodeId: string, fallbackRunIndex: number) => {
    const historicalRun = inspectedRuns.find(run => run.node.id === nodeId
      && (!run.loopGroupId || run.loopGroupId === activeLoopGroupId && run.loopIndex === activeLoopIteration))
    const leaveBranchHistory = historicalBranchScene && !branchSceneIncludesRun(historicalBranchScene, historicalRun)
    const runs = leaveBranchHistory ? executionState.nodeRuns : inspectedRuns
    const runIndex = findInspectableNodeRunIndex(
      runs,
      nodeId,
      fallbackRunIndex,
      activeLoopGroupId,
      activeLoopIteration,
    )
    if (runIndex < 0) return
    const run = runs[runIndex]
    if (leaveBranchHistory) setBranchSceneSelection(null)
    setRunnerFollowMode(false)
    setSelectedRunIndex(runIndex)
    setExecutionState((current) => ({ ...current, selectedNodeId: nodeId }))
    setSelectedLoopSnapshot(run.loopGroupId && run.loopIndex !== undefined
      ? { groupId: run.loopGroupId, loopIndex: run.loopIndex }
      : null)
    setRunnerInspectorTab('config')
  }

  const fitGraph = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const nextZoom = fitDagZoom(viewport.clientWidth, viewport.clientHeight, graphWidth, graphHeight)
    setZoom(nextZoom)
    const nextOffset = {
      x: Math.max(14, (viewport.clientWidth - graphWidth * nextZoom) / 2),
      y: Math.max(14, (viewport.clientHeight - graphHeight * nextZoom) / 2),
    }
    canvasViewRef.current = { zoom: nextZoom, ...nextOffset }
    setCanvasOffset(nextOffset)
  }, [graphWidth, graphHeight])

  const fitRunnerGraph = useCallback(() => {
    const viewport = runnerViewportRef.current
    if (!viewport) return
    const nextZoom = fitDagZoom(viewport.clientWidth, viewport.clientHeight, graphWidth, graphHeight, 64)
    const offset = { x: (viewport.clientWidth - graphWidth * nextZoom) / 2, y: 50 + (viewport.clientHeight - 64 - graphHeight * nextZoom) / 2 }
    runnerViewRef.current = { zoom: nextZoom, ...offset }
    setRunnerZoom(nextZoom)
    setRunnerOffset(offset)
  }, [graphWidth, graphHeight])

  const zoomRunnerBy = useCallback((factor: number) => {
    const viewport = runnerViewportRef.current
    if (!viewport) return
    const currentView = runnerViewRef.current
    const fitZoom = fitDagZoom(viewport.clientWidth, viewport.clientHeight, graphWidth, graphHeight, 64)
    const nextZoom = wheelDagZoom(currentView.zoom, -Math.log(factor) / 0.003, fitZoom)
    if (nextZoom === currentView.zoom) return
    const nextView = zoomDagAt(currentView, nextZoom, { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 })
    runnerViewRef.current = nextView
    setRunnerZoom(nextZoom)
    setRunnerOffset({ x: nextView.x, y: nextView.y })
  }, [graphWidth, graphHeight])

  const zoomCanvasBy = (factor: number) => {
    const viewport = viewportRef.current
    if (!viewport) return
    const currentView = canvasViewRef.current
    const nextZoom = wheelDagZoom(currentView.zoom, -Math.log(factor) / 0.003, fitDagZoom(viewport.clientWidth, viewport.clientHeight, graphWidth, graphHeight))
    const nextView = zoomDagAt(currentView, nextZoom, { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 })
    canvasViewRef.current = nextView
    setZoom(nextZoom)
    setCanvasOffset({ x: nextView.x, y: nextView.y })
  }

  const toggleRunnerFullscreen = async () => {
    const panel = runnerPanelRef.current
    if (!panel) return
    setRunnerFullscreenError('')
    try {
      if (document.fullscreenElement === panel) await document.exitFullscreen()
      else await panel.requestFullscreen()
    } catch {
      setRunnerFullscreenError('浏览器未能切换全屏，请检查页面权限后重试。')
    }
  }

  useEffect(() => {
    let fitFrame = 0
    const syncFullscreen = () => {
      const panel = runnerPanelRef.current
      const nextFullscreen = Boolean(panel && document.fullscreenElement === panel)
      const changed = nextFullscreen !== runnerFullscreenActiveRef.current
      runnerFullscreenActiveRef.current = nextFullscreen
      setIsRunnerFullscreen(nextFullscreen)
      setRunnerFullscreenError('')
      if (changed) {
        window.cancelAnimationFrame(fitFrame)
        fitFrame = window.requestAnimationFrame(fitRunnerGraph)
      }
    }
    document.addEventListener('fullscreenchange', syncFullscreen)
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreen)
      window.cancelAnimationFrame(fitFrame)
    }
  }, [fitRunnerGraph])

  const onRunnerWheel = useCallback((event: globalThis.WheelEvent) => {
    if ((event.target as Element).closest('.canvas-node-media')) return
    event.preventDefault()
    event.stopPropagation()
    const viewport = runnerViewportRef.current
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    const pointerX = event.clientX - rect.left
    const pointerY = event.clientY - rect.top
    const currentView = runnerViewRef.current
    const nextZoom = wheelDagZoom(currentView.zoom, event.deltaY, fitDagZoom(viewport.clientWidth, viewport.clientHeight, graphWidth, graphHeight, 64))
    if (nextZoom === currentView.zoom) return
    const nextView = zoomDagAt(currentView, nextZoom, { x: pointerX, y: pointerY })
    runnerViewRef.current = nextView
    setRunnerZoom(nextZoom)
    setRunnerOffset({ x: nextView.x, y: nextView.y })
  }, [graphWidth, graphHeight])

  useEffect(() => {
    const viewport = runnerViewportRef.current
    if (!configLoaded || !viewport || page !== 'workflow' || workflowView !== 'run' || runnerTab !== 'execute') return undefined
    viewport.addEventListener('wheel', onRunnerWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onRunnerWheel)
  }, [configLoaded, onRunnerWheel, page, runnerTab, workflowView])

  useEffect(() => {
    if (!mediaPreview) return undefined
    const previousOverflow = document.body.style.overflow
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMediaPreview(null)
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [mediaPreview])

  useEffect(() => {
    if (!textPreview) return undefined
    const previousOverflow = document.body.style.overflow
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTextPreview(null)
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [textPreview])

  useEffect(() => {
    if (!rollbackDialogActive) return undefined
    const previousOverflow = document.body.style.overflow
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !rollbackSaveLock.current) setRollbackDialog(null)
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [rollbackDialogActive])

  useEffect(() => () => {
    Object.values(modelTestAbortRef.current).forEach((controller) => controller.abort())
  }, [])

  useEffect(() => {
    const stored = Object.fromEntries(Object.entries(modelTestRuns).map(([modelId, run]) => [modelId, { ...run, rawBody: undefined }]))
    window.localStorage.setItem(EXPERIENCE_RUNS_STORAGE_KEY, JSON.stringify(stored))
  }, [modelTestRuns])

  useEffect(() => {
    if (!configLoaded) return
    saveAppViewState(window.sessionStorage, { page, workflowView, activeWorkflowId, runnerTab, executionId: executionState.id })
  }, [activeWorkflowId, executionState.id, page, runnerTab, workflowView, configLoaded])

  useEffect(() => {
    if (!isDebugBusy) return undefined
    const protectActiveExecution = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', protectActiveExecution)
    return () => window.removeEventListener('beforeunload', protectActiveExecution)
  }, [isDebugBusy])

  const startRunnerPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0 || (event.target as HTMLElement).closest('.dag-node,.dag-toolbar,.breakpoint-toggle')) return
    const viewport = runnerViewportRef.current
    if (!viewport) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    runnerPanRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: runnerViewRef.current.x, top: runnerViewRef.current.y }
    setIsRunnerPanning(true)
  }

  const moveRunnerPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = runnerPanRef.current
    const viewport = runnerViewportRef.current
    if (!pan || pan.pointerId !== event.pointerId || !viewport) return
    event.preventDefault()
    const offset = { x: pan.left + event.clientX - pan.x, y: pan.top + event.clientY - pan.y }
    runnerViewRef.current = { ...runnerViewRef.current, ...offset }
    setRunnerOffset(offset)
  }

  const stopRunnerPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = runnerPanRef.current
    if (!pan || pan.pointerId !== event.pointerId) return
    runnerPanRef.current = null
    setIsRunnerPanning(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const fitGraphRef = useRef(fitGraph)
  fitGraphRef.current = fitGraph
  useEffect(() => {
    if (!configLoaded) return undefined
    const id = window.requestAnimationFrame(() => fitGraphRef.current())
    return () => window.cancelAnimationFrame(id)
  }, [activeWorkflow.id, configLoaded, workflowView, showCanvasMedia])

  useEffect(() => {
    if (!configLoaded || page !== 'workflow' || workflowView !== 'run' || runnerTab !== 'execute') return undefined
    const id = window.requestAnimationFrame(fitRunnerGraph)
    return () => window.cancelAnimationFrame(id)
  }, [activeWorkflow.id, configLoaded, page, workflowView, runnerTab, fitRunnerGraph])

  const executionSaveQueue = useMemo(() => createExecutionSaveQueue(), [])
  const persistExecution = useCallback((state: ExecutionState): Promise<PersistenceResult> => {
    const savedState = { ...state }
    delete savedState.persistenceError
    const record: ExecutionRecord = {
      id: state.id,
      workflowId: state.workflowId,
      workflowName: state.workflowName,
      mode: state.mode,
      title: `${state.mode === 'step' ? '单步调试' : '完整执行'} · ${new Date().toLocaleString()}`,
      runtimeInputs: state.runtimeInputs,
      result: savedState,
    }
    return executionSaveQueue(async () => {
      try {
        await saveExecutionRecord(record)
        const listItem: ExecutionRecordListItem = {
          ...record,
          succeededCount: state.nodeRuns.filter((run) => run.status === 'success').length,
          failedCount: state.nodeRuns.filter((run) => run.status === 'failed').length,
          totalCount: state.nodeRuns.length,
        }
        setExecutionRecords((current) => [listItem, ...current.filter((item) => item.id !== record.id)].slice(0, 40))
        return { saved: true } as const
      } catch (error) {
        const message = `执行记录保存失败：${error instanceof Error ? error.message : String(error)}`
        setConfigStatus(message)
        setExecutionState(current => current.id === state.id ? { ...current, persistenceError: message } : current)
        return { saved: false, error: message } as const
      }
    })
  }, [executionSaveQueue])

  const retryExecutionSave = async () => {
    const state = executionState
    const result = await persistExecution(state)
    if (result.saved) {
      setExecutionState(current => current.id === state.id ? { ...current, persistenceError: undefined } : current)
      setConfigStatus('执行记录已保存，可继续运行')
    }
  }

  useEffect(() => {
    let cancelled = false
    async function hydrateConfig() {
      try {
        const stored = await loadConfigFromDatabase()
        if (cancelled) return
        const nextModels = mergeDefaultModels(stored.models)
        const nextWorkflows = await mergeDefaultWorkflows(stored.workflows)
        if (cancelled) return
        const repairedDamagedWorkflowText = stored.workflows.some(hasDamagedSanguoCanonicalText)
        const modelsChanged = serializedValuesDiffer(stored.models, nextModels)
        const workflowsChanged = serializedValuesDiffer(stored.workflows, nextWorkflows)
        const hydratedWorkflow = nextWorkflows.find((workflow) => workflow.id === activeWorkflowIdRef.current) ?? nextWorkflows[0]
        setModelsState(nextModels)
        setDraftModels(nextModels)
        setWorkflowsState(nextWorkflows)
        setActiveWorkflowId(hydratedWorkflow?.id ?? '')
        setSelectedNodeId(hydratedWorkflow?.nodes[0]?.id ?? '')
        let recoveredExecution: ExecutionRecord | undefined
        if (workflowViewRef.current === 'run' && executionStateIdRef.current) {
          try {
            const loaded = await loadExecutionRecord(executionStateIdRef.current)
            if (loaded.record.workflowId === hydratedWorkflow?.id) recoveredExecution = loaded.record
          } catch {
            // A newly opened runner may not have written its first checkpoint yet.
          }
        }
        if (hydratedWorkflow && recoveredExecution) {
          const upgradedRuns = migrateBranchRuns(hydratedWorkflow, recoveredExecution.result.nodeRuns)
          const recovered = recoverInterruptedNodeRuns(upgradedRuns)
          const restoredExecution = {
            ...recoveredExecution.result,
            ...(upgradedRuns !== recoveredExecution.result.nodeRuns ? { id: createId('record'), requestScopeId: recoveredExecution.result.requestScopeId ?? recoveredExecution.result.id } : {}),
            historical: false,
            nodeRuns: recovered.nodeRuns,
            selectedNodeId: recovered.nodeRuns[recovered.resumeIndex]?.node.id,
          }
          if (upgradedRuns !== recoveredExecution.result.nodeRuns) void persistExecution(restoredExecution)
          setRunMode(recoveredExecution.mode)
          setExecutionState(restoredExecution)
          setSelectedNodeId(restoredExecution.selectedNodeId ?? hydratedWorkflow.nodes[0]?.id ?? '')
          setSelectedRunIndex(recovered.resumeIndex)
          setWorkflowDebug(recoveredExecution.mode === 'step' ? { stepIndex: recovered.resumeIndex } : null)
          setRuntimePanelOpen(false)
          setSelectedLoopSnapshot(null)
        } else if (hydratedWorkflow) {
          const nextExecution = createExecutionState(hydratedWorkflow, 'step')
          setExecutionState({ ...nextExecution, selectedNodeId: undefined })
          setSelectedRunIndex(-1)
          setWorkflowDebug(null)
          setSelectedLoopSnapshot(null)
        }
        if (!workflowInfoOpenRef.current) {
          setWorkflowInfoDraft({ name: hydratedWorkflow?.name ?? '', description: hydratedWorkflow?.description ?? '' })
          setWorkflowInfoError('')
        }
        if (hydratedWorkflow) setRunResult(executeWorkflow(hydratedWorkflow))
        setConfigLoaded(true)
        const defaultsAdded = nextModels.length !== stored.models.length || nextWorkflows.length !== stored.workflows.length
        const workflowMigrated = workflowsChanged && !defaultsAdded
        setConfigStatus(recoveredExecution
          ? '检测到页面重建，已恢复上次执行检查点；被中断的节点可直接重新执行'
          : stored.models.length || stored.workflows.length
          ? repairedDamagedWorkflowText
            ? 'PostgreSQL 配置已加载，已修复三国工作流中的损坏文本'
            : defaultsAdded
              ? 'PostgreSQL 配置已加载，并补充三国工作流兼容模板'
              : workflowMigrated
                ? 'PostgreSQL 配置已加载，并已持久化最新工作流拓扑'
              : 'PostgreSQL 配置已加载'
          : 'PostgreSQL 空库已写入默认配置')
        if (modelsChanged) void saveModelsToDatabase(nextModels)
        if (workflowsChanged) void saveWorkflowsToDatabase(nextWorkflows).catch((error) => {
          setConfigStatus(`工作流迁移持久化失败：${error instanceof Error ? error.message : String(error)}`)
        })
      } catch (error) {
        if (cancelled) return
        const message = error instanceof Error ? error.message : String(error)
        setConfigLoadError(message)
        setConfigStatus(`PostgreSQL 连接失败：${message}`)
      }
    }
    void hydrateConfig()
    return () => {
      cancelled = true
    }
  }, [persistExecution])

  useEffect(() => {
    if (!configLoaded) return undefined
    const id = window.setTimeout(() => {
      void saveWorkflowsToDatabase(workflows).catch((error) => {
        setConfigStatus(`工作流同步失败：${error instanceof Error ? error.message : String(error)}`)
      })
    }, 500)
    return () => window.clearTimeout(id)
  }, [workflows, configLoaded])

  useEffect(() => {
    if (!configLoaded) return
    const executableWorkflow = normalizeWorkflow(activeWorkflow)
    if (!serializedValuesDiffer(activeWorkflow, executableWorkflow)) return
    setWorkflowsState((current) => current.map((workflow) => workflow.id === executableWorkflow.id ? executableWorkflow : workflow))
    setConfigStatus('检测到工作流规则升级，已在执行前更新当前工作流')
  }, [activeWorkflow, configLoaded])

  useEffect(() => {
    if (!configLoaded || runMode !== 'step' || workflowView !== 'run' || executionState.historical || executionState.workflowId !== activeWorkflow.id) return
    if (!hasExecutionPlanMismatch(activeWorkflow, executionState.nodeRuns)) return
    if (executionState.nodeRuns.some(run => run.status !== 'idle')) {
      const nodeRuns = refreshPendingExecutionNodes(activeWorkflow, executionState.nodeRuns)
      if (nodeRuns !== executionState.nodeRuns) setExecutionState(current => ({ ...current, nodeRuns }))
      setConfigStatus(isDurationPolicyTransition(activeWorkflow, executionState.nodeRuns)
        ? '此记录使用旧时长策略，已冻结原排程和成片证据；新策略需新建执行并从分镜重新规划'
        : '已保留执行检查点及成片证据，未开始的节点使用最新兼容配置')
      return
    }
    const nextExecution = createExecutionState(activeWorkflow, 'step')
    setRunMode('step')
    setWorkflowDebug(null)
    setSelectedLoopSnapshot(null)
    setExecutionState({ ...nextExecution, selectedNodeId: undefined })
    setSelectedRunIndex(-1)
    setRunResult(executeWorkflow(activeWorkflow))
    setConfigStatus('检测到工作流拓扑升级，已清除旧运行器节点快照')
  }, [activeWorkflow, configLoaded, executionState.historical, executionState.nodeRuns, executionState.workflowId, runMode, workflowView])

  useEffect(() => {
    if (!configLoaded || workflowView !== 'run' || runnerTab !== 'history') return
    void loadExecutionRecords(activeWorkflow.id)
      .then((data) => setExecutionRecords(data.records))
      .catch((error) => setConfigStatus(`执行记录加载失败：${error instanceof Error ? error.message : String(error)}`))
  }, [activeWorkflow.id, configLoaded, runnerTab, workflowView])

  useEffect(() => {
    if (!configLoaded || page !== 'models' || modelView.mode !== 'runs') return undefined
    let cancelled = false
    const timer = window.setTimeout(() => {
      setModelExecutionLoading(true)
      void loadModelExecutionRecords(modelExecutionFilters)
        .then((data) => {
          if (!cancelled) setModelExecutionRecords(data.records)
        })
        .catch((error) => {
          if (!cancelled) setConfigStatus(`模型执行流水加载失败：${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => {
          if (!cancelled) setModelExecutionLoading(false)
        })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [configLoaded, modelExecutionFilters, modelExecutionRefresh, modelView.mode, page])

  const setWorkflows = (recipe: (current: Workflow[]) => Workflow[]) => setWorkflowsState((current) => recipe(current))
  const saveSingleModel = async (modelId: string) => {
    const model = draftModels.find((item) => item.id === modelId)
    if (!model) return
    const affectedIds = new Set(sharedCredentialModelIds(modelId))
    const draftsById = new Map(draftModels.map((item) => [item.id, item]))
    const nextModels = models.map((item) => (affectedIds.has(item.id) ? draftsById.get(item.id) ?? item : item))
    const mergedModels = nextModels.some((item) => item.id === modelId) ? nextModels : [...nextModels, model]
    try {
      await saveModelsToDatabase(mergedModels)
      setModelsState(mergedModels)
      setConfigStatus('模型配置已写入 PostgreSQL')
      setStorageDiagnostic(JSON.stringify({ saved: true, storage: 'postgresql', models: getModelStorageSummary(mergedModels.filter((item) => affectedIds.has(item.id))) }, null, 2))
    } catch (error) {
      setConfigStatus(`模型配置保存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const updateActiveWorkflow = (recipe: (workflow: Workflow) => Workflow) =>
    setWorkflows((current) => current.map((workflow) => (workflow.id === activeWorkflow.id ? recipe(workflow) : workflow)))
  const openWorkflowInfo = () => {
    setWorkflowInfoDraft({ name: activeWorkflow.name, description: activeWorkflow.description })
    setWorkflowInfoError('')
    workflowInfoOpenRef.current = true
    setWorkflowInfoOpen(true)
  }
  const closeWorkflowInfo = () => {
    setWorkflowInfoDraft({ name: activeWorkflow.name, description: activeWorkflow.description })
    setWorkflowInfoError('')
    workflowInfoOpenRef.current = false
    setWorkflowInfoOpen(false)
  }
  const saveWorkflowInfo = async () => {
    const name = workflowInfoDraft.name.trim()
    const description = workflowInfoDraft.description.trim()
    if (!name) {
      setWorkflowInfoError('请输入工作流名称')
      return
    }

    const workflowId = activeWorkflow.id
    const nextWorkflows = workflows.map((workflow) =>
      workflow.id === workflowId ? { ...workflow, name, description } : workflow,
    )
    setWorkflowInfoSaving(true)
    setWorkflowInfoError('')
    try {
      await saveWorkflowsToDatabase(nextWorkflows)
      setWorkflowsState((current) => current.map((workflow) =>
        workflow.id === workflowId ? { ...workflow, name, description } : workflow,
      ))
      setWorkflowInfoDraft({ name, description })
      workflowInfoOpenRef.current = false
      setWorkflowInfoOpen(false)
      setConfigStatus('工作流基础信息已写入 PostgreSQL')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setWorkflowInfoError(`保存失败：${message}`)
      setConfigStatus(`工作流基础信息保存失败：${message}`)
    } finally {
      setWorkflowInfoSaving(false)
    }
  }
  const updateNode = (id: string, patch: Partial<WorkflowNode>) =>
    updateActiveWorkflow((workflow) => ({ ...workflow, nodes: workflow.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)) }))
  const updateParam = (nodeId: string, paramId: string, patch: Partial<WorkflowParam>) =>
    updateActiveWorkflow((workflow) => ({
      ...workflow,
      nodes: workflow.nodes.map((node) =>
        node.id === nodeId ? { ...node, params: node.params.map((param) => (param.id === paramId ? { ...param, ...patch } : param)) } : node,
      ),
    }))
  const canvasPoint = (event: MouseEvent) => {
    const rect = surfaceRef.current?.getBoundingClientRect()
    return rect ? { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom } : { x: 0, y: 0 }
  }

  const onCanvasWheel = useCallback((event: globalThis.WheelEvent) => {
    if ((event.target as Element).closest('.canvas-node-media')) return
    event.preventDefault()
    event.stopPropagation()
    const viewport = viewportRef.current
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    const pointerX = event.clientX - rect.left
    const pointerY = event.clientY - rect.top

    const currentView = canvasViewRef.current
    const nextZoom = wheelDagZoom(currentView.zoom, event.deltaY, fitDagZoom(viewport.clientWidth, viewport.clientHeight, graphWidth, graphHeight))
    if (nextZoom === currentView.zoom) return

    const nextView = zoomDagAt(currentView, nextZoom, { x: pointerX, y: pointerY })
    const nextOffset = { x: nextView.x, y: nextView.y }
    canvasViewRef.current = { zoom: nextZoom, ...nextOffset }
    setZoom(nextZoom)
    setCanvasOffset(nextOffset)
  }, [graphWidth, graphHeight])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!configLoaded || !viewport || (workflowView !== 'edit' && workflowView !== 'detail')) return undefined
    viewport.addEventListener('wheel', onCanvasWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onCanvasWheel)
  }, [configLoaded, onCanvasWheel, workflowView])

  const startCanvasPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.dag-node,.edge-path,.dag-toolbar')) return
    const viewport = viewportRef.current
    if (!viewport) return
    if (event.shiftKey && !isWorkflowDetail) {
      const start = canvasPoint(event)
      const bounds = Array.from(surfaceRef.current?.querySelectorAll<HTMLElement>('[data-canvas-node-id]') ?? []).map(element => ({
        id: element.dataset.canvasNodeId!, x: element.offsetLeft, y: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight,
      }))
      selectCanvasNodes([])
      setDrag({ type: 'selection', start, end: start, bounds })
      return
    }
    selectCanvasNodes([])
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const offset = canvasViewRef.current
    canvasPanRef.current = { x: event.clientX, y: event.clientY, left: offset.x, top: offset.y }
    setIsCanvasPanning(true)
  }

  const stopCanvasPan = () => {
    canvasPanRef.current = null
    setIsCanvasPanning(false)
    setDrag(null)
  }

  const rememberExecutionView = () => {
    if (workflowDebug || suspendedExecutionViewRef.current?.executionId !== executionState.id) {
      suspendedExecutionViewRef.current = { executionId: executionState.id, debug: workflowDebug }
    }
  }
  const returnToExecution = () => {
    const workflow = workflows.find(item => item.id === executionState.workflowId)
    if (!workflow) return
    const suspended = suspendedExecutionViewRef.current
    if (suspended?.executionId === executionState.id) setWorkflowDebug(suspended.debug)
    suspendedExecutionViewRef.current = null
    setActiveWorkflowId(workflow.id)
    setSelectedNodeId(executionState.selectedNodeId ?? workflow.nodes[0]?.id ?? '')
    setWorkflowInfoDraft({ name: workflow.name, description: workflow.description })
    setRunMode(executionState.mode)
    setPage('workflow')
    setWorkflowView('run')
    setRunnerTab('execute')
  }
  const addWorkflow = () => {
    if (isDebugBusy || hasUnsavedExecution) return
    rememberExecutionView()
    const node: WorkflowNode = {
      id: createId('node'),
      title: '项目输入',
      kind: 'input',
      resultVar: 'input',
      prompt: '输入 ${topic}',
      params: [{ id: createId('param'), name: 'topic', type: 'text', required: true, value: '新短视频主题' }],
      uploads: [],
      loop: defaultLoop(),
      position: { x: 90, y: 170 },
    }
    const workflow = { id: createId('wf'), name: `新工作流 ${workflows.length + 1}`, description: '在画布中点击新增节点，并拖动连接点建立依赖。', nodes: [node], edges: [] }
    setWorkflows((current) => [...current, workflow])
    setActiveWorkflowId(workflow.id)
    setSelectedNodeId(node.id)
    setWorkflowInfoDraft({ name: workflow.name, description: workflow.description })
    setWorkflowInfoError('')
    workflowInfoOpenRef.current = false
    setWorkflowInfoOpen(false)
    setWorkflowDebug(null)
    setRunResult(executeWorkflow(workflow))
    setPage('workflow')
    setWorkflowView('edit')
    workflowInfoOpenRef.current = true
    setWorkflowInfoOpen(true)
  }
  const openWorkflowEditor = (workflow: Workflow) => {
    if (isDebugBusy || hasUnsavedExecution) return
    rememberExecutionView()
    setActiveWorkflowId(workflow.id)
    setSelectedNodeId(workflow.nodes[0]?.id ?? '')
    setWorkflowInfoDraft({ name: workflow.name, description: workflow.description })
    setWorkflowInfoError('')
    workflowInfoOpenRef.current = false
    setWorkflowInfoOpen(false)
    setWorkflowDebug(null)
    setWorkflowView('edit')
  }
  const openWorkflowDetail = (workflow: Workflow) => {
    if (isDebugBusy || hasUnsavedExecution) return
    openWorkflowEditor(workflow)
    setWorkflowView('detail')
  }
  const duplicateWorkflow = () => {
    if (isDebugBusy || hasUnsavedExecution) return
    rememberExecutionView()
    const idMap = new Map(activeWorkflow.nodes.map((node) => [node.id, createId('node')]))
    const copy: Workflow = {
      ...activeWorkflow,
      id: createId('wf'),
      name: `${activeWorkflow.name} 副本`,
      nodes: activeWorkflow.nodes.map((node) => ({
        ...node,
        id: idMap.get(node.id) ?? createId('node'),
        parentId: node.parentId ? idMap.get(node.parentId) ?? node.parentId : undefined,
        childIds: node.childIds?.map((childId) => idMap.get(childId) ?? childId),
        acceptance: node.acceptance ? { ...node.acceptance, retryFrom: idMap.get(node.acceptance.retryFrom) ?? node.acceptance.retryFrom } : undefined,
        errorRetry: node.errorRetry ? { ...node.errorRetry, retryFrom: idMap.get(node.errorRetry.retryFrom) ?? node.errorRetry.retryFrom } : undefined,
        uploads: [...node.uploads],
      })),
      edges: activeWorkflow.edges.map((edge) => ({ ...edge, id: createId('edge'), from: idMap.get(edge.from) ?? edge.from, to: idMap.get(edge.to) ?? edge.to })),
    }
    setWorkflows((current) => [...current, copy])
    setActiveWorkflowId(copy.id)
    setSelectedNodeId(copy.nodes[0]?.id ?? '')
    setWorkflowInfoDraft({ name: copy.name, description: copy.description })
    setWorkflowInfoError('')
    workflowInfoOpenRef.current = false
    setWorkflowInfoOpen(false)
    setWorkflowDebug(null)
  }
  const addNode = (kind: NodeKind, position = { x: 160 + activeWorkflow.nodes.length * 80, y: 140 + (activeWorkflow.nodes.length % 3) * 110 }) => {
    const id = createId('node')
    const capability: ModelCapability | undefined = kind === 'asset' ? 'image' : kind === 'text' || kind === 'image' || kind === 'video' || kind === 'audio' ? kind : undefined
    const operation = kind === 'internet' ? 'internet.retrieve' : kind === 'asset' ? 'character.ensure' : kind === 'validation' ? 'history.verify' : kind === 'compose' ? 'timeline.compose' : kind === 'videoConcat' ? 'video.concat' : undefined
    const node: WorkflowNode = {
      id,
      title: nodeMeta[kind].label,
      kind,
      resultVar: `${kind}_${activeWorkflow.nodes.length + 1}`,
      prompt: kind === 'input' ? '输入 ${name}' : kind === 'code' ? '解析上传的附件，并将结果输出到流程上下文。' : `使用上下文变量生成${nodeMeta[kind].label}`,
      modelId: capability ? models.find((model) => model.capability === capability)?.id : undefined,
      operation,
      request: kind === 'http' ? { url: '/api/video-evidence', method: 'POST' } : undefined,
      code: kind === 'branch' ? DEFAULT_BRANCH_CODE : kind === 'code' ? DEFAULT_CODE_NODE_SCRIPT : undefined,
      outputMode: kind === 'text' ? 'legacy-shots' : undefined,
      loopResultMode: kind === 'videoConcat' ? 'latest' : undefined,
      params: kind === 'branch' ? [{ id: createId('param'), name: 'maxAttempts', englishName: 'maxAttempts', type: 'number', required: true, value: String(MAX_NODE_ATTEMPTS) }, { id: createId('param'), name: 'report', englishName: 'report', type: 'json', required: true, value: '${quality_report}' }] : kind === 'input'
        ? [{ id: createId('param'), name: 'name', englishName: 'name', type: 'text', required: false, value: '' }]
        : kind === 'video'
          ? [
              { id: createId('param'), name: '首帧参考图', englishName: 'referenceImage', type: 'image', required: false, value: '' },
              { id: createId('param'), name: '时长', englishName: 'duration', type: 'number', required: true, value: '5' },
              { id: createId('param'), name: '生成模式', englishName: 'mode', type: 'text', required: true, value: 'std' },
              { id: createId('param'), name: '原生音频', englishName: 'sound', type: 'text', required: false, value: 'off' },
              { id: createId('param'), name: '负向提示词', englishName: 'negativePrompt', type: 'text', required: false, value: '' },
            ]
          : kind === 'videoConcat'
            ? [
                { id: createId('param'), name: '视频列表', englishName: 'videos', type: 'json', required: true, value: '${video_shot.items}' },
                { id: createId('param'), name: '输出格式', englishName: 'format', type: 'text', required: true, value: 'mp4' },
              ]
            : [],
      uploads: [],
      loop: defaultLoop(),
      position,
    }
    updateActiveWorkflow((workflow) => ({ ...workflow, nodes: [...workflow.nodes, node] }))
    setSelectedNodeId(id)
  }
  const removeNode = (id: string) =>
    updateActiveWorkflow((workflow) => {
      const nodes = workflow.nodes.filter((node) => node.id !== id)
      if (selectedNodeId === id) { setSelectedNodeId(nodes[0]?.id ?? ''); setInspectorOpen(false) }
      return { ...workflow, nodes, edges: workflow.edges.filter((edge) => edge.from !== id && edge.to !== id) }
    })
  const removeEdge = (id: string) => updateActiveWorkflow((workflow) => ({ ...workflow, edges: workflow.edges.filter((edge) => edge.id !== id) }))
  const addEdge = (from: string, to: string, branch?: BranchPort) => {
    if (from === to && branch === undefined) return
    updateActiveWorkflow((workflow) => {
      if (branch !== undefined) return { ...workflow, edges: setBranchEdge(workflow.edges, from, branch, to, createId('edge')) }
      if (workflow.edges.some((edge) => edge.from === from && edge.to === to)) return workflow
      return { ...workflow, edges: [...workflow.edges, { id: createId('edge'), from, to }] }
    })
  }

  const moveCanvasPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = canvasPanRef.current
    if (!pan) return
    const nextOffset = { x: pan.left + event.clientX - pan.x, y: pan.top + event.clientY - pan.y }
    canvasViewRef.current = { ...canvasViewRef.current, ...nextOffset }
    setCanvasOffset(nextOffset)
  }
  const onSurfaceMove = (event: MouseEvent) => {
    if (!drag) return
    const point = canvasPoint(event)
    if (drag.type === 'edge') setDrag({ ...drag, ...point })
    if (drag.type === 'selection') {
      setDrag({ ...drag, end: point })
      selectCanvasNodes(expandCanvasSelection(nodesInSelection(drag.bounds, drag.start, point)))
    }
    if (drag.type === 'node') {
      const positions = moveSelection(drag.origins, { x: point.x - drag.start.x, y: (point.y - drag.start.y) / canvasYScale })
      updateActiveWorkflow(workflow => ({ ...workflow, nodes: workflow.nodes.map(node => positions[node.id] ? { ...node, position: positions[node.id] } : node) }))
    }
  }
  const startNodeDrag = (event: MouseEvent, node: WorkflowNode) => {
    if (isWorkflowDetail || event.button !== 0 || (event.target as HTMLElement).closest('.node-action,.port,.canvas-node-media')) return
    event.preventDefault()
    event.stopPropagation()
    const ids = expandCanvasSelection(event.shiftKey ? [...selectedCanvasIds, node.id] : selectedCanvasIds.includes(node.id) ? selectedCanvasIds : [node.id])
    selectCanvasNodes(ids)
    setSelectedNodeId(node.id)
    setDrag({ type: 'node', start: canvasPoint(event), origins: Object.fromEntries(activeWorkflow.nodes.filter(item => ids.includes(item.id)).map(item => [item.id, { ...item.position }])) })
  }
  const startEdgeDrag = (event: MouseEvent, node: WorkflowNode, branch?: BranchPort) => {
    if (isWorkflowDetail) return
    event.stopPropagation()
    setSelectedNodeId(node.id)
    const offset = branchOutputOffset(branch)
    setDrag({ type: 'edge', from: node.id, branch, x: node.position.x + offset.x, y: node.position.y + offset.y })
  }
  const finishEdgeDrag = (event: MouseEvent, to: string) => {
    event.stopPropagation()
    if (drag?.type === 'edge') addEdge(drag.from, to, drag.branch)
    setDrag(null)
  }
  const addParam = () =>
    updateNode(selectedNode.id, {
      params: [...selectedNode.params, { id: createId('param'), name: `param_${selectedNode.params.length + 1}`, englishName: `param_${selectedNode.params.length + 1}`, type: 'text', required: false, value: '' }],
    })
  const removeParam = (paramId: string) => updateNode(selectedNode.id, { params: selectedNode.params.filter((param) => param.id !== paramId) })
  const uploadAssets = (nodeId: string, files: FileList | null) => {
    if (!files?.length) return
    const targetNode = activeWorkflow.nodes.find((node) => node.id === nodeId)
    const selectedFiles = targetNode?.kind === 'code' ? [files[0]] : Array.from(files)
    if (targetNode?.kind === 'code' && !/\.xlsx$/i.test(selectedFiles[0]?.name ?? '')) {
      setConfigStatus('代码执行节点附件仅支持 .xlsx 文件')
      return
    }
    if (targetNode?.kind === 'code' && (selectedFiles[0]?.size ?? 0) > 15 * 1024 * 1024) {
      setConfigStatus('Excel 文件不能超过 15MB')
      return
    }
    selectedFiles.forEach((file) => {
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : ''
        if (!dataUrl) return
        updateActiveWorkflow((workflow) => ({
          ...workflow,
          nodes: workflow.nodes.map((node) =>
            node.id === nodeId
              ? {
                  ...node,
                  uploads: node.kind === 'code'
                    ? [{ id: createId('asset'), name: file.name, dataUrl, mimeType: file.type, size: file.size }]
                    : [...node.uploads, { id: createId('asset'), name: file.name, dataUrl, mimeType: file.type, size: file.size }],
                }
              : node,
          ),
        }))
        if (targetNode?.kind === 'code') setConfigStatus(`已上传附件：${file.name}`)
      }
      reader.readAsDataURL(file)
    })
  }
  const removeUpload = (nodeId: string, assetId: string) =>
    updateActiveWorkflow((workflow) => ({
      ...workflow,
      nodes: workflow.nodes.map((node) => (node.id === nodeId ? { ...node, uploads: node.uploads.filter((asset) => asset.id !== assetId) } : node)),
    }))
  const updateModel = (id: string, patch: Partial<ModelConfig>) => setDraftModels((current) => current.map((model) => (model.id === id ? { ...model, ...patch } : model)))
  const updateModelSetting = (id: string, key: string, value: string) =>
    setDraftModels((current) => {
      const updated = current.map((model) => (model.id === id ? { ...model, settings: { ...model.settings, [key]: value } } : model))
      return isSharedCredentialKey(id, key) ? syncSharedModelCredentials(updated, id) : updated
    })
  const addModel = () =>
    setDraftModels((current) => [
      ...current,
      { id: createId('model'), name: `自定义模型 ${current.length + 1}`, provider: 'Custom', capability: modelTab, settings: { endpoint: '', apiKey: '', model: '' }, testInput: '输入测试内容', testResult: '' },
    ])
  const removeModel = (id: string) => setDraftModels((current) => current.filter((model) => model.id !== id))

  const openWorkflowRun = (workflow: Workflow) => {
    if (isDebugBusy || hasUnsavedExecution) return
    setActiveWorkflowId(workflow.id)
    setSelectedNodeId(workflow.nodes[0]?.id ?? '')
    setWorkflowInfoDraft({ name: workflow.name, description: workflow.description })
    setWorkflowInfoError('')
    workflowInfoOpenRef.current = false
    setWorkflowInfoOpen(false)
    setWorkflowDebug(null)
    setRunMode('step')
    setRuntimePanelOpen(true)
    setRunnerInspectorTab('config')
    setRunnerFollowMode(true)
    setSelectedLoopSnapshot(null)
    const nextExecution = createExecutionState(workflow, 'step')
    setExecutionState({ ...nextExecution, selectedNodeId: undefined })
    setSelectedRunIndex(-1)
    setRunResult(executeWorkflow(workflow))
    setRunnerTab('execute')
    setWorkflowView('run')
  }



  const executeFullRun = async () => {
    if (executionState.persistenceError) return
    const executableWorkflow = normalizeWorkflow(activeWorkflow)
    if (serializedValuesDiffer(activeWorkflow, executableWorkflow)) {
      const upgradedWorkflows = workflows.map((workflow) => workflow.id === executableWorkflow.id ? executableWorkflow : workflow)
      setWorkflowsState(upgradedWorkflows)
      void saveWorkflowsToDatabase(upgradedWorkflows)
        .catch((error) => setConfigStatus(`执行前工作流升级保存失败：${error instanceof Error ? error.message : String(error)}`))
    }
    await runFullWorkflow(executableWorkflow)
  }

  const executeRealTask = async (task: StepTask, context: Record<string, unknown>): Promise<unknown> => {
    if (task.node.mapInput) return mapNodeInputs(task.node.mapInput, context, (itemContext, index) => executeRealTask({ ...task, node: { ...task.node, mapInput: undefined }, executionId: `${task.executionId ?? task.node.id}:item-${index}` }, itemContext))
    const node = task.node
    const executionWorkflow = normalizeWorkflow(activeWorkflow)
    if (node.kind === 'input') return runNode(node, context)
    if (node.kind === 'loop') {
      const loopItems = getLoopItems(context, node)
      return { count: loopItems.length, loopSource: node.loop.sourcePath, itemVar: node.loop.itemVar, nodes: getLoopNodes(executionWorkflow, node.id).map((item) => item.title) }
    }
    const currentLoop = context.loop && typeof context.loop === 'object' && !Array.isArray(context.loop) ? context.loop as Record<string, unknown> : {}
    const loopContext = task.loopNode ? {
      [task.loopNode.loop.itemVar]: task.loopItem,
      loop: { ...currentLoop, index: (task.loopIndex ?? 0) + 1, zeroIndex: task.loopIndex ?? 0, previous: task.loopPrevious ?? currentLoop.previous },
    } : {}
    const rawInput = context.input && typeof context.input === 'object' && !Array.isArray(context.input)
      ? context.input as Record<string, unknown> : undefined
    const activeInput = executionWorkflow.id === 'wf-sanguo-history-drama' && rawInput
      ? { ...rawInput, characterAssetSelections: characterSelectionsForEpisode(rawInput.characterAssetSelections, rawInput.episode_number) }
      : rawInput
    const baseContext = { ...context, ...(activeInput ? { input: activeInput } : {}), ...loopContext, uploads: node.uploads.map((asset) => asset.name) }
    let values = nodeParamValues(node, baseContext)
    const qualityDisposition = workflowQualityDisposition(executionWorkflow)
    if (qualityDisposition) values = { ...values, qualityDisposition }
    if (executionWorkflow.id === 'wf-sanguo-history-drama' && (node.kind === 'video' || node.kind === 'videoConcat')) {
      values = applyVideoOutputProfile(values, task.executionMode ?? 'step')
    }
    if (node.kind === 'text' && values.reviewPolicySource) {
      values.reviewPolicy = resolveNodePolicy(values.reviewPolicySource, task.policyNodes ?? executionWorkflow.nodes,
        sourceNode => nodeParamValues(sourceNode, baseContext))
    }
    const missingRequiredParams = missingRequiredParamNames(node.params, values)
    if (missingRequiredParams.length) {
      throw new Error(`${node.title} 缺少必填输入：${missingRequiredParams.join('、')}。请先执行其前置节点，禁止绕过工作流依赖直接调用模型。`)
    }
    if (node.operation === 'character.lookup' || node.operation === 'character.ensure' || node.operation === 'character.archive' || node.operation === 'character.voice-design' || node.operation === 'character.voice-archive') values.workflowId = executionWorkflow.id
    if (['character.lookup', 'character.ensure', 'character.archive', 'character.appearance'].includes(node.operation ?? '')) {
      values.episodeNumber = resolvePath(baseContext, 'input.episode_number')
    }
    const selectionSensitive = ['history.scene-outline', 'history.storyboard', 'character.lookup'].includes(node.operation ?? '')
    const selections = resolvePath(baseContext, 'input.characterAssetSelections')
    if (selections && ['character.ensure', 'character.archive'].includes(node.operation ?? '')) values = {...values, characterAssetSelections: selections}
    if (node.operation === 'character.archive' && values.shot === undefined) {
      const shot = resolvePath(baseContext, 'shot_script')
      if (shot && typeof shot === 'object' && !Array.isArray(shot)) values = {...values, shot}
    }
    const needsVisualCatalog = node.operation === 'history.scene-outline' && node.prompt.includes('【人物年龄与场景造型·大纲】')
    const needsEquipmentCatalog = node.operation === 'history.scene-outline' && node.prompt.includes('${characterEquipmentCatalog}')
    const needsArtisticIdentityCatalog = ['history.scene-outline', 'history.storyboard'].includes(node.operation ?? '')
      && node.prompt.includes('${characterArtisticIdentityCatalog}')
    const libraryAssets = needsVisualCatalog || needsArtisticIdentityCatalog || selectionSensitive && selections && Object.keys(selections).length
      ? (await requestJson<{characters: Record<string, unknown>[]}>('/api/characters')).characters : []
    const libraryEquipment = needsEquipmentCatalog
      ? (await requestJson<{equipment: Record<string, unknown>[]}>(`/api/character-equipment?workflowId=${encodeURIComponent(executionWorkflow.id)}`)).equipment : []
    const selectedCharacterVisuals = selectionSensitive ? resolveCharacterVisualSelections(libraryAssets, executionWorkflow.id, selections) : []
    if (selectedCharacterVisuals.length && ['history.scene-outline', 'history.storyboard'].includes(node.operation ?? '')) values = {...values, selectedCharacterVisuals}
    if (selectedCharacterVisuals.length && node.operation === 'history.storyboard') assertSelectedCharacterVisuals(resolvePath(baseContext, 'scene'), selectedCharacterVisuals)
    let codeBindings: Record<string, unknown> = {}
    if (node.kind === 'code' && node.operation === 'character.lookup') {
      assertSelectedCharacterVisuals(resolvePath(baseContext, 'shot_script'), selectedCharacterVisuals)
      const shot = resolvePath(baseContext, 'shot_script')
      const actors = withApprovedVoiceCasting(characterInputsForShot(shot), shot as Record<string, unknown>,
        resolvePath(baseContext, 'approved_scene_outline'))
      const lookupResponse = await runBuiltinNode(node.operation, node.prompt, {
        characters: actors,
        characterAssetSelections: selections,
        includeVoices: true,
        shot,
        workflowId: executionWorkflow.id,
        episodeNumber: resolvePath(baseContext, 'input.episode_number'),
        sceneId: resolvePath(baseContext, 'scene.id'),
        qualityDisposition: values.qualityDisposition,
      })
      if (lookupResponse.status >= 400) throw new Error(JSON.stringify(lookupResponse.body))
      const lookup = lookupResponse.body as {items?: Array<{id?: string;characterName?: string}>}
      for (const selected of selectedCharacterVisuals) if (actors.some(actor => actor.name === selected.name)
        && !lookup.items?.some(asset => asset.characterName === selected.name && asset.id === selected.assetId)) {
        throw new Error(`CHARACTER_VISUAL_SELECTION_MISMATCH: ${selected.name} 未召回用户指定的三视图，已在媒体付费前停止`)
      }
      codeBindings = { character_lookup_result: lookupResponse.body }
    }
    const aliases = nodeParamAliases(node, values)
    const visualCatalog = needsVisualCatalog ? characterVisualCatalog(libraryAssets,
      executionWorkflow.id, {input: resolvePath(baseContext, 'input'), historicalSources: resolvePath(baseContext, 'historical_sources')}, selectedCharacterVisuals) : undefined
    const artisticIdentityCatalog = needsArtisticIdentityCatalog ? characterArtisticIdentityCatalog(libraryAssets,
      executionWorkflow.id, {input: resolvePath(baseContext, 'input'), historicalSources: resolvePath(baseContext, 'historical_sources'),
        scene: resolvePath(baseContext, 'scene'), sceneOutline: resolvePath(baseContext, 'scene_outline')}) : undefined
    const equipmentCatalog = needsEquipmentCatalog ? characterEquipmentCatalog(libraryEquipment, executionWorkflow.id,
      {input: resolvePath(baseContext, 'input'), historicalSources: resolvePath(baseContext, 'historical_sources')}) : undefined
    const ungroundedContext = {
      ...baseContext,
      ...aliases,
      params: values,
      qualityDisposition: values.qualityDisposition,
      ...codeBindings,
      ...(visualCatalog ? {characterVisualCatalog: visualCatalog} : {}),
      ...(artisticIdentityCatalog ? {characterArtisticIdentityCatalog: artisticIdentityCatalog} : {}),
      ...(equipmentCatalog ? {characterEquipmentCatalog: equipmentCatalog} : {}),
      ...(selectedCharacterVisuals.length ? {selectedCharacterVisuals} : {}),
      uploads: node.uploads.map((asset) => asset.name),
    }
    const localContext = node.operation === 'history.storyboard'
      ? storyboardDramaContext(storyboardContinuityContext(ungroundedContext))
      : node.kind === 'text' && node.prompt.includes('${history_source_review}')
        ? historicalSourceReviewContext(ungroundedContext) : ungroundedContext
    const feedback = resolvePath(localContext, 'retry.feedback')
    // Structural correction and editorial rewrites consume the same configured writer budget,
    // including every child segment and every distinct model generation.
    const writerBudget = ['history.scene-outline', 'history.storyboard'].includes(node.operation ?? '') && node.prompt.includes('cinematic-v1')
      ? createDramaGenerationBudget(feedback, resolveDramaGenerationLimit(values.maxGenerationAttempts, 2, values.qualityDisposition)) : undefined
    // A new draft is a distinct model operation even when its correction prompt is unchanged.
    // Network reattachment retains this operation's key; it must never consume a new draft.
    const consumeWriterContext = () => {
      if (!writerBudget) return executionContext
      writerBudget.consume()
      return contextWithGenerationAttempt(executionContext, writerBudget.used)
    }
    const stampWriterResult = (output: unknown) => {
      const result = attachDramaRepairProvenance(output, feedback, Number(resolvePath(localContext, 'retry.attempt')) || 1)
      if (!writerBudget || !result || typeof result !== 'object') return result
      const record = result as Record<string, unknown>
      const repairProvenance = { ...(record.repairProvenance as Record<string, unknown>), generationAttempts: writerBudget.used }
      const segments = record[STORYBOARD_SEGMENTS_KEY]
      return { ...record, repairProvenance, ...(Array.isArray(segments) ? {
        [STORYBOARD_SEGMENTS_KEY]: segments.map(segment => ({ ...segment, repairProvenance })),
      } : {}) }
    }
    if (node.kind === 'video') {
      const shot = resolvePath(localContext, 'shot_script') as Record<string, unknown> | undefined
      if (shot && (shot.dramaticSceneId || shot.id)) values.voiceSceneId = shot.dramaticSceneId ?? shot.id
      const issue = cinematicContinuityIssue(
        (resolvePath(localContext, 'shot_script') ?? {}) as Record<string, unknown>,
        resolvePath(localContext, 'loop.previous.shot_script') as Record<string, unknown> | undefined,
        resolvePath(localContext, 'loop.previous.video_shot') as Record<string, unknown> | undefined,
      )
      if (issue) {
        if (values.qualityDisposition !== 'manual-review-v1') throw new Error(`STORYBOARD_WORLD_STATE_INVALID: ${issue}；请基于前镜实测状态重试本镜分镜，已阻止视频付费调用`)
        values = { ...values, qualityWarnings: [...(Array.isArray(values.qualityWarnings) ? values.qualityWarnings : []), `连续性待人工复核：${issue}`] }
      }
    }
    const rawPromptContext = node.kind === 'text' ? nodePromptInputContext(localContext, values.promptInputMode)
      : node.kind === 'video' ? videoPromptInputContext(localContext, values.promptInputMode) : localContext
    const promptRetry = resolvePath(rawPromptContext, 'retry')
    const promptContext = promptRetry && typeof promptRetry === 'object' && !Array.isArray(promptRetry)
      ? { ...rawPromptContext, retry: { ...promptRetry, feedback: withoutFailedTextCandidate(resolvePath(rawPromptContext, 'retry.feedback')) } } : rawPromptContext
    const writerStage = executionWorkflow.id === 'wf-sanguo-history-drama'
      ? node.operation === 'history.scene-outline' ? 'outline' : node.operation === 'history.storyboard' ? 'storyboard' : undefined
      : undefined
    const currentPrompt = writerStage === 'outline'
      ? refreshEpisodeBoundaryPrompt(refreshDramaticExpressionPrompt(node.prompt, writerStage))
      : writerStage ? refreshDramaticExpressionPrompt(node.prompt, writerStage) : node.prompt
    if (writerStage === 'outline' && !parseEpisodeBoundary(resolvePath(localContext, 'input.episode_boundary'),
      resolvePath(localContext, 'input.episode_number'), resolvePath(localContext, 'input.episode_title'))) {
      throw new Error('EPISODE_BOUNDARY_MISSING: 当前大纲缺少策划表邻集归属；请从「策划表输入整理」节点重跑，已阻止文本模型请求')
    }
    const prompt = interpolate(currentPrompt, promptContext) + renderRetryFeedbackPrompt(resolvePath(promptContext, 'retry.feedback'))
      + (writerStage && selectedCharacterVisuals.length ? '\n【用户指定的本次三视图】' + JSON.stringify(selectedCharacterVisuals)
        + '。出现这些人物的场景和分镜必须原样采用指定visualContext，不改用同人物其他候选。此选择是本作艺术造型，不能作为历史生年或实岁证据；剧情时间仍按史料。' : '')
      + (node.kind === 'video' ? characterEquipmentPrompt(values.equipmentBindings) : '')
    const knownSpeakers = node.kind === 'video' && task.voicePolicy === 'strict' ? knownVoiceSpeakers([
      ...(task.knownVoiceInputs ?? []),
      ...executionWorkflow.nodes.filter(n => n.kind === 'loop').flatMap(n => getLoopItems(baseContext, n)),
      ...executionWorkflow.nodes.filter(n => n.kind === 'video' && !n.parentId && !executionWorkflow.nodes.some(owner => owner.kind === 'loop' && owner.childIds?.includes(n.id))).map(n => nodeParamValues(n, baseContext)),
    ]) : undefined
    const executionContext = { knownVoiceSpeakers: knownSpeakers, voiceExecutionId: task.voiceExecutionId, voicePolicy: task.voicePolicy, requestKey: task.executionId ? `${task.executionId}:${node.id}:${task.loopIndex ?? 0}:${String(resolvePath(localContext, 'scene.id') ?? '')}` : undefined, workflowId: executionWorkflow.id, workflowName: executionWorkflow.name, nodeId: node.id, nodeName: node.title }
    if (executionWorkflow.id === 'wf-sanguo-history-drama' || (node.kind === 'video' && task.voicePolicy === 'strict')) {
      const runtime = await requestJson<{ historyQualityVersion?: string; voiceContractVersion?: string; videoOutputProfileVersion?: string; characterVisualContextVersion?: string }>('/api/runtime-version').catch(() => ({ historyQualityVersion: undefined, voiceContractVersion: undefined, videoOutputProfileVersion: undefined, characterVisualContextVersion: undefined }))
      if (executionWorkflow.id === 'wf-sanguo-history-drama' && runtime.historyQualityVersion !== HISTORY_QUALITY_VERSION) throw new Error('历史视频服务仍运行旧版本。请重启本地服务后再执行；已阻止新界面调用旧模型适配器。')
      if (executionWorkflow.id === 'wf-sanguo-history-drama' && (executionWorkflow.schemaVersion ?? 0) >= 146 && runtime.characterVisualContextVersion !== CHARACTER_VISUAL_CONTEXT_RUNTIME_VERSION) throw new Error('人物年龄与场景造型服务仍运行旧版本。请重启本地服务后再执行；已阻止旧服务按姓名误用其他年龄的人物图。')
      if ((node.kind === 'video' || node.kind === 'videoConcat') && runtime.videoOutputProfileVersion !== VIDEO_OUTPUT_PROFILE_VERSION) throw new Error('视频输出服务仍运行旧版本。请重启本地服务后再执行；已阻止错误规格的视频调用。')
      if (node.kind === 'video' && task.voicePolicy === 'strict') assertVoiceRuntime(runtime)
    }
    if (node.kind === 'image' && !node.modelId) return { ...uploadedImageOutput(node), prompt, model: undefined, params: values }
    if (node.kind === 'http') {
      if (!node.request || !/^\/api\/[\w/-]+$/.test(node.request.url)) throw new Error('HTTP 节点需配置本地 /api/ 请求地址')
      return requestJson<Record<string, unknown>>(node.request.url, { method: node.request.method, ...(node.request.method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) } : {}) })
    }
    if (node.kind === 'code' || node.kind === 'branch') {
      if (!node.code?.trim()) throw new Error(`${node.title} 未配置 JavaScript 代码`)
      const files = await Promise.all(node.uploads.map(materializeUpload))
      const response = await runCodeNode(node.code, prompt, values, files, localContext)
      if (response.status >= 400) throw new Error(`HTTP ${response.status}: ${JSON.stringify(response.body)}`)
      const result = response.body as Record<string, unknown> | undefined
      if (node.id === 'sanguo-scene-outline-accept' && result?.passed === true && result.contentContractVersion === 'cinematic-v1') {
        return { ...result, contextPatch: { approved_scene_outline: result } }
      }
      return response.body && typeof response.body === 'object' ? response.body : { value: response.body }
    }
    const model = models.find((item) => item.id === node.modelId)
    if (node.operation === 'character.ensure' || node.operation === 'frame.first.resolve') {
      if (node.modelId && !model) throw new Error(`${node.title} 配置的模型不存在`)
      const response = await runBuiltinNode(node.operation, prompt, values, model, executionContext)
      if (response.status >= 400) throw new Error(`HTTP ${response.status}: ${JSON.stringify(response.body)}`)
      if (node.kind === 'validation' && (response.body as Record<string, unknown>)?.passed !== true) throw new Error(`质量校验未通过：${JSON.stringify(response.body)}`)
      return { ...(response.body && typeof response.body === 'object' ? response.body as Record<string, unknown> : { value: response.body }), operation: node.operation }
    }
    if (node.kind === 'internet' || node.kind === 'validation' || node.kind === 'knowledge' || node.kind === 'asset' || node.kind === 'compose' || node.kind === 'videoConcat') {
      if (!node.operation) throw new Error(`${node.title} 未配置内置 operation`)
      if (node.kind === 'asset' && node.modelId && !model) throw new Error(`${node.title} 配置的模型不存在`)
      const response = await runBuiltinNode(node.operation, prompt, values, model, executionContext)
      if (response.status >= 400) throw new Error(`HTTP ${response.status}: ${JSON.stringify(response.body)}`)
      if (node.kind === 'validation' && (response.body as Record<string, unknown>)?.passed !== true) throw new Error(`质量校验未通过：${JSON.stringify(response.body)}`)
      return { ...(response.body && typeof response.body === 'object' ? response.body as Record<string, unknown> : { value: response.body }), operation: node.operation }
    }
    if (!model) throw new Error(`${node.title} 未配置模型`)
    let characterDesigns: ReturnType<typeof characterAppearanceContext> | undefined
    if (node.operation === 'history.storyboard') {
      const cast = resolvePath(localContext, 'scene.cast')
      const previousCast = resolvePath(localContext, 'scene.continuityFromPrevious') === true ? resolvePath(localContext, 'loop.previous.shot_script.endCharacters') : []
      const response = await runBuiltinNode('character.appearance', '', {
        characterAssetSelections: selections,
        characters: characterInputsForShot({characters: [...new Set([...(Array.isArray(cast) ? cast : []), ...(Array.isArray(previousCast) ? previousCast : [])])],
          characterVisuals: resolvePath(localContext, 'scene.characterVisuals')}),
        workflowId: executionWorkflow.id, episodeNumber: resolvePath(localContext, 'input.episode_number'), readOnly: true,
      }, undefined, executionContext)
      if (response.status >= 400) throw new Error(`HTTP ${response.status}: ${JSON.stringify(response.body)}`)
      characterDesigns = characterAppearanceContext((response.body as { items: Array<Record<string, unknown>> }).items)
    }
    if (node.operation === 'history.storyboard') {
      const actualTail = resolvePath(localContext, 'loop.previous.actualTailEvidence') as Record<string, unknown> | undefined
      const carry = task.failedCandidateBinding ? readFailedTextCandidate(feedback, task.failedCandidateBinding) : undefined
      const productionTimingPrompt = values.pacingVersion === 'duration-v2'
        ? '本轮使用duration-v2共享策略，按声明的表演类型、完整节拍依赖与可读收尾排程；不套4.5字/秒，不强制缩为最短整数，15秒放不下则按原节拍连续拆段。本轮pacing.timingPolicy必须原样使用以下完整对象：' + JSON.stringify(values.timingPolicy)
        : '本轮按自然语速每秒4.5个汉字和短标点停顿动态预算，禁止拖腔和凑满15秒。一行超过6秒则在语义停顿处拆成两条同角色对白；15秒放不下必须连续拆段，不得删剧情。'
      const expected = { ...values, storyboardQualityWarnings: resolvePath(localContext, 'storyboardQualityWarnings'), scene: resolvePath(localContext, 'scene'), previousShot: resolvePath(localContext, 'loop.previous.shot_script'), requireContinuityContract: true, requireDynamicPacing: true, requireNarrativeClosure: true, requireDramaContract: node.prompt.includes('cinematic-v1'), productionSpeechRate: 4.5, aspectRatio: resolvePath(localContext, 'input.aspect_ratio') }
      const execution = await executeRecoveredHistoricalStoryboard({
        binding: task.failedCandidateBinding, carry,
        plannedCandidate: carry ? undefined : task.storyboardSplitCandidate,
        canGenerate: () => writerBudget?.canConsume() ?? true,
        prompt: `${prompt}\n【实际生产语速预算】${productionTimingPrompt}\n【既有角色定妆，必须沿用】${JSON.stringify(characterDesigns)}。仅沿用身份、脸部和服装，不沿用旧站位或动作。没有既有资产的角色才可设计新外观。`,
        expected,
        generate: async (candidatePrompt) => {
          const generationContext = consumeWriterContext()
          const coverageCut = resolvePath(localContext, 'scene.continuityMode') === 'coverage_cut'
          const response = await runModelNode(model, candidatePrompt + (actualTail ? coverageCut
            ? '\n【实际同场切镜依据】附件是前镜实际尾帧，只作为现场人物和世界状态证据，允许已批准的反打与新景别。画外人物不等于离场，不能重演已完成动作或凭空转移道具；按已采证worldState继承，未知不猜。'
            : '\n【实际续接依据】附件是上一轮已验收成片的实际尾帧，上一镜lastFramePrompt已替换为该尾帧的实际观察。开场必须保持图中人物、站位、道具和机位；从这个状态连续表演本轮新剧情，禁止重演已完成动作。' : ''), { ...values, ...(actualTail ? { reviewImages: [actualTail.url] } : {}) }, node.operation, generationContext)
          if (response.status >= 400) throw new Error(`HTTP ${response.status}: ${JSON.stringify(response.body)}`)
          return { raw: response.body, requestKey: generationContext.requestKey ?? '', httpStatus: response.status }
        },
      })
      const splitSegments = storyboardSegments(execution.result)
      return stampWriterResult({ ...execution.result,
        ...(splitSegments.length > 1 && execution.source && isManagedStoryboardSplitNode(node, values)
          ? { [STORYBOARD_SPLIT_SOURCE_KEY]: { source: execution.source, expected } satisfies StoryboardSplitSourceEnvelope } : {}),
        ...(task.storyboardSplitCandidate && !carry ? { splitCandidateRecovery: {
          ...task.storyboardSplitCandidate.provenance, currentValidationRequired: false,
          validation: 'current-full-script-contract', generationAttempts: execution.generations,
          mode: execution.generations ? 'repaired' : 'revalidated',
        } } : {}),
        ...(execution.recovered ? { failedCandidateRecovery: {
        version: 'failed-text-candidate-recovery-v1', mode: execution.generations ? 'repaired' : 'revalidated',
        sourceExecutionId: execution.recovered.binding.executionId, sourceRequestKey: execution.recovered.source.requestKey,
        sourceModelExecutionId: execution.recovered.source.modelExecutionId, sourceRawSha256: execution.recovered.rawSha256,
        generationAttempts: execution.generations,
      } } : {}) })
    }
    if (node.kind === 'text' && values.qualityMode === 'principle-v1' && values.maxReviewAttempts !== undefined) {
      const report = await runPrincipleReview({
        maxAttempts: isManualReview(values) ? 1 : Number(values.maxReviewAttempts),
        generate: async (attempt, correction) => {
          const result = await runModelNode(model, prompt + correction, values, node.operation,
            { ...executionContext, requestKey: executionContext.requestKey ? `${executionContext.requestKey}:principle-review-${attempt}` : undefined })
          if (result.status >= 400) throw new Error(`HTTP ${result.status}: ${JSON.stringify(result.body)}`)
          return result.body
        },
        normalize: raw => normalizeStructuredTextOutput(raw, extractTextResponse(raw), 'json'),
      })
      return { ...report, model: node.modelId }
    }
    if (node.kind === 'text') {
      const validationContext = node.operation === 'history.scene-outline'
          ? { ...values, requireBeatCoverage: true, requireNarrativeClosure: true, requireDramaContract: node.prompt.includes('cinematic-v1'), requireEditorialGrammar: node.prompt.includes('editorialRole'), requireCharacterVisuals: node.prompt.includes('【人物年龄与场景造型·大纲】'), requireCharacterEquipment: node.prompt.includes('每段另写characterEquipment数组'), requireEpisodeBoundary: executionWorkflow.id === 'wf-sanguo-history-drama', deriveInheritedStates: true, input: resolvePath(localContext, 'input'), historicalSources: resolvePath(localContext, 'historical_sources') }
          : node.operation === 'history.storyboard'
            ? { ...values, requireCharacterEquipment: node.prompt.includes('继承当前scene.characterEquipment') }
            : values
      const normalizeCandidate = (value: unknown) => {
        const text = extractTextResponse(value)
        return normalizeStructuredTextOutput(value, text, node.outputMode ?? 'legacy-shots')
      }
      const normalizeAndValidate = (value: unknown) => {
        const normalized = applyScopedDramaRepair(normalizeCandidate(value), feedback, localContext)
        // Collect independent guard failures together so one correction can address them all.
        // The writer retains the actual diagnostics when its shared generation budget is exhausted.
        const diagnostics: string[] = []
        const collect = (check: () => void) => {
          try { check() } catch (error) { diagnostics.push(error instanceof Error ? error.message : String(error)) }
        }
        if (node.operation === 'history.scene-outline') {
          const citations = resolvePath(localContext, 'historical_sources.citations')
          // Run pre-review guards against the same mechanical normalization used
          // by the structural validator. Otherwise a harmless empty-cast generic
          // montage is rejected before its deterministic live-action projection.
          const guardCandidate = normalizeDramaOutline(normalized, validationContext)
          collect(() => validateHistoricalProductionPlan(guardCandidate))
          if (Array.isArray(citations)) collect(() => validateHistoricalAgency(guardCandidate, citations))
          collect(() => validateEpisodeNarrativeBoundary(guardCandidate, resolvePath(localContext, 'input'),
            executionWorkflow.id === 'wf-sanguo-history-drama'))
        }
        if (diagnostics.length && !isManualReview(values)) {
          // Still run the contract validator so its own defects join the same round.
          collect(() => validateHistoricalStructuredOutput(node.operation, normalized, validationContext))
          throw new Error([...new Set(diagnostics)].join('\n'))
        }
        const validated = validateHistoricalStructuredOutput(node.operation, normalized, validationContext)
        if (node.operation === 'history.scene-outline') assertSelectedCharacterVisuals(validated, selectedCharacterVisuals)
        return { normalized, validated: isManualReview(values) && diagnostics.length && validated && typeof validated === 'object'
          ? { ...validated, qualityWarnings: [...new Set([...((validated as Record<string, unknown>).qualityWarnings as string[] ?? []), ...diagnostics])] } : validated }
      }
      let rawBody: unknown
      let result: ReturnType<typeof normalizeAndValidate>
      let recoveryProvenance: Record<string, unknown> | undefined
      if (node.operation === 'history.scene-outline') {
        const carry = task.failedCandidateBinding ? readFailedTextCandidate(feedback, task.failedCandidateBinding) : undefined
        const execution = await executeFailedTextCandidate({ binding: task.failedCandidateBinding, carry, prompt,
          maxGenerations: resolveDramaGenerationLimit(values.maxGenerationAttempts, 2, values.qualityDisposition),
          canGenerate: () => writerBudget?.canConsume() ?? true,
          generate: async correctionPrompt => {
            const generationContext = consumeWriterContext()
            const response = await runModelNode(model, correctionPrompt, values, node.operation, generationContext)
            if (response.status >= 400) throw new Error(`HTTP ${response.status}: ${JSON.stringify(response.body)}`)
            return { raw: response.body, requestKey: generationContext.requestKey ?? '', httpStatus: response.status }
          }, normalizeCandidate, normalizeAndValidate, buildCorrection: buildSceneOutlineRepairSuffix, candidatesDiffer: serializedValuesDiffer })
        rawBody = execution.raw
        result = execution.result
        if (execution.recovered) recoveryProvenance = { version: 'failed-text-candidate-recovery-v1', mode: 'revalidated',
          sourceExecutionId: execution.recovered.binding.executionId, sourceRequestKey: execution.recovered.source.requestKey,
          sourceModelExecutionId: execution.recovered.source.modelExecutionId, sourceRawSha256: execution.recovered.rawSha256,
          generationAttempts: execution.generations }
      } else {
        const response = await runModelNode(model, prompt, values, node.operation, consumeWriterContext())
        if (response.status >= 400) throw new Error(`HTTP ${response.status}: ${JSON.stringify(response.body)}`)
        rawBody = response.body
        result = normalizeAndValidate(rawBody)
      }
      const body = sanitizeBase64(rawBody)
      const transportModelId = body && typeof body === 'object' && !Array.isArray(body)
        ? String((body as { transportFailover?: { toModelId?: unknown } }).transportFailover?.toModelId ?? '').trim()
        : ''
      return stampWriterResult({
        ...(result.validated && typeof result.validated === 'object' && !Array.isArray(result.validated) ? result.validated : result.normalized),
        raw: body,
        model: transportModelId || node.modelId,
        ...(recoveryProvenance ? { failedCandidateRecovery: recoveryProvenance } : {}),
      })
    }
    const response = await runModelNode(model, prompt, values, node.operation, consumeWriterContext())
    if (response.status >= 400) throw new Error(`HTTP ${response.status}: ${JSON.stringify(response.body)}`)
    const rawBody = response.body
    const body = sanitizeBase64(rawBody)
    if (node.operation === 'character.voice-design') return { ...voiceCandidateOutput(rawBody), raw: body, model: node.modelId }
    const urls = extractMediaUrls(rawBody)
    const url = urls[0] ?? extractFirstUrl(rawBody)
    if (node.kind === 'video' && !url) {
      throw new Error(`${node.title} 未返回可用的视频 URL，不能标记为执行成功`)
    }
    const rawRecord = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? rawBody as Record<string, unknown> : {}
    let lastFrameUrl = extractFirstUrl(rawRecord.lastFrameUrl ?? rawRecord.last_frame_url ?? rawRecord.last_frame)
    let extractedLastFrameUrl = ''
    if (node.kind === 'video' && node.captureTail !== false && url && !lastFrameUrl) {
      const nextScene = resolvePath(localContext, `scene_outline.scenes.${(task.loopIndex ?? 0) + 1}`)
      const nextSceneNeedsTail = Boolean(nextScene && typeof nextScene === 'object' && !Array.isArray(nextScene)
        && (nextScene as Record<string, unknown>).continuityFromPrevious === true)
      try {
        const tailFrameDataUrl = await captureVideoTailFrame(url)
        const stored = await requestJson<{ url: string }>('/api/runtime-assets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl: tailFrameDataUrl, prefix: `${node.id}-${task.loopIndex ?? 0}-tail` }),
        })
        extractedLastFrameUrl = stored.url
        lastFrameUrl = stored.url
      } catch (error) {
        if (nextSceneNeedsTail) {
          throw new Error(`下一镜要求连续续接，但当前成片尾帧提取失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
        }
      }
    }
    return {
      url,
      ...(node.kind === 'image' ? { urls, items: urls.map((itemUrl) => ({ url: itemUrl })) } : {}),
      ...(lastFrameUrl ? { lastFrameUrl } : {}),
      ...(extractedLastFrameUrl ? { extractedLastFrameUrl } : {}),
      ...(rawRecord.characterVoices ? { characterVoices: rawRecord.characterVoices, voiceManifest: rawRecord.voiceManifest, voiceConsistency: rawRecord.voiceConsistency } : {}),
      ...(rawRecord.narration ? { narration: rawRecord.narration, voiceManifest: rawRecord.voiceManifest, voiceConsistency: rawRecord.voiceConsistency } : {}),
      ...(rawRecord.offscreenDialogue ? { offscreenDialogue: rawRecord.offscreenDialogue, voiceManifest: rawRecord.voiceManifest, voiceConsistency: rawRecord.voiceConsistency } : {}),
      ...(rawRecord.nativeGroupVoices ? { nativeGroupVoices: rawRecord.nativeGroupVoices, voiceConsistency: rawRecord.voiceConsistency } : {}),
      ...(rawRecord.mapVideoGate ? { mapVideoGate: rawRecord.mapVideoGate } : {}),
      ...(rawRecord.mapAnnotationOverlay ? { mapAnnotationOverlay: rawRecord.mapAnnotationOverlay } : {}),
      ...(rawRecord.mapPortraitOverlay ? { mapPortraitOverlay: rawRecord.mapPortraitOverlay } : {}),
      ...(values.qualityDisposition ? { qualityDisposition: values.qualityDisposition } : {}),
      ...(values.qualityWarnings ? { qualityWarnings: values.qualityWarnings } : {}),
      raw: body,
      prompt,
      params: values,
      model: node.modelId,
    }
  }

  const continueFullRun = async (state: ExecutionState) => {
    if (state.persistenceError) return
    if (fullExecutionLockRef.current || stepExecutionLockRef.current) return
    fullExecutionLockRef.current = true
    fullPauseRequestedRef.current = false
    setFullPauseRequested(false)
    setDebugContinueRunning(true)
    try {
      await runWorkflowToCompletion(state, (index, current) => fullPauseRequestedRef.current ? Promise.resolve(undefined) : executeStepIndex(index, current))
    } finally {
      fullExecutionLockRef.current = false
      setDebugContinueRunning(false)
    }
  }

  const runFullWorkflow = async (workflow: Workflow) => {
    if (executionState.persistenceError) return
    if (fullExecutionLockRef.current || stepExecutionLockRef.current) return
    setRunMode('run')
    setWorkflowDebug(null)
    setRuntimePanelOpen(false)
    setRunnerFollowMode(true)
    setSelectedLoopSnapshot(null)
    const base = createExecutionState(workflow, 'run')
    const validationError = branchConfigurationErrors(workflow).join('；') || validateRuntimeInputs(workflow)
    if (validationError) {
      setRuntimePanelOpen(true)
      const failed = failInputNodeRuns(base.nodeRuns, validationError)
      const failedState = { ...base, ...failed, selectedNodeId: failed.selectedNodeId }
      setExecutionState(failedState)
      setSelectedRunIndex(failed.selectedRunIndex)
      await persistExecution(failedState)
      return
    }
    setExecutionState(base)
    setSelectedRunIndex(-1)
    await continueFullRun(base)
  }

  const executeStepRun = () => {
    if (executionState.persistenceError) return
    if (stepExecutionLockRef.current || fullExecutionLockRef.current) return
    const executableWorkflow = normalizeWorkflow(activeWorkflow)
    if (serializedValuesDiffer(activeWorkflow, executableWorkflow)) {
      const upgradedWorkflows = workflows.map((workflow) => workflow.id === executableWorkflow.id ? executableWorkflow : workflow)
      setWorkflowsState(upgradedWorkflows)
      void saveWorkflowsToDatabase(upgradedWorkflows)
        .catch((error) => setConfigStatus(`执行前工作流升级保存失败：${error instanceof Error ? error.message : String(error)}`))
    }
    setRunMode('step')
    setRuntimePanelOpen(false)
    setRunnerInspectorTab('config')
    setRunnerFollowMode(true)
    setSelectedLoopSnapshot(null)
    const nodeRuns = createStaticNodeRuns(executableWorkflow)
    const nextState = createExecutionState(executableWorkflow, 'step', nodeRuns)
    const validationError = branchConfigurationErrors(executableWorkflow).join('；') || validateRuntimeInputs(executableWorkflow)
    if (validationError) {
      setRuntimePanelOpen(true)
      const failed = failInputNodeRuns(nodeRuns, validationError)
      const failedState = { ...nextState, ...failed, selectedNodeId: failed.selectedNodeId }
      setExecutionState(failedState)
      setSelectedRunIndex(failed.selectedRunIndex)
      setWorkflowDebug(null)
      persistExecution(failedState)
      return
    }
    setWorkflowDebug({ stepIndex: 0 })
    setExecutionState(nextState)
    setSelectedRunIndex(-1)
    void executeStepIndex(0, nextState, { breakpointForNode: resolveActiveBreakpoint })
  }

  const moveWorkflowDebugStep = (direction: -1 | 1) => {
    if (!workflowDebug || !executionState.nodeRuns.length || stepExecutionLockRef.current) return
    const currentRun = executionState.nodeRuns[workflowDebug.stepIndex]
    if (direction > 0 && currentRun?.status === 'idle') {
      void executeStepIndex(workflowDebug.stepIndex, executionState)
      return
    }
    if (direction > 0 && !canAdvanceStep(currentRun?.status, workflowDebug.stepIndex, executionState.nodeRuns.length)) return
    const nextStepIndex = Math.max(0, Math.min(executionState.nodeRuns.length - 1, workflowDebug.stepIndex + direction))
    const nextState = { stepIndex: nextStepIndex }
    setWorkflowDebug(nextState)
    if (runnerAutoFollowRef.current) setRunnerInspectorTab('config')
    setSelectedNodeId(executionState.nodeRuns[nextStepIndex]?.node.id ?? selectedNode.id)
    if (direction > 0 && executionState.nodeRuns[nextStepIndex]?.status === 'idle') {
      void executeStepIndex(nextStepIndex, executionState)
    } else {
      followExecutionInInspector(nextStepIndex)
    }
  }

  const executeStepIndex = async (
    requestedIndex: number,
    requestedState = executionState,
    options: { breakpointForNode?: (nodeId: string) => WorkflowBreakpoint | undefined; ignoreBreakpointRunId?: string; stopBeforeRun?: (run: NodeRunState) => boolean } = {},
  ): Promise<ExecutionState | undefined> => {
    if (stepExecutionLockRef.current || requestedState.persistenceError) return
    if (isDurationPolicyTransition(activeWorkflow, requestedState.nodeRuns)) {
      setConfigStatus('此记录使用旧时长策略，已冻结原排程和成片证据；请新建执行，从原分镜节点重新规划。')
      return
    }
    const currentNodeIds = new Set(activeWorkflow.nodes.map(node => node.id))
    const runNodeIds = new Set(requestedState.nodeRuns.flatMap(run => [run.node.id, ...(run.node.kind === 'loop' ? run.node.childIds ?? [] : [])]))
    if (currentNodeIds.size !== runNodeIds.size || [...currentNodeIds].some(id => !runNodeIds.has(id))) {
      setConfigStatus('此执行记录属于旧拓扑，已保留原证据。请从升级后的恢复记录继续，避免跳过独立验收。')
      return
    }
    const retryErrors = branchConfigurationErrors(activeWorkflow)
    if (retryErrors.length) { setConfigStatus(retryErrors.join('；')); return }
    const safeRequestedIndex = firstBlockingRunIndex(requestedState.nodeRuns, requestedIndex)
    const requestedRun = requestedState.nodeRuns[safeRequestedIndex]
    if (!requestedRun || requestedRun.status !== 'idle') return
    stepExecutionLockRef.current = true
    let checkpointState = requestedState
    const saveCheckpoint = async (state: ExecutionState) => {
      checkpointState = state
      await requireExecutionCheckpoint(() => persistExecution(state))
    }
    try {
      let index = safeRequestedIndex
      const refreshedRuns = refreshPendingExecutionNodes(normalizeWorkflow(activeWorkflow), requestedState.nodeRuns)
      let baseState = refreshedRuns === requestedState.nodeRuns ? requestedState : { ...requestedState, nodeRuns: refreshedRuns }
      let prepared = prepareStepRun(baseState, index)

      // A route miss is bookkeeping, not a user-visible debug step. Record it and
      // continue to the next runnable node while holding the same execution lock.
      while (prepared && !options.stopBeforeRun?.(prepared.run) && shouldSkipStep(prepared.run.status, prepared.run.node.runIf, prepared.inputContext)) {
        const { run, inputs, inputContext } = prepared
        const output = { skipped: true, condition: run.node.runIf }
        const nextRuns = baseState.nodeRuns.map((item, itemIndex) => itemIndex === index
          ? { ...item, inputs, inputContext, output, context: inputContext, status: 'skipped' as NodeRunStatus, durationMs: 0 }
          : item)
        const logs = [...baseState.logs, `${run.label ?? run.node.title}（分支条件未命中，已跳过）`]
        baseState = { ...baseState, nodeRuns: nextRuns, context: inputContext, logs, selectedNodeId: run.node.id }
        index += 1
        prepared = prepareStepRun(baseState, index)
      }

      const matchingBreakpoint = prepared ? options.breakpointForNode?.(prepared.run.node.id) : undefined
      if (prepared && (options.stopBeforeRun?.(prepared.run)
        || shouldPauseBeforeRun(matchingBreakpoint, prepared.run, prepared.inputContext, options.ignoreBreakpointRunId))) {
        const pausedRuns = baseState.nodeRuns.map((item, itemIndex) => itemIndex === index
          ? { ...item, inputs: prepared.inputs, inputContext: prepared.inputContext }
          : item)
        const pausedState = { ...baseState, nodeRuns: pausedRuns, selectedNodeId: prepared.run.node.id }
        setWorkflowDebug({ stepIndex: index })
        setExecutionState(pausedState)
        setSelectedNodeId(prepared.run.node.id)
        followExecutionInInspector(index)
        if (runnerAutoFollowRef.current && prepared.run.loopGroupId && prepared.run.loopIndex !== undefined) {
          setSelectedLoopSnapshot({ groupId: prepared.run.loopGroupId, loopIndex: prepared.run.loopIndex })
        }
        await saveCheckpoint(pausedState)
        return pausedState
      }

      if (!prepared || prepared.run.status !== 'idle') {
        const lastIndex = Math.max(0, Math.min(index - 1, baseState.nodeRuns.length - 1))
        setWorkflowDebug({ stepIndex: lastIndex })
        setExecutionState(baseState)
        followExecutionInInspector(lastIndex)
        await saveCheckpoint(baseState)
        return baseState
      }

      const { run, context, previousLoopResult, inputContext, inputs } = prepared
      setWorkflowDebug({ stepIndex: index })
      setSelectedNodeId(run.node.id)
      // Ensure a durable resume point exists before starting a long model call.
      await saveCheckpoint(baseState)
      const startedAt = performance.now()
      const runningRuns = baseState.nodeRuns.map((item, itemIndex) => (itemIndex === index ? { ...item, inputs, inputContext, status: 'running' as NodeRunStatus, startedAt } : item))
      const runningState = { ...baseState, nodeRuns: runningRuns, selectedNodeId: run.node.id }
      setExecutionState(runningState)
      followExecutionInInspector(index)
      if (runnerAutoFollowRef.current && run.loopGroupId && run.loopIndex !== undefined) setSelectedLoopSnapshot({ groupId: run.loopGroupId, loopIndex: run.loopIndex })
      try {
        // Persist the exact in-flight node and resolved inputs before crossing a
        // long model boundary. A reload can then recover this node as idle,
        // while other tabs and diagnostics no longer mistake it for unstarted.
        await saveCheckpoint(runningState)
        const effectiveNode = nodeWithRunOverrides(run)
        const disposition = workflowQualityDisposition(normalizeWorkflow(activeWorkflow))
        const writerInputs = failedTextCandidateWriterInputs(effectiveNode.operation ?? '',
          { ...inputs, ...(disposition ? { qualityDisposition: disposition } : {}) }, inputContext)
        const failedBinding = failedTextRunBinding(baseState, index, inputContext, writerInputs, effectiveNode)
        const carriedFailure = failedBinding ? readFailedTextCandidate(run.retryFeedback, failedBinding) : undefined
        const writerProjection = effectiveNode.operation === 'history.storyboard'
          ? storyboardContinuityContext({ ...inputContext, qualityDisposition: writerInputs.qualityDisposition }) : inputContext
        const actualTail = resolvePath(writerProjection, 'loop.previous.actualTailEvidence') as Record<string, unknown> | undefined
        const splitCandidate = run.storyboardSplitCandidate && !carriedFailure
          ? readStoryboardSplitCandidate({ reference: run.storyboardSplitCandidate,
              currentPrefix: baseState.nodeRuns.slice(0, index), runtimeInputs: baseState.runtimeInputs,
              currentNode: effectiveNode, currentRun: run,
              model: models.find(model => model.id === effectiveNode.modelId) ?? {}, params: writerInputs,
              scene: resolvePath(writerProjection, 'scene') as Record<string, unknown>, timingPolicy: writerInputs.timingPolicy,
              executionIdentity: { executionId: baseState.id, requestScopeId: baseState.requestScopeId ?? baseState.id, workflowId: baseState.workflowId },
              actualTailUrl: typeof actualTail?.url === 'string' ? actualTail.url : undefined }) : undefined
        let output = await executeRealTask({
          failedCandidateBinding: failedBinding, storyboardSplitCandidate: splitCandidate,
          knownVoiceInputs: baseState.nodeRuns.filter(item => item.node.kind === 'video' && item.status !== 'skipped').map(item => item.loopItem),
          voiceExecutionId: baseState.requestScopeId ?? baseState.id, voicePolicy: baseState.voicePolicy,
          executionId: `${baseState.generationScopeId ?? baseState.requestScopeId ?? baseState.id}:attempt-${run.attempt ?? 1}:revision-${run.revision ?? 0}`,
          executionMode: baseState.mode,
          node: effectiveNode,
          policyNodes: baseState.nodeRuns.filter(item => item.loopIndex === undefined
            || (item.loopGroupId === run.loopGroupId && item.loopIndex === run.loopIndex)).map(nodeWithRunOverrides),
          label: run.label,
          loopNode: run.loopNode,
          loopItem: run.loopItem,
          loopIndex: run.loopIndex,
          loopPrevious: previousLoopResult,
        }, inputContext)
        if (run.node.kind === 'branch') {
          const transition = routeBranch(activeWorkflow, runningRuns.map((item, i) => i === index ? { ...item, durationMs: Math.max(1, Math.round(performance.now() - startedAt)) } : item), index, output, inputContext)
          const updated: ExecutionState = { ...baseState, nodeRuns: transition.runs, context: transition.context,
            branchHistory: [...(baseState.branchHistory ?? []), transition.history],
            logs: [...baseState.logs, `${run.node.title} → ${transition.history.value} → ${transition.history.to}`],
            selectedNodeId: transition.runs[transition.index].node.id }
          setWorkflowDebug({ stepIndex: transition.index })
          followExecutionInInspector(transition.index)
          setExecutionState(updated)
          await saveCheckpoint(updated)
          return updated
        }
        const splitSegments = run.node.operation === 'history.storyboard' ? storyboardSegments(output) : []
        const splitSource = output && typeof output === 'object' && !Array.isArray(output)
          ? (output as Record<string, unknown>)[STORYBOARD_SPLIT_SOURCE_KEY] as StoryboardSplitSourceEnvelope | undefined : undefined
        const publicSegments = splitSegments.length > 1 ? splitSegments.map(publicStoryboardOutput) : []
        const sourceScene = splitSource?.expected.scene ?? run.loopItem
        const splitScenes = publicSegments.map((segment, partIndex) => sceneFromStoryboardSegment(sourceScene, segment, partIndex, publicSegments.length))
        if (publicSegments.length) output = publicSegments[0]
        const expandedInputContext = publicSegments.length
          ? {
              ...expandedSceneOutline(inputContext, run.loopItem, publicSegments),
              ...(run.loopNode ? { [run.loopNode.loop.itemVar]: splitScenes[0] } : {}),
            }
          : run.node.operation === 'history.storyboard' ? expandedSceneOutline(inputContext, run.loopItem, [output as Record<string, unknown>]) : inputContext
        let nextContext = applyNodeOutputToContext(expandedInputContext, run.node.resultVar, output)
        let nextRuns = runningRuns.map((item, itemIndex) => (itemIndex === index ? { ...item, output, context: nextContext, status: 'success' as NodeRunStatus, durationMs: Math.max(1, Math.round(performance.now() - startedAt)) } : item))
        if (publicSegments.length && run.loopNode && run.loopGroupId) {
          const currentLoopIndex = run.loopIndex ?? 0
          const loopChildren = getLoopNodes(activeWorkflow, run.loopNode.id)
          const insertionIndex = nextRuns.findIndex((item, itemIndex) => itemIndex > index && item.loopGroupId === run.loopGroupId && (item.loopIndex ?? 0) > currentLoopIndex)
          const insertAt = insertionIndex >= 0 ? insertionIndex : nextRuns.findIndex((item, itemIndex) => itemIndex > index && item.loopGroupId !== run.loopGroupId)
          const boundedInsertAt = insertAt >= 0 ? insertAt : nextRuns.length
          const extraCount = splitScenes.length - 1
          nextRuns = nextRuns.map((item) => {
            if (item.loopGroupId === run.loopGroupId && item.loopIndex === currentLoopIndex) return { ...item, loopItem: splitScenes[0] }
            if (item.loopGroupId !== run.loopGroupId || (item.loopIndex ?? 0) <= currentLoopIndex) return item
            const loopItem = item.loopItem && typeof item.loopItem === 'object' && !Array.isArray(item.loopItem)
              ? { ...item.loopItem as Record<string, unknown>, sequence: Number((item.loopItem as Record<string, unknown>).sequence ?? 0) + extraCount }
              : item.loopItem
            const loopIndex = (item.loopIndex ?? 0) + extraCount
            return { ...item, loopIndex, loopItem, label: `第 ${loopIndex + 1} 轮 / ${item.node.title} -> ${item.node.resultVar}` }
          })
          const insertedRuns: NodeRunState[] = []
          splitScenes.slice(1).forEach((splitScene, extraIndex) => {
            const loopIndex = currentLoopIndex + extraIndex + 1
            loopChildren.forEach((child, childIndex) => {
              insertedRuns.push({
                id: `${child.id}-${run.loopGroupId}-split-${loopIndex}-${childIndex}`,
                node: child,
                output: undefined,
                context: {},
                inputs: {},
                inputContext: {},
                label: `第 ${loopIndex + 1} 轮 / ${child.title} -> ${child.resultVar}`,
                status: 'idle',
                durationMs: 0,
                loopNode: run.loopNode,
                loopItem: splitScene,
                loopIndex,
                loopPrevious: undefined,
                loopGroupId: run.loopGroupId,
                loopIsLast: false,
              })
            })
          })
          nextRuns = [...nextRuns.slice(0, boundedInsertAt), ...insertedRuns, ...nextRuns.slice(boundedInsertAt)]
          const lastLoopIndex = Math.max(...nextRuns.filter((item) => item.loopGroupId === run.loopGroupId).map((item) => item.loopIndex ?? 0))
          nextRuns = nextRuns.map((item) => item.loopGroupId === run.loopGroupId ? {
            ...item,
            loopIsLast: item.loopIndex === lastLoopIndex && item.node.id === loopChildren.at(-1)?.id,
          } : item)
          if (splitSource) {
            const sourceBinding = splitSource.source.binding
            if (!sourceBinding) throw new Error('STORYBOARD_SPLIT_CANDIDATE_INVALID: successful split lacks its provider binding')
            const plan = await createStoryboardSplitPlan({
              source: { executionId: baseState.id, requestScopeId: baseState.requestScopeId ?? baseState.id,
                generationScopeId: sourceBinding.generationScopeId, workflowId: baseState.workflowId,
                nodeId: run.node.id, runId: run.id, loopGroupId: run.loopGroupId, loopIndex: currentLoopIndex,
                attempt: sourceBinding.attempt, revision: sourceBinding.revision, sceneId: sourceBinding.sceneId,
                requestKey: splitSource.source.requestKey, httpStatus: splitSource.source.httpStatus,
                modelExecutionId: splitSource.source.modelExecutionId },
              raw: splitSource.source.raw, validatedSegments: publicSegments,
              sourceRun: nextRuns[index], sourcePrefix: baseState.nodeRuns.slice(0, index),
              runtimeInputs: baseState.runtimeInputs, sourceParams: writerInputs,
              model: models.find(model => model.id === effectiveNode.modelId) ?? {},
              originalScene: sourceScene as Record<string, unknown>, timingPolicy: writerInputs.timingPolicy,
              expected: splitSource.expected,
            })
            nextRuns = nextRuns.map((item, itemIndex) => {
              if (itemIndex === index) return { ...item, storyboardSplitPlan: plan }
              const segmentIndex = (item.loopIndex ?? -1) - currentLoopIndex
              return item.loopGroupId === run.loopGroupId && item.node.id === run.node.id
                && segmentIndex >= 1 && segmentIndex < publicSegments.length
                ? { ...item, storyboardSplitCandidate: storyboardSplitCandidateRef(plan, segmentIndex) } : item
            })
          }
        }
        if (run.node.kind === 'loop' && run.node.loop.enabled) {
          const loopItems = getLoopItems(nextContext, run.node)
          const loopChildren = getLoopNodes(activeWorkflow, run.node.id)
          const childIds = new Set(loopChildren.map((child) => child.id))
          const loopGroupId = `${run.node.id}-${Date.now()}`
          const expandedRuns: NodeRunState[] = []
          loopItems.forEach((loopItem, loopIndex) => {
            loopChildren.forEach((child, childIndex) => {
              expandedRuns.push({
                id: `${child.id}-${loopGroupId}-${loopIndex}-${childIndex}`,
                node: child,
                output: undefined,
                context: {},
                inputs: {},
                inputContext: {},
                label: `第 ${loopIndex + 1} 轮 / ${child.title} -> ${child.resultVar}`,
                status: run.branchEntryTarget && loopIndex === 0 && childIndex < loopChildren.findIndex(n => n.id === run.branchEntryTarget) ? 'skipped' : 'idle',
                branchState: run.branchCarry?.[child.id]?.loopIndex === loopIndex ? run.branchCarry[child.id].state : undefined,
                paramOverrides: run.branchCarry?.[child.id]?.loopIndex === loopIndex ? run.branchCarry[child.id].paramOverrides : undefined,
                durationMs: 0,
                loopNode: run.node,
                loopItem,
                loopIndex,
                loopPrevious: undefined,
                loopGroupId,
                loopIsLast: loopIndex === loopItems.length - 1 && childIndex === loopChildren.length - 1,
              })
            })
          })
          nextRuns = [...nextRuns.slice(0, index + 1), ...expandedRuns, ...nextRuns.slice(index + 1).filter((item) => !childIds.has(item.node.id))]
        } else if (run.loopGroupId && run.loopIsLast && run.loopNode) {
          const completedLoopRuns = nextRuns.filter((item) => item.loopGroupId === run.loopGroupId && item.status === 'success')
          const iterations = new Map<number, Record<string, unknown>>()
          completedLoopRuns.forEach((item) => {
            const iteration = iterations.get(item.loopIndex ?? 0) ?? {}
            iteration[item.node.resultVar] = item.output
            iterations.set(item.loopIndex ?? 0, iteration)
          })
          const orderedIterations = [...iterations.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)
          const loopOutputs = aggregateLoopOutputs(orderedIterations, Object.fromEntries(getLoopNodes(activeWorkflow, run.loopNode.id)
            .map(child => [child.resultVar, child.loopResultMode ?? 'collect'])))
          nextContext = { ...nextContext, ...loopOutputs }
          nextRuns = nextRuns.map((item, itemIndex) => itemIndex === index ? { ...item, context: nextContext } : item)
        }
        const logs = [...baseState.logs, run.label ?? `${run.node.title} -> ${run.node.resultVar}`]
        const updated = { ...baseState, nodeRuns: nextRuns, context: nextContext, logs, selectedNodeId: run.node.id }
        setExecutionState(updated)
        await saveCheckpoint(updated)
        if (requiresManualMediaDecision(nextRuns[index])) setRunnerInspectorTab('output')
        return updated
      } catch (error) {
        if (error instanceof ExecutionPersistenceError) throw error
        const message = error instanceof Error ? error.message : String(error)
        const logs = [...baseState.logs, `${run.node.title} -> 失败：${message}`]
        const nextRuns = runningRuns.map((item, itemIndex) => (itemIndex === index ? { ...item,
          ...(error instanceof FailedTextCandidateError ? { retryFeedback: withFailedTextCandidate(item.retryFeedback, error.evidence) } : {}),
          output: { error: message }, context: { ...context, error: message }, status: 'failed' as NodeRunStatus, error: message, durationMs: Math.max(1, Math.round(performance.now() - startedAt)) } : item))
        const updated = { ...baseState, nodeRuns: nextRuns, context: { ...context, error: message }, logs, selectedNodeId: run.node.id }
        setExecutionState(updated)
        await saveCheckpoint(updated)
        return updated
      }
    } catch (error) {
      if (!(error instanceof ExecutionPersistenceError)) throw error
      // Storage failure is not a model failure: retain the completed output and
      // stop the executor until this exact checkpoint can be saved.
      setExecutionState({ ...checkpointState, persistenceError: error.message })
      return undefined
    } finally {
      stepExecutionLockRef.current = false
    }
  }

  const continueToNextBreakpoint = async () => {
    if (!workflowDebug || stepExecutionLockRef.current || debugContinueRunning || executionState.persistenceError) return
    setDebugContinueRunning(true)
    if (runnerAutoFollowRef.current) setRunnerInspectorTab('config')
    try {
      let state = executionState
      const currentIndex = workflowDebug.stepIndex
      const currentRun = state.nodeRuns[currentIndex]

      // Resuming from a breakpoint executes that paused node once. Subsequent
      // breakpoint checks pause before executing the matching node.
      if (currentRun?.status === 'idle') {
        const previous = state
        const updated = await executeStepIndex(currentIndex, state, {
          breakpointForNode: resolveActiveBreakpoint,
          ignoreBreakpointRunId: currentRun.id,
        })
        if (!updated) return
        state = updated
        if (state.nodeRuns.some((run) => run.status === 'failed')) return
        if (newlyRequiredManualMediaDecision(previous.nodeRuns, state.nodeRuns)) return
      }

      while (true) {
        const firstPendingIndex = state.nodeRuns.findIndex((run) => run.status === 'idle')
        if (firstPendingIndex < 0) return
        const pendingRunId = state.nodeRuns[firstPendingIndex]?.id
        const previous = state
        const updated = await executeStepIndex(firstPendingIndex, state, { breakpointForNode: resolveActiveBreakpoint })
        if (!updated) return
        state = updated
        if (state.nodeRuns.find((run) => run.id === pendingRunId)?.status === 'idle') return
        if (state.nodeRuns.some((run) => run.status === 'failed')) return
        if (newlyRequiredManualMediaDecision(previous.nodeRuns, state.nodeRuns)) return
      }
    } finally {
      setDebugContinueRunning(false)
    }
  }

  const loadHistoricalExecution = (record: ExecutionRecord) => {
    const upgradedRuns = migrateBranchRuns(activeWorkflow, record.result.nodeRuns)
    if (upgradedRuns !== record.result.nodeRuns) {
      const result = { ...record.result, id: createId('record'), requestScopeId: record.result.requestScopeId ?? record.result.id, nodeRuns: upgradedRuns,
        selectedNodeId: upgradedRuns.find(r => r.status === 'failed')?.node.id ?? record.result.selectedNodeId }
      record = { ...record, id: result.id, result }
      void persistExecution(result)
    }

    setRunMode(record.mode)
    setRuntimePanelOpen(false)
    setRunnerInspectorTab('config')
    setExecutionState({ ...record.result, historical: true })
    const selectedIndex = historicalInspectorRunIndex(record.result.nodeRuns, record.result.selectedNodeId)
    setWorkflowDebug(record.mode === 'step' ? { stepIndex: selectedIndex } : null)
    setSelectedRunIndex(selectedIndex)
    const historicalRun = record.result.nodeRuns[selectedIndex]
    setRunnerFollowMode(false)
    setSelectedLoopSnapshot(historicalRun?.loopGroupId && historicalRun.loopIndex !== undefined
      ? { groupId: historicalRun.loopGroupId, loopIndex: historicalRun.loopIndex }
      : null)
  }

  const resolveExecutionRecord = async (item: ExecutionRecordListItem) => {
    if (item.runtimeInputs && item.result) return item as ExecutionRecord
    const { record } = await loadExecutionRecord(item.id)
    return record
  }

  const openHistoricalExecution = async (item: ExecutionRecordListItem) => {
    if (executionState.persistenceError) return
    setExecutionRecordLoadingId(item.id)
    try {
      const record = await resolveExecutionRecord(item)
      loadHistoricalExecution(record)
      setRunnerTab('execute')
    } catch (error) {
      setConfigStatus(`执行记录详情加载失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setExecutionRecordLoadingId('')
    }
  }

  const retryFromRunIndex = async (index: number) => {
    if (isDebugBusy || failedTextRetryLockRef.current || stepExecutionLockRef.current || fullExecutionLockRef.current || rollbackSaveLock.current || executionState.persistenceError) return
    if (isDurationPolicyTransition(activeWorkflow, executionState.nodeRuns)) {
      setConfigStatus('此记录的旧时长策略已冻结；请从保留原大纲的新重排记录继续，不能将旧视频接到新排程验收。')
      return
    }
    setRunnerFollowMode(true)
    const validationError = validateRuntimeInputs(activeWorkflow)
    if (validationError) {
      const failed = failInputNodeRuns(executionState.nodeRuns, validationError)
      const failedState = { ...executionState, id: createId('record'), ...failed, selectedNodeId: failed.selectedNodeId }
      setExecutionState(failedState)
      setSelectedRunIndex(failed.selectedRunIndex)
      persistExecution(failedState)
      return
    }
    const currentIds = new Set(activeWorkflow.nodes.map(node=>node.id))
    const snapshotIds = new Set(executionState.nodeRuns.flatMap(run=>[run.node.id,...(run.node.kind==='loop'?run.node.childIds??[]:[])]))
    if (currentIds.size !== snapshotIds.size || [...currentIds].some(id=>!snapshotIds.has(id))) {
      setConfigStatus('此记录保留旧流程的验收证据。请打开已升级的恢复记录继续，或开始新执行；已阻止旧拓扑绕过独立验收。')
      return
    }
    const retryIndex = firstBlockingRunIndex(executionState.nodeRuns, index)
    if (executionState.nodeRuns[retryIndex]?.node.kind === 'branch') {
      const nodeRuns = retryBranchRun(executionState.nodeRuns, retryIndex)
      const id = createId('record')
      const updated = { ...executionState, id, parentExecutionId: executionState.id,
        requestScopeId: executionState.requestScopeId ?? executionState.id, generationScopeId: id,
        historical: false, mode: 'step' as const, nodeRuns, selectedNodeId: nodeRuns[retryIndex].node.id }
      setRunMode('step')
      setWorkflowDebug({ stepIndex: retryIndex })
      setExecutionState(updated)
      setSelectedRunIndex(retryIndex)
      void executeStepIndex(retryIndex, updated)
      return
    }
    const invalidated = activeWorkflow.id === 'wf-sanguo-history-drama' ? historicalVideoRetryIndexes(executionState.nodeRuns, retryIndex) : undefined
    let sourceRuns = executionState.nodeRuns
    let failedCandidateBinding: FailedTextCandidateBinding | undefined
    const failedRun = sourceRuns[retryIndex]
    if (failedRun?.status === 'failed' && isRecoverableFailedTextNode(failedRun.node, failedRun.inputs ?? {})
      && isFailedTextCandidateValidationMessage(failedRun.error, failedRun.node.operation)) {
      failedTextRetryLockRef.current = true
      setFailedTextRetryLoading(true)
      try {
        const disposition = workflowQualityDisposition(normalizeWorkflow(activeWorkflow))
        failedCandidateBinding = failedTextRunBinding(executionState, retryIndex, failedRun.inputContext ?? {},
          { ...failedRun.inputs, ...(disposition ? { qualityDisposition: disposition } : {}) })
        if (!failedCandidateBinding) throw new Error('FAILED_TEXT_CANDIDATE_INVALID: missing source run binding')
        let evidence = readFailedTextCandidate(failedRun.retryFeedback, failedCandidateBinding)
        if (!evidence) {
          const ledger = await loadModelExecutionRecords({ workflowId: failedCandidateBinding.workflowId, nodeId: failedCandidateBinding.nodeId,
            operation: failedCandidateBinding.operation, requestKeyPrefix: failedTextCandidateRequestPrefix(failedCandidateBinding), capability: 'text', limit: '20' })
          evidence = failedTextCandidateFromLedger(ledger.records, failedCandidateBinding, failedRun.error!)
        }
        if (executionStateIdRef.current !== executionState.id) throw new Error('FAILED_TEXT_CANDIDATE_INVALID: execution changed while loading source evidence')
        // Attach to the in-memory retry source only. The failed persisted record
        // remains intact and every already completed prefix result is retained.
        if (evidence) sourceRuns = sourceRuns.map((run, at) => at === retryIndex ? { ...run, retryFeedback: withFailedTextCandidate(run.retryFeedback, evidence!) } : run)
      } catch (error) {
        setConfigStatus(`失败候选恢复已停止：${error instanceof Error ? error.message : String(error)}`)
        return
      } finally {
        failedTextRetryLockRef.current = false
        setFailedTextRetryLoading(false)
      }
    }
    const baseRuns = manualRetryRuns(sourceRuns, retryIndex, invalidated, failedCandidateBinding)
    const completedRuns = baseRuns.slice(0, retryIndex).filter((run) => run.status === 'success' || run.status === 'skipped')
    const id = createId('record')
    // Transport recovery resumes paid mapped siblings; an intentional new
    // candidate needs a unique namespace even when retried from the same source.
    const resumesTransport = baseRuns[retryIndex]?.revision === executionState.nodeRuns[retryIndex]?.revision
    const updated = {
      ...executionState,
      id,
      parentExecutionId: executionState.id,
      generationScopeId: resumesTransport ? executionState.generationScopeId ?? executionState.requestScopeId ?? executionState.id : id,
      requestScopeId: executionState.requestScopeId ?? executionState.id,
      historical: false,
      mode: 'step' as const,
      nodeRuns: baseRuns,
      context: completedRuns.at(-1)?.context ?? {},
      logs: completedRuns.map((run) => run.label ?? `${run.node.title} -> ${run.node.resultVar}`),
      selectedNodeId: baseRuns[retryIndex]?.node.id,
    }
    setRunMode('step')
    setWorkflowDebug({ stepIndex: retryIndex })
    setExecutionState(updated)
    setSelectedRunIndex(retryIndex)
    void executeStepIndex(retryIndex, updated)
  }

  const createVoiceUpgradeExecution = async (plan: VoiceUpgradePlan) => {
    if (isDebugBusy || executionState.persistenceError) throw Error('请等待当前执行停止并保存后再创建换声分支')
    if (executionState.voicePolicy !== 'strict') throw Error('旧执行没有固定声音策略，请按参数创建完整新执行')
    const currentIds = new Set(activeWorkflow.nodes.map(node => node.id))
    const snapshotIds = new Set(executionState.nodeRuns.flatMap(run => [run.node.id, ...(run.node.kind === 'loop' ? run.node.childIds ?? [] : [])]))
    if (currentIds.size !== snapshotIds.size || [...currentIds].some(id => !snapshotIds.has(id)) || isDurationPolicyTransition(activeWorkflow, executionState.nodeRuns)) throw Error('当前流程与原执行不兼容，请从已升级的恢复记录创建换声分支')
    const id = createId('record'), first = Math.min(...plan.indexes)
    const sourceId = executionState.requestScopeId ?? executionState.id
    await requestJson('/api/character-voices/upgrade', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId, targetId: id, expected: plan.changes.map(c => ({ characterId: c.to.characterId, version: c.to.version })) }) })
    const nodeRuns = manualRetryRuns(executionState.nodeRuns, first, new Set(plan.indexes))
    const completed = nodeRuns.slice(0, first).filter(run => run.status === 'success' || run.status === 'skipped')
    const next: ExecutionState = { ...executionState, id, requestScopeId: id, generationScopeId: id, historical: false, mode: 'step', nodeRuns,
      context: completed.at(-1)?.context ?? {}, selectedNodeId: nodeRuns[first].node.id,
      logs: [...completed.map(run => run.label ?? run.node.title), `从 ${executionState.id} 创建换声执行，等待开始生成`],
      voiceUpgrade: { sourceExecutionId: executionState.id, characterVersions: plan.changes.map(c => ({ characterId: c.to.characterId, from: c.from.version, to: c.to.version })), invalidatedRunIds: plan.indexes.map(i => nodeRuns[i].id) },
    }
    const saved = await persistExecution(next)
    if (!saved.saved) throw Error(saved.error)
    setExecutionState(next); setRunMode('step'); setSelectedRunIndex(first); setWorkflowDebug({ stepIndex: first }); setBranchSceneSelection(null)
    setConfigStatus('换声分支已保存。原执行保留；点击继续执行后才会生成新视频。')
  }

  const openRollbackDialog = (mode: 'previous' | 'specific') => {
    if (isDebugBusy || hasUnsavedExecution) return
    const target = mode === 'previous' ? previousRollbackTarget : previousRollbackTarget ?? rollbackTargets.at(-1)
    if (!target) return
    setRollbackDialog({ executionId: executionState.id, targetRunId: target.run.id, mode })
  }

  const createBreakpointRollbackExecution = async () => {
    if (!rollbackDialogActive || !rollbackTarget || isDebugBusy || stepExecutionLockRef.current || fullExecutionLockRef.current || rollbackSaveLock.current || executionState.persistenceError) return
    rollbackSaveLock.current = true
    setRollbackSaving(true)
    try {
      if (isDurationPolicyTransition(activeWorkflow, executionState.nodeRuns)) throw Error('此记录使用旧时长策略，请从已升级的恢复记录继续。')
      const currentIds = new Set(activeWorkflow.nodes.map(node => node.id))
      const snapshotIds = new Set(executionState.nodeRuns.flatMap(run => [run.node.id, ...(run.node.kind === 'loop' ? run.node.childIds ?? [] : [])]))
      if (currentIds.size !== snapshotIds.size || [...currentIds].some(id => !snapshotIds.has(id))) throw Error('当前流程与原记录不兼容，请从已升级的恢复记录回退。')
      const { state: fork, plan } = forkBreakpointRollback(executionState, {
        id: createId('record'), targetRunId: rollbackTarget.run.id, breakpoints: rollbackBreakpoints, createdAt: new Date().toISOString(),
      })
      // A rollback to the first node leaves the whole queue idle. Refresh its
      // pending definitions before saving so plan reconciliation keeps this
      // fork and its provenance instead of replacing it with a fresh run.
      const refreshed = { ...fork, nodeRuns: refreshPendingExecutionNodes(normalizeWorkflow(activeWorkflow), fork.nodeRuns) }
      const prepared = prepareStepRun(refreshed, plan.targetIndex)
      const next: ExecutionState = prepared ? { ...refreshed, nodeRuns: refreshed.nodeRuns.map((run, index) => index === plan.targetIndex
        ? { ...run, inputs: prepared.inputs, inputContext: prepared.inputContext } : run) } : refreshed
      const saved = await persistExecution(next)
      if (!saved.saved) throw Error(saved.error)
      if (executionStateIdRef.current !== executionState.id || activeWorkflowIdRef.current !== executionState.workflowId) {
        setRollbackDialog(null)
        setConfigStatus(`回退记录 ${next.id} 已保存，可从历史记录打开。`)
        return
      }
      // Reject late source-record responses immediately, before React commits
      // the newly selected rollback record.
      executionStateIdRef.current = next.id
      setExecutionState(next)
      setRunMode('step')
      setWorkflowDebug({ stepIndex: plan.targetIndex })
      setSelectedRunIndex(plan.targetIndex)
      const targetRun = next.nodeRuns[plan.targetIndex]
      setSelectedNodeId(targetRun.node.id)
      setSelectedLoopSnapshot(targetRun.loopGroupId && targetRun.loopIndex !== undefined
        ? { groupId: targetRun.loopGroupId, loopIndex: targetRun.loopIndex } : null)
      setBranchSceneSelection(null)
      setRunnerFollowMode(true)
      setRunnerInspectorTab('config')
      setRuntimePanelOpen(false)
      setRollbackDialog(null)
      setConfigStatus(`已回退到 ${targetRun.loopIndex !== undefined ? `第 ${targetRun.loopIndex + 1} 轮 · ` : ''}${targetRun.node.title} 的执行前；原记录和目标之前的成果保留。点击“下一步”或“运行到下一断点”继续。`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setRollbackDialog(current => current?.executionId === executionState.id ? { ...current, error: message } : current)
      setConfigStatus(message)
    } finally {
      rollbackSaveLock.current = false
      setRollbackSaving(false)
    }
  }

  const previousRollbackControl = <button type="button" className="ghost-btn" onClick={() => openRollbackDialog('previous')}
    disabled={isDebugBusy || hasUnsavedExecution || !previousRollbackTarget}
    title={previousRollbackTarget ? '回退到当前执行位置之前最近一个已到达的断点' : '当前执行位置之前没有可回退的断点'}>
    <RotateCcw size={17} />回退到上一个断点
  </button>

  const rollbackControl = <button type="button" className="ghost-btn" onClick={() => openRollbackDialog('specific')}
    disabled={isDebugBusy || hasUnsavedExecution || rollbackTargets.length === 0}
    title={rollbackTargets.length ? '选择已到达的断点，保留此前成果并回退到执行前' : '请先为已到达的节点设置断点；条件断点只列出条件匹配的轮次'}>
    <RotateCcw size={17} />回退到指定断点
  </button>
  const rollbackControls = <div className="rollback-action-pair">{previousRollbackControl}{rollbackControl}</div>

  const workflowWithRuntimeInputs = (workflow: Workflow, runtimeInputs: Record<string, unknown>): Workflow => ({
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      const values = runtimeInputs[node.resultVar]
      if (node.kind !== 'input' || !values || typeof values !== 'object') return node
      const valueMap = values as Record<string, unknown>
      return {
        ...node,
        params: node.params.map((param) => {
          const key = param.englishName || param.name
          return key in valueMap ? { ...param, value: stringifyValue(valueMap[key]) } : param
        }),
      }
    }),
  })

  const rerunHistoricalExecution = async (item: ExecutionRecordListItem) => {
    if (executionState.persistenceError) return
    setExecutionRecordLoadingId(item.id)
    try {
      const record = await resolveExecutionRecord(item)
      const workflow = workflowWithRuntimeInputs(activeWorkflow, record.runtimeInputs)
      updateActiveWorkflow(() => workflow)
      setRunnerTab('execute')
      await runFullWorkflow(workflow)
    } catch (error) {
      setConfigStatus(`历史记录重跑失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setExecutionRecordLoadingId('')
    }
  }

  const getModelStorageSummary = (items: ModelConfig[]) =>
    items.map((model) => ({
      name: model.name,
      provider: model.provider,
      capability: model.capability,
      apiKeyLength: model.settings.apiKey?.length ?? 0,
      accessKeyLength: model.settings.accessKey?.length ?? 0,
      secretKeyLength: model.settings.secretKey?.length ?? 0,
      endpoint: model.settings.endpoint,
      model: model.settings.model,
    }))

  const inspectModelStorage = async () => {
    try {
      const stored = await loadConfigFromDatabase()
      setStorageDiagnostic(JSON.stringify({ source: 'postgresql:model_configs', models: getModelStorageSummary(stored.models) }, null, 2))
      setConfigStatus('已从 PostgreSQL 拉取模型配置')
    } catch (error) {
      setConfigStatus(`配置拉取失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const runModelStorageSelfTest = async () => {
    const probeKey = `probe-key-${Date.now()}`
    const probeModel: ModelConfig = {
      id: 'storage-probe-model',
      name: 'storage-probe-model',
      provider: 'Custom',
      capability: 'text',
      settings: { endpoint: 'https://example.invalid', model: 'probe', apiKey: probeKey },
      testInput: 'probe',
      testResult: '',
    }
    try {
      const before = (await loadConfigFromDatabase()).models
      await saveModelsToDatabase([...before.filter((model) => model.id !== probeModel.id), probeModel])
      const after = await loadConfigFromDatabase()
      const matched = after.models.find((model) => model.id === probeModel.id)
      await saveModelsToDatabase(before)
      const ok = matched?.settings.apiKey === probeKey
      setStorageDiagnostic(
        JSON.stringify(
          {
            selfTest: ok ? '通过' : '失败',
            storage: 'postgresql:model_configs',
            wroteKeyLength: probeKey.length,
            readKeyLength: matched?.settings.apiKey?.length ?? 0,
            restored: true,
            note: '自测使用临时假 key，写入后已恢复原配置。',
          },
          null,
          2,
        ),
      )
      setConfigStatus(ok ? 'PostgreSQL 入库自测通过' : 'PostgreSQL 入库自测失败')
    } catch (error) {
      setConfigStatus(`PostgreSQL 入库自测失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const updateModelTestParam = (modelId: string, key: string, value: ExperienceValue) =>
    setModelTestParams((current) => ({
      ...current,
      [modelId]: { ...current[modelId], [key]: value },
    }))

  const experienceFieldValue = (model: ModelConfig, field: ExperienceField) =>
    modelTestParams[model.id]?.[field.key] ?? field.defaultValue

  const experienceFieldDisabled = (model: ModelConfig, field: ExperienceField) => {
    const values = modelTestParams[model.id] ?? {}
    const multiShot = Boolean(values.multiShot ?? false)
    const shotType = String(values.shotType ?? 'intelligence')
    const hasReferenceImage = Boolean(String(values.referenceImage ?? '').trim())
    if (field.key === 'shotType') return !multiShot
    if (field.key === 'multiPrompt') return !multiShot || shotType !== 'customize'
    if (field.key === 'endImage' || field.key === 'staticMask' || field.key === 'dynamicMasks') return !hasReferenceImage
    return false
  }

  const uploadExperienceImage = async (model: ModelConfig, field: ExperienceField, file?: File) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      updateModel(model.id, { testResult: `参数错误：${field.label}只支持图片文件` })
      return
    }
    try {
      updateModelTestParam(model.id, field.key, await assetDataUrl(file))
    } catch (error) {
      updateModel(model.id, { testResult: `图片读取失败：${error instanceof Error ? error.message : String(error)}` })
    }
  }

  const uploadExperienceImages = async (model: ModelConfig, field: ExperienceField, files?: FileList | null) => {
    if (!files?.length) return
    const selected = Array.from(files)
    const invalid = selected.find((file) => !file.type.startsWith('image/'))
    if (invalid) {
      updateModel(model.id, { testResult: `参数错误：${invalid.name} 不是图片文件` })
      return
    }
    const oversized = selected.find((file) => file.size > 10 * 1024 * 1024)
    if (oversized) {
      updateModel(model.id, { testResult: `参数错误：${oversized.name} 超过 10MB` })
      return
    }
    const current = experienceFieldValue(model, field)
    const existing = Array.isArray(current) ? current : []
    if (existing.length + selected.length > 7) {
      updateModel(model.id, { testResult: '参数错误：参考附件最多上传 7 张图片' })
      return
    }
    try {
      const images = await Promise.all(selected.map(assetDataUrl))
      updateModelTestParam(model.id, field.key, [...existing, ...images])
    } catch (error) {
      updateModel(model.id, { testResult: `图片读取失败：${error instanceof Error ? error.message : String(error)}` })
    }
  }

  const renderExperienceField = (model: ModelConfig, field: ExperienceField) => {
    const value = experienceFieldValue(model, field)
    const disabled = experienceFieldDisabled(model, field)
    if (model.provider === 'Bailian' && field.key === 'voice') return <BailianVoicePicker key={model.settings.model} model={model.settings.model} value={String(value)} disabled={disabled} onChange={voice => updateModelTestParam(model.id, 'voice', voice)} />
    const title = <span className="experience-field-title"><strong>{field.label}<em>选填</em></strong><code>{field.apiName}</code></span>
    if (field.control === 'checkbox') {
      return (
        <label className={`experience-field checkbox-field${disabled ? ' is-disabled' : ''}`} key={field.key}>
          <span className="experience-checkbox-row"><input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(event) => updateModelTestParam(model.id, field.key, event.target.checked)} />{title}</span>
          {field.help ? <small>{field.help}</small> : null}
        </label>
      )
    }
    if (field.control === 'images') {
      const images = Array.isArray(value) ? value : []
      return (
        <div className={`experience-field experience-attachments-field${disabled ? ' is-disabled' : ''}`} key={field.key}>
          {title}
          <div className="experience-attachment-actions">
            <label className="upload-btn"><ImageIcon size={15} />添加参考附件<input type="file" accept="image/*" multiple disabled={disabled} onChange={(event) => { void uploadExperienceImages(model, field, event.target.files); event.currentTarget.value = '' }} /></label>
            <span>{images.length}/7 张</span>
          </div>
          {images.length ? (
            <div className="experience-attachment-grid">
              {images.map((image, index) => (
                <div className="experience-attachment-item" key={`${image.slice(0, 48)}-${index}`}>
                  <img src={image} alt={`参考附件 ${index + 1}`} />
                  <span>@参考附件{index + 1}</span>
                  <button type="button" className="node-action" aria-label={`删除参考附件 ${index + 1}`} disabled={disabled} onClick={() => updateModelTestParam(model.id, field.key, images.filter((_, itemIndex) => itemIndex !== index))}><XCircle size={15} /></button>
                </div>
              ))}
            </div>
          ) : <div className="experience-attachment-empty"><ImageIcon size={20} />尚未添加参考附件</div>}
          {field.help ? <small>{field.help}</small> : null}
        </div>
      )
    }
    const commonProps = {
      value: String(value),
      disabled,
      placeholder: field.placeholder,
      onChange: (event: { target: { value: string } }) => updateModelTestParam(model.id, field.key, event.target.value),
    }
    if (field.control === 'image') {
      const imageSource = String(value).trim()
      const canPreview = imageSource.startsWith('data:image/') || /^https?:\/\//i.test(imageSource)
      return (
        <div className={`experience-field experience-image-field${disabled ? ' is-disabled' : ''}`} key={field.key}>
          {title}
          <div className="experience-image-control">
            {canPreview ? <img src={imageSource} alt={`${field.label}预览`} /> : <span className="experience-image-placeholder"><ImageIcon size={22} />未选择本地图片</span>}
            <div className="experience-image-actions">
              <label className="upload-btn"><ImageIcon size={15} />{imageSource ? '替换图片' : '上传图片'}<input type="file" accept="image/*" disabled={disabled} onChange={(event) => { void uploadExperienceImage(model, field, event.target.files?.[0]); event.currentTarget.value = '' }} /></label>
              {imageSource ? <button type="button" className="node-action" title={`清除${field.label}`} disabled={disabled} onClick={() => updateModelTestParam(model.id, field.key, '')}><XCircle size={16} /></button> : null}
            </div>
          </div>
          <textarea {...commonProps} rows={2} spellCheck={false} />
          {field.help ? <small>{field.help}</small> : null}
        </div>
      )
    }
    return (
      <label className={`experience-field${disabled ? ' is-disabled' : ''}`} key={field.key}>
        {title}
        {field.control === 'select' ? (
          <select {...commonProps}>{field.options?.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select>
        ) : field.control === 'textarea' || field.control === 'json' ? (
          <textarea {...commonProps} rows={field.control === 'json' ? 4 : 3} spellCheck={field.control !== 'json'} />
        ) : (
          <input {...commonProps} list={field.options ? `options-${model.id}-${field.key}` : undefined} type={field.control === 'number' ? 'number' : 'text'} min={field.min} max={field.max} step={field.step} />
        )}
        {field.control === 'text' && field.options ? <datalist id={`options-${model.id}-${field.key}`}>{field.options.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}</datalist> : null}
        {field.help ? <small>{field.help}</small> : null}
      </label>
    )
  }

  const renderExperienceParameters = (model: ModelConfig) => {
    const fields = modelExperienceFields(model)
    if (!fields.length) return <p className="empty-note">该模型没有额外的单次调用参数，输入提示词后即可测试。</p>
    const groups = [
      { id: 'input', title: '输入素材', description: model.capability === 'audio' ? '本次语音的人物标记' : '本次生成使用的参考素材' },
      { id: 'generation', title: '生成控制', description: model.capability === 'audio' ? '音色、情绪、语速和音调' : '画幅、时长、质量等单次参数' },
      { id: 'advanced', title: '高级调用', description: model.capability === 'audio' ? '音频采样率和生成种子' : '分镜、运镜、蒙版和任务回调' },
    ] as const
    return (
      <div className="experience-groups">
        {groups.map((group) => {
          const groupFields = fields.filter((field) => field.group === group.id)
          if (!groupFields.length) return null
          return (
            <section className={`experience-param-group ${group.id}`} key={group.id}>
              <div className="experience-group-head"><div><h3>{group.title}</h3><p>{group.description}</p></div><span>{groupFields.length} 项</span></div>
              <div className="experience-field-grid">{groupFields.map((field) => renderExperienceField(model, field))}</div>
            </section>
          )
        })}
      </div>
    )
  }

  const insertExperienceReference = (model: ModelConfig, index: number) => {
    const token = `@参考附件${index + 1}`
    const prompt = model.testInput.trimEnd()
    updateModel(model.id, { testInput: prompt ? `${prompt} ${token}` : token })
  }

  const writeExperienceRawResult = (model: ModelConfig, params: Record<string, unknown>, httpStatus: number, body: unknown) => {
    const text = `HTTP ${httpStatus}\n请求参数：\n${JSON.stringify(sanitizeBase64(params), null, 2)}\n\n接口响应：\n${JSON.stringify(sanitizeBase64(body), null, 2).slice(0, 12000)}`
    updateModel(model.id, { testResult: text })
  }

  const setExperienceRun = (modelId: string, patch: Partial<ExperienceRun>) => {
    setModelTestRuns((current) => {
      const previous = current[modelId] ?? {
        phase: 'submitting',
        startedAt: experienceTimestamp(),
        updatedAt: experienceTimestamp(),
        media: [],
      }
      return { ...current, [modelId]: { ...previous, ...patch } }
    })
  }

  const experienceRunFromResponse = (
    model: ModelConfig,
    status: number,
    body: unknown,
    inspection: ExperienceResponseInspection,
    startedAt: number,
  ): ExperienceRun => {
    const failed = status >= 400 || inspection.failed
    return {
      phase: failed ? 'failed' : inspection.pending ? 'processing' : 'succeeded',
      startedAt,
      updatedAt: experienceTimestamp(),
      httpStatus: status,
      taskId: inspection.taskId,
      providerStatus: inspection.providerStatus,
      message: inspection.message,
      media: inspection.media,
      rawBody: body,
      error: failed ? inspection.message || `${model.name} 调用失败（HTTP ${status}）` : undefined,
    }
  }

  const openExecutionInExperience = (record: ModelExecutionRecord) => {
    const model = draftModels.find((item) => item.id === record.modelId)
    if (!model) {
      setConfigStatus(`无法打开体验页：流水使用的模型 ${record.modelName} 已不在模型配置中`)
      return
    }
    const restored = restoreModelExperienceRequest(model, record.requestData)
    const responseBody = record.responseData ?? (record.error ? { error: record.error, status: 'failed' } : {})
    const inspection = inspectExperienceResponse(responseBody, model.capability)
    const parsedCreatedAt = record.createdAt ? Date.parse(record.createdAt) : Number.NaN
    const startedAt = Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : experienceTimestamp()
    const parsedUpdatedAt = record.updatedAt ? Date.parse(record.updatedAt) : Number.NaN
    const updatedAt = Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : startedAt + Math.max(0, record.durationMs)
    const phase: ExperienceRunPhase = record.status === 'processing'
      ? 'processing'
      : record.status === 'failed'
        ? 'failed'
        : 'succeeded'
    const rawResult = `流水 ${record.id}\n请求参数：\n${JSON.stringify(sanitizeBase64(record.requestData), null, 2)}\n\n接口响应：\n${JSON.stringify(sanitizeBase64(responseBody), null, 2).slice(0, 12000)}`

    setModelTestParams((current) => ({ ...current, [model.id]: restored.values }))
    updateModel(model.id, { testInput: restored.prompt, testResult: rawResult })
    setModelTestRuns((current) => ({
      ...current,
      [model.id]: {
        phase,
        startedAt,
        updatedAt,
        httpStatus: record.httpStatus,
        taskId: record.taskId || inspection.taskId,
        providerStatus: inspection.providerStatus,
        message: phase === 'processing' ? inspection.message || '该流水仍在执行，可继续查询供应商任务' : inspection.message,
        media: inspection.media,
        rawBody: responseBody,
        error: phase === 'failed' ? record.error || inspection.message || '该次调用执行失败' : undefined,
      },
    }))
    if (record.taskId) setModelTaskIds((current) => ({ ...current, [model.id]: record.taskId as string }))
    setExperienceSource({ record, omittedFields: restored.omittedFields })
    setModelView({ mode: 'detail', modelId: model.id })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const pollDelay = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer)
      reject(new DOMException('调用已取消', 'AbortError'))
    }, { once: true })
  })

  const experienceQueryMode = (model: ModelConfig, params: Record<string, unknown>) => {
    if (model.provider !== 'Kling') return undefined
    if (model.capability === 'image') return 'image'
    if (model.capability !== 'video') return undefined
    if (Array.isArray(params.referenceImages) && params.referenceImages.length) return 'omni-video'
    return params.referenceImage ? 'image2video' : 'text2video'
  }

  const pollExperienceTask = async (
    model: ModelConfig,
    params: Record<string, unknown>,
    taskId: string,
    queryMode: string | undefined,
    displayStartedAt: number,
    controller: AbortController,
    immediately = false,
  ) => {
    const intervalMs = Math.max(500, Number(model.settings.pollIntervalMs) || 3000)
    const timeoutMs = Math.max(intervalMs, Number(model.settings.taskTimeoutMs) || 900000)
    const deadline = experienceTimestamp() + timeoutMs
    let firstQuery = true
    while (experienceTimestamp() < deadline) {
      if (!immediately || !firstQuery) await pollDelay(intervalMs, controller.signal)
      firstQuery = false
      const pollResponse = await fetch('/api/model-test/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, params, taskId, queryMode }),
        signal: controller.signal,
      })
      const result = await pollResponse.json() as { status?: number; body?: unknown; error?: string }
      const status = result.status ?? pollResponse.status
      const body = result.body ?? result
      const inspection = inspectExperienceResponse(body, model.capability)
      writeExperienceRawResult(model, params, status, body)
      const nextRun = experienceRunFromResponse(model, status, body, inspection, displayStartedAt)
      setModelTestRuns((current) => ({
        ...current,
        [model.id]: { ...nextRun, taskId: inspection.taskId || taskId, queryMode },
      }))
      if (!inspection.pending || status >= 400) return
    }
    setExperienceRun(model.id, {
      phase: 'paused',
      updatedAt: experienceTimestamp(),
      taskId,
      queryMode,
      message: undefined,
      error: `本轮等待已结束，任务仍在生成。点击“继续查询”即可再次拉取，不需要重新生成。`,
    })
  }

  const resumeExperienceTask = async (model: ModelConfig, requestedTaskId?: string) => {
    const existingRun = modelTestRuns[model.id]
    const taskId = (requestedTaskId || existingRun?.taskId || modelTaskIds[model.id] || '').trim()
    if (!taskId) return
    let params: Record<string, unknown>
    try {
      params = parseModelExperienceParams(model, modelTestParams[model.id])
    } catch {
      params = {}
    }
    modelTestAbortRef.current[model.id]?.abort()
    const controller = new AbortController()
    modelTestAbortRef.current[model.id] = controller
    const queryMode = existingRun?.queryMode ?? experienceQueryMode(model, params)
    const startedAt = existingRun?.startedAt ?? experienceTimestamp()
    setExperienceRun(model.id, {
      phase: 'processing',
      startedAt,
      updatedAt: experienceTimestamp(),
      taskId,
      queryMode,
      error: undefined,
      message: '正在重新拉取供应商任务结果',
    })
    setModelTaskIds((current) => ({ ...current, [model.id]: taskId }))
    try {
      await pollExperienceTask(model, params, taskId, queryMode, startedAt, controller, true)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      const message = error instanceof Error ? error.message : String(error)
      setExperienceRun(model.id, { phase: 'failed', updatedAt: experienceTimestamp(), taskId, queryMode, error: message })
    } finally {
      if (modelTestAbortRef.current[model.id] === controller) delete modelTestAbortRef.current[model.id]
    }
  }

  const testModel = async (model: ModelConfig) => {
    let params: Record<string, unknown>
    try {
      params = parseModelExperienceParams(model, modelTestParams[model.id])
    } catch (error) {
      updateModel(model.id, { testResult: `参数错误：${error instanceof Error ? error.message : String(error)}` })
      return
    }
    modelTestAbortRef.current[model.id]?.abort()
    const controller = new AbortController()
    modelTestAbortRef.current[model.id] = controller
    const startedAt = experienceTimestamp()
    const queryMode = experienceQueryMode(model, params)
    setModelTestRuns((current) => ({
      ...current,
      [model.id]: { phase: 'submitting', startedAt, updatedAt: startedAt, media: [], queryMode },
    }))
    updateModel(model.id, { testResult: '正在调用真实接口...' })
    try {
      const response = await fetch('/api/model-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, params }),
        signal: controller.signal,
      })
      const result = await response.json() as { status?: number; body?: unknown; error?: string }
      const status = result.status ?? response.status
      const body = result.body ?? result
      const inspection = inspectExperienceResponse(body, model.capability)
      writeExperienceRawResult(model, params, status, body)
      const initialRun = experienceRunFromResponse(model, status, body, inspection, startedAt)
      setModelTestRuns((current) => ({ ...current, [model.id]: { ...initialRun, queryMode } }))

      if (!inspection.pending || !inspection.taskId || status >= 400) return
      setModelTaskIds((current) => ({ ...current, [model.id]: inspection.taskId as string }))
      await pollExperienceTask(model, params, inspection.taskId, queryMode, startedAt, controller)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      const message = error instanceof Error ? error.message : String(error)
      updateModel(model.id, { testResult: `测试失败：${message}` })
      setExperienceRun(model.id, { phase: 'failed', updatedAt: experienceTimestamp(), error: message })
    } finally {
      if (modelTestAbortRef.current[model.id] === controller) delete modelTestAbortRef.current[model.id]
    }
  }

  const renderExperienceResult = (model: ModelConfig) => {
    const run = modelTestRuns[model.id]
    if (!run) {
      return (
        <section className="experience-result-panel empty" aria-label="生成结果">
          <div className="experience-result-empty"><Play size={22} /><div><strong>生成结果会显示在这里</strong><span>提交后将自动跟踪任务，完成后可直接预览和下载。</span></div></div>
          {model.provider === 'Kling' && (model.capability === 'video' || model.capability === 'image') ? <div className="experience-task-recovery"><input value={modelTaskIds[model.id] ?? ''} placeholder="输入已有任务 ID" aria-label="已有任务 ID" onChange={(event) => setModelTaskIds((current) => ({ ...current, [model.id]: event.target.value }))} /><button type="button" className="ghost-btn" disabled={!modelTaskIds[model.id]?.trim()} onClick={() => void resumeExperienceTask(model)}>拉取已有结果</button></div> : null}
          {model.testResult ? <details className="experience-raw"><summary>查看上次原始响应</summary><pre className="model-result">{model.testResult}</pre></details> : null}
        </section>
      )
    }
    const isRunning = run.phase === 'submitting' || run.phase === 'processing'
    const label = run.phase === 'submitting' ? '正在提交'
      : run.phase === 'processing' ? '生成中'
        : run.phase === 'paused' ? '等待已暂停'
        : run.phase === 'succeeded' ? '生成完成' : '生成失败'
    const elapsedSeconds = Math.max(0, Math.round((run.updatedAt - run.startedAt) / 1000))
    return (
      <section className={`experience-result-panel ${run.phase}`} aria-label="生成结果" aria-live="polite">
        <header className="experience-result-head">
          <div className="experience-result-status">
            {isRunning ? <LoaderCircle className="run-status-spinner" size={19} /> : run.phase === 'paused' ? <RotateCcw size={19} /> : run.phase === 'succeeded' ? <CheckCircle2 size={19} /> : <XCircle size={19} />}
            <div><strong>{label}</strong><span>{run.phase === 'submitting' ? '正在发送参数到供应商接口' : run.message || (isRunning ? '页面正在自动查询任务状态' : run.phase === 'succeeded' ? '结果已返回，可在下方查看' : run.error)}</span></div>
          </div>
          <div className="experience-result-head-actions">
            <dl className="experience-result-meta">
              {run.taskId ? <div><dt>任务 ID</dt><dd title={run.taskId}>{run.taskId}</dd></div> : null}
              {run.providerStatus ? <div><dt>供应商状态</dt><dd>{run.providerStatus}</dd></div> : null}
              <div><dt>已用时</dt><dd>{elapsedSeconds} 秒</dd></div>
              {model.capability === 'audio' && typeof (run.rawBody as { duration?: unknown })?.duration === 'number' ? <div><dt>实际音频时长</dt><dd>{Number((run.rawBody as { duration: number }).duration).toFixed(2)} 秒</dd></div> : null}
            </dl>
            {run.taskId && model.provider === 'Kling' && run.phase !== 'succeeded' ? <button type="button" className="ghost-btn experience-refresh-task" onClick={() => void resumeExperienceTask(model, run.taskId)}>{run.phase === 'processing' ? '立即刷新' : '继续查询'}</button> : null}
          </div>
        </header>
        {isRunning ? <div className="experience-result-skeleton" aria-hidden="true"><span /><span /><span /></div> : null}
        {run.error ? <p className="experience-result-error">{run.error}</p> : null}
        {run.phase === 'succeeded' && !run.media.length && model.capability !== 'text' ? <p className="experience-result-note">接口已完成，但响应中没有识别到可预览的媒体地址。请展开原始响应检查供应商返回字段。</p> : null}
        {run.media.length ? (
          <div className="experience-media-grid">
            {run.media.map((media, index) => {
              const downloadUrl = media.url.startsWith('http')
                ? `/api/media-download?url=${encodeURIComponent(media.url)}&filename=${encodeURIComponent(media.filename)}`
                : media.url
              return (
                <article className={`experience-media-item ${media.kind}`} key={`${media.url}-${index}`}>
                  <div className="experience-media-preview">
                    {media.kind === 'image' ? <button type="button" aria-label={`放大查看生成图片 ${index + 1}`} onClick={() => setMediaPreview({ url: media.url, kind: 'image', label: `生成图片 ${index + 1}`, filename: media.filename })}><img src={media.url} alt={`生成图片 ${index + 1}`} loading="lazy" /></button> : null}
                    {media.kind === 'video' ? <video src={media.url} controls preload="metadata">当前浏览器不支持视频播放。</video> : null}
                    {media.kind === 'audio' ? <audio src={media.url} controls preload="metadata">当前浏览器不支持音频播放。</audio> : null}
                  </div>
                  <footer><span>{media.kind === 'image' ? '图片' : media.kind === 'video' ? '视频' : '音频'} {index + 1}</span><div>{media.kind === 'image' || media.kind === 'video' ? <button type="button" onClick={() => setMediaPreview({ url: media.url, kind: media.kind === 'image' ? 'image' : 'video', label: `${media.kind === 'image' ? '生成图片' : '生成视频'} ${index + 1}`, filename: media.filename })}><Maximize2 size={15} />放大查看</button> : <a href={media.url} target="_blank" rel="noreferrer"><ExternalLink size={15} />新窗口查看</a>}<a href={downloadUrl} download={media.filename}><Download size={15} />下载</a></div></footer>
                </article>
              )
            })}
          </div>
        ) : null}
        <details className="experience-raw"><summary>查看原始请求与响应</summary><pre className="model-result">{model.testResult || '暂无原始响应'}</pre></details>
      </section>
    )
  }

  const renderModelFields = (model: ModelConfig) => {
    if (model.provider === 'Codex' && model.capability === 'text') {
      return (
        <>
          <label>Codex 可执行文件<input value={model.settings.executablePath ?? ''} placeholder="codex" onChange={(e) => updateModelSetting(model.id, 'executablePath', e.target.value)} /><small>使用本机 Codex CLI 的现有登录；每次独立调用，不改写全局配置。</small></label>
          <div className="position-grid">
            <label>推理强度<select value={model.settings.reasoningEffort ?? ''} onChange={(e) => updateModelSetting(model.id, 'reasoningEffort', e.target.value)}><option value="">沿用默认</option>{['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((effort) => <option value={effort} key={effort}>{effort}</option>)}</select></label>
            <label>调用超时（ms）<input type="number" min="1" max="3600000" step="1" value={model.settings.timeoutMs ?? '180000'} onChange={(e) => updateModelSetting(model.id, 'timeoutMs', e.target.value)} /></label>
          </div>
        </>
      )
    }
    if (model.provider === 'Bailian' && model.capability === 'audio') {
      return <>
        <label>API Key<input type="password" value={model.settings.apiKey ?? ''} onChange={(e) => updateModelSetting(model.id, 'apiKey', e.target.value)} /></label>
        <label>业务空间 Base URL<input value={model.settings.endpoint ?? ''} onChange={(e) => updateModelSetting(model.id, 'endpoint', e.target.value)} /><small>支持 compatible-mode/v1 地址，自动使用同域名语音合成接口。</small></label>
        <label>默认音色 ID<input value={model.settings.voice ?? ''} onChange={(e) => updateModelSetting(model.id, 'voice', e.target.value)} /><small>系统音色或与当前模型匹配的定制音色 ID。</small></label>
        <label>默认人物声音指令<textarea value={model.settings.instruction ?? ''} onChange={(e) => updateModelSetting(model.id, 'instruction', e.target.value)} placeholder="选填，例如：自然亲切、吐字清晰" /></label>
      </>
    }
    if (model.provider === 'Local') {
      return <label>联调模式<input value={model.settings.fixtureMode ?? 'true'} onChange={(e) => updateModelSetting(model.id, 'fixtureMode', e.target.value)} /></label>
    }
    if (model.provider === 'Kling') {
      const credentialFields = (
        <>
          <label>API Key（新版）<input type="password" value={model.settings.apiKey ?? ''} onChange={(e) => updateModelSetting(model.id, 'apiKey', e.target.value)} /><small>可灵图片和视频模型共享；配置新版 API Key 后优先使用。</small></label>
          <div className="position-grid"><label>Access Key（兼容旧版）<input value={model.settings.accessKey ?? ''} onChange={(e) => updateModelSetting(model.id, 'accessKey', e.target.value)} /></label><label>Secret Key（兼容旧版）<input type="password" value={model.settings.secretKey ?? ''} onChange={(e) => updateModelSetting(model.id, 'secretKey', e.target.value)} /></label></div>
        </>
      )
      return (
        <>
          {credentialFields}
          <label>Endpoint<input value={model.settings.endpoint ?? ''} onChange={(e) => updateModelSetting(model.id, 'endpoint', e.target.value)} /></label>
          <div className="position-grid"><label>轮询间隔（ms）<input value={model.settings.pollIntervalMs ?? '3000'} onChange={(e) => updateModelSetting(model.id, 'pollIntervalMs', e.target.value)} /></label><label>单轮等待时间（ms）<input value={model.settings.taskTimeoutMs ?? '900000'} onChange={(e) => updateModelSetting(model.id, 'taskTimeoutMs', e.target.value)} /><small>达到时间后可继续查询，不会丢失任务。</small></label></div>
        </>
      )
    }
    if ((model.provider === 'OpenAI' || model.provider === 'Ofox') && model.capability === 'image') {
      return (
        <>
          <label>API Key<input type="password" value={model.settings.apiKey ?? ''} onChange={(e) => updateModelSetting(model.id, 'apiKey', e.target.value)} />{model.provider === 'Ofox' ? <small>与 GPT Image 模型共享配置。</small> : null}</label>
          <label>Endpoint<input value={model.settings.endpoint ?? ''} onChange={(e) => updateModelSetting(model.id, 'endpoint', e.target.value)} /></label>
        </>
      )
    }
    if (model.provider === 'OpenAI' && model.capability === 'audio') {
      return (
        <>
          <label>API Key<input type="password" value={model.settings.apiKey ?? ''} onChange={(e) => updateModelSetting(model.id, 'apiKey', e.target.value)} /></label>
          <label>Endpoint<input value={model.settings.endpoint ?? ''} onChange={(e) => updateModelSetting(model.id, 'endpoint', e.target.value)} /></label>
        </>
      )
    }
    return (
      <>
        {model.capability === 'text' && ['Anthropic', 'OpenAI', 'Custom'].includes(model.provider) ? <label>接口协议<select value={model.settings.apiProtocol ?? ''} onChange={(e) => updateModelSetting(model.id, 'apiProtocol', e.target.value)}><option value="">{model.provider === 'Anthropic' ? 'Anthropic Messages（默认）' : '请选择网关支持的协议'}</option><option value="anthropic-messages">Anthropic Messages</option></select><small>协议由网关决定；GPT 等模型也可通过兼容 Messages 的网关接入。</small></label> : null}
        {model.capability === 'text' && ['Anthropic', 'OpenAI', 'Custom'].includes(model.provider) ? <label>返回方式<select value={model.settings.stream ?? 'true'} onChange={(e) => updateModelSetting(model.id, 'stream', e.target.value)}><option value="true">流式响应</option><option value="false">完整响应（非流式）</option></select><small>网关流式连接不稳定时，可选择等待完整响应；两种方式都检查内容是否完整。</small></label> : null}
        <label>API Key<input type="password" value={model.settings.apiKey ?? ''} onChange={(e) => updateModelSetting(model.id, 'apiKey', e.target.value)} /></label>
        <label>Endpoint<input value={model.settings.endpoint ?? ''} onChange={(e) => updateModelSetting(model.id, 'endpoint', e.target.value)} /></label>
      </>
    )
  }

  const updateBranchDebugParam = (index: number, paramId: string, value: string) => {
    const updated = { ...executionState, nodeRuns: executionState.nodeRuns.map((run, i) => i === index ? { ...run, paramOverrides: { ...run.paramOverrides, [paramId]: value } } : run) }
    setExecutionState(updated)
    void persistExecution(updated)
  }

  const updateSelectedRunContext = (path: string[], rawValue: string) => {
    if (viewingBranchHistory) return
    let value: unknown = rawValue
    try {
      value = JSON.parse(rawValue)
    } catch {
      value = rawValue
    }
    const updated = {
      ...executionState,
      nodeRuns: executionState.nodeRuns.map((run, index) => index === selectedRunIndex ? {
        ...run, context: cloneWithPath(run.context, path, value) as Record<string, unknown>,
        ...(run.node.kind === 'branch' ? {
          routeInputContext: cloneWithPath(run.routeInputContext ?? run.inputContext ?? {}, path, value) as Record<string, unknown>,
          routeInputOverrides: cloneWithPath(run.routeInputOverrides ?? {}, path, value) as Record<string, unknown>,
        } : {}),
      } : run),
      context: cloneWithPath(executionState.context, path, value) as Record<string, unknown>,
    }
    setExecutionState(updated)
    void persistExecution(updated)
  }

  const renderMediaValue = (value: unknown, key = 'media') => {
    if (typeof value === 'string') {
      if (value.startsWith('data:audio/')) return <audio className="result-audio" src={value} controls preload="none" />
      if (/\.(mp3|wav|m4a|aac|ogg)(\?|$)/i.test(value)) return <audio className="result-audio" src={value} controls preload="none" />
      const kind = inspectableMediaKind(value, key)
      if (kind) {
        const label = key || (kind === 'image' ? '图片' : '视频')
        const filename = mediaFilename(value, kind, key)
        const preview = () => setMediaPreview({ url: value, kind, label, filename })
        return (
          <figure className={`inspectable-media ${kind}`}>
            <div className="inspectable-media-stage">
              {kind === 'image'
                ? <button type="button" className="inspectable-media-image-button" aria-label={`放大查看 ${label}`} onClick={preview}><img className="result-media" src={value} alt={label} loading="lazy" /></button>
                : <video className="result-media" src={value} controls preload="none">当前浏览器不支持视频播放。</video>}
            </div>
            <figcaption>
              <span>{kind === 'image' ? '图片' : '视频'}</span>
              <div>
                <button type="button" onClick={preview}><Maximize2 size={14} />放大查看</button>
                <a href={mediaDownloadUrl(value, filename)} download={filename}><Download size={14} />下载</a>
              </div>
            </figcaption>
          </figure>
        )
      }
      if (value.startsWith('data:')) return <span className="media-omitted">内联媒体内容</span>
    }
    return null
  }

  const variableMetadata = useMemo(
    () => buildVariableMetadata(activeWorkflow.nodes, executionState.nodeRuns),
    [activeWorkflow.nodes, executionState.nodeRuns],
  )

  const renderVariableName = (key: string, metadataPath: string[], chineseName?: string, producerTitle?: string) => {
    const metadata = resolveVariableMetadata(variableMetadata, metadataPath)
    const displayChineseName = chineseName ?? metadata?.chineseName
    const displayProducer = producerTitle ?? metadata?.nodeTitle
    return (
      <span className="variable-heading">
        <span className="variable-name"><code>{key}</code>{displayChineseName ? <strong>{displayChineseName}</strong> : null}</span>
        {displayProducer ? <small>来源：{displayProducer}</small> : null}
      </span>
    )
  }

  const renderContextEditor = (value: unknown, path: string[] = [], metadataPrefix: string[] = [], paramLabels?: Map<string, { chineseName: string; producerTitle?: string }>, editable = true) => {
    if (value && typeof value === 'object') {
      const entries = Array.isArray(value) ? undefined : displayEntries(value as Record<string, unknown>)
      const count = entries?.length ?? (value as unknown[]).length
      return <InspectorEntries count={count} renderEntry={(index) => {
        const [key, child] = entries?.[index] ?? [String(index), (value as unknown[])[index]]
        const label = path.length === 0 ? paramLabels?.get(key) : undefined
        return <InspectorDisclosure key={key}
          defaultOpen={path.length === 0 && typeof child === 'string' && Boolean(inspectableMediaKind(child, [...metadataPrefix, key].join('.')))}
          summary={renderVariableName(key, [...metadataPrefix, ...path, key], label?.chineseName, label?.producerTitle)}>
          {() => renderContextEditor(child, [...path, key], metadataPrefix, paramLabels, editable)}
        </InspectorDisclosure>
      }} />
    }
    const media = renderMediaValue(value, [...metadataPrefix, ...path].join('.'))
    const textValue = typeof value === 'string' && value.startsWith('data:') ? '[base64 hidden]' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    const valuePath = [...metadataPrefix, ...path]
    const valueTitle = valuePath.length ? valuePath.join('.') : '参数内容'
    const isHiddenData = typeof value === 'string' && value.startsWith('data:')
    return (
      <div className="context-value-editor">
        {media}
        <div className="context-textarea-shell">
          {!isHiddenData ? <button type="button" className="context-expand-button" aria-label={`展开查看 ${valueTitle}`} title="展开查看" onClick={() => { setMediaPreview(null); setTextPreview({ value: textValue ?? '', title: valueTitle, eyebrow: '参数内容', editable, target: { type: 'context', path } }) }}><Maximize2 size={14} /><span>展开</span></button> : null}
          <textarea rows={media ? 2 : 4} value={textValue ?? ''} disabled={!editable || isHiddenData} onChange={(event) => updateSelectedRunContext(path, event.target.value)} />
        </div>
      </div>
    )
  }

  const updateExpandedText = (nextValue: string) => {
    if (!textPreview) return
    setTextPreview((current) => current ? { ...current, value: nextValue } : current)
    if (textPreview.target.type === 'context') {
      updateSelectedRunContext(textPreview.target.path, nextValue)
    } else if (textPreview.target.type === 'node') {
      updateNode(textPreview.target.nodeId, { [textPreview.target.field]: nextValue })
    } else {
      updateParam(textPreview.target.nodeId, textPreview.target.paramId, { value: nextValue })
    }
  }

  const renderNodeConfiguration = (node: WorkflowNode) => {
    const model = models.find((item) => item.id === node.modelId)
    const outputModeLabel: Record<TextOutputMode, string> = {
      'legacy-shots': '旧版 shots 数组',
      array: 'JSON 数组',
      json: 'JSON 对象',
      text: '纯文本',
    }
    const facts = [
      ['节点类型', nodeMeta[node.kind].label],
      ['结果变量', `\${${node.resultVar}}`],
      ...(model ? [['执行模型', model.name]] : []),
      ...(node.operation ? [['节点操作', node.operation]] : []),
      ...(node.outputMode ? [['结构化输出', outputModeLabel[node.outputMode]]] : []),
      ...(node.mapInput ? [['逐项输入', JSON.stringify(node.mapInput)]] : []),
      ...(node.request ? [['HTTP 请求', `${node.request.method} ${node.request.url}`]] : []),
      ...(node.kind === 'branch' ? activeWorkflow.edges.filter(e => e.from === node.id).map(e => [`${e.branch} 出口`, activeWorkflow.nodes.find(n => n.id === e.to)?.title ?? e.to]) : []),
    ]
    return (
      <div className="node-implementation">
        <div className="implementation-facts">
          {facts.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
        </div>
        {node.prompt ? (
          <section className="implementation-block">
            <div className="implementation-title"><strong>{node.kind === 'code' ? '处理说明' : '提示词 / 模板'}</strong><span>执行时会解析上下文变量</span></div>
            <pre>{node.prompt}</pre>
          </section>
        ) : null}
        {(node.kind === 'code' || node.kind === 'branch') && node.code ? (
          <section className="implementation-block">
            <div className="implementation-title"><strong>JavaScript 实现</strong><span>只读快照</span></div>
            <pre>{node.code}</pre>
          </section>
        ) : null}
        {node.params.length ? (
          <section className="implementation-block">
            <div className="implementation-title"><strong>节点参数</strong><span>{node.params.length} 项</span></div>
            <div className="implementation-params">
              {node.params.map((param) => (
                <div key={param.id}>
                  <span>{param.name}{param.englishName ? ` (${param.englishName})` : ''}</span>
                  <small>{param.type}{param.required ? ' / 必填' : ' / 可选'}</small>
                  <code>{param.value || '未设置'}</code>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        {node.kind === 'loop' ? (
          <section className="implementation-block">
            <div className="implementation-title"><strong>循环配置</strong><span>{node.loop.fallbackCount} 次</span></div>
            <div className="implementation-facts compact">
              <div><span>循环来源</span><strong>{node.loop.sourcePath}</strong></div>
              <div><span>单项变量</span><strong>{node.loop.itemVar}</strong></div>
            </div>
          </section>
        ) : null}
        {node.uploads.length ? (
          <section className="implementation-block">
            <div className="implementation-title"><strong>附件</strong><span>{node.uploads.length} 个</span></div>
            <div className="implementation-files">{node.uploads.map((asset) => <span key={asset.id}>{asset.name}</span>)}</div>
          </section>
        ) : null}
      </div>
    )
  }

  const selectedRunInputContext = useMemo(() => {
    if (!selectedRun?.context || !selectedRun.node.resultVar) return selectedRun?.context
    if (selectedRun.node.kind === 'branch' && selectedRun.routeInputContext) return { ...selectedRun.inputContext, ...selectedRun.routeInputContext }
    if (selectedRun.inputContext) return selectedRun.inputContext
    const outputKeys = selectedRun.output && typeof selectedRun.output === 'object' && !Array.isArray(selectedRun.output) ? new Set(Object.keys(selectedRun.output as Record<string, unknown>)) : new Set<string>()
    return Object.fromEntries(
      displayEntries(selectedRun.context).filter(([key]) => key !== selectedRun.node.resultVar && !outputKeys.has(key)),
    )
  }, [selectedRun])
  const selectedRunInputs = selectedRun?.inputs ?? (selectedRun ? nodeParamValues(selectedRun.node, selectedRunInputContext ?? {}) : undefined)
  const selectedVoiceReviewOutput = voiceReviewSource(
    selectedRun?.output,
    selectedRunInputs?.currentVideo,
    selectedRunInputContext?.video_shot,
  )
  const selectedVoiceReviewTarget = voiceReviewTarget(selectedVoiceReviewOutput)
  const canContinueAfterVoiceReview = !viewingBranchHistory
    && selectedRun?.status === 'failed'
    && String(selectedRun.error ?? '').startsWith('VOICE_REVIEW_REQUIRED:')
    && selectedVoiceReviewTarget !== null
  const selectedRunInputLabels = useMemo(() => {
    if (!selectedRun) return new Map<string, { chineseName: string; producerTitle?: string }>()
    return new Map(selectedRun.node.params.map((param) => {
      const key = paramKey(param)
      const reference = param.value.trim().match(/^\$\{([^}]+)\}$/)?.[1].trim().split('.')
      return [key, { chineseName: param.name, producerTitle: reference ? resolveVariableMetadata(variableMetadata, reference)?.nodeTitle : selectedRun.node.kind === 'input' ? selectedRun.node.title : '节点配置' }]
    }))
  }, [selectedRun, variableMetadata])

  const recoverLegacyVideoOutput = useCallback(async (run: NodeRunState, requestedIndex: number) => {
    const taskId = recoverableVideoTaskId(run.output)
    if (!taskId || run.node.kind !== 'video') return
    const model = models.find((item) => item.id === run.node.modelId)
    if (!model || model.provider !== 'Kling') return
    const recoveryKey = `${executionState.id}:${run.id}:${taskId}`
    if (legacyVideoRecoveryRef.current.has(recoveryKey)) return
    legacyVideoRecoveryRef.current.add(recoveryKey)
    setLegacyVideoRecoveryStatus((current) => ({ ...current, [run.id]: '正在拉取已有视频，不会重新生成…' }))
    try {
      const oldOutput = run.output && typeof run.output === 'object' && !Array.isArray(run.output) ? run.output as Record<string, unknown> : {}
      const params = oldOutput.params && typeof oldOutput.params === 'object' && !Array.isArray(oldOutput.params)
        ? oldOutput.params as Record<string, unknown>
        : run.inputs ?? {}
      const queryMode = Array.isArray(params.referenceImages) && params.referenceImages.length
        ? 'omni-video'
        : params.referenceImage || params.image
          ? 'image2video'
          : 'text2video'
      const result = await requestJson<{ status: number; body: unknown }>('/api/model-test/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, params, taskId, queryMode }),
      })
      // A result lookup started in the source record must not replace a newly
      // saved rollback record when the lookup finishes later.
      if (executionStateIdRef.current !== executionState.id || activeWorkflowIdRef.current !== executionState.workflowId) return
      if (result.status >= 400) throw new Error(`任务查询失败（HTTP ${result.status}）`)
      const inspection = inspectExperienceResponse(result.body, 'video')
      if (inspection.failed) throw new Error(inspection.message || '视频任务生成失败')
      const videoUrl = inspection.media.find((item) => item.kind === 'video')?.url
      if (!videoUrl) {
        setLegacyVideoRecoveryStatus((current) => ({ ...current, [run.id]: inspection.pending ? '原任务仍在生成，可稍后再次拉取。' : '任务已完成，但没有返回视频 URL。' }))
        return
      }
      const nextOutput = {
        ...oldOutput,
        url: videoUrl,
        raw: sanitizeBase64(result.body),
        recoveredTaskId: taskId,
      }
      const actualIndex = executionState.nodeRuns.findIndex((item, index) => item.id === run.id || index === requestedIndex && item.node.id === run.node.id)
      if (actualIndex < 0) return
      const nextRuns = executionState.nodeRuns.map((item, index) => index === actualIndex
        ? { ...item, output: nextOutput, context: { ...item.context, [item.node.resultVar]: nextOutput } }
        : item)
      const nextContext = run.node.resultVar in executionState.context
        ? { ...executionState.context, [run.node.resultVar]: nextOutput }
        : executionState.context
      const recoveryLog = `${run.node.title} -> 已从 Kling 任务 ${taskId} 回填视频结果`
      const updated = {
        ...executionState,
        nodeRuns: nextRuns,
        context: nextContext,
        logs: executionState.logs.includes(recoveryLog) ? executionState.logs : [...executionState.logs, recoveryLog],
      }
      setExecutionState(updated)
      persistExecution(updated)
      setLegacyVideoRecoveryStatus((current) => ({ ...current, [run.id]: '已拉取并回填视频。' }))
    } catch (error) {
      setLegacyVideoRecoveryStatus((current) => ({ ...current, [run.id]: `拉取失败：${error instanceof Error ? error.message : String(error)}` }))
    } finally {
      legacyVideoRecoveryRef.current.delete(recoveryKey)
    }
  }, [executionState, models, persistExecution])

  const selectedLegacyVideoTaskId = selectedRun ? recoverableVideoTaskId(selectedRun.output) : ''
  useEffect(() => {
    if (viewingBranchHistory || runnerInspectorTab !== 'output' || !selectedRun || !selectedLegacyVideoTaskId) return
    void recoverLegacyVideoOutput(selectedRun, selectedRunIndex)
  }, [viewingBranchHistory, recoverLegacyVideoOutput, runnerInspectorTab, selectedLegacyVideoTaskId, selectedRun, selectedRunIndex])

  const detailModel = modelView.mode === 'detail' ? draftModels.find((model) => model.id === modelView.modelId) : undefined
  const detailReferenceImages = detailModel && Array.isArray(modelTestParams[detailModel.id]?.referenceImages)
    ? modelTestParams[detailModel.id].referenceImages as string[]
    : []

  if (!configLoaded) {
    return (
      <main className="config-startup">
        <section className="config-startup-card" role={configLoadError ? 'alert' : 'status'} aria-live="polite" aria-busy={!configLoadError}>
          {configLoadError ? <XCircle size={28} /> : <LoaderCircle className="run-status-spinner" size={28} />}
          <h1>{configLoadError ? '工作流配置加载失败' : '正在加载工作流配置'}</h1>
          <p>{configLoadError ? '无法读取已保存的配置，暂时无法打开或执行工作流。' : '正在读取已保存的配置，请稍候。'}</p>
          {configLoadError ? <>
            <p className="config-startup-error">{configLoadError}</p>
            <button type="button" className="primary-btn" onClick={() => window.location.reload()}><RotateCcw size={17} />重新加载</button>
          </> : null}
        </section>
      </main>
    )
  }

  return (
    <main className={navCollapsed ? 'app-shell nav-collapsed' : 'app-shell'}>
      <aside className="side-nav" aria-label="主菜单">
        <div className="studio-nav-brand"><div className="brand"><Sparkles size={22} /><div><strong>短视频生成系统</strong><span>Workflow AIGC Studio</span></div></div><button className="icon-btn nav-toggle" aria-label={navCollapsed ? '展开菜单' : '折叠菜单'} title={navCollapsed ? '展开菜单' : '折叠菜单'} aria-expanded={!navCollapsed} onClick={() => setNavCollapsed(value => !value)}>{navCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}</button></div>
        <button className="primary-btn studio-nav-create" type="button" onClick={addWorkflow} disabled={isDebugBusy || hasUnsavedExecution} title="新建工作流" aria-label="新建工作流"><Plus size={19} /><span>新建工作流</span></button>
        <span className="studio-nav-label">创作空间</span>
        <button className={page === 'workflow' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('workflow')} title="工作流编排" aria-label="工作流编排" aria-current={page === 'workflow' ? 'page' : undefined}><Layers size={18} /><span>工作流编排</span></button>
        <button className={page === 'characters' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('characters')} title="人物库" aria-label="人物库" aria-current={page === 'characters' ? 'page' : undefined}><UsersRound size={18} /><span>人物库</span></button>
        <button className={page === 'models' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('models')} title="模型管理" aria-label="模型管理" aria-current={page === 'models' ? 'page' : undefined}><Settings size={18} /><span>模型管理</span></button>
        <div className="studio-nav-workspace">
          <button type="button" onClick={() => { setPage('workflow'); setWorkflowView('list') }}><Layers size={15} /><span>全部工作流</span><span>{workflows.length}</span></button>
          {executionState.nodeRuns.some(run => run.status !== 'idle') || hasUnsavedExecution ? <button type="button" onClick={returnToExecution}><Activity size={15} /><span>返回当前执行</span><ChevronRight size={14} /></button> : null}
        </div>
        <div className="studio-nav-footer"><Clapperboard size={17} /><div><strong>让创作持续发生</strong><span>{workflows.length} 个工作流 · {models.length} 个模型</span></div></div>
      </aside>

      {mediaPreview ? (
        <div className="media-lightbox" onMouseDown={(event) => { if (event.target === event.currentTarget) setMediaPreview(null) }}>
          <section className={`media-lightbox-dialog ${mediaPreview.kind}`} role="dialog" aria-modal="true" aria-label={`放大查看${mediaPreview.kind === 'image' ? '图片' : '视频'}`}>
            <header>
              <div><span>{mediaPreview.kind === 'image' ? '图片预览' : '视频预览'}</span><strong title={mediaPreview.label}>{mediaPreview.label}</strong></div>
              <div className="media-lightbox-actions">
                <a href={mediaDownloadUrl(mediaPreview.url, mediaPreview.filename)} download={mediaPreview.filename}><Download size={16} />下载</a>
                <button type="button" autoFocus onClick={() => setMediaPreview(null)} aria-label="关闭媒体预览"><X size={19} /></button>
              </div>
            </header>
            <div className="media-lightbox-content">
              {mediaPreview.kind === 'image'
                ? <img src={mediaPreview.url} alt={mediaPreview.label} />
                : <video src={mediaPreview.url} controls autoPlay preload="metadata">当前浏览器不支持视频播放。</video>}
            </div>
          </section>
        </div>
      ) : null}

      {textPreview ? (
        <div className="text-preview-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setTextPreview(null) }}>
          <section className="text-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="text-preview-title">
            <header>
              <div><span>{textPreview.eyebrow}</span><strong id="text-preview-title" title={textPreview.title}>{textPreview.title}</strong></div>
              <button type="button" onClick={() => setTextPreview(null)} aria-label={`关闭${textPreview.title}弹窗`}><X size={19} /></button>
            </header>
            <div className="text-preview-content">
              <textarea
                autoFocus
                aria-label={`${textPreview.title} 的完整内容`}
                value={textPreview.value}
                readOnly={!textPreview.editable}
                spellCheck={false}
                onChange={(event) => updateExpandedText(event.target.value)}
              />
            </div>
          </section>
        </div>
      ) : null}

      {rollbackDialogActive ? (
        <div className="dialog-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !rollbackSaveLock.current) setRollbackDialog(null) }}>
          <form className="dialog-content rollback-dialog" role="dialog" aria-modal="true" aria-labelledby="rollback-dialog-title"
            aria-describedby="rollback-dialog-description" onSubmit={(event) => { event.preventDefault(); void createBreakpointRollbackExecution() }}>
            <h2 id="rollback-dialog-title">{rollbackDialog.mode === 'previous' ? '回退到上一个断点' : '回退到指定断点'}</h2>
            <p id="rollback-dialog-description">{rollbackDialog.mode === 'previous'
              ? '将回退到当前执行位置之前最近一个已到达的断点。请确认目标和影响范围。'
              : '选择本次执行已到达的断点。循环节点按具体轮次分别列出，条件断点只列出条件匹配的实例。'}</p>
            {rollbackDialog.mode === 'previous' && rollbackTarget ? <div className="rollback-target-summary">
              <span>目标断点</span>
              <strong>第 {rollbackTarget.index + 1} 步 · {rollbackTarget.run.loopIndex !== undefined ? `第 ${rollbackTarget.run.loopIndex + 1} 轮 · ` : ''}{rollbackTarget.run.node.title} · {runStatusLabels[rollbackTarget.run.status]}</strong>
            </div> : rollbackDialog.mode === 'specific' && rollbackTargets.length ? <label className="rollback-target-field">
              <span>目标断点</span>
              <select autoFocus aria-label="目标断点" value={rollbackDialog.targetRunId} disabled={isDebugBusy || hasUnsavedExecution}
                onChange={event => setRollbackDialog({ executionId: executionState.id, targetRunId: event.target.value, mode: 'specific' })}>
                {rollbackTargets.map(({ index, run }) => <option key={run.id} value={run.id}>
                  第 {index + 1} 步 · {run.loopIndex !== undefined ? `第 ${run.loopIndex + 1} 轮 · ` : ''}{run.node.title} · {runStatusLabels[run.status]}
                </option>)}
              </select>
            </label> : <p role="status">当前没有可回退的断点。请先在 DAG 中为已到达的节点设置断点。</p>}
            {rollbackImpact ? <div className="rollback-impact">
              <p>保留目标之前的 {rollbackImpact.preservedRunCount} 个步骤；目标及后续步骤将重新执行，涉及 {rollbackImpact.completedInvalidatedCount} 个已完成结果。</p>
              <p>原记录及已有输出保留。回退后停在目标断点的执行前，点击“下一步”或“运行到下一断点”继续。</p>
            </div> : null}
            {rollbackError || rollbackDialog.error ? <p className="rollback-error" role="alert">{rollbackDialog.error || rollbackError}</p> : null}
            <div className="dialog-actions">
              <button type="button" className="ghost-btn" autoFocus={rollbackDialog.mode === 'previous'} disabled={rollbackSaving} onClick={() => setRollbackDialog(null)}>取消</button>
              <button type="submit" className="primary-btn" disabled={isDebugBusy || hasUnsavedExecution || !rollbackImpact}>
                {rollbackSaving ? '正在保存回退记录' : '确认回退'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {breakpointEditor ? (
        <div className="dialog-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setBreakpointEditor(null) }}>
          <form className="dialog-content breakpoint-dialog" role="dialog" aria-modal="true" aria-labelledby="breakpoint-dialog-title" onSubmit={(event) => { event.preventDefault(); saveBreakpointEditor() }}>
            <h2 id="breakpoint-dialog-title">配置条件断点</h2>
            <p className="breakpoint-dialog-node">{activeWorkflow.nodes.find((node) => node.id === breakpointEditor.nodeId)?.title ?? breakpointEditor.nodeId}</p>
            <label className="breakpoint-mode-field">
              <input type="checkbox" checked={breakpointEditor.conditional} onChange={(event) => setBreakpointEditor({ ...breakpointEditor, conditional: event.target.checked })} />
              <span>仅当条件成立时暂停</span>
            </label>
            <div className="breakpoint-condition-fields" aria-disabled={!breakpointEditor.conditional}>
              <label>
                <span>变量路径</span>
                <input autoFocus={breakpointEditor.conditional} value={breakpointEditor.path} disabled={!breakpointEditor.conditional} placeholder="loop.index" onChange={(event) => setBreakpointEditor({ ...breakpointEditor, path: event.target.value })} />
              </label>
              <label>
                <span>运算符</span>
                <select value={breakpointEditor.operator} disabled={!breakpointEditor.conditional} onChange={(event) => setBreakpointEditor({ ...breakpointEditor, operator: event.target.value as BreakpointOperator })}>
                  {(Object.keys(breakpointOperatorLabels) as BreakpointOperator[]).map((operator) => <option value={operator} key={operator}>{breakpointOperatorLabels[operator]}</option>)}
                </select>
              </label>
              <label>
                <span>比较值</span>
                <input value={breakpointEditor.value} disabled={!breakpointEditor.conditional} placeholder="3" onChange={(event) => setBreakpointEditor({ ...breakpointEditor, value: event.target.value })} />
              </label>
            </div>
            <p className="breakpoint-dialog-help">循环轮次使用 <code>loop.index</code>，从 1 开始；例如值为 3 表示第 3 轮。数字、布尔值和 JSON 会按实际类型比较。</p>
            <div className="dialog-actions breakpoint-dialog-actions">
              <button type="button" className="danger-btn" onClick={deleteBreakpointEditor}>删除断点</button>
              <span />
              <button type="button" className="ghost-btn" onClick={() => setBreakpointEditor(null)}>取消</button>
              <button type="submit" className="primary-btn" disabled={breakpointEditor.conditional && !breakpointEditor.path.trim()}>保存</button>
            </div>
          </form>
        </div>
      ) : null}

      {page === 'characters' ? (
        <CharacterLibrary workflows={workflows.map(({ id, name }) => ({ id, name }))} />
      ) : page === 'workflow' ? (
        workflowView === 'list' ? (
          <WorkflowLibrary workflows={workflows} onCreate={addWorkflow} onDetails={openWorkflowDetail} onEdit={openWorkflowEditor} onRun={openWorkflowRun}
            onCharacters={() => setPage('characters')} onModels={() => { setPage('models'); setModelView({ mode: 'list' }) }}
            busy={isDebugBusy || hasUnsavedExecution}
            blockedReason={hasUnsavedExecution ? '执行记录尚未保存，请返回当前执行重试保存' : '有任务执行中，完成或暂停后可打开其他工作流'}
            currentExecution={executionState.nodeRuns.some(run => run.status !== 'idle') || hasUnsavedExecution ? { name: executionState.workflowName, onReturn: returnToExecution } : undefined} />
        ) : workflowView === 'run' ? (
          <section className="workspace">
            <header className="topbar">
              <div>
                <h1>执行工作流</h1>
                <p>{activeWorkflow.name} · {executionState.historical ? '历史快照' : '当前拓扑'} · {voicePolicyLabel(executionState.voicePolicy)} · 执行记录 ID：{executionState.id}</p>
              </div>
              <div className="topbar-actions">
                <button className="ghost-btn" onClick={() => setWorkflowView('list')}>返回列表</button>
                <button className="ghost-btn" disabled={isDebugBusy || hasUnsavedExecution} onClick={() => setWorkflowView('edit')}><Pencil size={17} />编辑编排</button>
              </div>
            </header>
            <div className="runner-tabs">
              <button className={runnerTab === 'execute' ? 'tab-btn active' : 'tab-btn'} onClick={() => setRunnerTab('execute')}>执行控制</button>
              <button className={runnerTab === 'history' ? 'tab-btn active' : 'tab-btn'} onClick={() => setRunnerTab('history')}>历史记录</button>
            </div>
            {runnerTab === 'history' ? (
              <section className="runner-panel history-page">
                <div className="panel-title"><h2>历史执行记录</h2><span>{executionRecords.length} 条</span></div>
                <div className="history-table">
                  <div className="history-table-head"><span>标题 / ID</span><span>模式</span><span>状态</span><span>创建时间</span><span>操作</span></div>
                  {executionRecords.map((record) => {
                    const loading = executionRecordLoadingId === record.id
                    return (
                      <article className={record.id === executionState.id ? 'history-row active' : 'history-row'} key={record.id}>
                        <div><strong>{record.title}</strong><small>{record.id}</small></div>
                        <span>{record.mode === 'step' ? '单步调试' : '完整执行'}</span>
                        <span>{record.failedCount ? '失败' : `${record.succeededCount}/${record.totalCount} 成功`}</span>
                        <span>{record.createdAt ? new Date(record.createdAt).toLocaleString() : '刚刚'}</span>
                        <div className="history-row-actions">
                          <button className="ghost-btn" disabled={loading} onClick={() => void openHistoricalExecution(record)}>{loading ? '加载中' : '查看'}</button>
                          <button className="ghost-btn" disabled={loading} onClick={() => void rerunHistoricalExecution(record)}>按参数重跑</button>
                        </div>
                      </article>
                    )
                  })}
                  {!executionRecords.length ? <p className="empty-note">暂无历史记录</p> : null}
                </div>
              </section>
            ) : (
            <div className="runner-grid">
              <section className="runner-panel runner-controls">
                <div className="runner-control-bar">
                  <div className="runner-control-heading">
                    <h2>运行控制</h2>
                    <span>{activeWorkflow.nodes.length} 个节点，{runtimeParamCount} 个运行参数</span>
                  </div>
                  <div className="run-mode-switch compact">
                    <button className={runMode === 'step' ? 'tab-btn active' : 'tab-btn'} disabled={isDebugBusy || hasUnsavedExecution} onClick={() => setRunMode('step')}>单步调试</button>
                    <button className={runMode === 'run' ? 'tab-btn active' : 'tab-btn'} disabled={isDebugBusy || hasUnsavedExecution} onClick={() => setRunMode('run')}>完整执行</button>
                  </div>
                  <div className="runner-control-actions">
                    {runMode === 'run' ? (
                      <div className="full-run-actions">
                        <button className="primary-btn" onClick={executeFullRun} disabled={isDebugBusy || hasUnsavedExecution}><Play size={17} />{isDebugBusy ? '完整执行中' : '开始完整执行'}</button>
                        {fullExecutionLockRef.current ? <button className="ghost-btn" disabled={fullPauseRequested} onClick={() => { fullPauseRequestedRef.current = true; setFullPauseRequested(true) }}>{fullPauseRequested ? '等待当前节点完成后暂停' : '完成当前节点后暂停'}</button> : null}
                        {executionState.nodeRuns.some(run => run.status === 'success') && executionState.nodeRuns.some(run => run.status === 'idle') && !executionState.nodeRuns.some(run => run.status === 'failed') ? <button className="ghost-btn" disabled={isDebugBusy || hasUnsavedExecution} onClick={() => void continueFullRun(executionState)}>从检查点继续</button> : null}
                        {rollbackControls}
                      </div>
                    ) : isStepDebugActive ? (
                      <div className="debug-actions">
                        <div className="step-navigation-actions">
                          <button className="ghost-btn" onClick={() => moveWorkflowDebugStep(-1)} disabled={!workflowDebug || workflowDebug.stepIndex === 0 || isDebugBusy}><ChevronLeft size={17} />上一步</button>
                          <button className="primary-btn" onClick={() => moveWorkflowDebugStep(1)} disabled={!canMoveToNextStep}>下一步<ChevronRight size={17} /></button>
                        </div>
                        <div className="breakpoint-actions">
                          <button className="ghost-btn continue-btn" onClick={() => void continueToNextBreakpoint()} disabled={!canContinueToBreakpoint} title="连续执行，并在下一个断点节点执行前暂停">
                            <Play size={17} />{debugContinueRunning ? '运行中' : '运行到下一断点'}
                          </button>
                          {rollbackControls}
                        </div>
                        <div className={fullExecutionLockRef.current ? 'debug-secondary-actions has-pause' : 'debug-secondary-actions'}>
                          {fullExecutionLockRef.current ? <button className="ghost-btn" disabled={fullPauseRequested} onClick={() => { fullPauseRequestedRef.current = true; setFullPauseRequested(true) }}>{fullPauseRequested ? '等待当前节点完成后暂停' : '完成当前节点后暂停'}</button> : null}
                          <button className="ghost-btn icon-only" title="使用当前运行参数重新调试" aria-label="重新调试" onClick={executeStepRun} disabled={isDebugBusy || hasUnsavedExecution}><RotateCcw size={17} /></button>
                        </div>
                      </div>
                    ) : (
                      <div className="debug-start-actions">
                        <button className="primary-btn" onClick={executeStepRun} disabled={hasUnsavedExecution}><Repeat size={17} />开始单步调试</button>
                        {rollbackControls}
                      </div>
                    )}
                  </div>
                  <button className={runtimePanelOpen ? 'params-toggle active' : 'params-toggle'} aria-expanded={runtimePanelOpen} onClick={() => setRuntimePanelOpen((open) => !open)}>
                    <SlidersHorizontal size={17} />
                    <span>运行参数</span>
                    <strong>{runtimeParamCount}</strong>
                    <ChevronDown className="params-toggle-chevron" size={16} />
                  </button>
                </div>
                {hasUnsavedExecution ? (
                  <div role="alert" className="empty-note">
                    <strong>{executionState.persistenceError}</strong>
                    <p>当前节点结果已保留，后续执行已暂停。重试保存成功后可继续。</p>
                    <button className="primary-btn" disabled={isDebugBusy} onClick={() => void retryExecutionSave()}>重试保存</button>
                  </div>
                ) : null}
                {runtimePanelOpen ? (
                  <div className="runner-params-panel">
                    <div className="runner-params-intro">
                      <strong>本次运行输入</strong>
                      <span>{isStepDebugActive ? '调试已开始，修改后需重新调试才会生效。' : '确认输入后选择执行方式。开始后会自动收起。'}</span>
                    </div>
                    <div className="runner-params-grid">
                      {runtimeInputNodes.map((inputNode) => (
                        <div className="runner-input-group" key={inputNode.id}>
                          <strong>{inputNode.title}</strong>
                          {inputNode.params.map((param) => {
                            const paramKey = param.englishName || param.name
                            const isQualityChoice = activeWorkflow.id === 'wf-sanguo-history-drama' && paramKey === 'qualityDisposition'
                            return <label key={param.id} className={isQualityChoice ? 'runner-quality-choice' : undefined}
                              data-runtime-result-var={inputNode.resultVar} data-runtime-param-key={paramKey} data-runtime-param-type={param.type}>
                              <span>{isQualityChoice ? '质检方式' : <>{param.name} {param.englishName ? `(${param.englishName})` : ''}</>}</span>
                              {isQualityChoice ? (
                                <select aria-label="质检方式" value={workflowQualityDisposition(activeWorkflow) ?? 'manual-review-v1'} disabled={isDebugBusy || hasUnsavedExecution}
                                  onChange={event => {
                                    const disposition = event.target.value === 'strict-v1' ? 'strict-v1' : 'manual-review-v1'
                                    updateActiveWorkflow(workflow => setQualityDisposition(workflow, disposition))
                                    setConfigStatus(disposition === 'manual-review-v1' ? '已切换用户验收：后续内容问题只提示，不自动重拍；已有结果保留。' : '已切换严格质检；后续节点使用原质量门槛，已有结果保留。')
                                  }}>
                                  <option value="manual-review-v1">用户验收（推荐）</option><option value="strict-v1">严格质检</option>
                                </select>
                              ) : param.type === 'json' ? (
                                <textarea rows={3} value={param.value} onChange={(event) => updateParam(inputNode.id, param.id, { value: event.target.value })} />
                              ) : (
                                <input
                                  type={param.type === 'number' ? 'number' : 'text'}
                                  min={param.englishName === 'episode_number' ? 1 : undefined}
                                  max={param.englishName === 'episode_number' ? 1000 : undefined}
                                  value={param.value}
                                  onChange={(event) => updateParam(inputNode.id, param.id, { value: event.target.value })}
                                />
                              )}
                            </label>
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </section>

              <section className={`runner-panel runner-main${isRunnerFullscreen ? ' is-fullscreen' : ''}`} ref={runnerPanelRef}>
                <div className="panel-title runner-dag-title">
                  <div><h2>执行 DAG</h2><span>{runMode === 'step' && workflowDebug ? `第 ${workflowDebug.stepIndex + 1} / ${executionState.nodeRuns.length} 步${debugLoopLabel} · 当前：${currentStepRun?.node.title ?? '准备中'} · ${breakpointNodeIds.size} 个断点` : `执行顺序 ${executionOrder.ordered.length} 步`}</span></div>
                  <div className="run-state-legend" aria-label="节点状态图例">
                    <span className="current">当前步骤</span>
                    <span className="completed">已完成</span>
                    <span className="pending">待执行</span>
                    {runMode === 'step' ? <span className="breakpoint">断点</span> : null}
                  </div>
                </div>
                <div
                  className={`runner-dag dag-canvas${isRunnerPanning ? ' is-panning' : ''}`}
                  ref={runnerViewportRef}
                  style={{ backgroundPosition: `${runnerOffset.x}px ${runnerOffset.y}px`, backgroundSize: `${24 * runnerZoom}px ${24 * runnerZoom}px` }}
                  onPointerDown={startRunnerPan}
                  onPointerMove={moveRunnerPan}
                  onPointerUp={stopRunnerPan}
                  onPointerCancel={stopRunnerPan}
                  onLostPointerCapture={() => {
                    runnerPanRef.current = null
                    setIsRunnerPanning(false)
                  }}
                >
                  <div className="dag-toolbar">
                    <button type="button" className="ghost-btn" aria-pressed={showCanvasMedia} onClick={() => setShowCanvasMedia(value => !value)}><ImageIcon size={16} />媒体预览</button>
                    <button type="button" className="ghost-btn zoom-step" aria-label="缩小执行 DAG" title="缩小" onClick={() => zoomRunnerBy(0.8)}><ZoomOut size={17} /></button>
                    <span className="zoom-value">{Math.round(runnerZoom * 100)}%</span>
                    <button type="button" className="ghost-btn zoom-step" aria-label="放大执行 DAG" title="放大" onClick={() => zoomRunnerBy(1.25)}><ZoomIn size={17} /></button>
                    <button className="ghost-btn zoom-fit" onClick={fitRunnerGraph}>适配</button>
                    <button type="button" className="ghost-btn runner-fullscreen-toggle" aria-label={isRunnerFullscreen ? '退出执行 DAG 全屏' : '全屏展示执行 DAG'} aria-pressed={isRunnerFullscreen} title={isRunnerFullscreen ? '退出全屏（Esc）' : '全屏展示'} onClick={() => void toggleRunnerFullscreen()}>{isRunnerFullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}<span>{isRunnerFullscreen ? '退出全屏' : '全屏'}</span></button>
                    {runnerFullscreenError ? <span className="runner-fullscreen-error" role="alert">{runnerFullscreenError}</span> : null}
                  </div>
                  <div className="dag-zoom-layer runner-zoom-layer">
                    <div className="dag-surface" style={{ width: graphWidth, height: graphHeight, transform: `translate(${runnerOffset.x}px, ${runnerOffset.y}px) scale(${runnerZoom})` }}>
                      <svg className="dag-lines" width={graphWidth} height={graphHeight}>
                        <BranchConnections nodes={canvasNodes} edges={activeWorkflow.edges} prefix="runner-branch" nodeHeight={canvasNodeHeight} />
                        <defs><marker id="runner-arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="var(--studio-subtle)" /></marker></defs>
                        {activeWorkflow.edges.filter(edge => edge.branch === undefined).map((edge) => {
                          const from = canvasNodes.find((node) => node.id === edge.from)
                          const to = canvasNodes.find((node) => node.id === edge.to)
                          if (!from || !to) return null
                          const startX = from.position.x + 248, startY = from.position.y + 62, endX = to.position.x, endY = to.position.y + 62
                          const mid = Math.max(48, Math.abs(endX - startX) / 2)
                          return <path key={edge.id} d={`M ${startX} ${startY} C ${startX + mid} ${startY}, ${endX - mid} ${endY}, ${endX} ${endY}`} fill="none" stroke="var(--studio-subtle)" strokeWidth="2.5" markerEnd="url(#runner-arrow)" />
                        })}
                      </svg>
                      {canvasNodes.filter((node) => node.kind === 'loop').map((loopNode) => {
                        const children = getLoopNodes(canvasWorkflow, loopNode.id)
                        if (!children.length) return null
                        const minX = Math.min(...children.map((node) => node.position.x))
                        const minY = Math.min(...children.map((node) => node.position.y))
                        const maxX = Math.max(...children.map((node) => node.position.x + 248))
                        const maxY = Math.max(...children.map((node) => node.position.y + canvasNodeHeight(node)))
                        return (
                          <div key={loopNode.id} className="loop-container" style={{ left: minX - 20, top: minY - 50, width: maxX - minX + 40, height: maxY - minY + 70 }}>
                            <div className="loop-header"><Repeat size={16} /><strong>{loopNode.title}</strong><span>循环 {getLoopItems(executionState.context, loopNode).length} 次</span></div>
                          </div>
                        )
                      })}
                      {canvasNodes.map((node) => {
                        const Icon = nodeMeta[node.kind].icon
                        const model = models.find((item) => item.id === node.modelId)
                        const nodeRuns = inspectedRuns.filter((run) => run.node.id === node.id)
                        const latestRun = nodeRuns.find((run) => run.status === 'running') ?? nodeRuns.filter((run) => run.status !== 'idle').at(-1) ?? nodeRuns[0]
                        const loopSnapshotRun = activeLoopGroupId && activeLoopIteration !== undefined
                          ? nodeRuns.find((run) => run.loopGroupId === activeLoopGroupId && run.loopIndex === activeLoopIteration)
                          : undefined
                        const isRepeatedLoopNode = Boolean(activeLoopGroupId && nodeRuns.some((run) => run.loopGroupId === activeLoopGroupId))
                        const displayRun = isRepeatedLoopNode ? loopSnapshotRun : latestRun
                        const latestRunIndex = inspectedRuns.findIndex((run) => run.id === displayRun?.id)
                        const fallbackRunIndex = inspectedRuns.findIndex((run) => run.node.id === node.id)
                        const runIndex = latestRunIndex >= 0 ? latestRunIndex : fallbackRunIndex
                        const status = displayRun?.status ?? 'idle'
                        const isCurrent = selectedRun?.node.id === node.id
                        const isStepCursor = isStepDebugActive && !viewingBranchHistory && !viewingHistoricalLoopSnapshot && currentStepRun?.node.id === node.id
                        const isStepCurrent = isStepCursor && status !== 'skipped'
                        const isStepCompleted = isStepDebugActive && !viewingBranchHistory && !isStepCurrent
                          && isDisplayedRunCompletedBeforeStep(inspectedRuns, latestRunIndex, workflowDebug?.stepIndex ?? 0)
                        const nodeBreakpoint = breakpointByNodeId.get(node.id)
                        const hasBreakpoint = Boolean(nodeBreakpoint)
                        const breakpointLabel = nodeBreakpoint?.condition
                          ? `${nodeBreakpoint.condition.path} ${breakpointOperatorLabels[nodeBreakpoint.condition.operator]} ${formatBreakpointValue(nodeBreakpoint.condition.value)}`
                          : ''
                        const statusLabel = isRepeatedLoopNode && activeLoopIteration !== undefined
                          ? `第 ${activeLoopIteration + 1} 轮 · ${runStatusLabels[status]}`
                          : isStepCurrent && hasBreakpoint && status === 'idle' ? '断点暂停' : isStepCurrent && status === 'idle' ? '当前步骤' : isStepCompleted ? '已完成' : runStatusLabels[status]
                        return (
                          <Fragment key={node.id}>
                          <article tabIndex={0} aria-label={node.title} data-canvas-node-id={node.id} className={['dag-node', 'runner-dag-node', hasCanvasMedia(node) ? 'has-canvas-media' : '', node.kind === 'branch' ? 'branch-node' : '', node.kind === 'loop' ? 'loop-node' : '', status, isCurrent ? 'selected' : '', isStepCurrent ? 'step-current' : '', isStepCompleted ? 'step-completed' : '', isRepeatedLoopNode ? 'loop-snapshot-node' : '', hasBreakpoint ? 'has-breakpoint' : ''].filter(Boolean).join(' ')} style={{ left: node.position.x, top: node.position.y }} onClick={() => inspectRunnerNode(node.id, runIndex)} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); inspectRunnerNode(node.id, runIndex) } }}>
                            {node.kind === 'branch' && <BranchNodeShape />}<span className="dag-node-top"><Icon size={20} /><strong title={node.title}>{node.title}</strong></span>
                            <small>{nodeMeta[node.kind].label}{model ? ` · ${model.name}` : ''}</small>
                            <code>${'{' + node.resultVar + '}'}</code>
                            <span className="run-status-badge" translate="no">
                              <span className="run-status-icon" aria-hidden="true">
                                {status === 'running' ? <LoaderCircle className="run-status-spinner" size={14} /> : isStepCurrent ? <Play size={13} /> : status === 'success' ? <CheckCircle2 size={13} /> : status === 'failed' ? <XCircle size={13} /> : null}
                              </span>
                              <span className="run-status-text">{statusLabel}{status !== 'idle' && displayRun ? <> · <RunDuration run={displayRun} /></> : null}</span>
                            </span>
                            {node.kind === 'loop' ? <span className="loop-badge"><Repeat size={13} />循环 {node.loop.fallbackCount}</span> : null}
                            {breakpointLabel ? <span className="breakpoint-condition-label" title={`条件断点：${breakpointLabel}`}>{breakpointLabel}</span> : null}
                            {renderCanvasMedia(node)}
                          </article>
                          {runMode === 'step' ? (
                            <button
                              className={hasBreakpoint ? 'breakpoint-toggle active' : 'breakpoint-toggle'}
                              style={{ left: node.position.x + 212, top: node.position.y + 8 }}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={() => openBreakpointEditor(node.id)}
                              aria-pressed={hasBreakpoint}
                              aria-label={`${hasBreakpoint ? '编辑' : '设置'} ${node.title} 的断点`}
                              title={status === 'running'
                                ? (hasBreakpoint ? '编辑断点；本次节点已开始执行，修改将在下次执行时生效' : '设置断点；本次节点已开始执行，将在下次执行时暂停')
                                : hasBreakpoint ? (breakpointLabel ? `编辑条件断点：${breakpointLabel}` : '编辑或删除断点') : '设置普通断点；再次点击可配置条件'}
                            ><span aria-hidden="true" /></button>
                          ) : null}
                          </Fragment>
                        )
                      })}
                    </div>
                  </div>
                </div>
              </section>

              <section className="runner-panel runner-context">
                {visibleBranchSceneIndices.length > 0 ? <nav className={viewingBranchHistory ? "loop-snapshot-nav is-history" : "loop-snapshot-nav"} aria-label="分支回跳轮次">
                  <div className="loop-snapshot-heading"><div><strong>分支回跳轮次</strong><span>{viewingBranchHistory ? '历史现场 · 只读' : '当前执行现场'} · 每次回跳开始新一轮</span></div></div>
                  <div className="loop-snapshot-rounds">
                    {[...visibleBranchSceneIndices, branchScenes.length].map((index, roundIndex) => <button type="button" key={index}
                      className={index === (branchSceneIndex ?? branchScenes.length) ? 'active' : ''}
                      aria-pressed={index === (branchSceneIndex ?? branchScenes.length)}
                      aria-label={`第 ${roundIndex + 1} 轮 · ${index === branchScenes.length ? '当前轮' : '已回跳'}`}
                      onClick={() => {
                        const current = index === branchScenes.length
                        const runs = current ? executionState.nodeRuns : branchScenes[index].scene as NodeRunState[]
                        setBranchSceneSelection(current ? null : { executionId: executionState.id, index })
                        setRunnerFollowMode(current)
                        setSelectedLoopSnapshot(null)
                        setSelectedRunIndex(Math.max(0, runs.findIndex(run => run.node.id === selectedRun?.node.id && run.loopGroupId === selectedRun?.loopGroupId && run.loopIndex === selectedRun?.loopIndex)))
                      }}><span>{roundIndex + 1}</span><small>{index === branchScenes.length ? '当前轮' : '已回跳'}</small></button>)}
                  </div>
                </nav> : null}
                {activeLoopGroupId && activeLoopIterations.length ? (
                  <nav className={viewingHistoricalLoopSnapshot ? 'loop-snapshot-nav is-history' : 'loop-snapshot-nav'} aria-label="循环轮次现场">
                    <div className="loop-snapshot-heading">
                      <span className="loop-snapshot-icon"><Repeat size={16} /></span>
                      <div><strong>循环轮次现场</strong><span>{viewingHistoricalLoopSnapshot ? '正在回看历史参数快照' : runnerAutoFollow ? '跟随当前执行轮次' : '已固定当前查看现场'}</span></div>
                      {viewingHistoricalLoopSnapshot ? <em>历史</em> : <em className="live">当前</em>}
                    </div>
                    <div className="loop-snapshot-rounds loop-snapshot-rounds-wrap" role="list" aria-label="已开始的循环轮次">
                      {activeLoopIterations.map((loopIndex) => (
                        <button
                          type="button"
                          className={loopIndex === activeLoopIteration ? 'active' : ''}
                          aria-pressed={loopIndex === activeLoopIteration}
                          onClick={() => inspectLoopIteration(loopIndex)}
                          key={loopIndex}
                        >
                          <span>{loopIndex + 1}</span>
                          <small>{inspectedRuns.some(run => run.loopGroupId === activeLoopGroupId && run.loopIndex === loopIndex && run.status === 'failed') ? '失败' : loopIndex === latestLoopIteration ? '当前轮' : inspectedRuns.some(run => run.loopGroupId === activeLoopGroupId && run.loopIndex === loopIndex && run.status === 'idle') ? '待执行' : '已完成'}</small>
                        </button>
                      ))}
                    </div>
                    <div className="loop-snapshot-foot">
                      <span>选择轮次后，DAG 内的循环节点会同步显示该轮输入、上下文和输出。</span>
                      {!runnerAutoFollow || viewingHistoricalLoopSnapshot ? <button type="button" onClick={returnToCurrentLoopIteration}><RefreshCw size={13} />回到当前轮</button> : null}
                    </div>
                  </nav>
                ) : null}
                <div className="panel-title runner-context-title">
                <div><span className="inspector-kicker">节点检查</span><h2>{selectedRun?.node.title ?? '选择一个节点'}</h2><p>{selectedRun ? <>{selectedRun.loopIndex !== undefined ? `第 ${selectedRun.loopIndex + 1} 轮 · ` : ''}{isStepDebugActive && !viewingBranchHistory && currentStepRun?.id === selectedRun.id && selectedRun.status === 'idle' ? '当前步骤' : runStatusLabels[selectedRun.status]}{selectedRun.status !== 'idle' ? <> · <RunDuration run={selectedRun} /></> : null}</> : '点击 DAG 节点查看配置、输入和输出'}</p></div>
                  {selectedRun && !viewingBranchHistory && selectedRun.status !== 'idle' ? <button className="ghost-btn" disabled={isDebugBusy || hasUnsavedExecution} onClick={() => retryFromRunIndex(selectedRunIndex)}>从此节点重试</button> : null}
                </div>
                {selectedRun ? (
                  <>
                    <div className="inspector-tabs" role="tablist" aria-label="节点检查内容">
                      <button className={runnerInspectorTab === 'config' ? 'active' : ''} role="tab" aria-selected={runnerInspectorTab === 'config'} onClick={() => setRunnerInspectorTab('config')}>配置实现</button>
                      <button className={runnerInspectorTab === 'input' ? 'active' : ''} role="tab" aria-selected={runnerInspectorTab === 'input'} onClick={() => setRunnerInspectorTab('input')}>输入 / 上下文</button>
                      <button className={runnerInspectorTab === 'output' ? 'active' : ''} role="tab" aria-selected={runnerInspectorTab === 'output'} onClick={() => setRunnerInspectorTab('output')}>输出</button>
                    </div>
                    {selectedRun.node.kind === 'branch' ? <section className="branch-debug-controls">
                      <strong>分支调试变量</strong><p>{viewingBranchHistory ? '当前显示该轮保存的变量和路由计数。返回当前轮后可继续调试。' : '修改只应用于本次执行；保留已有路由次数和质检结果，再点击“从此节点重试”重新判断。'}</p>
                      <small>已路由 {selectedRun.branchState?.visits ?? 0} 次 · true {selectedRun.branchState?.counts.true ?? 0} / false {selectedRun.branchState?.counts.false ?? 0}</small>
                      {selectedRun.node.params.map(param => <label key={param.id}>{param.englishName || param.name}<input aria-label={`调试变量 ${param.englishName || param.name}`} disabled={viewingBranchHistory || debugContinueRunning || selectedRun.status === 'running'} value={selectedRun.paramOverrides?.[param.id] ?? param.value} onChange={event => updateBranchDebugParam(selectedRunIndex, param.id, event.target.value)} /></label>)}
                    </section> : null}
                    <div className="inspector-content" role="tabpanel">
                      {runnerInspectorTab === 'config' ? renderNodeConfiguration(selectedRun.node) : null}
                      {runnerInspectorTab === 'input' ? (
                        selectedRun.status === 'idle'
                          ? <div className="inspector-empty"><strong>还没有输入快照</strong><span>执行到该节点后，这里会显示解析后的节点输入与执行前上下文。</span></div>
                          : <div className="inspector-variable-sections" key={`${executionState.id}:${selectedRun.id}:${branchSceneIndex ?? 'current'}`}>
                              {selectedRunInputs && displayEntries(selectedRunInputs).length ? (
                                <section className="variable-section">
                                  <div className="variable-section-title"><strong>节点输入</strong><span>{displayEntries(selectedRunInputs).length} 个变量</span></div>
                                  {renderContextEditor(selectedRunInputs, [], [], selectedRunInputLabels, false)}
                                </section>
                              ) : null}
                              {selectedRunInputContext && displayEntries(selectedRunInputContext).length ? (
                                <section className="variable-section">
                                  <div className="variable-section-title"><strong>流程上下文</strong><span>执行前快照</span></div>
                                  {renderContextEditor(selectedRunInputContext, [], [], undefined, !viewingBranchHistory)}
                                </section>
                              ) : null}
                              {(!selectedRunInputs || !displayEntries(selectedRunInputs).length) && (!selectedRunInputContext || !displayEntries(selectedRunInputContext).length)
                                ? <div className="inspector-empty"><strong>本节点没有输入变量</strong><span>该节点从空上下文开始执行。</span></div>
                                : null}
                            </div>
                      ) : null}
                      {runnerInspectorTab === 'output' && selectedRun.attempts?.length ? <section className="variable-section"><strong>历次尝试（当前第 {selectedRun.attempt ?? 1} 次）</strong>{renderContextEditor({ attempts: selectedRun.attempts }, [], [], new Map(), false)}</section> : null}
                      {runnerInspectorTab === 'output' ? (
                        selectedRun.status === 'idle'
                          ? <div className="inspector-empty"><strong>节点尚未执行</strong><span>完成这个步骤后，可在这里检查输出结果。</span></div>
                          : <div className="result-preview variable-section" key={`${executionState.id}:${selectedRun.id}:${branchSceneIndex ?? 'current'}`}>
                              <div className="variable-section-title output-title">
                                {renderVariableName(selectedRun.node.resultVar, [selectedRun.node.resultVar], selectedRun.node.title, selectedRun.node.title)}
                                <div className="output-recovery-actions">
                                  {legacyVideoRecoveryStatus[selectedRun.id] ? <small>{legacyVideoRecoveryStatus[selectedRun.id]}</small> : null}
                                  {!viewingBranchHistory && selectedLegacyVideoTaskId ? (
                                    <button type="button" className="ghost-btn" onClick={() => void recoverLegacyVideoOutput(selectedRun, selectedRunIndex)}>
                                      {legacyVideoRecoveryRef.current.has(`${executionState.id}:${selectedRun.id}:${selectedLegacyVideoTaskId}`)
                                        ? <LoaderCircle className="run-status-spinner" size={14} />
                                        : <RefreshCw size={14} />}
                                      拉取已有视频
                                    </button>
                                  ) : <span>节点输出</span>}
                                </div>
                              </div>
                              <PrincipleQualitySummary output={selectedRun.output} />
                              <VoiceListeningReview
                                key={selectedRun.id + JSON.stringify(selectedVoiceReviewTarget)}
                                output={selectedVoiceReviewOutput}
                                readOnly={viewingBranchHistory || isDebugBusy || Boolean(executionState.persistenceError)}
                                onPassed={canContinueAfterVoiceReview ? () => retryFromRunIndex(selectedRunIndex) : undefined}
                              />
                              {executionState.voicePolicy === 'strict' && selectedRun.node.kind === 'video' && !viewingBranchHistory ? <VoiceUpgradePanel key={executionState.id + selectedRun.id} sourceId={executionState.requestScopeId ?? executionState.id} output={selectedRun.output} runs={executionState.nodeRuns} historicalWorkflow={activeWorkflow.id === 'wf-sanguo-history-drama'} disabled={isDebugBusy || Boolean(executionState.persistenceError)} onCreate={createVoiceUpgradeExecution} /> : null}
                              <DurationDiagnostics context={selectedRun.context ?? selectedRunInputContext ?? {}} output={selectedRun.output} runStatus={selectedRun.status} runError={selectedRun.error} resultVar={selectedRun.node.resultVar} />
                              {renderContextEditor(selectedRun.output, [], [selectedRun.node.resultVar], undefined, false)}
                            </div>
                      ) : null}
                    </div>
                  </>
                ) : <div className="inspector-empty standalone"><strong>从 DAG 开始检查</strong><span>所有节点都可以点击，尚未执行的节点也能查看配置实现。</span></div>}
                <InspectorDisclosure className="run-log-disclosure" summary={<>执行日志 <span>{executionState.logs.length}</span></>}>
                  {() => <div className="run-log"><InspectorEntries count={executionState.logs.length} renderEntry={index => <span key={index}><CheckCircle2 size={15} />{executionState.logs[index]}</span>} /></div>}
                </InspectorDisclosure>
              </section>
            </div>
            )}
          </section>
        ) : (
        <section className="workspace">
          <header className="topbar">
            <div className="workflow-edit-heading">
              <h1>{activeWorkflow.name}</h1>
              <p>{isWorkflowDetail ? '工作流详情 · ' : ''}{activeWorkflow.description || '暂无工作流描述'}</p>
            </div>
            <div className="topbar-actions">
              <button className="ghost-btn" onClick={() => setWorkflowView('list')}>返回列表</button>
              {isWorkflowDetail ? <button className="ghost-btn" onClick={() => setWorkflowView('edit')}><Pencil size={16} />编辑编排</button> : <button className="ghost-btn" onClick={openWorkflowInfo} aria-expanded={workflowInfoOpen} aria-controls="workflow-info-editor"><Pencil size={16} />基础信息</button>}
              <button className="ghost-btn" disabled={isDebugBusy || hasUnsavedExecution} onClick={duplicateWorkflow}><Copy size={16} />复制当前工作流</button>
              <button className="primary-btn" disabled={isDebugBusy || hasUnsavedExecution} onClick={() => openWorkflowRun(activeWorkflow)}><Play size={17} />进入执行</button>
            </div>
          </header>
          {!isWorkflowDetail && workflowInfoOpen ? (
            <form
              id="workflow-info-editor"
              className="workflow-info-editor"
              noValidate
              onSubmit={(event) => {
                event.preventDefault()
                void saveWorkflowInfo()
              }}
            >
              <div className="workflow-info-editor-head">
                <div>
                  <h2>工作流基础信息</h2>
                  <p>名称和描述会显示在工作流列表与执行页面。</p>
                </div>
                <span>修改后保存到配置库</span>
              </div>
              <div className="workflow-info-fields">
                <label>
                  <span>工作流名称</span>
                  <input
                    autoFocus
                    required
                    maxLength={80}
                    value={workflowInfoDraft.name}
                    aria-label="工作流名称"
                    aria-invalid={Boolean(workflowInfoError)}
                    aria-describedby={workflowInfoError ? 'workflow-info-error' : undefined}
                    onChange={(event) => {
                      setWorkflowInfoDraft((current) => ({ ...current, name: event.target.value }))
                      if (workflowInfoError) setWorkflowInfoError('')
                    }}
                  />
                  <small>{workflowInfoDraft.name.length}/80</small>
                </label>
                <label>
                  <span>工作流描述</span>
                  <textarea
                    rows={3}
                    maxLength={300}
                    placeholder="说明这个工作流的用途和主要产出"
                    value={workflowInfoDraft.description}
                    aria-label="工作流描述"
                    onChange={(event) => setWorkflowInfoDraft((current) => ({ ...current, description: event.target.value }))}
                  />
                  <small>{workflowInfoDraft.description.length}/300</small>
                </label>
              </div>
              <div className="workflow-info-editor-footer">
                {workflowInfoError ? <span id="workflow-info-error" role="alert">{workflowInfoError}</span> : <span>名称为必填项，描述可留空。</span>}
                <div>
                  <button type="button" className="ghost-btn" onClick={closeWorkflowInfo} disabled={workflowInfoSaving}>取消</button>
                  <button type="submit" className="primary-btn" disabled={workflowInfoSaving}>{workflowInfoSaving ? '保存中...' : '保存基础信息'}</button>
                </div>
              </div>
            </form>
          ) : null}
          <div className={`workflow-grid${isWorkflowDetail ? ' workflow-detail-grid' : ''}`}>
            <section className="node-palette">
              <h2>新增节点</h2>
              {(Object.keys(nodeMeta) as NodeKind[]).map((kind) => { const Icon = nodeMeta[kind].icon; return <button className="palette-item" key={kind} onClick={() => addNode(kind)}><Icon size={18} /><span>{nodeMeta[kind].label}</span><Plus size={16} /></button> })}
            </section>

            <section className="canvas">
              <div className="canvas-header"><div><h2>{activeWorkflow.name}</h2><span>{executionState.workflowId === activeWorkflow.id && executionState.nodeRuns.some(run => run.status !== 'idle') ? `当前查看的执行：${executionState.id}${activeLoopIteration !== undefined ? ` · 第 ${activeLoopIteration + 1} 轮` : ''}${viewingBranchHistory ? ' · 历史分支' : ''}` : '图片、视频和声音直接预览；执行后查看生成结果'}</span></div><span>{executionOrder.hasCycle ? '存在循环依赖' : `执行顺序 ${executionOrder.ordered.length} 步`}</span></div>
              <div
                className={`dag-canvas editable-dag${isCanvasPanning ? ' is-panning' : ''}`}
                ref={viewportRef}
                onPointerDown={startCanvasPan}
                onPointerMove={moveCanvasPan}
                onPointerUp={() => { if (canvasPanRef.current) stopCanvasPan() }}
                onPointerCancel={stopCanvasPan}
                onLostPointerCapture={() => { if (canvasPanRef.current) stopCanvasPan() }}
                onMouseMove={onSurfaceMove}
                onMouseUp={stopCanvasPan}
                onMouseLeave={() => { if (!canvasPanRef.current) stopCanvasPan() }}
                style={{ backgroundPosition: `${canvasOffset.x}px ${canvasOffset.y}px`, backgroundSize: `${24 * zoom}px ${24 * zoom}px` }}
              >
                <div className="dag-toolbar"><button type="button" className="ghost-btn" aria-pressed={showCanvasMedia} onClick={() => setShowCanvasMedia(value => !value)}><ImageIcon size={16} />媒体预览</button><button type="button" className="ghost-btn zoom-step" aria-label="缩小画布" onClick={() => zoomCanvasBy(0.8)}><ZoomOut size={17} /></button><span className="zoom-value">{Math.round(zoom * 100)}%</span><button type="button" className="ghost-btn zoom-step" aria-label="放大画布" onClick={() => zoomCanvasBy(1.25)}><ZoomIn size={17} /></button><button className="ghost-btn zoom-fit" onClick={fitGraph}>适配画布</button></div>
                <div className="dag-zoom-layer editable-zoom-layer">
                <div className="dag-surface" ref={surfaceRef} style={{ width: graphWidth, height: graphHeight, transform: `translate(${canvasOffset.x}px, ${canvasOffset.y}px) scale(${zoom})` }}>
                  {drag?.type === 'selection' ? <div className="canvas-selection-box" style={(() => { const rect = selectionRect(drag.start, drag.end); return { left: rect.x, top: rect.y, width: rect.width, height: rect.height } })()} /> : null}
                  <svg className="dag-lines" width={graphWidth} height={graphHeight}>
                    <BranchConnections nodes={canvasNodes} edges={activeWorkflow.edges} prefix="editor-branch" nodeHeight={canvasNodeHeight} onRemove={isWorkflowDetail ? undefined : removeEdge} />
                    <defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="var(--studio-subtle)" /></marker></defs>
                    {activeWorkflow.edges.filter(edge => edge.branch === undefined).map((edge) => {
                      const from = canvasNodes.find((node) => node.id === edge.from)
                      const to = canvasNodes.find((node) => node.id === edge.to)
                      if (!from || !to) return null
                      const startX = from.position.x + 248, startY = from.position.y + 62, endX = to.position.x, endY = to.position.y + 62
                      const mid = Math.max(48, Math.abs(endX - startX) / 2)
                      return <path key={edge.id} className="edge-path" d={`M ${startX} ${startY} C ${startX + mid} ${startY}, ${endX - mid} ${endY}, ${endX} ${endY}`} fill="none" stroke="var(--studio-subtle)" strokeWidth="2.5" markerEnd="url(#arrow)" onClick={isWorkflowDetail ? undefined : () => removeEdge(edge.id)} />
                    })}
                    {drag?.type === 'edge'
                      ? (() => {
                          const from = canvasNodes.find((node) => node.id === drag.from)
                          const offset = branchOutputOffset(drag.branch)
                          return from ? <path d={`M ${from.position.x + offset.x} ${from.position.y + offset.y} L ${drag.x} ${drag.y}`} fill="none" stroke="var(--studio-accent)" strokeWidth="2.5" strokeDasharray="6 4" /> : null
                        })()
                      : null}
                  </svg>
                  {canvasNodes.filter((node) => node.kind === 'loop').map((loopNode) => {
                    const children = getLoopNodes(canvasWorkflow, loopNode.id)
                    if (!children.length) return null
                    const minX = Math.min(...children.map((n) => n.position.x))
                    const minY = Math.min(...children.map((n) => n.position.y))
                    const maxX = Math.max(...children.map((n) => n.position.x + 248))
                    const maxY = Math.max(...children.map((n) => n.position.y + canvasNodeHeight(n)))
                    return (
                      <div key={loopNode.id} className="loop-container" style={{ left: minX - 20, top: minY - 50, width: maxX - minX + 40, height: maxY - minY + 70 }}>
                        <div className="loop-header"><Repeat size={16} /><strong>{loopNode.title}</strong><span>循环 {getLoopItems(executionState.context, loopNode).length} 次</span></div>
                      </div>
                    )
                  })}
                  {canvasNodes.map((node) => {
                    const meta = nodeMeta[node.kind]
                    if (!meta) return null
                    const Icon = meta.icon
                    const model = models.find((item) => item.id === node.modelId)
                    const isInLoop = activeWorkflow.nodes.some((candidate) => candidate.kind === 'loop' && getLoopNodes(canvasWorkflow, candidate.id).some((child) => child.id === node.id))
                    const isDebugCurrent = workflowDebugSnapshot?.currentRun?.node.id === node.id
                    if (node.kind === 'loop') {
                      return (
                        <article className={['dag-node', 'loop-node', selectedCanvasIds.includes(node.id) ? 'selected' : '', isDebugCurrent ? 'debug-current' : ''].filter(Boolean).join(' ')} key={node.id} data-canvas-node-id={node.id} style={{ left: node.position.x, top: node.position.y }} onMouseDown={(e) => startNodeDrag(e, node)} onClick={(event) => { if ((event.target as HTMLElement).closest('.port,.node-action,.canvas-node-media')) return; setSelectedNodeId(node.id); setInspectorOpen(!isWorkflowDetail) }}>
                          <button className="port port-in" title="输入连接点" onMouseUp={(e) => finishEdgeDrag(e, node.id)} />
                          <button className="port port-out" title="输出连接点" onMouseDown={(e) => startEdgeDrag(e, node)} />
                          <span className="dag-node-top"><Icon size={20} /><strong title={node.title}>{node.title}</strong><button className="node-action" title="删除节点" onClick={(e) => { e.stopPropagation(); removeNode(node.id) }}><Trash2 size={14} /></button></span>
                          <small>{meta.label}</small>
                          <code>${'{' + node.resultVar + '}'}</code>
                          <span className="loop-badge"><Repeat size={13} />循环 {node.loop.fallbackCount}</span>
                        </article>
                      )
                    }
                    return (
                      <article className={['dag-node', hasCanvasMedia(node) ? 'has-canvas-media' : '', node.kind === 'branch' ? 'branch-node' : '', selectedCanvasIds.includes(node.id) ? 'selected' : '', isDebugCurrent ? 'debug-current' : ''].filter(Boolean).join(' ')} key={node.id} data-canvas-node-id={node.id} style={{ left: node.position.x, top: node.position.y }} onMouseDown={(e) => startNodeDrag(e, node)} onClick={(event) => { if ((event.target as HTMLElement).closest('.port,.node-action,.canvas-node-media')) return; setSelectedNodeId(node.id); setInspectorOpen(!isWorkflowDetail) }}>
                        <button className="port port-in" title="输入连接点" onMouseUp={(e) => finishEdgeDrag(e, node.id)} />
                        {node.kind === 'branch' ? <>{(['true', 'false'] as const).map(port => <button key={port} className={`port port-out branch-port branch-port-${port}`} title={`${port} 输出连接点`} onMouseDown={e => startEdgeDrag(e, node, port)}><span>{port}</span></button>)}</> : <button className="port port-out" title="输出连接点" onMouseDown={(e) => startEdgeDrag(e, node)} />}
                        {node.kind === 'branch' && <BranchNodeShape />}<span className="dag-node-top"><Icon size={20} /><strong title={node.title}>{node.title}</strong><button className="node-action" title="删除节点" onClick={(e) => { e.stopPropagation(); removeNode(node.id) }}><Trash2 size={14} /></button></span>
                        <small>{meta.label}{model ? ` · ${model.name}` : ''}</small>
                        <code>${'{' + node.resultVar + '}'}</code>
                        {renderCanvasMedia(node)}
                        {isInLoop ? null : node.loop.enabled ? <span className="loop-badge"><Repeat size={13} />循环 {node.loop.fallbackCount}</span> : null}
                      </article>
                    )
                  })}
                </div>
                </div>
              </div>
            </section>

            {!isWorkflowDetail && inspectorOpen && selectedNode ? <section className="inspector node-properties-drawer" role="dialog" aria-modal="false" aria-labelledby="node-properties-title">
              <div className="panel-title"><h2 id="node-properties-title">节点属性</h2><button className="icon-btn inspector-close" title="关闭节点属性" aria-label="关闭节点属性" onClick={() => setInspectorOpen(false)}><X size={19} /></button><button className="icon-btn danger" title="删除节点" onClick={() => removeNode(selectedNode.id)} disabled={activeWorkflow.nodes.length <= 1}><Trash2 size={17} /></button></div>
              <label>节点名称<input value={selectedNode.title} onChange={(event) => updateNode(selectedNode.id, { title: event.target.value })} /></label>
              <label>结果变量名<input value={selectedNode.resultVar} onChange={(event) => updateNode(selectedNode.id, { resultVar: event.target.value })} /></label>
              {selectedCapability ? <label>使用模型<select value={selectedNode.modelId ?? ''} onChange={(event) => updateNode(selectedNode.id, { modelId: event.target.value || undefined })}>{selectedNode.kind === 'image' ? <option value="">手工上传，不调用模型</option> : null}{availableModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label> : null}
              {selectedNode.kind === 'internet' || selectedNode.kind === 'validation' || selectedNode.kind === 'knowledge' || selectedNode.kind === 'asset' || selectedNode.kind === 'compose' || selectedNode.kind === 'videoConcat' || selectedNode.kind === 'text' ? <label>节点操作<input value={selectedNode.operation ?? ''} placeholder="例如 internet.retrieve" onChange={(event) => updateNode(selectedNode.id, { operation: event.target.value || undefined })} /></label> : null}
              {selectedNode.kind === 'text' ? <label>结构化输出<select value={selectedNode.outputMode ?? 'legacy-shots'} onChange={(event) => updateNode(selectedNode.id, { outputMode: event.target.value as TextOutputMode })}><option value="legacy-shots">旧版 shots 数组</option><option value="array">JSON 数组</option><option value="json">JSON 对象</option><option value="text">纯文本</option></select></label> : null}
              {selectedNode.kind === 'http' ? <label>请求地址<input value={selectedNode.request?.url ?? ''} placeholder="/api/video-evidence" onChange={event => updateNode(selectedNode.id, {request:{url:event.target.value,method:'POST'}})} /></label> : null}
              {selectedNode.kind === 'branch' ? <div className="branch-config">
                <label>所属循环<select aria-label="分支所属循环" value={selectedNode.parentId ?? activeWorkflow.nodes.find(n => n.kind === 'loop' && n.childIds?.includes(selectedNode.id))?.id ?? ''} onChange={event => updateActiveWorkflow(w => setBranchLoop(w, selectedNode.id, event.target.value))}><option value="">循环外</option>{activeWorkflow.nodes.filter(n => n.kind === 'loop').map(n => <option key={n.id} value={n.id}>{n.title}</option>)}</select></label>
                <p>代码返回 true / false，沿对应连线执行。可连接任意节点，包括自身和之前的节点；次数限制由代码及参数决定。抛出错误会停在本节点，单步调试可修改参数后重试。</p>
                {(['true', 'false'] as const).map(port => <label key={port}>{port} 出口目标<select aria-label={`${port} 出口目标`} value={activeWorkflow.edges.find(e => e.from === selectedNode.id && e.branch === port)?.to ?? ''} onChange={event => updateActiveWorkflow(w => ({ ...w, edges: setBranchEdge(w.edges, selectedNode.id, port, event.target.value, createId('edge')) }))}>
                  <option value="">未连接</option>{activeWorkflow.nodes.map(n => <option key={n.id} value={n.id}>{n.title}{n.id === selectedNode.id ? '（自身）' : ''}</option>)}
                </select></label>)}
                {branchConfigurationErrors(activeWorkflow).filter(e => e.includes(selectedNode.id)).map(e => <p role="alert" key={e}>{e}</p>)}
              </div> : null}
              <label><input type="checkbox" checked={Boolean(selectedNode.mapInput)} onChange={event=>updateNode(selectedNode.id,{mapInput:event.target.checked?{sourcePath:'items',itemVar:'item',maxItems:24}:undefined})} />对数组逐项执行</label>
              {selectedNode.mapInput ? <div className="loop-config"><label>数组来源<input value={selectedNode.mapInput.sourcePath} onChange={event=>updateNode(selectedNode.id,{mapInput:{...selectedNode.mapInput!,sourcePath:event.target.value}})} /></label><label>单项变量<input value={selectedNode.mapInput.itemVar} onChange={event=>updateNode(selectedNode.id,{mapInput:{...selectedNode.mapInput!,itemVar:event.target.value}})} /></label><label>数量上限<input type="number" min="1" max="100" value={selectedNode.mapInput.maxItems??24} onChange={event=>updateNode(selectedNode.id,{mapInput:{...selectedNode.mapInput!,maxItems:Number(event.target.value)}})} /></label></div> : null}
              <div className="long-text-field">
                <div className="long-text-field-heading">
                  <label htmlFor={`node-prompt-${selectedNode.id}`}>{selectedNode.kind === 'code' || selectedNode.kind === 'internet' || selectedNode.kind === 'validation' || selectedNode.kind === 'knowledge' || selectedNode.kind === 'asset' || selectedNode.kind === 'compose' || selectedNode.kind === 'videoConcat' ? '处理说明（内置操作不作为文本模型提示词）' : '提示词 / 模板'}</label>
                  <button type="button" onClick={() => setTextPreview({ value: selectedNode.prompt, title: `${selectedNode.title} · ${selectedNode.kind === 'code' ? '处理说明' : '提示词 / 模板'}`, eyebrow: '节点内容', editable: true, target: { type: 'node', nodeId: selectedNode.id, field: 'prompt' } })} aria-label="展开编辑提示词或处理说明"><Maximize2 size={14} />展开</button>
                </div>
                <textarea id={`node-prompt-${selectedNode.id}`} rows={5} value={selectedNode.prompt} onChange={(event) => updateNode(selectedNode.id, { prompt: event.target.value })} />
              </div>
              {(selectedNode.kind === 'code' || selectedNode.kind === 'branch') ? (
                <div className="code-config">
                  <div className="code-config-title">
                    <div><strong>JavaScript 代码</strong><span>可用 ${'{变量路径}'} 占位符、context、顶层上下文变量（如 input）、files、prompt、console 和 excel.parse()。return 中的 contextPatch 会合并进流程上下文。</span></div>
                    <button type="button" onClick={() => setTextPreview({ value: selectedNode.code ?? '', title: `${selectedNode.title} · JavaScript 代码`, eyebrow: '节点内容', editable: true, target: { type: 'node', nodeId: selectedNode.id, field: 'code' } })} aria-label="展开编辑 JavaScript 代码"><Maximize2 size={14} />展开</button>
                  </div>
                  <textarea
                    aria-label="JavaScript 代码"
                    className="code-editor"
                    rows={30}
                    spellCheck={false}
                    value={selectedNode.code ?? ''}
                    onChange={(event) => updateNode(selectedNode.id, { code: event.target.value })}
                  />
                  <span className="empty-note">受限同步 JavaScript 环境（1.5 秒）；不提供网络、文件系统和模块 API。Excel 示例：excel.parse(files[0], {'{'} sheetName: '1000集总表', headerRow: 1, outputLimit: 5000 {'}'})。</span>
                </div>
              ) : null}
              {selectedNode.kind === 'loop' ? <div className="loop-config"><label>循环来源变量<input value={selectedNode.loop.sourcePath} onChange={(event) => updateNode(selectedNode.id, { loop: { ...selectedNode.loop, sourcePath: event.target.value } })} /></label><div className="position-grid"><label>默认次数<input type="number" value={selectedNode.loop.fallbackCount} onChange={(event) => updateNode(selectedNode.id, { loop: { ...selectedNode.loop, fallbackCount: Number(event.target.value) } })} /></label><label>单项变量名<input value={selectedNode.loop.itemVar} onChange={(event) => updateNode(selectedNode.id, { loop: { ...selectedNode.loop, itemVar: event.target.value } })} /></label></div></div> : null}
              {selectedNode.kind === 'input' || selectedNode.kind === 'image' ? <div className="upload-box"><div><strong>{selectedNode.title === '模特图生成' ? '模特参考图' : '上传图片'}</strong><span>上传后的图片会作为该节点的输出数组，可被后续节点通过 ${'{' + selectedNode.resultVar + '.items}'} 引用。</span></div><label className="upload-btn"><ImageIcon size={16} />选择图片<input type="file" accept="image/*" multiple onChange={(event) => { uploadAssets(selectedNode.id, event.target.files); event.currentTarget.value = '' }} /></label>{selectedNode.uploads.length ? <div className="thumb-grid">{selectedNode.uploads.map((asset) => <div className="thumb-item" key={asset.id}><img src={asset.dataUrl} alt={asset.name} /><button className="node-action" title="删除图片" onClick={() => removeUpload(selectedNode.id, asset.id)}><Trash2 size={14} /></button></div>)}</div> : null}</div> : null}
              {(selectedNode.kind === 'code' || selectedNode.kind === 'branch') ? (
                <div className="upload-box">
                  <div><strong>附件</strong><span>支持 Excel .xlsx，最大 15MB；上传新附件会替换当前附件。代码可通过 files 和 excel.parse() 读取。</span></div>
                  <label className="upload-btn"><FileSpreadsheet size={16} />上传附件<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { uploadAssets(selectedNode.id, event.target.files); event.currentTarget.value = '' }} /></label>
                  {selectedNode.uploads.length ? <div className="file-upload-list">{selectedNode.uploads.map((asset) => <div className="file-upload-item" key={asset.id}><FileSpreadsheet size={20} /><div className="file-upload-copy"><strong>{asset.name}</strong><span>{asset.size ? `${(asset.size / 1024).toFixed(1)} KB` : '随工作流保存'}</span></div><div className="file-upload-actions"><a className="node-action attachment-download" href={assetDownloadUrl(asset.dataUrl, asset.name)} download={asset.name} title="下载附件" aria-label={`下载附件 ${asset.name}`}><Download size={14} /></a><button className="node-action" title="删除附件" aria-label={`删除附件 ${asset.name}`} onClick={() => removeUpload(selectedNode.id, asset.id)}><Trash2 size={14} /></button></div></div>)}</div> : <span className="empty-note">尚未上传附件；不调用 excel.parse() 的代码仍可执行。</span>}
                </div>
              ) : null}
              {<><div className="panel-title compact"><h3>{selectedNode.kind === 'input' ? '入参字段' : '参数配置'}</h3><button className="ghost-btn" onClick={addParam}><Plus size={16} />添加</button></div>
              <div className="param-list">
                {selectedNode.params.map((param) => {
                  const valueLength = Array.from(param.value).length
                  const isValueCapped = valueLength > PARAM_VALUE_VISIBLE_LIMIT
                  return (
                    <div className="param-editor" key={param.id}>
                      <label className="param-field">
                        <span>中文名</span>
                        <input value={param.name} onChange={(event) => updateParam(selectedNode.id, param.id, { name: event.target.value })} />
                      </label>
                      <label className="param-field">
                        <span>英文名</span>
                        <input value={param.englishName || ''} onChange={(event) => updateParam(selectedNode.id, param.id, { englishName: event.target.value })} />
                      </label>
                      <label className="param-field param-type-field">
                        <span>类型</span>
                        <select value={param.type} onChange={(event) => updateParam(selectedNode.id, param.id, { type: event.target.value as ParamType })}><option value="text">文本</option><option value="number">数字</option><option value="boolean">布尔</option><option value="image">单图</option><option value="images">多图</option><option value="json">JSON</option></select>
                      </label>
                      <label className="check-label param-required-field"><input type="checkbox" checked={param.required} onChange={(event) => updateParam(selectedNode.id, param.id, { required: event.target.checked })} />必填</label>
                      {<button className="icon-btn" title="删除入参" aria-label={`删除入参 ${param.name || param.englishName || ''}`} onClick={() => removeParam(param.id)}><Trash2 size={15} /></button>}
                      <div className="param-field param-value-field">
                        <div className="long-text-field-heading">
                          <label htmlFor={`param-value-${selectedNode.id}-${param.id}`}>参数值</label>
                          <button type="button" onClick={() => setTextPreview({ value: param.value, title: `${selectedNode.title} · ${param.name || param.englishName || '参数值'}`, eyebrow: '节点参数', editable: true, target: { type: 'param', nodeId: selectedNode.id, paramId: param.id } })} aria-label={`展开编辑${param.name || param.englishName || '参数值'}`}><Maximize2 size={14} />展开</button>
                        </div>
                        <textarea
                          id={`param-value-${selectedNode.id}-${param.id}`}
                          className={isValueCapped ? 'param-value is-capped' : 'param-value'}
                          rows={getParamValueRows(param.value)}
                          value={param.value}
                          onChange={(event) => updateParam(selectedNode.id, param.id, { value: event.target.value })}
                        />
                        {isValueCapped ? <small>超过 50 个字符，已限制默认高度；滚动可查看全部 {valueLength} 个字符。</small> : null}
                      </div>
                    </div>
                  )
                })}
              </div></>}
            </section> : null}
          </div>
        </section>
        )
      ) : (
        <section className="workspace">
          {modelView.mode === 'list' ? (
            <>
              <header className="topbar">
                <div>
                  <h1>模型管理</h1>
                  <p>这里只维护模型、接口地址和凭据；画幅、时长、质量等单次生成参数在体验页配置。</p>
                </div>
                <div className="topbar-actions">
                  <button className="ghost-btn" onClick={() => setModelView({ mode: 'runs' })}><Activity size={17} />执行流水</button>
                  <button className="ghost-btn" onClick={addModel}><Plus size={17} />新增模型</button>
                </div>
              </header>
              <details className="studio-storage-disclosure">
                <summary><Settings size={15} /><span>配置库诊断</span><ChevronDown size={16} /></summary>
                <section className="storage-panel">
                <div>
                  <h2>配置库诊断</h2>
                  <p>当前项目使用 PostgreSQL 保存模型配置和工作流配置；这里只显示 key 长度，不显示明文。</p>
                  <p>{configStatus}</p>
                </div>
                <div className="storage-actions">
                  <button className="ghost-btn" onClick={inspectModelStorage}>从配置库拉取</button>
                  <button className="ghost-btn" onClick={runModelStorageSelfTest}>配置入库自测</button>
                </div>
                {storageDiagnostic ? <pre className="storage-result">{storageDiagnostic}</pre> : null}
                </section>
              </details>
              <div className="model-tabs">
                {(['text', 'image', 'video', 'audio'] as ModelCapability[]).map((capability) => (
                  <button key={capability} className={modelTab === capability ? 'tab-btn active' : 'tab-btn'} onClick={() => setModelTab(capability)}>
                    {capability === 'text' ? '文本推理模型' : capability === 'image' ? '图片生成模型' : capability === 'video' ? '视频生成模型' : '语音合成 / TTS'}
                  </button>
                ))}
              </div>
              <div className="model-grid">
                {draftModels.filter((model) => model.capability === modelTab).map((model) => (
                  <article className="model-card" key={model.id}>
                    <div className="model-card-head">
                      <div>
                        <h2>{model.name}</h2>
                        <span>{model.provider} · {model.capability}</span>
                      </div>
                      <button className="icon-btn" title="删除模型" onClick={() => removeModel(model.id)}><Trash2 size={16} /></button>
                    </div>
                    <label>模型名称<input value={model.name} onChange={(event) => updateModel(model.id, { name: event.target.value })} /></label>
                    <div className="position-grid">
                      <label>Provider<select value={model.provider} onChange={(event) => updateModel(model.id, { provider: event.target.value as ModelProvider })}><option value="Anthropic">Anthropic</option><option value="OpenAI">OpenAI</option>{model.capability === 'text' ? <option value="Codex">Codex（本机 CLI）</option> : null}<option value="Ofox">Ofox</option><option value="Kling">Kling</option><option value="Bailian">百炼 TTS</option><option value="Local">Local</option><option value="Custom">Custom</option></select></label>
                      <label>Model ID<input value={model.settings.model ?? ''} onChange={(event) => updateModelSetting(model.id, 'model', event.target.value)} /></label>
                    </div>
                    {renderModelFields(model)}
                    <div className="model-card-actions">
                      <button className="primary-btn" onClick={() => saveSingleModel(model.id)}>保存配置</button>
                      <button className="ghost-btn" onClick={() => { setExperienceSource(null); setModelView({ mode: 'detail', modelId: model.id }) }}><FlaskConical size={17} />测试 / 体验</button>
                    </div>
                  </article>
                ))}
              </div>
            </>
          ) : modelView.mode === 'runs' ? (
            <section className="model-runs-page">
              <header className="topbar">
                <div>
                  <h1>模型执行流水</h1>
                  <p>统一查看体验调用与工作流节点调用；记录已隐藏凭据和大体积 Base64 内容。</p>
                </div>
                <div className="topbar-actions">
                  <button className="ghost-btn" onClick={() => setModelExecutionRefresh((current) => current + 1)}><RefreshCw size={16} />刷新</button>
                  <button className="ghost-btn" onClick={() => setModelView({ mode: 'list' })}>返回模型列表</button>
                </div>
              </header>
              <section className="model-run-summary" aria-label="流水汇总">
                <div><span>当前结果</span><strong>{modelExecutionRecords.length}</strong></div>
                <div><span>执行中</span><strong>{modelExecutionRecords.filter((record) => record.status === 'processing').length}</strong></div>
                <div><span>成功</span><strong>{modelExecutionRecords.filter((record) => record.status === 'succeeded').length}</strong></div>
                <div><span>失败</span><strong>{modelExecutionRecords.filter((record) => record.status === 'failed').length}</strong></div>
              </section>
              <section className="model-run-filter-panel" aria-label="执行流水筛选">
                <label><span>执行渠道</span><select value={modelExecutionFilters.channel} onChange={(event) => setModelExecutionFilters((current) => ({ ...current, channel: event.target.value }))}><option value="">全部渠道</option><option value="experience">体验调用</option><option value="workflow">工作流调用</option></select></label>
                <label><span>模型</span><select value={modelExecutionFilters.modelId} onChange={(event) => setModelExecutionFilters((current) => ({ ...current, modelId: event.target.value }))}><option value="">全部模型</option>{draftModels.map((model) => <option value={model.id} key={model.id}>{model.name}</option>)}</select></label>
                <label><span>能力类型</span><select value={modelExecutionFilters.capability} onChange={(event) => setModelExecutionFilters((current) => ({ ...current, capability: event.target.value }))}><option value="">全部类型</option><option value="text">文本</option><option value="image">图片</option><option value="video">视频</option><option value="audio">音频</option></select></label>
                <label><span>执行状态</span><select value={modelExecutionFilters.status} onChange={(event) => setModelExecutionFilters((current) => ({ ...current, status: event.target.value }))}><option value="">全部状态</option><option value="processing">执行中</option><option value="succeeded">成功</option><option value="failed">失败</option></select></label>
                <label className="model-run-search"><span>搜索</span><div><Search size={15} /><input value={modelExecutionFilters.keyword} placeholder="任务 ID、流水 ID、工作流或节点" onChange={(event) => setModelExecutionFilters((current) => ({ ...current, keyword: event.target.value }))} /></div></label>
                <button type="button" className="ghost-btn model-run-reset" disabled={!Object.values(modelExecutionFilters).some(Boolean)} onClick={() => setModelExecutionFilters({ channel: '', modelId: '', status: '', capability: '', keyword: '' })}>重置筛选</button>
              </section>
              <section className="model-run-table-card">
                <div className="model-run-table-head"><span>时间 / 流水 ID</span><span>渠道</span><span>模型</span><span>来源</span><span>状态</span><span>耗时</span><span>操作</span></div>
                {modelExecutionLoading ? <div className="model-run-loading"><span /><span /><span /></div> : null}
                {!modelExecutionLoading && modelExecutionRecords.map((record) => (
                  <details className="model-run-row" key={record.id}>
                    <summary>
                      <span><strong>{record.createdAt ? new Date(record.createdAt).toLocaleString() : '刚刚'}</strong><small>{record.taskId || record.id}</small></span>
                      <span><em className={`model-run-channel ${record.channel}`}>{record.channel === 'experience' ? '体验调用' : '工作流调用'}</em></span>
                      <span><strong>{record.modelName}</strong><small>{record.provider} · {record.capability}</small></span>
                      <span><strong>{record.workflowName || '模型体验页'}</strong><small>{record.nodeName || '直接调用'}</small></span>
                      <span><em className={`model-run-status ${record.status}`}>{record.status === 'processing' ? '执行中' : record.status === 'succeeded' ? '成功' : record.status === 'failed' ? '失败' : record.status}</em>{record.httpStatus ? <small>HTTP {record.httpStatus}</small> : null}</span>
                      <span>{record.durationMs >= 1000 ? `${(record.durationMs / 1000).toFixed(1)} 秒` : `${record.durationMs} ms`}</span>
                      <span><button type="button" className="ghost-btn model-run-experience" onClick={(event) => { event.preventDefault(); event.stopPropagation(); openExecutionInExperience(record) }}><FlaskConical size={15} />去体验</button></span>
                    </summary>
                    <div className="model-run-detail">
                      <dl>
                        <div><dt>流水 ID</dt><dd>{record.id}</dd></div>
                        {record.taskId ? <div><dt>供应商任务 ID</dt><dd>{record.taskId}</dd></div> : null}
                        {record.workflowId ? <div><dt>工作流</dt><dd>{record.workflowName}（{record.workflowId}）</dd></div> : null}
                        {record.nodeId ? <div><dt>节点</dt><dd>{record.nodeName}（{record.nodeId}）</dd></div> : null}
                        <div><dt>最后更新</dt><dd>{record.updatedAt ? new Date(record.updatedAt).toLocaleString() : '-'}</dd></div>
                      </dl>
                      {record.error ? <p className="model-run-error">{record.error}</p> : null}
                      <div className="model-run-payloads"><details><summary>请求摘要</summary><pre>{JSON.stringify(record.requestData, null, 2)}</pre></details><details><summary>响应摘要</summary><pre>{JSON.stringify(record.responseData ?? {}, null, 2)}</pre></details></div>
                    </div>
                  </details>
                ))}
                {!modelExecutionLoading && !modelExecutionRecords.length ? <div className="model-run-empty"><Activity size={22} /><strong>没有符合条件的执行流水</strong><span>发起一次模型体验调用或执行包含模型节点的工作流后，记录会显示在这里。</span></div> : null}
              </section>
            </section>
          ) : detailModel ? (
            <section className="model-detail">
              <header className="topbar">
                <div>
                  <h1>{detailModel.name}</h1>
                  <p>{detailModel.provider} · {detailModel.capability} 模型测试与体验</p>
                </div>
                <div className="topbar-actions">
                  <button className="ghost-btn" onClick={() => setModelView(experienceSource ? { mode: 'runs' } : { mode: 'list' })}>{experienceSource ? '返回执行流水' : '返回模型列表'}</button>
                </div>
              </header>
              <article className="model-card detail-card">
                <div className="model-card-head">
                  <div>
                    <h2>调用体验</h2>
                    <span>以下参数只作用于本次请求，不会写入模型静态配置。</span>
                  </div>
                </div>
                <div className="experience-contract" aria-label="配置边界">
                  <span><Settings size={15} />模型管理<strong>连接与鉴权</strong></span>
                  <ChevronRight size={17} />
                  <span className="active"><SlidersHorizontal size={15} />调用体验<strong>本次生成参数</strong></span>
                </div>
                {experienceSource ? (
                  <aside className="experience-source" aria-label="流水参数来源">
                    <div><Activity size={17} /><span><strong>已载入执行流水</strong><small>{experienceSource.record.workflowName || '模型体验页'} · {experienceSource.record.nodeName || experienceSource.record.id}</small></span></div>
                    <p>参数与已有产物已带入下方，可直接查看、调整后再次调用。</p>
                    {experienceSource.omittedFields.length ? <p className="experience-source-warning">出于安全与存储限制，{experienceSource.omittedFields.join('、')}中的大体积素材未保留，请重新上传。</p> : null}
                  </aside>
                ) : null}
                <label className="experience-prompt"><span className="experience-field-title"><strong>{detailModel.capability === 'audio' ? '合成台词' : '提示词'}<em>{detailModel.capability === 'audio' ? '必填' : '选填'}</em></strong><code>prompt</code></span><textarea rows={6} value={detailModel.testInput} placeholder={detailModel.provider === 'Kling' && detailModel.capability === 'video' ? '留空时使用默认值：让画面自然运动。' : undefined} onChange={(event) => updateModel(detailModel.id, { testInput: event.target.value })} />{detailReferenceImages.length ? <span className="experience-prompt-references"><em>插入素材引用</em>{detailReferenceImages.map((_, index) => <button type="button" key={index} onClick={(event) => { event.preventDefault(); insertExperienceReference(detailModel, index) }}>@参考附件{index + 1}</button>)}</span> : null}</label>
                {renderExperienceParameters(detailModel)}
                <div className="experience-actions"><span>提交后会自动跟踪任务，生成结果可直接预览和下载。</span><button className="primary-btn" disabled={modelTestRuns[detailModel.id]?.phase === 'submitting' || modelTestRuns[detailModel.id]?.phase === 'processing'} onClick={() => testModel(detailModel)}>{modelTestRuns[detailModel.id]?.phase === 'submitting' || modelTestRuns[detailModel.id]?.phase === 'processing' ? <LoaderCircle className="run-status-spinner" size={17} /> : <FlaskConical size={17} />}{modelTestRuns[detailModel.id]?.phase === 'submitting' ? '正在提交' : modelTestRuns[detailModel.id]?.phase === 'processing' ? '生成中' : '发起测试调用'}</button></div>
                {renderExperienceResult(detailModel)}
              </article>
            </section>
          ) : (
            <section className="model-detail">
              <button className="ghost-btn" onClick={() => setModelView({ mode: 'list' })}>返回模型列表</button>
            </section>
          )}
        </section>
      )}
    </main>
  )
}

export default App
