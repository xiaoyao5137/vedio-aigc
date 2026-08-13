import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
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
} from 'lucide-react'
import './App.css'
import { DEFAULT_CODE_NODE_SCRIPT, SANGUO_CHARACTER_LOOKUP_CODE, SANGUO_CONTEXT_INIT_CODE, SANGUO_FIRST_FRAME_BRANCH_CODE, SANGUO_REUSE_TAIL_CODE, SANGUO_TAIL_FRAME_CODE } from './code-node-presets'
import CharacterLibrary from './CharacterLibrary'
import { isSharedCredentialKey, sharedCredentialModelIds, syncSharedModelCredentials } from './model-config'
import { inspectExperienceResponse, modelExperienceFields, parseModelExperienceParams, restoreModelExperienceRequest } from './model-experience'
import type { ExperienceField, ExperienceMedia, ExperienceResponseInspection, ExperienceValue } from './model-experience'
import { aggregateLoopOutputs, applyNodeOutputToContext, buildVariableMetadata, canAdvanceStep, containsUnicodeReplacementCharacter, extractTextResponse, normalizeStructuredTextOutput, resolveVariableMetadata, scopedLoopNodes, shouldRunNode, shouldSkipStep, validateHistoricalStructuredOutput } from './workflow-core'

type NodeKind = 'input' | 'image' | 'video' | 'text' | 'code' | 'loop' | 'internet' | 'validation' | 'knowledge' | 'asset' | 'audio' | 'compose'
type ParamType = 'text' | 'number' | 'boolean' | 'image' | 'images' | 'json'
type ModelCapability = 'text' | 'image' | 'video' | 'audio'
type ModelProvider = 'Anthropic' | 'OpenAI' | 'Ofox' | 'Kling' | 'Local' | 'Custom'
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
}
type WorkflowEdge = { id: string; from: string; to: string }
type Workflow = { id: string; name: string; description: string; nodes: WorkflowNode[]; edges: WorkflowEdge[]; schemaVersion?: number }
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
type NodeRunRequestContext = { workflowId?: string; workflowName?: string; nodeId?: string; nodeName?: string }
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
type WorkflowView = 'list' | 'edit' | 'run'
type RunMode = 'run' | 'step'
type RunnerInspectorTab = 'config' | 'input' | 'output'
type WorkflowDebugState = { stepIndex: number }
type StepTask = { node: WorkflowNode; loopNode?: WorkflowNode; loopItem?: unknown; loopIndex?: number; loopPrevious?: Record<string, unknown>; label?: string }
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
}
type ExecutionState = {
  id: string
  mode: RunMode
  workflowId: string
  workflowName: string
  runtimeInputs: Record<string, unknown>
  nodeRuns: NodeRunState[]
  context: Record<string, unknown>
  logs: string[]
  selectedNodeId?: string
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
type WorkflowDebugSnapshot = {
  steps: NodeRunResult[]
  runs: NodeRunResult[]
  currentRun?: NodeRunResult
  context: Record<string, unknown>
  logs: string[]
}
type GraphDrag =
  | { type: 'node'; nodeId: string; offsetX: number; offsetY: number }
  | { type: 'edge'; from: string; x: number; y: number }
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
  input: { label: '输入节点', icon: ListPlus },
  text: { label: '文本推理节点', icon: Bot },
  image: { label: '图片生成节点', icon: ImageIcon },
  video: { label: '视频生成节点', icon: Clapperboard },
  code: { label: '代码执行节点', icon: Code2 },
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
const DAG_WHEEL_ZOOM_SENSITIVITY = 0.003

const initialModels: ModelConfig[] = [
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

const SANGUO_SCENE_OUTLINE_PROMPT = `你是兼具正史功底、成熟电视剧编剧能力和短视频网感的三国历史短剧策划。基于运行时从互联网取得的史料原文，为《\${input.episode_title}》规划叙事完整、数量与时长均由史事复杂度决定的连续短镜头。成片必须让观众是在“追剧”，而不是听史料摘要或观看按时间顺序排列的历史事件。

只返回一个 JSON 对象，不要 Markdown、解释或代码围栏。字段和类型必须严格如下：
{
  "episodeTitle": "本集标题",
  "scenes": [
    {
      "id": "scene-01",
      "sequence": 1,
      "title": "镜头标题",
      "purpose": "本镜头的叙事任务与可见动作",
      "historicalBasis": "[史料1] 对应史料所支持的事实",
      "adaptationBoundary": "正史未载、仅作合理戏剧化的内容",
      "targetDuration": 5,
      "continuityFromPrevious": false
    }
  ]
}

硬性规则：
1. 根据本集史料的事件数量、人物行动、转折和收束，自主判断 scenes 数量；不得套用固定镜头数。sequence 从 1 连续递增，id 唯一。系统会在剧情生成后按实际 scenes 数组自动计算场景数和总时长，无需输出 count 或 totalDuration。
2. targetDuration 只能是 5 或 10；根据每个事件的叙事需要自行决定，不预设整集时长。
3. 第一镜 continuityFromPrevious 必须为 false；只有时空、人物动作和构图确实连续时，后续镜头才可为 true。
4. historicalBasis 必须用“[史料N]”引用下方实际史料，不得把《三国演义》或合理拟制写成正史。
5. 每个镜头必须有明确可拍摄动作，整体形成起承转合，并以史实节点或下一集悬念收束。
6. 开篇优先使用反常动作、迫近危机、人物困境、身份反差或信息差迅速制造钩子；中段持续安排欲望与阻力、试探与反制、误判与后果，避免“某人做了某事、随后又发生某事”的历史直叙。
7. 剧情必须兼具网感、趣味感、剧情感和电视剧吸睛性。网感来自节奏、反差、悬念、回扣、情绪爆点和便于传播的记忆点，不得硬塞现代网络热梗、现代词汇、出戏段子或低俗戏说；趣味优先来自人物性格碰撞、处境反差、言外之意和有代价的机锋。
8. 每个具名角色的决定、动作、说话策略和关系张力必须符合正史及可靠注本记载的性格、身份、年龄阶段和政治处境；先从史料中提炼本集可见的性格证据，再将其转化为行动。不得把所有角色写成同一种忠勇、沉稳或慷慨腔调，也不得用后世定型印象覆盖其当时状态。
9. purpose 不写抽象说明或史料摘要，必须同时写清“谁想达成什么—受到什么阻力—采取什么可见行动—产生什么戏剧变化/悬念”，并体现本镜头的角色性格与观众情绪价值。
10. 合理戏剧化只能补足对白、微动作、场面调度和史料留白，不得虚构改变历史因果、胜负归属、人物核心立场或时代常识的桥段；所有拟制内容明确写入 adaptationBoundary。

史料引用清单：
\${historical_sources.citations}

史料原文：
\${historical_sources.text}`

const SANGUO_STORYBOARD_PROMPT = `你是兼具电视剧叙事、短视频节奏和历史人物塑造能力的竖屏三国短剧分镜师。把本集《\${input.episode_title}》的当前场景“\${scene.title}”改写成一个可直接执行、开镜即有戏的视频短分镜，而不是把 scene.purpose 换一种说法复述。

只返回一个 JSON 对象，不要 Markdown、解释或代码围栏。字段和类型必须严格如下：
{
  "id": "scene-01",
  "title": "镜头标题",
  "duration": 5,
  "characters": ["本镜头实际出镜的人物姓名"],
  "visualPrompt": "完整的竖屏9:16真人历史电影画面提示",
  "camera": "景别、焦段与运镜",
  "mood": "低饱和写实氛围",
  "firstFrameMode": "generate",
  "firstFramePrompt": "需要新生成首帧时使用的完整提示",
  "lastFramePrompt": "本镜头结束构图的完整提示，用于衔接下一镜",
  "videoPrompt": "从首帧到尾帧的动作、运镜、物理约束与声音设计",
  "audioType": "旁白",
  "audioText": "旁白或角色名：对白",
  "historicalBasis": "[史料1] 对应史料依据",
  "adaptationBoundary": "本镜头合理拟制的边界"
}

硬性规则：
1. duration 必须等于当前场景 targetDuration，且只能是 5 或 10。
2. characters 只列画面中真实出镜的具名人物；群演不入列，不得为了复用已有资产增添人物。
3. firstFrameMode 只能是 "generate" 或 "reuse_previous_tail"。第一镜必须 generate；仅当 scene.continuityFromPrevious 为 true 且前镜尾帧可直接作为本镜起点时才可 reuse_previous_tail。
4. 画面须为真人实景、东汉服化道准确、低饱和土褐/黛青/暗红色调、自然日光或油灯火把；禁止卡通、动漫、游戏 CG、玄幻光效、AI 塑料感、现代物件、字幕和水印。
5. 同一人物跨镜头必须保持脸型、年龄、发式、胡须、服装主色和体型一致。模型画面不生成文字；年月、地名和史实说明留给后期。
6. historicalBasis 必须保留当前场景的史料编号；具体对白、微动作和正史未载过程写入 adaptationBoundary。
7. 一个短分镜只聚焦一个强动作或一次关系变化。首帧就交代冲突、异常、压迫或关键道具，结尾必须形成反应、反转、代价、未答问题或可衔接下一镜的视觉钩子；禁止站桩念史、流水账旁白和没有对手反应的单向陈述。
8. 每个具名角色都必须按史料记载的性格和本集所处人生阶段来行动与表达：用选择、目光、停顿、抢话、试探、克制、威压、迟疑或反制外化性格，不用旁白直接贴“足智多谋、忠勇”等标签，不套用《三国演义》或后世脸谱替代史料依据。
9. audioType 只标记主要人声类型，只能精确填写“旁白”或“对白”；即使镜头包含环境声、动作声或音乐，也不得写成“旁白+环境音”等组合值。audioText 要像电视剧台词而非史书翻译：对白须有对象、目的、潜台词和对方压力，允许克制机锋、反差或回扣；旁白只补画面无法表达的关键信息。语言凝练、符合时代语境和身份差异，不得使用现代网络词、流行梗、官腔解说或无依据名言。videoPrompt 必须同时写清普通话对白/旁白、环境声和动作声，使视频模型一次生成同步画面与声音。
10. 网感与趣味必须服务剧情：通过快进入、强信息差、人物关系张力、意外但合理的反应和可传播记忆点实现；不得把历史人物降格成现代段子手，不得为搞笑破坏人物尊严、史实因果或整体历史质感。
11. visualPrompt、camera、firstFramePrompt、lastFramePrompt 和 videoPrompt 必须共同落实上述戏剧动作与人物反应，镜头设计要突出权力距离、关系变化和情绪落点，不能只写通用的“缓慢推进、人物严肃”；camera 与 audioText 的完整内容都必须落实进 videoPrompt，而不是依赖视频模型的非标准扩展参数。

当前场景：\${scene}

史料原文：
\${historical_sources.text}`

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
    childIds: ['sanguo-shot-script', 'sanguo-character-lookup', 'sanguo-character-image', 'sanguo-first-frame-branch', 'sanguo-first-frame', 'sanguo-first-frame-tail', 'sanguo-video', 'sanguo-last-frame'],
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
    prompt: SANGUO_STORYBOARD_PROMPT,
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
    id: 'sanguo-character-image',
    title: '人物图片生成',
    kind: 'image',
    modelId: 'local-image-simulator',
    resultVar: 'character_assets',
    prompt: '${character_lookup.imageRequest.prompt}',
    runIf: { path: 'character_lookup.shouldGenerate', equals: true },
    params: [
      { id: 'sg-ci-refs', name: '参考图', englishName: 'referenceImages', type: 'images', required: false, value: '${character_lookup.imageRequest.referenceImages}' },
      { id: 'sg-ci-size', name: '尺寸', englishName: 'size', type: 'text', required: true, value: '${character_lookup.imageRequest.size}' },
      { id: 'sg-ci-count', name: '生成数量', englishName: 'n', type: 'number', required: true, value: '${character_lookup.imageRequest.n}' },
    ],
    uploads: [],
    loop: defaultLoop(),
    parentId: 'sanguo-scene-loop',
    position: { x: 2050, y: 60 },
  },
  {
    id: 'sanguo-first-frame-branch',
    title: '首帧生成分支',
    kind: 'code',
    resultVar: 'first_frame_branch',
    prompt: '判断当前镜头需要生成新首帧，还是直接截取并复用前镜尾帧。',
    code: SANGUO_FIRST_FRAME_BRANCH_CODE,
    params: [],
    uploads: [],
    loop: defaultLoop(),
    parentId: 'sanguo-scene-loop',
    position: { x: 2330, y: 60 },
  },
  {
    id: 'sanguo-first-frame',
    title: '首帧图生成',
    kind: 'image',
    modelId: 'local-image-simulator',
    resultVar: 'first_frame',
    prompt: '${first_frame_branch.imageRequest.prompt}',
    runIf: { path: 'first_frame_branch.shouldGenerate', equals: true },
    params: [
      { id: 'sg-ff-refs', name: '参考图', englishName: 'referenceImages', type: 'images', required: false, value: '${first_frame_branch.imageRequest.referenceImages}' },
      { id: 'sg-ff-size', name: '尺寸', englishName: 'size', type: 'text', required: true, value: '${first_frame_branch.imageRequest.size}' },
    ],
    uploads: [],
    loop: defaultLoop(),
    parentId: 'sanguo-scene-loop',
    position: { x: 2610, y: -80 },
  },
  {
    id: 'sanguo-first-frame-tail',
    title: '首帧图截取尾帧',
    kind: 'code',
    resultVar: 'first_frame',
    prompt: '将前镜尾帧作为当前镜头首帧，不调用图片模型。',
    code: SANGUO_REUSE_TAIL_CODE,
    runIf: { path: 'first_frame_branch.shouldReusePreviousTail', equals: true },
    params: [],
    uploads: [],
    loop: defaultLoop(),
    parentId: 'sanguo-scene-loop',
    position: { x: 2610, y: 200 },
  },
  {
    id: 'sanguo-video',
    title: '图生视频',
    kind: 'video',
    modelId: 'local-video-simulator',
    resultVar: 'video_shot',
    prompt: '${shot_script.videoPrompt}\n运镜：${shot_script.camera}\n声音类型：${shot_script.audioType}\n同期声音与台词：${shot_script.audioText}',
    params: [
      { id: 'sg-v-image', name: '首帧参考图', englishName: 'referenceImage', type: 'image', required: true, value: '${first_frame.url}' },
      { id: 'sg-v-duration', name: '时长', englishName: 'duration', type: 'number', required: true, value: '${shot_script.duration}' },
      { id: 'sg-v-mode', name: '生成模式', englishName: 'mode', type: 'text', required: true, value: 'std' },
      { id: 'sg-v-sound', name: '原生音频', englishName: 'sound', type: 'text', required: true, value: 'on' },
      { id: 'sg-v-negative', name: '负向提示词', englishName: 'negativePrompt', type: 'text', required: false, value: '画面闪烁、人物变形、身份漂移、服饰突变、现代物件、字幕、水印、卡通、动漫、游戏CG、玄幻光效、AI塑料感' },
    ],
    uploads: [],
    loop: defaultLoop(),
    parentId: 'sanguo-scene-loop',
    position: { x: 2890, y: 60 },
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
    position: { x: 3170, y: 60 },
  },
  {
    id: 'sanguo-verify',
    title: '史料引用与改编边界检查',
    kind: 'validation',
    operation: 'history.verify',
    resultVar: 'historical_verification',
    prompt: '确定性检查：核对每个短分镜的史料编号、改编边界、5/10 秒时长，并与剧情规划实际产出的镜头数和总时长一致；不调用大模型。',
    params: [
      { id: 'sg-check-citations', name: '史料引用', englishName: 'citations', type: 'json', required: true, value: '${historical_sources.citations}' },
      { id: 'sg-check-shots', name: '分镜', englishName: 'shots', type: 'json', required: true, value: '${shot_script.items}' },
      { id: 'sg-check-policy', name: '改编规则', englishName: 'policy', type: 'text', required: true, value: '${input.adaptation_policy}' },
      { id: 'sg-check-scene-count', name: '剧情规划镜头数', englishName: 'expectedSceneCount', type: 'number', required: true, value: '${scene_outline.count}' },
      { id: 'sg-check-duration', name: '剧情规划总时长', englishName: 'expectedTotalDuration', type: 'number', required: true, value: '${scene_outline.totalDuration}' },
    ],
    uploads: [],
    loop: defaultLoop(),
    position: { x: 3450, y: 160 },
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
      { id: 'sg-m-resolution', name: '分辨率', englishName: 'resolution', type: 'text', required: true, value: '1080x1920' },
      { id: 'sg-m-format', name: '格式', englishName: 'format', type: 'text', required: true, value: 'mp4' },
    ],
    uploads: [],
    loop: defaultLoop(),
    position: { x: 3730, y: 160 },
  },
]

const sanguoEdges: WorkflowEdge[] = [
  { id: 'sg-e-input-context', from: 'sanguo-input', to: 'sanguo-context-init' },
  { id: 'sg-e-context-k', from: 'sanguo-context-init', to: 'sanguo-knowledge' },
  { id: 'sg-e-k-so', from: 'sanguo-knowledge', to: 'sanguo-scene-outline' },
  { id: 'sg-e-so-loop', from: 'sanguo-scene-outline', to: 'sanguo-scene-loop' },
  { id: 'sg-e-loop-shot', from: 'sanguo-scene-loop', to: 'sanguo-shot-script' },
  { id: 'sg-e-shot-lookup', from: 'sanguo-shot-script', to: 'sanguo-character-lookup' },
  { id: 'sg-e-lookup-image', from: 'sanguo-character-lookup', to: 'sanguo-character-image' },
  { id: 'sg-e-image-branch', from: 'sanguo-character-image', to: 'sanguo-first-frame-branch' },
  { id: 'sg-e-branch-generate', from: 'sanguo-first-frame-branch', to: 'sanguo-first-frame' },
  { id: 'sg-e-branch-tail', from: 'sanguo-first-frame-branch', to: 'sanguo-first-frame-tail' },
  { id: 'sg-e-generate-video', from: 'sanguo-first-frame', to: 'sanguo-video' },
  { id: 'sg-e-tail-video', from: 'sanguo-first-frame-tail', to: 'sanguo-video' },
  { id: 'sg-e-video-last-frame', from: 'sanguo-video', to: 'sanguo-last-frame' },
  { id: 'sg-e-last-frame-verify', from: 'sanguo-last-frame', to: 'sanguo-verify' },
  { id: 'sg-e-verify-compose', from: 'sanguo-verify', to: 'sanguo-compose' },
]

const initialWorkflows: Workflow[] = [
  {
    id: 'wf-sanguo-history-drama',
    schemaVersion: 16,
    name: '三国原著史料短剧（分步生成）',
    description: '输入只需选择集数；短分镜通过提示词直接引用上下文，代码节点处理人物与首尾帧连续性，图生视频节点按标准参数一次生成画面与原生音频。',
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

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const nestedError = data.body && typeof data.body === 'object' ? data.body.error : undefined
    throw new Error(data.error ?? nestedError ?? `HTTP ${response.status}`)
  }
  return data as T
}

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
  return requestJson<{ records: ExecutionRecord[] }>(`/api/execution-records?workflowId=${encodeURIComponent(workflowId)}`)
}

function saveExecutionRecord(record: ExecutionRecord) {
  return requestJson<{ ok: boolean; id: string }>('/api/execution-records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ record }),
  })
}

function loadModelExecutionRecords(filters: ModelExecutionFilters) {
  const query = new URLSearchParams()
  Object.entries(filters).forEach(([key, value]) => {
    if (value.trim()) query.set(key, value.trim())
  })
  return requestJson<{ records: ModelExecutionRecord[] }>(`/api/model-executions?${query.toString()}`)
}

function runModelNode(model: ModelConfig, prompt: string, params: Record<string, unknown>, operation?: string, executionContext?: NodeRunRequestContext) {
  return requestJson<{ status: number; body: unknown }>('/api/node-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, params, operation, executionContext }),
  })
}

function runBuiltinNode(operation: string, prompt: string, params: Record<string, unknown>, model?: ModelConfig, executionContext?: NodeRunRequestContext) {
  return requestJson<{ status: number; body: unknown }>('/api/builtin-node-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, prompt, params, model, executionContext }),
  })
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

function stringifyValue(value: unknown) {
  if (Array.isArray(value)) return value.join(', ')
  if (value && typeof value === 'object') return JSON.stringify(value)
  return value === undefined || value === null ? '' : String(value)
}

function interpolate(template: string, context: Record<string, unknown>) {
  return template.replace(/\$\{([^}]+)\}/g, (_, expression: string) => stringifyValue(resolvePath(context, expression.trim())))
}

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
  if (param.type === 'json') return paramValue(param)
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
  const nodesById = new Map(workflow.nodes.map((node) => [node.id, node]))
  const indegree = new Map(workflow.nodes.map((node) => [node.id, 0]))
  const outgoing = new Map<string, WorkflowEdge[]>()
  workflow.edges.forEach((edge) => {
    if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) return
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge])
  })
  const queue = workflow.nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0)
  const ordered: WorkflowNode[] = []
  while (queue.length) {
    const node = queue.shift()
    if (!node) continue
    ordered.push(node)
    ;(outgoing.get(node.id) ?? []).forEach((edge) => {
      const nextValue = (indegree.get(edge.to) ?? 0) - 1
      indegree.set(edge.to, nextValue)
      if (nextValue === 0) {
        const next = nodesById.get(edge.to)
        if (next) queue.push(next)
      }
    })
  }
  return { ordered: ordered.length === workflow.nodes.length ? ordered : workflow.nodes, hasCycle: ordered.length !== workflow.nodes.length }
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
  const prompt = interpolate(node.prompt, localContext)
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
  return scopedLoopNodes(workflow, loopNodeId, ordered)
}

function getLoopItems(context: Record<string, unknown>, loopNode: WorkflowNode) {
  const source = resolvePath(context, loopNode.loop.sourcePath)
  return Array.isArray(source) ? source : Array.from({ length: loopNode.loop.fallbackCount }, (_, index) => `片段 ${index + 1}`)
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
  const prompt = interpolate(node.prompt, localContext)
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
  return getExecutionOrder(workflow).ordered.map<NodeRunState>((node, index) => ({
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

function prepareStepRun(state: ExecutionState, index: number) {
  const run = state.nodeRuns[index]
  if (!run) return undefined
  const context = index > 0 ? state.nodeRuns[index - 1]?.context ?? state.context : {}
  const previousLoopResult = run.loopGroupId && (run.loopIndex ?? 0) > 0
    ? Object.fromEntries(state.nodeRuns
        .filter((item) => item.loopGroupId === run.loopGroupId && item.loopIndex === (run.loopIndex ?? 0) - 1 && item.status === 'success')
        .map((item) => [item.node.resultVar, item.output]))
    : run.loopPrevious
  const inputContext = run.loopNode ? {
    ...context,
    [run.loopNode.loop.itemVar]: run.loopItem,
    loop: { index: (run.loopIndex ?? 0) + 1, zeroIndex: run.loopIndex ?? 0, previous: previousLoopResult },
  } : { ...context }
  return { run, context, previousLoopResult, inputContext, inputs: nodeParamValues(run.node, inputContext) }
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
  return /^https?:\/\//i.test(url)
    ? `/api/media-download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`
    : url
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
  const hasContextNode = workflow.nodes.some((node) => node.id === sanguoContextNode.id)
  const hasConfigurableCode = workflow.nodes.some((node) => node.id === sanguoContextNode.id && Boolean(node.code?.trim()))
  const canonicalNodeIds = new Set(sanguoNodes.map((node) => node.id))
  const hasCanonicalOrder = workflow.nodes
    .filter((node) => canonicalNodeIds.has(node.id))
    .every((node, index) => node.id === sanguoNodes[index]?.id)
  const hasV15Topology = workflow.nodes.some((node) => node.id === 'sanguo-knowledge' && node.kind === 'internet' && node.operation === 'internet.retrieve'
      && node.params.every((param) => param.englishName !== 'sourceDetail' && param.englishName !== 'sourceNames'))
    && workflow.nodes.some((node) => node.id === 'sanguo-verify' && node.kind === 'validation' && node.operation === 'history.verify')
    && workflow.nodes.some((node) => node.id === 'sanguo-scene-outline' && node.kind === 'text' && node.params.length === 0)
    && workflow.nodes.some((node) => node.id === 'sanguo-shot-script' && node.kind === 'text' && node.params.length === 0)
    && workflow.nodes.some((node) => node.id === 'sanguo-character-lookup' && node.kind === 'code' && node.operation === 'character.lookup' && node.params.length === 0)
    && workflow.nodes.some((node) => node.id === 'sanguo-character-image' && node.kind === 'image' && !node.operation
      && node.params.every((param) => ['referenceImages', 'size', 'n'].includes(param.englishName ?? '')))
    && workflow.nodes.some((node) => node.id === 'sanguo-first-frame-branch' && node.kind === 'code' && node.params.length === 0)
    && workflow.nodes.some((node) => node.id === 'sanguo-first-frame' && node.kind === 'image' && !node.operation
      && node.params.every((param) => ['referenceImages', 'size'].includes(param.englishName ?? '')))
    && workflow.nodes.some((node) => node.id === 'sanguo-first-frame-tail' && node.kind === 'code' && node.params.length === 0)
    && workflow.nodes.some((node) => node.id === 'sanguo-video' && node.kind === 'video'
      && node.params.length === 5
      && node.params.every((param) => ['referenceImage', 'duration', 'mode', 'sound', 'negativePrompt'].includes(param.englishName ?? '')))
    && workflow.nodes.some((node) => node.id === 'sanguo-last-frame' && node.kind === 'code' && node.params.length === 0 && Boolean(node.code?.trim()))
    && !workflow.nodes.some((node) => node.id === 'sanguo-audio')
    && workflow.edges.some((edge) => edge.from === 'sanguo-video' && edge.to === 'sanguo-last-frame')
    && workflow.edges.some((edge) => edge.from === 'sanguo-last-frame' && edge.to === 'sanguo-verify')
  const usesRealHistoricalModels = workflow.nodes
    .filter((node) => node.id === 'sanguo-scene-outline' || node.id === 'sanguo-shot-script')
    .every((node) => node.modelId === 'claude-opus-4-8')
  const hasDamagedCanonicalText = hasDamagedSanguoCanonicalText(workflow)
  if ((workflow.schemaVersion ?? 1) >= 16 && hasContextNode && hasConfigurableCode && hasV15Topology && hasCanonicalOrder && usesRealHistoricalModels && !hasDamagedCanonicalText) return workflow

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
    'sanguo-character-image',
    'sanguo-first-frame-branch',
    'sanguo-first-frame',
    'sanguo-first-frame-tail',
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
      modelId: node.id === 'sanguo-character-lookup' || node.id === 'sanguo-first-frame-branch' || node.id === 'sanguo-first-frame-tail' || node.id === 'sanguo-last-frame'
        ? undefined
        : node.id === 'sanguo-scene-outline' || node.id === 'sanguo-shot-script'
          ? defaultNode.modelId
          : node.modelId ?? defaultNode.modelId,
      prompt: defaultNode.prompt,
      params: defaultNode.params,
      code: defaultNode.code ?? node.code,
      runIf: defaultNode.runIf,
      loop: defaultNode.loop,
      parentId: defaultNode.parentId,
      childIds: defaultNode.childIds,
      position: defaultNode.position,
    }
  })
  const legacyReplacedNodeIds = new Set(['sanguo-character-plan', 'sanguo-character-assets', 'sanguo-audio'])
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
    schemaVersion: 16,
    description: '输入只需选择集数；短分镜通过提示词直接引用上下文，代码节点处理人物与首尾帧连续性，图生视频节点按标准参数一次生成画面与原生音频。',
    nodes: completedNodes,
    edges: [...preservedCustomEdges, ...sanguoEdges],
  }
}

function normalizeWorkflow(workflow: Workflow): Workflow {
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
      code: node.kind === 'code' ? node.code ?? DEFAULT_CODE_NODE_SCRIPT : node.code,
    })),
    edges: workflow.edges ?? [],
  }
  if (workflow.id === 'wf-sanguo-history-drama') return migrateSanguoWorkflow(base)
  if (workflow.id !== 'wf-story') return base
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
      const key = `${edge.from}->${edge.to}`
      if (edgeKeys.has(key)) return false
      edgeKeys.add(key)
      return true
    })
  return {
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
  }
}

function mergeDefaultModels(stored: ModelConfig[]) {
  const ids = new Set(stored.map((model) => model.id))
  return syncSharedModelCredentials([...stored, ...initialModels.filter((model) => !ids.has(model.id))])
}

function mergeDefaultWorkflows(stored: Workflow[]) {
  const ids = new Set(stored.map((workflow) => workflow.id))
  return [...stored.map(normalizeWorkflow), ...initialWorkflows.filter((workflow) => !ids.has(workflow.id)).map(normalizeWorkflow)]
}

function App() {
  const viewportRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const canvasPanRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const canvasViewRef = useRef({ zoom: 1, x: 0, y: 0 })
  const runnerViewportRef = useRef<HTMLDivElement>(null)
  const runnerPanRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const runnerZoomRef = useRef(1)
  const modelTestAbortRef = useRef<Record<string, AbortController>>({})
  const workflowInfoOpenRef = useRef(false)
  const stepExecutionLockRef = useRef(false)
  const [page, setPage] = useState<'workflow' | 'characters' | 'models'>('workflow')
  const [workflows, setWorkflowsState] = useState<Workflow[]>(initialWorkflows)
  const [models, setModelsState] = useState<ModelConfig[]>(initialModels)
  const [draftModels, setDraftModels] = useState<ModelConfig[]>(initialModels)
  const [activeWorkflowId, setActiveWorkflowId] = useState(workflows[0]?.id ?? '')
  const [selectedNodeId, setSelectedNodeId] = useState(workflows[0]?.nodes[0]?.id ?? '')
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
  const [workflowView, setWorkflowView] = useState<WorkflowView>('list')
  const [workflowInfoOpen, setWorkflowInfoOpen] = useState(false)
  const [workflowInfoDraft, setWorkflowInfoDraft] = useState(() => ({
    name: workflows[0]?.name ?? '',
    description: workflows[0]?.description ?? '',
  }))
  const [workflowInfoError, setWorkflowInfoError] = useState('')
  const [workflowInfoSaving, setWorkflowInfoSaving] = useState(false)
  const [runnerTab, setRunnerTab] = useState<'execute' | 'history'>('execute')
  const [drag, setDrag] = useState<GraphDrag>(null)
  const [isCanvasPanning, setIsCanvasPanning] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [canvasOffset, setCanvasOffset] = useState({ x: 0, y: 0 })
  const [runnerZoom, setRunnerZoom] = useState(1)
  const [storageDiagnostic, setStorageDiagnostic] = useState('')
  const [configLoaded, setConfigLoaded] = useState(false)
  const [configStatus, setConfigStatus] = useState('正在连接 PostgreSQL 配置库...')
  const [runMode, setRunMode] = useState<RunMode>('step')
  const [workflowDebug, setWorkflowDebug] = useState<WorkflowDebugState | null>(null)
  const [runtimePanelOpen, setRuntimePanelOpen] = useState(true)
  const [runnerInspectorTab, setRunnerInspectorTab] = useState<RunnerInspectorTab>('config')
  const activeWorkflow = workflows.find((workflow) => workflow.id === activeWorkflowId) ?? workflows[0]
  const selectedNode = activeWorkflow.nodes.find((node) => node.id === selectedNodeId) ?? activeWorkflow.nodes[0]
  const workflowDebugSnapshot = useMemo(() => (workflowDebug ? createWorkflowDebugSnapshot(activeWorkflow, workflowDebug) : undefined), [activeWorkflow, workflowDebug])
  const [, setRunResult] = useState(() => executeWorkflow(activeWorkflow))
  const [executionState, setExecutionState] = useState<ExecutionState>(() => createExecutionState(activeWorkflow, 'step'))
  const [executionRecords, setExecutionRecords] = useState<ExecutionRecord[]>([])
  const [selectedRunIndex, setSelectedRunIndex] = useState(0)
  const [mediaPreview, setMediaPreview] = useState<MediaPreviewState | null>(null)
  const selectedCapability: ModelCapability | undefined = selectedNode?.kind === 'asset' && selectedNode.operation !== 'character.lookup'
    ? 'image'
    : selectedNode?.kind === 'text' || selectedNode?.kind === 'image' || selectedNode?.kind === 'video' || selectedNode?.kind === 'audio'
      ? selectedNode.kind
      : undefined
  const availableModels = models.filter((model) => selectedCapability && model.capability === selectedCapability)
  const executionOrder = getExecutionOrder(activeWorkflow)
  const debugLoopInfo = workflowDebugSnapshot?.currentRun?.context.loop
  const debugLoopLabel =
    debugLoopInfo && typeof debugLoopInfo === 'object' && 'index' in debugLoopInfo ? `，第 ${String(debugLoopInfo.index)} 轮` : ''
  const graphWidth = Math.max(1300, ...activeWorkflow.nodes.map((node) => node.position.x + 280))
  const graphHeight = Math.max(560, ...activeWorkflow.nodes.map((node) => node.position.y + 180))
  const selectedRun = executionState.nodeRuns[selectedRunIndex] ?? executionState.nodeRuns.find((run) => run.node.id === executionState.selectedNodeId && run.status !== 'idle')
  const runtimeInputNodes = activeWorkflow.nodes.filter((node) => node.kind === 'input')
  const runtimeParamCount = runtimeInputNodes.reduce((count, node) => count + node.params.length, 0)
  const isStepDebugActive = runMode === 'step' && workflowDebug !== null
  const currentStepRun = workflowDebug ? executionState.nodeRuns[workflowDebug.stepIndex] : undefined
  const isStepExecuting = executionState.nodeRuns.some((run) => run.status === 'running')
  const canMoveToNextStep = !isStepExecuting && workflowDebug
    ? canAdvanceStep(currentStepRun?.status, workflowDebug.stepIndex, executionState.nodeRuns.length)
    : false

  const fitGraph = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const nextZoom = Math.min(1, Math.max(0.35, Math.min((viewport.clientWidth - 28) / graphWidth, (viewport.clientHeight - 28) / graphHeight)))
    setZoom(Number(nextZoom.toFixed(2)))
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
    const nextZoom = Math.min(1, Math.max(0.35, Math.min((viewport.clientWidth - 28) / graphWidth, (viewport.clientHeight - 64) / graphHeight)))
    const roundedZoom = Number(nextZoom.toFixed(2))
    runnerZoomRef.current = roundedZoom
    setRunnerZoom(roundedZoom)
    viewport.scrollTo({ left: 0, top: 0 })
  }, [graphWidth, graphHeight])

  const onRunnerWheel = useCallback((event: globalThis.WheelEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const viewport = runnerViewportRef.current
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    const pointerX = event.clientX - rect.left
    const pointerY = event.clientY - rect.top
    const currentZoom = runnerZoomRef.current
    const scaleFactor = Math.exp(-event.deltaY * DAG_WHEEL_ZOOM_SENSITIVITY)
    const nextZoom = Number(Math.min(1.8, Math.max(0.35, currentZoom * scaleFactor)).toFixed(3))
    if (nextZoom === currentZoom) return

    const canvasX = (viewport.scrollLeft + pointerX) / currentZoom
    const canvasY = (viewport.scrollTop + pointerY) / currentZoom
    runnerZoomRef.current = nextZoom
    setRunnerZoom(nextZoom)
    window.requestAnimationFrame(() => {
      viewport.scrollTo({
        left: canvasX * nextZoom - pointerX,
        top: canvasY * nextZoom - pointerY,
      })
    })
  }, [])

  useEffect(() => {
    const viewport = runnerViewportRef.current
    if (!viewport || workflowView !== 'run' || runnerTab !== 'execute') return undefined
    viewport.addEventListener('wheel', onRunnerWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onRunnerWheel)
  }, [onRunnerWheel, runnerTab, workflowView])

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

  useEffect(() => () => {
    Object.values(modelTestAbortRef.current).forEach((controller) => controller.abort())
  }, [])

  useEffect(() => {
    const stored = Object.fromEntries(Object.entries(modelTestRuns).map(([modelId, run]) => [modelId, { ...run, rawBody: undefined }]))
    window.localStorage.setItem(EXPERIENCE_RUNS_STORAGE_KEY, JSON.stringify(stored))
  }, [modelTestRuns])

  const startRunnerPan = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest('.dag-node,.dag-toolbar')) return
    const viewport = runnerViewportRef.current
    if (!viewport) return
    runnerPanRef.current = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop }
  }

  const moveRunnerPan = (event: MouseEvent) => {
    const pan = runnerPanRef.current
    const viewport = runnerViewportRef.current
    if (!pan || !viewport) return
    viewport.scrollLeft = pan.left - (event.clientX - pan.x)
    viewport.scrollTop = pan.top - (event.clientY - pan.y)
  }

  useEffect(() => {
    const id = window.requestAnimationFrame(fitGraph)
    return () => window.cancelAnimationFrame(id)
  }, [activeWorkflow.id, fitGraph])

  useEffect(() => {
    if (workflowView !== 'run' || runnerTab !== 'execute') return undefined
    const id = window.requestAnimationFrame(fitRunnerGraph)
    return () => window.cancelAnimationFrame(id)
  }, [activeWorkflow.id, workflowView, runnerTab, fitRunnerGraph])

  useEffect(() => {
    let cancelled = false
    async function hydrateConfig() {
      try {
        const stored = await loadConfigFromDatabase()
        if (cancelled) return
        const nextModels = mergeDefaultModels(stored.models)
        const nextWorkflows = mergeDefaultWorkflows(stored.workflows)
        const repairedDamagedWorkflowText = stored.workflows.some(hasDamagedSanguoCanonicalText)
        setModelsState(nextModels)
        setDraftModels(nextModels)
        setWorkflowsState(nextWorkflows)
        setActiveWorkflowId(nextWorkflows[0]?.id ?? '')
        setSelectedNodeId(nextWorkflows[0]?.nodes[0]?.id ?? '')
        if (!workflowInfoOpenRef.current) {
          setWorkflowInfoDraft({ name: nextWorkflows[0]?.name ?? '', description: nextWorkflows[0]?.description ?? '' })
          setWorkflowInfoError('')
        }
        setRunResult(executeWorkflow(nextWorkflows[0]))
        setConfigLoaded(true)
        const defaultsAdded = nextModels.length !== stored.models.length || nextWorkflows.length !== stored.workflows.length
        setConfigStatus(stored.models.length || stored.workflows.length
          ? repairedDamagedWorkflowText
            ? 'PostgreSQL 配置已加载，已修复三国工作流中的损坏文本'
            : defaultsAdded
              ? 'PostgreSQL 配置已加载，并补充三国工作流兼容模板'
              : 'PostgreSQL 配置已加载'
          : 'PostgreSQL 空库已写入默认配置')
        if (nextModels.length !== stored.models.length) void saveModelsToDatabase(nextModels)
        if (nextWorkflows.length !== stored.workflows.length || repairedDamagedWorkflowText) void saveWorkflowsToDatabase(nextWorkflows)
      } catch (error) {
        if (cancelled) return
        setConfigStatus(`PostgreSQL 连接失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    void hydrateConfig()
    return () => {
      cancelled = true
    }
  }, [])

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
    if (workflowView !== 'run') return
    void loadExecutionRecords(activeWorkflow.id)
      .then((data) => setExecutionRecords(data.records))
      .catch((error) => setConfigStatus(`执行记录加载失败：${error instanceof Error ? error.message : String(error)}`))
  }, [activeWorkflow.id, workflowView])

  useEffect(() => {
    if (page !== 'models' || modelView.mode !== 'runs') return undefined
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
  }, [modelExecutionFilters, modelExecutionRefresh, modelView.mode, page])

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
    event.preventDefault()
    event.stopPropagation()
    const viewport = viewportRef.current
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    const pointerX = event.clientX - rect.left
    const pointerY = event.clientY - rect.top

    const currentView = canvasViewRef.current
    const scaleFactor = Math.exp(-event.deltaY * DAG_WHEEL_ZOOM_SENSITIVITY)
    const nextZoom = Number(Math.min(1.8, Math.max(0.35, currentView.zoom * scaleFactor)).toFixed(3))
    if (nextZoom === currentView.zoom) return

    const canvasX = (pointerX - currentView.x) / currentView.zoom
    const canvasY = (pointerY - currentView.y) / currentView.zoom
    const nextOffset = {
      x: pointerX - canvasX * nextZoom,
      y: pointerY - canvasY * nextZoom,
    }
    canvasViewRef.current = { zoom: nextZoom, ...nextOffset }
    setZoom(nextZoom)
    setCanvasOffset(nextOffset)
  }, [])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || workflowView !== 'edit') return undefined
    viewport.addEventListener('wheel', onCanvasWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onCanvasWheel)
  }, [onCanvasWheel, workflowView])

  const startCanvasPan = (event: MouseEvent) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.dag-node,.edge-path')) return
    const viewport = viewportRef.current
    if (!viewport) return
    event.preventDefault()
    const offset = canvasViewRef.current
    canvasPanRef.current = { x: event.clientX, y: event.clientY, left: offset.x, top: offset.y }
    setIsCanvasPanning(true)
  }

  const stopCanvasPan = () => {
    canvasPanRef.current = null
    setIsCanvasPanning(false)
    setDrag(null)
  }

  const addWorkflow = () => {
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
  }
  const duplicateWorkflow = () => {
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
        uploads: [...node.uploads],
      })),
      edges: activeWorkflow.edges.map((edge) => ({ id: createId('edge'), from: idMap.get(edge.from) ?? edge.from, to: idMap.get(edge.to) ?? edge.to })),
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
    const operation = kind === 'internet' ? 'internet.retrieve' : kind === 'asset' ? 'character.ensure' : kind === 'validation' ? 'history.verify' : kind === 'compose' ? 'timeline.compose' : undefined
    const node: WorkflowNode = {
      id,
      title: nodeMeta[kind].label,
      kind,
      resultVar: `${kind}_${activeWorkflow.nodes.length + 1}`,
      prompt: kind === 'input' ? '输入 ${name}' : kind === 'code' ? '解析上传的附件，并将结果输出到流程上下文。' : `使用上下文变量生成${nodeMeta[kind].label}`,
      modelId: capability ? models.find((model) => model.capability === capability)?.id : undefined,
      operation,
      code: kind === 'code' ? DEFAULT_CODE_NODE_SCRIPT : undefined,
      outputMode: kind === 'text' ? 'legacy-shots' : undefined,
      params: kind === 'input'
        ? [{ id: createId('param'), name: 'name', englishName: 'name', type: 'text', required: false, value: '' }]
        : kind === 'video'
          ? [
              { id: createId('param'), name: '首帧参考图', englishName: 'referenceImage', type: 'image', required: false, value: '' },
              { id: createId('param'), name: '时长', englishName: 'duration', type: 'number', required: true, value: '5' },
              { id: createId('param'), name: '生成模式', englishName: 'mode', type: 'text', required: true, value: 'std' },
              { id: createId('param'), name: '原生音频', englishName: 'sound', type: 'text', required: false, value: 'off' },
              { id: createId('param'), name: '负向提示词', englishName: 'negativePrompt', type: 'text', required: false, value: '' },
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
      if (selectedNodeId === id) setSelectedNodeId(nodes[0]?.id ?? '')
      return { ...workflow, nodes, edges: workflow.edges.filter((edge) => edge.from !== id && edge.to !== id) }
    })
  const removeEdge = (id: string) => updateActiveWorkflow((workflow) => ({ ...workflow, edges: workflow.edges.filter((edge) => edge.id !== id) }))
  const addEdge = (from: string, to: string) => {
    if (from === to) return
    updateActiveWorkflow((workflow) => {
      if (workflow.edges.some((edge) => edge.from === from && edge.to === to)) return workflow
      return { ...workflow, edges: [...workflow.edges, { id: createId('edge'), from, to }] }
    })
  }

  const onSurfaceMove = (event: MouseEvent) => {
    const pan = canvasPanRef.current
    if (pan) {
      const nextOffset = { x: pan.left + event.clientX - pan.x, y: pan.top + event.clientY - pan.y }
      canvasViewRef.current = { ...canvasViewRef.current, ...nextOffset }
      setCanvasOffset(nextOffset)
      return
    }
    if (!drag) return
    const point = canvasPoint(event)
    if (drag.type === 'edge') setDrag({ ...drag, ...point })
    if (drag.type === 'node') updateNode(drag.nodeId, { position: { x: Math.max(0, point.x - drag.offsetX), y: Math.max(0, point.y - drag.offsetY) } })
  }
  const startNodeDrag = (event: MouseEvent, node: WorkflowNode) => {
    if ((event.target as HTMLElement).closest('.node-action,.port')) return
    const point = canvasPoint(event)
    setSelectedNodeId(node.id)
    setDrag({ type: 'node', nodeId: node.id, offsetX: point.x - node.position.x, offsetY: point.y - node.position.y })
  }
  const startEdgeDrag = (event: MouseEvent, node: WorkflowNode) => {
    event.stopPropagation()
    setSelectedNodeId(node.id)
    setDrag({ type: 'edge', from: node.id, x: node.position.x + 248, y: node.position.y + 62 })
  }
  const finishEdgeDrag = (event: MouseEvent, to: string) => {
    event.stopPropagation()
    if (drag?.type === 'edge') addEdge(drag.from, to)
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
    const nextExecution = createExecutionState(workflow, 'step')
    setExecutionState({ ...nextExecution, selectedNodeId: undefined })
    setSelectedRunIndex(-1)
    setRunResult(executeWorkflow(workflow))
    setRunnerTab('execute')
    setWorkflowView('run')
  }

  const persistExecution = (state: ExecutionState) => {
    const record: ExecutionRecord = {
      id: state.id,
      workflowId: state.workflowId,
      workflowName: state.workflowName,
      mode: state.mode,
      title: `${state.mode === 'step' ? '单步调试' : '完整执行'} · ${new Date().toLocaleString()}`,
      runtimeInputs: state.runtimeInputs,
      result: state,
    }
    setExecutionRecords((current) => [record, ...current.filter((item) => item.id !== record.id)].slice(0, 40))
    void saveExecutionRecord(record).catch((error) => setConfigStatus(`执行记录保存失败：${error instanceof Error ? error.message : String(error)}`))
  }

  const executeFullRun = async () => {
    await runFullWorkflow(activeWorkflow)
  }

  const executeRealTask = async (task: StepTask, context: Record<string, unknown>) => {
    const node = task.node
    if (node.kind === 'input') return runNode(node, context)
    if (node.kind === 'loop') {
      const loopItems = getLoopItems(context, node)
      return { count: loopItems.length, loopSource: node.loop.sourcePath, itemVar: node.loop.itemVar, nodes: getLoopNodes(activeWorkflow, node.id).map((item) => item.title) }
    }
    const currentLoop = context.loop && typeof context.loop === 'object' && !Array.isArray(context.loop) ? context.loop as Record<string, unknown> : {}
    const loopContext = task.loopNode ? {
      [task.loopNode.loop.itemVar]: task.loopItem,
      loop: { ...currentLoop, index: (task.loopIndex ?? 0) + 1, zeroIndex: task.loopIndex ?? 0, previous: task.loopPrevious ?? currentLoop.previous },
    } : {}
    const baseContext = { ...context, ...loopContext, uploads: node.uploads.map((asset) => asset.name) }
    const values = nodeParamValues(node, baseContext)
    if (node.operation === 'character.lookup' || node.operation === 'character.ensure') values.workflowId = activeWorkflow.id
    let codeBindings: Record<string, unknown> = {}
    if (node.kind === 'code' && node.operation === 'character.lookup') {
      const lookupResponse = await runBuiltinNode(node.operation, node.prompt, {
        characters: resolvePath(baseContext, 'shot_script.characters'),
        workflowId: activeWorkflow.id,
      })
      if (lookupResponse.status >= 400) throw new Error(JSON.stringify(lookupResponse.body))
      codeBindings = { character_lookup_result: lookupResponse.body }
    }
    const aliases = nodeParamAliases(node, values)
    const localContext = {
      ...baseContext,
      ...aliases,
      ...codeBindings,
      uploads: node.uploads.map((asset) => asset.name),
    }
    const prompt = interpolate(node.prompt, localContext)
    const executionContext = { workflowId: activeWorkflow.id, workflowName: activeWorkflow.name, nodeId: node.id, nodeName: node.title }
    if (node.kind === 'image' && !node.modelId) return { ...uploadedImageOutput(node), prompt, model: undefined, params: values }
    if (node.kind === 'code') {
      if (!node.code?.trim()) throw new Error(`${node.title} 未配置 JavaScript 代码`)
      const files = await Promise.all(node.uploads.map(materializeUpload))
      const response = await runCodeNode(node.code, prompt, values, files, localContext)
      if (response.status >= 400) throw new Error(JSON.stringify(response.body))
      return response.body && typeof response.body === 'object' ? response.body : { value: response.body }
    }
    const model = models.find((item) => item.id === node.modelId)
    if (node.operation === 'character.ensure' || node.operation === 'frame.first.resolve') {
      if (node.modelId && !model) throw new Error(`${node.title} 配置的模型不存在`)
      const response = await runBuiltinNode(node.operation, prompt, values, model, executionContext)
      if (response.status >= 400) throw new Error(JSON.stringify(response.body))
      return { ...(response.body && typeof response.body === 'object' ? response.body as Record<string, unknown> : { value: response.body }), operation: node.operation }
    }
    if (node.kind === 'internet' || node.kind === 'validation' || node.kind === 'knowledge' || node.kind === 'asset' || node.kind === 'compose') {
      if (!node.operation) throw new Error(`${node.title} 未配置内置 operation`)
      if (node.kind === 'asset' && node.modelId && !model) throw new Error(`${node.title} 配置的模型不存在`)
      const response = await runBuiltinNode(node.operation, prompt, values, model, executionContext)
      if (response.status >= 400) throw new Error(JSON.stringify(response.body))
      return { ...(response.body && typeof response.body === 'object' ? response.body as Record<string, unknown> : { value: response.body }), operation: node.operation }
    }
    if (!model) throw new Error(`${node.title} 未配置模型`)
    const response = await runModelNode(model, prompt, values, node.operation, executionContext)
    if (response.status >= 400) throw new Error(JSON.stringify(response.body))
    const rawBody = response.body
    const body = sanitizeBase64(rawBody)
    if (node.kind === 'text') {
      const text = extractTextResponse(rawBody)
      const normalized = normalizeStructuredTextOutput(rawBody, text, node.outputMode ?? 'legacy-shots')
      const validationContext = node.operation === 'history.storyboard'
        ? { ...values, scene: resolvePath(localContext as Record<string, unknown>, 'scene') }
        : values
      const validated = validateHistoricalStructuredOutput(node.operation, normalized, validationContext)
      return {
        ...(validated && typeof validated === 'object' && !Array.isArray(validated) ? validated : normalized),
        raw: body,
        model: node.modelId,
      }
    }
    const urls = extractMediaUrls(rawBody)
    const url = urls[0] ?? extractFirstUrl(rawBody)
    const rawRecord = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? rawBody as Record<string, unknown> : {}
    const lastFrameUrl = extractFirstUrl(rawRecord.lastFrameUrl ?? rawRecord.last_frame_url ?? rawRecord.last_frame)
    return {
      url,
      ...(node.kind === 'image' ? { urls, items: urls.map((itemUrl) => ({ url: itemUrl })) } : {}),
      ...(lastFrameUrl ? { lastFrameUrl } : {}),
      raw: body,
      prompt,
      params: values,
      model: node.modelId,
    }
  }

  const runFullWorkflow = async (workflow: Workflow) => {
    setRunMode('run')
    setWorkflowDebug(null)
    setRuntimePanelOpen(false)
    const base = createExecutionState(workflow, 'run')
    const validationError = validateRuntimeInputs(workflow)
    if (validationError) {
      setRuntimePanelOpen(true)
      const failed = failInputNodeRuns(base.nodeRuns, validationError)
      const failedState = { ...base, ...failed, selectedNodeId: failed.selectedNodeId }
      setExecutionState(failedState)
      setSelectedRunIndex(failed.selectedRunIndex)
      persistExecution(failedState)
      return
    }
    setExecutionState({ ...base, selectedNodeId: undefined })
    setSelectedRunIndex(-1)
    let nextState = base
    let context: Record<string, unknown> = {}
    let logs: string[] = []
    let nodeRuns: NodeRunState[] = []
    const { ordered } = getExecutionOrder(workflow)
    const skippedLoopChildren = new Set<string>()
    for (const node of ordered) {
      if (skippedLoopChildren.has(node.id)) continue
      const task: StepTask = { node, label: `${node.title} -> ${node.resultVar}` }
      const index = nodeRuns.length
      const inputContext = { ...context }
      const inputs = nodeParamValues(node, inputContext)
      const runningRun: NodeRunState = { id: `${node.id}-${index}`, node, output: undefined, context: { ...context }, inputs, inputContext, label: task.label, status: 'running', durationMs: 0, startedAt: performance.now() }
      nodeRuns = [...nodeRuns, runningRun]
      setExecutionState((current) => ({ ...current, nodeRuns, selectedNodeId: node.id }))
      setSelectedRunIndex(index)
      const startedAt = performance.now()
      try {
        const output = await executeRealTask(task, context)
        context = applyNodeOutputToContext(context, node.resultVar, output)
        logs = [...logs, task.label ?? `${node.title} -> ${node.resultVar}`]
        nodeRuns = nodeRuns.map((run, runIndex) => (runIndex === index ? { ...run, output, context: { ...context }, status: 'success', durationMs: Math.max(1, Math.round(performance.now() - startedAt)) } : run))
        if (node.kind === 'loop' && node.loop.enabled) {
          const loopNodes = getLoopNodes(workflow, node.id)
          const loopItems = getLoopItems(context, node)
          loopNodes.forEach((loopChild) => skippedLoopChildren.add(loopChild.id))
          const loopBaseContext = { ...context }
          const iterationOutputs: Array<Record<string, unknown>> = []
          for (let itemIndex = 0; itemIndex < loopItems.length; itemIndex += 1) {
            const item = loopItems[itemIndex]
            let iterationContext: Record<string, unknown> = {
              ...loopBaseContext,
              [node.loop.itemVar]: item,
              loop: { index: itemIndex + 1, zeroIndex: itemIndex, previous: iterationOutputs.at(-1) },
            }
            const iterationResult: Record<string, unknown> = {}
            for (const loopChild of loopNodes) {
              const childTask: StepTask = { node: loopChild, loopNode: node, loopItem: item, loopIndex: itemIndex, label: `第 ${itemIndex + 1} 轮 / ${loopChild.title} -> ${loopChild.resultVar}` }
              const childIndex = nodeRuns.length
              const childStartedAt = performance.now()
              const childInputContext = { ...iterationContext }
              const childInputs = nodeParamValues(loopChild, childInputContext)
              if (!shouldRunNode(loopChild.runIf, childInputContext)) {
                nodeRuns = [...nodeRuns, { id: `${loopChild.id}-${childIndex}`, node: loopChild, output: { skipped: true, condition: loopChild.runIf }, context: { ...iterationContext }, inputs: childInputs, inputContext: childInputContext, label: childTask.label, status: 'skipped', durationMs: 0 }]
                logs = [...logs, `${childTask.label}（分支条件未命中，已跳过）`]
                setExecutionState((current) => ({ ...current, nodeRuns, context: iterationContext, logs, selectedNodeId: loopChild.id }))
                continue
              }
              nodeRuns = [...nodeRuns, { id: `${loopChild.id}-${childIndex}`, node: loopChild, output: undefined, context: { ...iterationContext }, inputs: childInputs, inputContext: childInputContext, label: childTask.label, status: 'running', durationMs: 0, startedAt: childStartedAt }]
              setExecutionState((current) => ({ ...current, nodeRuns, selectedNodeId: loopChild.id }))
              setSelectedRunIndex(childIndex)
              const childOutput = await executeRealTask(childTask, iterationContext)
              iterationContext = { ...iterationContext, [loopChild.resultVar]: childOutput }
              iterationResult[loopChild.resultVar] = childOutput
              logs = [...logs, childTask.label ?? `${loopChild.title} -> ${loopChild.resultVar}`]
              nodeRuns = nodeRuns.map((run, runIndex) => (runIndex === childIndex ? { ...run, output: childOutput, context: { ...iterationContext }, status: 'success', durationMs: Math.max(1, Math.round(performance.now() - childStartedAt)) } : run))
              setExecutionState((current) => ({ ...current, nodeRuns, context: iterationContext, logs, selectedNodeId: loopChild.id }))
            }
            iterationOutputs.push(iterationResult)
          }
          const aggregateOutputs = aggregateLoopOutputs(iterationOutputs)
          context = {
            ...loopBaseContext,
            ...aggregateOutputs,
            [node.resultVar]: { ...(output as Record<string, unknown>), items: iterationOutputs, count: iterationOutputs.length },
          }
          nodeRuns = nodeRuns.map((run, runIndex) => (runIndex === index ? { ...run, output: context[node.resultVar], context: { ...context } } : run))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logs = [...logs, `${node.title} -> 失败：${message}`]
        nodeRuns = nodeRuns.map((run, runIndex) => (runIndex === index ? { ...run, status: 'failed', error: message, output: { error: message }, context: { ...context, error: message }, durationMs: Math.max(1, Math.round(performance.now() - startedAt)) } : run))
        nextState = { ...base, nodeRuns, context: { ...context, error: message }, logs, selectedNodeId: node.id }
        setExecutionState(nextState)
        setSelectedRunIndex(index)
        persistExecution(nextState)
        return
      }
      nextState = { ...base, nodeRuns, context, logs, selectedNodeId: node.id }
      setExecutionState(nextState)
      setSelectedRunIndex(index)
    }
    persistExecution(nextState)
  }

  const executeStepRun = () => {
    if (stepExecutionLockRef.current) return
    setRunMode('step')
    setRuntimePanelOpen(false)
    setRunnerInspectorTab('config')
    const nodeRuns = createStaticNodeRuns(activeWorkflow)
    const nextState = createExecutionState(activeWorkflow, 'step', nodeRuns)
    const validationError = validateRuntimeInputs(activeWorkflow)
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
    void executeStepIndex(0, nextState)
  }

  const moveWorkflowDebugStep = (direction: -1 | 1) => {
    if (!workflowDebug || !executionState.nodeRuns.length || stepExecutionLockRef.current) return
    if (direction > 0 && !canAdvanceStep(executionState.nodeRuns[workflowDebug.stepIndex]?.status, workflowDebug.stepIndex, executionState.nodeRuns.length)) return
    const nextStepIndex = Math.max(0, Math.min(executionState.nodeRuns.length - 1, workflowDebug.stepIndex + direction))
    const nextState = { stepIndex: nextStepIndex }
    setWorkflowDebug(nextState)
    setRunnerInspectorTab('config')
    setSelectedNodeId(executionState.nodeRuns[nextStepIndex]?.node.id ?? selectedNode.id)
    if (direction > 0 && executionState.nodeRuns[nextStepIndex]?.status === 'idle') {
      void executeStepIndex(nextStepIndex, executionState)
    } else {
      setSelectedRunIndex(nextStepIndex)
    }
  }

  const executeStepIndex = async (requestedIndex: number, requestedState = executionState) => {
    if (stepExecutionLockRef.current) return
    const requestedRun = requestedState.nodeRuns[requestedIndex]
    if (!requestedRun || requestedRun.status !== 'idle') return
    stepExecutionLockRef.current = true
    try {
      let index = requestedIndex
      let baseState = requestedState
      let prepared = prepareStepRun(baseState, index)

      // A route miss is bookkeeping, not a user-visible debug step. Record it and
      // continue to the next runnable node while holding the same execution lock.
      while (prepared && shouldSkipStep(prepared.run.status, prepared.run.node.runIf, prepared.inputContext)) {
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

      if (!prepared || prepared.run.status !== 'idle') {
        const lastIndex = Math.max(0, Math.min(index - 1, baseState.nodeRuns.length - 1))
        setWorkflowDebug({ stepIndex: lastIndex })
        setExecutionState(baseState)
        setSelectedRunIndex(lastIndex)
        persistExecution(baseState)
        return
      }

      const { run, context, previousLoopResult, inputContext, inputs } = prepared
      setWorkflowDebug({ stepIndex: index })
      setSelectedNodeId(run.node.id)
      const startedAt = performance.now()
      const runningRuns = baseState.nodeRuns.map((item, itemIndex) => (itemIndex === index ? { ...item, inputs, inputContext, status: 'running' as NodeRunStatus, startedAt } : item))
      setExecutionState({ ...baseState, nodeRuns: runningRuns, selectedNodeId: run.node.id })
      setSelectedRunIndex(index)
      try {
        const output = await executeRealTask({
          node: run.node,
          label: run.label,
          loopNode: run.loopNode,
          loopItem: run.loopItem,
          loopIndex: run.loopIndex,
          loopPrevious: previousLoopResult,
        }, inputContext)
        let nextContext = applyNodeOutputToContext(inputContext, run.node.resultVar, output)
        let nextRuns = runningRuns.map((item, itemIndex) => (itemIndex === index ? { ...item, output, context: nextContext, status: 'success' as NodeRunStatus, durationMs: Math.max(1, Math.round(performance.now() - startedAt)) } : item))
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
                status: 'idle',
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
        } else if (run.loopGroupId && run.loopIsLast) {
          const completedLoopRuns = nextRuns.filter((item) => item.loopGroupId === run.loopGroupId && item.status === 'success')
          const iterations = new Map<number, Record<string, unknown>>()
          completedLoopRuns.forEach((item) => {
            const iteration = iterations.get(item.loopIndex ?? 0) ?? {}
            iteration[item.node.resultVar] = item.output
            iterations.set(item.loopIndex ?? 0, iteration)
          })
          nextContext = { ...nextContext, ...aggregateLoopOutputs([...iterations.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)) }
          nextRuns = nextRuns.map((item, itemIndex) => itemIndex === index ? { ...item, context: nextContext } : item)
        }
        const logs = [...baseState.logs, run.label ?? `${run.node.title} -> ${run.node.resultVar}`]
        const updated = { ...baseState, nodeRuns: nextRuns, context: nextContext, logs, selectedNodeId: run.node.id }
        setExecutionState(updated)
        persistExecution(updated)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const logs = [...baseState.logs, `${run.node.title} -> 失败：${message}`]
        const nextRuns = runningRuns.map((item, itemIndex) => (itemIndex === index ? { ...item, output: { error: message }, context: { ...context, error: message }, status: 'failed' as NodeRunStatus, error: message, durationMs: Math.max(1, Math.round(performance.now() - startedAt)) } : item))
        const updated = { ...baseState, nodeRuns: nextRuns, context: { ...context, error: message }, logs, selectedNodeId: run.node.id }
        setExecutionState(updated)
        persistExecution(updated)
      }
    } finally {
      stepExecutionLockRef.current = false
    }
  }

  const loadHistoricalExecution = (record: ExecutionRecord) => {
    setRunMode(record.mode)
    setRuntimePanelOpen(false)
    setRunnerInspectorTab('config')
    setExecutionState(record.result)
    setWorkflowDebug(record.mode === 'step' ? { stepIndex: Math.max(0, record.result.nodeRuns.findIndex((run) => run.status === 'idle') - 1) } : null)
    const selectedIndex = record.result.nodeRuns.findIndex((run) => run.node.id === record.result.selectedNodeId && run.status !== 'idle')
    setSelectedRunIndex(selectedIndex)
  }

  const retryFromRunIndex = (index: number) => {
    const validationError = validateRuntimeInputs(activeWorkflow)
    if (validationError) {
      const failed = failInputNodeRuns(executionState.nodeRuns, validationError)
      const failedState = { ...executionState, id: createId('record'), ...failed, selectedNodeId: failed.selectedNodeId }
      setExecutionState(failedState)
      setSelectedRunIndex(failed.selectedRunIndex)
      persistExecution(failedState)
      return
    }
    const baseRuns = executionState.nodeRuns.map((run, runIndex) => (runIndex < index ? run : {
      ...run,
      output: undefined,
      context: {},
      inputs: {},
      inputContext: {},
      status: 'idle' as NodeRunStatus,
      durationMs: 0,
      error: undefined,
      startedAt: undefined,
    }))
    const completedRuns = baseRuns.slice(0, index).filter((run) => run.status === 'success' || run.status === 'skipped')
    const updated = {
      ...executionState,
      id: createId('record'),
      nodeRuns: baseRuns,
      context: completedRuns.at(-1)?.context ?? {},
      logs: completedRuns.map((run) => run.label ?? `${run.node.title} -> ${run.node.resultVar}`),
      selectedNodeId: baseRuns[index]?.node.id,
    }
    setWorkflowDebug({ stepIndex: index })
    setExecutionState(updated)
    setSelectedRunIndex(index)
    void executeStepIndex(index, updated)
  }

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

  const rerunHistoricalExecution = async (record: ExecutionRecord) => {
    const workflow = workflowWithRuntimeInputs(activeWorkflow, record.runtimeInputs)
    updateActiveWorkflow(() => workflow)
    setRunnerTab('execute')
    await runFullWorkflow(workflow)
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
          <input {...commonProps} type={field.control === 'number' ? 'number' : 'text'} min={field.min} max={field.max} step={field.step} />
        )}
        {field.help ? <small>{field.help}</small> : null}
      </label>
    )
  }

  const renderExperienceParameters = (model: ModelConfig) => {
    const fields = modelExperienceFields(model)
    if (!fields.length) return <p className="empty-note">该模型没有额外的单次调用参数，输入提示词后即可测试。</p>
    const groups = [
      { id: 'input', title: '输入素材', description: '本次生成使用的参考素材' },
      { id: 'generation', title: '生成控制', description: '画幅、时长、质量等单次参数' },
      { id: 'advanced', title: '高级调用', description: '分镜、运镜、蒙版和任务回调' },
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
        <label>API Key<input type="password" value={model.settings.apiKey ?? ''} onChange={(e) => updateModelSetting(model.id, 'apiKey', e.target.value)} /></label>
        <label>Endpoint<input value={model.settings.endpoint ?? ''} onChange={(e) => updateModelSetting(model.id, 'endpoint', e.target.value)} /></label>
      </>
    )
  }

  const updateSelectedRunContext = (path: string[], rawValue: string) => {
    let value: unknown = rawValue
    try {
      value = JSON.parse(rawValue)
    } catch {
      value = rawValue
    }
    setExecutionState((current) => ({
      ...current,
      nodeRuns: current.nodeRuns.map((run, index) => (index === selectedRunIndex ? { ...run, context: cloneWithPath(run.context, path, value) as Record<string, unknown> } : run)),
      context: cloneWithPath(current.context, path, value) as Record<string, unknown>,
    }))
  }

  const renderMediaValue = (value: unknown, key = 'media') => {
    if (typeof value === 'string') {
      if (value.startsWith('data:audio/')) return <audio className="result-audio" src={value} controls />
      if (/\.(mp3|wav|m4a|aac|ogg)(\?|$)/i.test(value)) return <audio className="result-audio" src={value} controls />
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
                : <video className="result-media" src={value} controls preload="metadata">当前浏览器不支持视频播放。</video>}
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
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return (
        <div className="context-tree">
          {displayEntries(value as Record<string, unknown>).map(([key, child]) => {
            const label = path.length === 0 ? paramLabels?.get(key) : undefined
            return (
              <details className="context-row" key={[...path, key].join('.')} open={typeof child === 'string' && (isMediaUrl(child) || Boolean(inspectableMediaKind(child, [...metadataPrefix, ...path, key].join('.'))))}>
                <summary>{renderVariableName(key, [...metadataPrefix, ...path, key], label?.chineseName, label?.producerTitle)}</summary>
                {renderContextEditor(child, [...path, key], metadataPrefix, paramLabels, editable)}
              </details>
            )
          })}
        </div>
      )
    }
    if (Array.isArray(value)) {
      return (
        <div className="context-tree">
          {value.map((child, index) => (
            <details className="context-row" key={[...path, String(index)].join('.')} open={typeof child === 'string' && (isMediaUrl(child) || Boolean(inspectableMediaKind(child, [...metadataPrefix, ...path, String(index)].join('.'))))}>
              <summary>{String(index)}</summary>
              {renderContextEditor(child, [...path, String(index)], metadataPrefix, paramLabels, editable)}
            </details>
          ))}
        </div>
      )
    }
    const media = renderMediaValue(value, [...metadataPrefix, ...path].join('.'))
    const textValue = typeof value === 'string' && value.startsWith('data:') ? '[base64 hidden]' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    return (
      <div className="context-value-editor">
        {media}
        <textarea rows={media ? 2 : 4} value={textValue ?? ''} disabled={!editable || typeof value === 'string' && value.startsWith('data:')} onChange={(event) => updateSelectedRunContext(path, event.target.value)} />
      </div>
    )
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
        {node.kind === 'code' && node.code ? (
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
    if (selectedRun.inputContext) return selectedRun.inputContext
    const outputKeys = selectedRun.output && typeof selectedRun.output === 'object' && !Array.isArray(selectedRun.output) ? new Set(Object.keys(selectedRun.output as Record<string, unknown>)) : new Set<string>()
    return Object.fromEntries(
      displayEntries(selectedRun.context).filter(([key]) => key !== selectedRun.node.resultVar && !outputKeys.has(key)),
    )
  }, [selectedRun])
  const selectedRunInputs = selectedRun?.inputs ?? (selectedRun ? nodeParamValues(selectedRun.node, selectedRunInputContext ?? {}) : undefined)
  const selectedRunInputLabels = useMemo(() => {
    if (!selectedRun) return new Map<string, { chineseName: string; producerTitle?: string }>()
    return new Map(selectedRun.node.params.map((param) => {
      const key = paramKey(param)
      const reference = param.value.trim().match(/^\$\{([^}]+)\}$/)?.[1].trim().split('.')
      return [key, { chineseName: param.name, producerTitle: reference ? resolveVariableMetadata(variableMetadata, reference)?.nodeTitle : selectedRun.node.kind === 'input' ? selectedRun.node.title : '节点配置' }]
    }))
  }, [selectedRun, variableMetadata])

  const detailModel = modelView.mode === 'detail' ? draftModels.find((model) => model.id === modelView.modelId) : undefined
  const detailReferenceImages = detailModel && Array.isArray(modelTestParams[detailModel.id]?.referenceImages)
    ? modelTestParams[detailModel.id].referenceImages as string[]
    : []

  return (
    <main className="app-shell">
      <aside className="side-nav">
        <div className="brand"><Sparkles size={22} /><div><strong>短视频生成系统</strong><span>Workflow AIGC Studio</span></div></div>
        <button className={page === 'workflow' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('workflow')}><Layers size={18} />工作流编排</button>
        <button className={page === 'characters' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('characters')}><UsersRound size={18} />人物库</button>
        <button className={page === 'models' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('models')}><Settings size={18} />模型管理</button>
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

      {page === 'characters' ? (
        <CharacterLibrary workflows={workflows.map(({ id, name }) => ({ id, name }))} />
      ) : page === 'workflow' ? (
        workflowView === 'list' ? (
          <section className="workspace">
            <header className="topbar">
              <div>
                <h1>短视频工作流</h1>
                <p>管理和编排视频生成工作流</p>
              </div>
              <button className="primary-btn" onClick={addWorkflow}><Plus size={17} />新建工作流</button>
            </header>
            <div className="workflow-table-card">
              {workflows.map((workflow) => (
                <article key={workflow.id} className="workflow-card">
                  <div>
                    <strong>{workflow.name}</strong>
                    <p>{workflow.description}</p>
                    <span>{workflow.nodes.length} 节点 · {workflow.edges.length} 连线</span>
                  </div>
                  <div className="workflow-card-actions">
                    <button className="ghost-btn" onClick={() => { setActiveWorkflowId(workflow.id); setSelectedNodeId(workflow.nodes[0]?.id ?? ''); setWorkflowInfoDraft({ name: workflow.name, description: workflow.description }); setWorkflowInfoError(''); workflowInfoOpenRef.current = false; setWorkflowInfoOpen(false); setWorkflowDebug(null); setWorkflowView('edit') }}><Pencil size={16} />编辑</button>
                    <button className="primary-btn" onClick={() => openWorkflowRun(workflow)}><Play size={16} />执行</button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : workflowView === 'run' ? (
          <section className="workspace">
            <header className="topbar">
              <div>
                <h1>执行工作流</h1>
                <p>{activeWorkflow.name} · 执行记录 ID：{executionState.id}</p>
              </div>
              <div className="topbar-actions">
                <button className="ghost-btn" onClick={() => setWorkflowView('list')}>返回列表</button>
                <button className="ghost-btn" onClick={() => setWorkflowView('edit')}><Pencil size={17} />编辑编排</button>
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
                    const failed = record.result.nodeRuns.some((run) => run.status === 'failed')
                    const completed = record.result.nodeRuns.filter((run) => run.status === 'success').length
                    return (
                      <article className={record.id === executionState.id ? 'history-row active' : 'history-row'} key={record.id}>
                        <div><strong>{record.title}</strong><small>{record.id}</small></div>
                        <span>{record.mode === 'step' ? '单步调试' : '完整执行'}</span>
                        <span>{failed ? '失败' : `${completed}/${record.result.nodeRuns.length} 成功`}</span>
                        <span>{record.createdAt ? new Date(record.createdAt).toLocaleString() : '刚刚'}</span>
                        <div className="history-row-actions">
                          <button className="ghost-btn" onClick={() => { loadHistoricalExecution(record); setRunnerTab('execute') }}>查看</button>
                          <button className="ghost-btn" onClick={() => void rerunHistoricalExecution(record)}>按参数重跑</button>
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
                    <button className={runMode === 'step' ? 'tab-btn active' : 'tab-btn'} onClick={() => setRunMode('step')}>单步调试</button>
                    <button className={runMode === 'run' ? 'tab-btn active' : 'tab-btn'} onClick={() => setRunMode('run')}>完整执行</button>
                  </div>
                  <div className="runner-control-actions">
                    {runMode === 'run' ? (
                      <button className="primary-btn" onClick={executeFullRun}><Play size={17} />开始完整执行</button>
                    ) : isStepDebugActive ? (
                      <div className="debug-actions">
                        <button className="ghost-btn" onClick={() => moveWorkflowDebugStep(-1)} disabled={!workflowDebug || workflowDebug.stepIndex === 0 || isStepExecuting}><ChevronLeft size={17} />上一步</button>
                        <button className="primary-btn" onClick={() => moveWorkflowDebugStep(1)} disabled={!canMoveToNextStep}>下一步<ChevronRight size={17} /></button>
                        <button className="ghost-btn icon-only" title="使用当前运行参数重新调试" aria-label="重新调试" onClick={executeStepRun} disabled={isStepExecuting}><RotateCcw size={17} /></button>
                      </div>
                    ) : (
                      <button className="primary-btn" onClick={executeStepRun}><Repeat size={17} />开始单步调试</button>
                    )}
                  </div>
                  <button className={runtimePanelOpen ? 'params-toggle active' : 'params-toggle'} aria-expanded={runtimePanelOpen} onClick={() => setRuntimePanelOpen((open) => !open)}>
                    <SlidersHorizontal size={17} />
                    <span>运行参数</span>
                    <strong>{runtimeParamCount}</strong>
                    <ChevronDown className="params-toggle-chevron" size={16} />
                  </button>
                </div>
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
                          {inputNode.params.map((param) => (
                            <label key={param.id}>
                              <span>{param.name} {param.englishName ? `(${param.englishName})` : ''}</span>
                              {param.type === 'json' ? (
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
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </section>

              <section className="runner-panel runner-main">
                <div className="panel-title runner-dag-title">
                  <div><h2>执行 DAG</h2><span>{runMode === 'step' && workflowDebug ? `第 ${workflowDebug.stepIndex + 1} / ${executionState.nodeRuns.length} 步${debugLoopLabel} · 当前：${currentStepRun?.node.title ?? '准备中'}` : `执行顺序 ${executionOrder.ordered.length} 步`}</span></div>
                  <div className="run-state-legend" aria-label="节点状态图例">
                    <span className="current">当前步骤</span>
                    <span className="completed">已完成</span>
                    <span className="pending">待执行</span>
                  </div>
                </div>
                <div className="runner-dag dag-canvas" ref={runnerViewportRef} onMouseDown={startRunnerPan} onMouseMove={moveRunnerPan} onMouseUp={() => { runnerPanRef.current = null }} onMouseLeave={() => { runnerPanRef.current = null }}>
                  <div className="dag-toolbar">
                    <button className="ghost-btn zoom-fit" onClick={fitRunnerGraph}>适配</button>
                    <span className="zoom-value">{Math.round(runnerZoom * 100)}%</span>
                  </div>
                  <div className="dag-zoom-layer" style={{ width: graphWidth * runnerZoom, height: graphHeight * runnerZoom }}>
                    <div className="dag-surface" style={{ width: graphWidth, height: graphHeight, transform: `scale(${runnerZoom})` }}>
                      <svg className="dag-lines" width={graphWidth} height={graphHeight}>
                        <defs><marker id="runner-arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#78909c" /></marker></defs>
                        {activeWorkflow.edges.map((edge) => {
                          const from = activeWorkflow.nodes.find((node) => node.id === edge.from)
                          const to = activeWorkflow.nodes.find((node) => node.id === edge.to)
                          if (!from || !to) return null
                          const startX = from.position.x + 248, startY = from.position.y + 62, endX = to.position.x, endY = to.position.y + 62
                          const mid = Math.max(48, Math.abs(endX - startX) / 2)
                          return <path key={edge.id} d={`M ${startX} ${startY} C ${startX + mid} ${startY}, ${endX - mid} ${endY}, ${endX} ${endY}`} fill="none" stroke="#78909c" strokeWidth="2.5" markerEnd="url(#runner-arrow)" />
                        })}
                      </svg>
                      {activeWorkflow.nodes.filter((node) => node.kind === 'loop').map((loopNode) => {
                        const children = getLoopNodes(activeWorkflow, loopNode.id)
                        if (!children.length) return null
                        const minX = Math.min(...children.map((node) => node.position.x))
                        const minY = Math.min(...children.map((node) => node.position.y))
                        const maxX = Math.max(...children.map((node) => node.position.x + 248))
                        const maxY = Math.max(...children.map((node) => node.position.y + 124))
                        return (
                          <div key={loopNode.id} className="loop-container" style={{ left: minX - 20, top: minY - 50, width: maxX - minX + 40, height: maxY - minY + 70 }}>
                            <div className="loop-header"><Repeat size={16} /><strong>{loopNode.title}</strong><span>循环 {loopNode.loop.fallbackCount} 次</span></div>
                          </div>
                        )
                      })}
                      {activeWorkflow.nodes.map((node) => {
                        const Icon = nodeMeta[node.kind].icon
                        const model = models.find((item) => item.id === node.modelId)
                        const nodeRuns = executionState.nodeRuns.filter((run) => run.node.id === node.id)
                        const latestRun = nodeRuns.find((run) => run.status === 'running') ?? nodeRuns.filter((run) => run.status !== 'idle').at(-1) ?? nodeRuns[0]
                        const latestRunIndex = executionState.nodeRuns.findIndex((run) => run.id === latestRun?.id)
                        const fallbackRunIndex = executionState.nodeRuns.findIndex((run) => run.node.id === node.id)
                        const runIndex = latestRunIndex >= 0 ? latestRunIndex : fallbackRunIndex
                        const status = latestRun?.status ?? 'idle'
                        const isCurrent = selectedRun?.node.id === node.id
                        const isStepCursor = isStepDebugActive && currentStepRun?.node.id === node.id
                        const isStepCurrent = isStepCursor && status !== 'skipped'
                        const isStepCompleted = isStepDebugActive && !isStepCurrent && executionState.nodeRuns.some((run, index) => run.node.id === node.id && run.status === 'success' && index < (workflowDebug?.stepIndex ?? 0))
                        const statusLabel = isStepCurrent ? '当前步骤' : isStepCompleted ? '已完成' : runStatusLabels[status]
                        return (
                          <button className={['dag-node', 'runner-dag-node', node.kind === 'loop' ? 'loop-node' : '', status, isCurrent ? 'selected' : '', isStepCurrent ? 'step-current' : '', isStepCompleted ? 'step-completed' : ''].filter(Boolean).join(' ')} key={node.id} style={{ left: node.position.x, top: node.position.y }} onClick={() => { setSelectedRunIndex(runIndex); setExecutionState((current) => ({ ...current, selectedNodeId: node.id })); setRunnerInspectorTab('config') }}>
                            <span className="dag-node-top"><Icon size={20} /><strong>{node.title}</strong></span>
                            <small>{nodeMeta[node.kind].label}{model ? ` · ${model.name}` : ''}</small>
                            <code>${'{' + node.resultVar + '}'}</code>
                            <span className="run-status-badge">
                              {status === 'running' ? <LoaderCircle className="run-status-spinner" size={14} aria-hidden="true" /> : isStepCurrent ? <Play size={13} /> : status === 'success' ? <CheckCircle2 size={13} /> : status === 'failed' ? <XCircle size={13} /> : null}
                              {statusLabel}{status !== 'idle' ? ` · ${latestRun?.durationMs ?? 0}ms` : ''}
                            </span>
                            {node.kind === 'loop' ? <span className="loop-badge"><Repeat size={13} />循环 {node.loop.fallbackCount}</span> : null}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </div>
              </section>

              <section className="runner-panel runner-context">
                <div className="panel-title runner-context-title">
                <div><span className="inspector-kicker">节点检查</span><h2>{selectedRun?.node.title ?? '选择一个节点'}</h2><p>{selectedRun ? `${isStepDebugActive && currentStepRun?.id === selectedRun.id && selectedRun.status !== 'skipped' ? '当前步骤' : runStatusLabels[selectedRun.status]}${selectedRun.status !== 'idle' ? ` · ${selectedRun.durationMs}ms` : ''}` : '点击 DAG 节点查看配置、输入和输出'}</p></div>
                  {selectedRun && selectedRun.status !== 'idle' ? <button className="ghost-btn" onClick={() => retryFromRunIndex(selectedRunIndex)}>从此节点重试</button> : null}
                </div>
                {selectedRun ? (
                  <>
                    <div className="inspector-tabs" role="tablist" aria-label="节点检查内容">
                      <button className={runnerInspectorTab === 'config' ? 'active' : ''} role="tab" aria-selected={runnerInspectorTab === 'config'} onClick={() => setRunnerInspectorTab('config')}>配置实现</button>
                      <button className={runnerInspectorTab === 'input' ? 'active' : ''} role="tab" aria-selected={runnerInspectorTab === 'input'} onClick={() => setRunnerInspectorTab('input')}>输入 / 上下文</button>
                      <button className={runnerInspectorTab === 'output' ? 'active' : ''} role="tab" aria-selected={runnerInspectorTab === 'output'} onClick={() => setRunnerInspectorTab('output')}>输出</button>
                    </div>
                    <div className="inspector-content" role="tabpanel">
                      {runnerInspectorTab === 'config' ? renderNodeConfiguration(selectedRun.node) : null}
                      {runnerInspectorTab === 'input' ? (
                        selectedRun.status === 'idle'
                          ? <div className="inspector-empty"><strong>还没有输入快照</strong><span>执行到该节点后，这里会显示解析后的节点输入与执行前上下文。</span></div>
                          : <div className="inspector-variable-sections">
                              {selectedRunInputs && displayEntries(selectedRunInputs).length ? (
                                <section className="variable-section">
                                  <div className="variable-section-title"><strong>节点输入</strong><span>{displayEntries(selectedRunInputs).length} 个变量</span></div>
                                  {renderContextEditor(selectedRunInputs, [], [], selectedRunInputLabels, false)}
                                </section>
                              ) : null}
                              {selectedRunInputContext && displayEntries(selectedRunInputContext).length ? (
                                <section className="variable-section">
                                  <div className="variable-section-title"><strong>流程上下文</strong><span>执行前快照</span></div>
                                  {renderContextEditor(selectedRunInputContext)}
                                </section>
                              ) : null}
                              {(!selectedRunInputs || !displayEntries(selectedRunInputs).length) && (!selectedRunInputContext || !displayEntries(selectedRunInputContext).length)
                                ? <div className="inspector-empty"><strong>本节点没有输入变量</strong><span>该节点从空上下文开始执行。</span></div>
                                : null}
                            </div>
                      ) : null}
                      {runnerInspectorTab === 'output' ? (
                        selectedRun.status === 'idle'
                          ? <div className="inspector-empty"><strong>节点尚未执行</strong><span>完成这个步骤后，可在这里检查输出结果。</span></div>
                          : <div className="result-preview variable-section">
                              <div className="variable-section-title output-title">
                                {renderVariableName(selectedRun.node.resultVar, [selectedRun.node.resultVar], selectedRun.node.title, selectedRun.node.title)}
                                <span>节点输出</span>
                              </div>
                              {renderContextEditor(selectedRun.output, [], [selectedRun.node.resultVar], undefined, false)}
                            </div>
                      ) : null}
                    </div>
                  </>
                ) : <div className="inspector-empty standalone"><strong>从 DAG 开始检查</strong><span>所有节点都可以点击，尚未执行的节点也能查看配置实现。</span></div>}
                <details className="run-log-disclosure">
                  <summary>执行日志 <span>{executionState.logs.length}</span></summary>
                  <div className="run-log">{executionState.logs.map((log) => <span key={log}><CheckCircle2 size={15} />{log}</span>)}</div>
                </details>
              </section>
            </div>
            )}
          </section>
        ) : (
        <section className="workspace">
          <header className="topbar">
            <div className="workflow-edit-heading">
              <h1>{activeWorkflow.name}</h1>
              <p>{activeWorkflow.description || '暂无工作流描述'}</p>
            </div>
            <div className="topbar-actions">
              <button className="ghost-btn" onClick={() => setWorkflowView('list')}>返回列表</button>
              <button className="ghost-btn" onClick={openWorkflowInfo} aria-expanded={workflowInfoOpen} aria-controls="workflow-info-editor"><Pencil size={16} />基础信息</button>
              <button className="ghost-btn" onClick={duplicateWorkflow}><Copy size={16} />复制当前工作流</button>
              <button className="primary-btn" onClick={() => openWorkflowRun(activeWorkflow)}><Play size={17} />进入执行</button>
            </div>
          </header>
          {workflowInfoOpen ? (
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
          <div className="workflow-grid">
            <section className="node-palette">
              <h2>画布新增节点</h2>
              {(Object.keys(nodeMeta) as NodeKind[]).map((kind) => { const Icon = nodeMeta[kind].icon; return <button className="palette-item" key={kind} onClick={() => addNode(kind)}><Icon size={18} /><span>{nodeMeta[kind].label}</span><Plus size={16} /></button> })}
            </section>

            <section className="canvas">
              <div className="canvas-header"><div><h2>{activeWorkflow.name}</h2><span>{activeWorkflow.description}</span></div><span>{executionOrder.hasCycle ? '存在循环依赖' : `执行顺序 ${executionOrder.ordered.length} 步`}</span></div>
              <div
                className={`dag-canvas editable-dag${isCanvasPanning ? ' is-panning' : ''}`}
                ref={viewportRef}
                onMouseDown={startCanvasPan}
                onMouseMove={onSurfaceMove}
                onMouseUp={stopCanvasPan}
                onMouseLeave={stopCanvasPan}
                style={{ backgroundPosition: `${canvasOffset.x}px ${canvasOffset.y}px`, backgroundSize: `${24 * zoom}px ${24 * zoom}px` }}
              >
                <div className="dag-zoom-layer editable-zoom-layer">
                <div className="dag-surface" ref={surfaceRef} style={{ width: graphWidth, height: graphHeight, transform: `translate(${canvasOffset.x}px, ${canvasOffset.y}px) scale(${zoom})` }}>
                  <svg className="dag-lines" width={graphWidth} height={graphHeight}>
                    <defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#78909c" /></marker></defs>
                    {activeWorkflow.edges.map((edge) => {
                      const from = activeWorkflow.nodes.find((node) => node.id === edge.from)
                      const to = activeWorkflow.nodes.find((node) => node.id === edge.to)
                      if (!from || !to) return null
                      const startX = from.position.x + 248, startY = from.position.y + 62, endX = to.position.x, endY = to.position.y + 62
                      const mid = Math.max(48, Math.abs(endX - startX) / 2)
                      return <path key={edge.id} className="edge-path" d={`M ${startX} ${startY} C ${startX + mid} ${startY}, ${endX - mid} ${endY}, ${endX} ${endY}`} fill="none" stroke="#78909c" strokeWidth="2.5" markerEnd="url(#arrow)" onClick={() => removeEdge(edge.id)} />
                    })}
                    {drag?.type === 'edge'
                      ? (() => {
                          const from = activeWorkflow.nodes.find((node) => node.id === drag.from)
                          return from ? <path d={`M ${from.position.x + 248} ${from.position.y + 62} L ${drag.x} ${drag.y}`} fill="none" stroke="#166f7a" strokeWidth="2.5" strokeDasharray="6 4" /> : null
                        })()
                      : null}
                  </svg>
                  {activeWorkflow.nodes.filter((node) => node.kind === 'loop').map((loopNode) => {
                    const children = getLoopNodes(activeWorkflow, loopNode.id)
                    if (!children.length) return null
                    const minX = Math.min(...children.map((n) => n.position.x))
                    const minY = Math.min(...children.map((n) => n.position.y))
                    const maxX = Math.max(...children.map((n) => n.position.x + 248))
                    const maxY = Math.max(...children.map((n) => n.position.y + 124))
                    return (
                      <div key={loopNode.id} className="loop-container" style={{ left: minX - 20, top: minY - 50, width: maxX - minX + 40, height: maxY - minY + 70 }}>
                        <div className="loop-header"><Repeat size={16} /><strong>{loopNode.title}</strong><span>循环 {loopNode.loop.fallbackCount} 次</span></div>
                      </div>
                    )
                  })}
                  {activeWorkflow.nodes.map((node) => {
                    const meta = nodeMeta[node.kind]
                    if (!meta) return null
                    const Icon = meta.icon
                    const model = models.find((item) => item.id === node.modelId)
                    const isInLoop = activeWorkflow.nodes.some((candidate) => candidate.kind === 'loop' && getLoopNodes(activeWorkflow, candidate.id).some((child) => child.id === node.id))
                    const isDebugCurrent = workflowDebugSnapshot?.currentRun?.node.id === node.id
                    if (node.kind === 'loop') {
                      return (
                        <article className={['dag-node', 'loop-node', selectedNode?.id === node.id ? 'selected' : '', isDebugCurrent ? 'debug-current' : ''].filter(Boolean).join(' ')} key={node.id} style={{ left: node.position.x, top: node.position.y }} onMouseDown={(e) => startNodeDrag(e, node)} onClick={() => setSelectedNodeId(node.id)}>
                          <button className="port port-in" title="输入连接点" onMouseUp={(e) => finishEdgeDrag(e, node.id)} />
                          <button className="port port-out" title="输出连接点" onMouseDown={(e) => startEdgeDrag(e, node)} />
                          <span className="dag-node-top"><Icon size={20} /><strong>{node.title}</strong><button className="node-action" title="删除节点" onClick={(e) => { e.stopPropagation(); removeNode(node.id) }}><Trash2 size={14} /></button></span>
                          <small>{meta.label}</small>
                          <code>${'{' + node.resultVar + '}'}</code>
                          <span className="loop-badge"><Repeat size={13} />循环 {node.loop.fallbackCount}</span>
                        </article>
                      )
                    }
                    return (
                      <article className={['dag-node', selectedNode?.id === node.id ? 'selected' : '', isDebugCurrent ? 'debug-current' : ''].filter(Boolean).join(' ')} key={node.id} style={{ left: node.position.x, top: node.position.y }} onMouseDown={(e) => startNodeDrag(e, node)} onClick={() => setSelectedNodeId(node.id)}>
                        <button className="port port-in" title="输入连接点" onMouseUp={(e) => finishEdgeDrag(e, node.id)} />
                        <button className="port port-out" title="输出连接点" onMouseDown={(e) => startEdgeDrag(e, node)} />
                        <span className="dag-node-top"><Icon size={20} /><strong>{node.title}</strong><button className="node-action" title="删除节点" onClick={(e) => { e.stopPropagation(); removeNode(node.id) }}><Trash2 size={14} /></button></span>
                        <small>{meta.label}{model ? ` · ${model.name}` : ''}</small>
                        <code>${'{' + node.resultVar + '}'}</code>
                        {isInLoop ? null : node.loop.enabled ? <span className="loop-badge"><Repeat size={13} />循环 {node.loop.fallbackCount}</span> : null}
                      </article>
                    )
                  })}
                </div>
                </div>
              </div>
            </section>

            <section className="inspector">
              <div className="panel-title"><h2>节点属性</h2><button className="icon-btn danger" title="删除节点" onClick={() => removeNode(selectedNode.id)} disabled={activeWorkflow.nodes.length <= 1}><Trash2 size={17} /></button></div>
              <label>节点名称<input value={selectedNode.title} onChange={(event) => updateNode(selectedNode.id, { title: event.target.value })} /></label>
              <label>结果变量名<input value={selectedNode.resultVar} onChange={(event) => updateNode(selectedNode.id, { resultVar: event.target.value })} /></label>
              {selectedCapability ? <label>使用模型<select value={selectedNode.modelId ?? ''} onChange={(event) => updateNode(selectedNode.id, { modelId: event.target.value || undefined })}>{selectedNode.kind === 'image' ? <option value="">手工上传，不调用模型</option> : null}{availableModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label> : null}
              {selectedNode.kind === 'internet' || selectedNode.kind === 'validation' || selectedNode.kind === 'knowledge' || selectedNode.kind === 'asset' || selectedNode.kind === 'compose' || selectedNode.kind === 'text' ? <label>节点操作<input value={selectedNode.operation ?? ''} placeholder="例如 internet.retrieve" onChange={(event) => updateNode(selectedNode.id, { operation: event.target.value || undefined })} /></label> : null}
              {selectedNode.kind === 'text' ? <label>结构化输出<select value={selectedNode.outputMode ?? 'legacy-shots'} onChange={(event) => updateNode(selectedNode.id, { outputMode: event.target.value as TextOutputMode })}><option value="legacy-shots">旧版 shots 数组</option><option value="array">JSON 数组</option><option value="json">JSON 对象</option><option value="text">纯文本</option></select></label> : null}
              <label>{selectedNode.kind === 'code' || selectedNode.kind === 'internet' || selectedNode.kind === 'validation' || selectedNode.kind === 'knowledge' || selectedNode.kind === 'asset' || selectedNode.kind === 'compose' ? '处理说明（内置操作不作为文本模型提示词）' : '提示词 / 模板'}<textarea rows={5} value={selectedNode.prompt} onChange={(event) => updateNode(selectedNode.id, { prompt: event.target.value })} /></label>
              {selectedNode.kind === 'code' ? (
                <div className="code-config">
                  <div className="code-config-title">
                    <strong>JavaScript 代码</strong>
                    <span>可用 ${'{变量路径}'} 占位符、context、顶层上下文变量（如 input）、files、prompt、console 和 excel.parse()。return 中的 contextPatch 会合并进流程上下文。</span>
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
              {selectedNode.kind === 'code' ? (
                <div className="upload-box">
                  <div><strong>附件</strong><span>支持 Excel .xlsx，最大 15MB；上传新附件会替换当前附件。代码可通过 files 和 excel.parse() 读取。</span></div>
                  <label className="upload-btn"><FileSpreadsheet size={16} />上传附件<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { uploadAssets(selectedNode.id, event.target.files); event.currentTarget.value = '' }} /></label>
                  {selectedNode.uploads.length ? <div className="file-upload-list">{selectedNode.uploads.map((asset) => <div className="file-upload-item" key={asset.id}><FileSpreadsheet size={20} /><div><strong>{asset.name}</strong><span>{asset.size ? `${(asset.size / 1024).toFixed(1)} KB` : '随工作流保存'}</span></div><button className="node-action" title="删除附件" onClick={() => removeUpload(selectedNode.id, asset.id)}><Trash2 size={14} /></button></div>)}</div> : <span className="empty-note">尚未上传附件；不调用 excel.parse() 的代码仍可执行。</span>}
                </div>
              ) : null}
              {selectedNode.kind === 'input' || selectedNode.params.length ? <><div className="panel-title compact"><h3>{selectedNode.kind === 'input' ? '入参字段' : '参数配置'}</h3>{selectedNode.kind === 'input' ? <button className="ghost-btn" onClick={addParam}><Plus size={16} />添加</button> : null}</div>
              <div className="param-list">
                {selectedNode.params.map((param) => {
                  const valueLength = Array.from(param.value).length
                  const isValueCapped = valueLength > PARAM_VALUE_VISIBLE_LIMIT
                  return (
                    <div className="param-editor" key={param.id}>
                      <label className="param-field">
                        <span>中文名</span>
                        <input disabled={selectedNode.kind !== 'input'} value={param.name} onChange={(event) => updateParam(selectedNode.id, param.id, { name: event.target.value })} />
                      </label>
                      <label className="param-field">
                        <span>英文名</span>
                        <input disabled={selectedNode.kind !== 'input'} value={param.englishName || ''} onChange={(event) => updateParam(selectedNode.id, param.id, { englishName: event.target.value })} />
                      </label>
                      <label className="param-field param-type-field">
                        <span>类型</span>
                        <select disabled={selectedNode.kind !== 'input'} value={param.type} onChange={(event) => updateParam(selectedNode.id, param.id, { type: event.target.value as ParamType })}><option value="text">文本</option><option value="number">数字</option><option value="boolean">布尔</option><option value="image">单图</option><option value="images">多图</option><option value="json">JSON</option></select>
                      </label>
                      <label className="check-label param-required-field"><input disabled={selectedNode.kind !== 'input'} type="checkbox" checked={param.required} onChange={(event) => updateParam(selectedNode.id, param.id, { required: event.target.checked })} />必填</label>
                      {selectedNode.kind === 'input' ? <button className="icon-btn" title="删除入参" aria-label={`删除入参 ${param.name || param.englishName || ''}`} onClick={() => removeParam(param.id)}><Trash2 size={15} /></button> : null}
                      <label className="param-field param-value-field">
                        <span>参数值</span>
                        <textarea
                          className={isValueCapped ? 'param-value is-capped' : 'param-value'}
                          rows={getParamValueRows(param.value)}
                          value={param.value}
                          onChange={(event) => updateParam(selectedNode.id, param.id, { value: event.target.value })}
                        />
                        {isValueCapped ? <small>超过 50 个字符，已限制默认高度；滚动可查看全部 {valueLength} 个字符。</small> : null}
                      </label>
                    </div>
                  )
                })}
              </div></> : null}
            </section>
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
              <div className="model-tabs">
                {(['text', 'image', 'video', 'audio'] as ModelCapability[]).map((capability) => (
                  <button key={capability} className={modelTab === capability ? 'tab-btn active' : 'tab-btn'} onClick={() => setModelTab(capability)}>
                    {capability === 'text' ? '文本推理模型' : capability === 'image' ? '图片生成模型' : capability === 'video' ? '视频生成模型' : '音频生成模型'}
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
                      <label>Provider<select value={model.provider} onChange={(event) => updateModel(model.id, { provider: event.target.value as ModelProvider })}><option value="Anthropic">Anthropic</option><option value="OpenAI">OpenAI</option><option value="Ofox">Ofox</option><option value="Kling">Kling</option><option value="Local">Local</option><option value="Custom">Custom</option></select></label>
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
                <label className="experience-prompt"><span className="experience-field-title"><strong>提示词<em>选填</em></strong><code>prompt</code></span><textarea rows={6} value={detailModel.testInput} placeholder={detailModel.provider === 'Kling' && detailModel.capability === 'video' ? '留空时使用默认值：让画面自然运动。' : undefined} onChange={(event) => updateModel(detailModel.id, { testInput: event.target.value })} />{detailReferenceImages.length ? <span className="experience-prompt-references"><em>插入素材引用</em>{detailReferenceImages.map((_, index) => <button type="button" key={index} onClick={(event) => { event.preventDefault(); insertExperienceReference(detailModel, index) }}>@参考附件{index + 1}</button>)}</span> : null}</label>
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
