import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent, WheelEvent } from 'react'
import {
  Bot,
  CheckCircle2,
  Clapperboard,
  Copy,
  FlaskConical,
  Image as ImageIcon,
  Layers,
  ListPlus,
  Pencil,
  Play,
  Plus,
  Repeat,
  Settings,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react'
import './App.css'

type NodeKind = 'input' | 'image' | 'video' | 'text'
type ParamType = 'text' | 'number' | 'boolean' | 'image' | 'images' | 'json'
type ModelCapability = 'text' | 'image' | 'video'
type ModelProvider = 'Anthropic' | 'OpenAI' | 'Kling' | 'Custom'

type WorkflowParam = { id: string; name: string; type: ParamType; required: boolean; value: string }
type UploadedAsset = { id: string; name: string; dataUrl: string }
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
}
type WorkflowEdge = { id: string; from: string; to: string }
type Workflow = { id: string; name: string; description: string; nodes: WorkflowNode[]; edges: WorkflowEdge[] }
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
type ModelView = { mode: 'list' } | { mode: 'detail'; modelId: string }
type GraphDrag =
  | { type: 'node'; nodeId: string; offsetX: number; offsetY: number }
  | { type: 'edge'; from: string; x: number; y: number }
  | null

const nodeMeta: Record<NodeKind, { label: string; icon: typeof Pencil }> = {
  input: { label: '输入节点', icon: ListPlus },
  text: { label: '文本推理节点', icon: Bot },
  image: { label: '图片生成节点', icon: ImageIcon },
  video: { label: '视频生成节点', icon: Clapperboard },
}

const createId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`
const defaultLoop = (): LoopConfig => ({ enabled: false, sourcePath: 'script_fragments.items', fallbackCount: 8, itemVar: 'item' })

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
      maxTokens: '300',
      temperature: '0.7',
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
      size: '1024x1024',
      quality: 'high',
      n: '1',
    },
    testInput: '赛博朋克风格的城市夜跑者，霓虹灯，写实摄影',
    testResult: '',
  },
  {
    id: 'keling3',
    name: 'keling3',
    provider: 'Kling',
    capability: 'video',
    settings: {
      endpoint: 'https://api.klingai.com/v1/videos',
      accessKey: '',
      secretKey: '',
      model: 'keling3',
      duration: '5',
      aspectRatio: '9:16',
      mode: 'std',
    },
    testInput: '让夜跑者从镜头左侧跑入，镜头轻微跟随，霓虹反光。',
    testResult: '',
  },
]

const storyNodes: WorkflowNode[] = [
  {
    id: 'node-input',
    title: '项目输入',
    kind: 'input',
    resultVar: 'input',
    prompt: '短视频主题：${topic}，目标平台：${platform}',
    params: [
      { id: 'topic', name: 'topic', type: 'text', required: true, value: '城市夜跑装备推荐' },
      { id: 'platform', name: 'platform', type: 'text', required: true, value: '抖音' },
      { id: 'ratio', name: 'ratio', type: 'text', required: true, value: '9:16' },
    ],
    uploads: [],
    loop: defaultLoop(),
    position: { x: 50, y: 170 },
  },
  {
    id: 'node-fragments',
    title: '8段脚本片段',
    kind: 'text',
    modelId: 'claude-opus-4-8',
    resultVar: 'script_fragments',
    prompt: '基于 ${input.topic} 生成 8 个可独立成镜头的短视频脚本片段。',
    params: [
      {
        id: 'items',
        name: 'items',
        type: 'json',
        required: true,
        value:
          '[\n  "开场展示夜跑场景",\n  "跑鞋缓震特写",\n  "透气衣物细节",\n  "耳机与配速提醒",\n  "反光装备安全提示",\n  "腰包收纳演示",\n  "跑后拉伸恢复",\n  "结尾购买建议"\n]',
      },
    ],
    uploads: [],
    loop: defaultLoop(),
    position: { x: 360, y: 100 },
  },
  {
    id: 'node-image',
    title: '循环生成8张首帧',
    kind: 'image',
    modelId: 'gpt-image-2',
    resultVar: 'first_frames',
    prompt: '为第 ${loop.index} 个脚本片段生成竖版首帧：${item}',
    params: [{ id: 'style', name: 'style', type: 'text', required: true, value: '写实运动广告，夜景霓虹' }],
    uploads: [],
    loop: { enabled: true, sourcePath: 'script_fragments.items', fallbackCount: 8, itemVar: 'item' },
    position: { x: 690, y: 55 },
  },
  {
    id: 'node-video',
    title: '循环生成8个视频分镜',
    kind: 'video',
    modelId: 'keling3',
    resultVar: 'video_shots',
    prompt: '基于 ${item} 和 ${first_frames.items} 生成第 ${loop.index} 个视频分镜。',
    params: [{ id: 'duration', name: 'duration', type: 'number', required: true, value: '3' }],
    uploads: [],
    loop: { enabled: true, sourcePath: 'script_fragments.items', fallbackCount: 8, itemVar: 'item' },
    position: { x: 1030, y: 150 },
  },
]

const initialWorkflows: Workflow[] = [
  {
    id: 'wf-story',
    name: '夜跑短视频分镜生成',
    description: '基于 8 段脚本循环生成 8 张首帧和 8 个视频分镜。',
    nodes: storyNodes,
    edges: [
      { id: 'edge-input-fragments', from: 'node-input', to: 'node-fragments' },
      { id: 'edge-fragments-image', from: 'node-fragments', to: 'node-image' },
      { id: 'edge-fragments-video', from: 'node-fragments', to: 'node-video' },
      { id: 'edge-image-video', from: 'node-image', to: 'node-video' },
    ],
  },
  {
    id: 'wf-cover',
    name: '封面图生成',
    description: '单独生成封面图，可在画布上继续加视频节点。',
    nodes: [
      { ...storyNodes[0], id: 'cover-input', position: { x: 90, y: 180 } },
      { ...storyNodes[2], id: 'cover-image', title: '封面图', resultVar: 'cover_image', loop: defaultLoop(), position: { x: 440, y: 180 } },
    ],
    edges: [{ id: 'cover-edge', from: 'cover-input', to: 'cover-image' }],
  },
]

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
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
  const values = Object.fromEntries(node.params.map((param) => [param.name, paramValue(param)]))
  const localContext = {
    ...context,
    ...values,
    [node.loop.itemVar]: loopItem,
    loop: loopIndex === undefined ? undefined : { index: loopIndex + 1, zeroIndex: loopIndex },
    uploads: node.uploads.map((asset) => asset.name),
  }
  const prompt = interpolate(node.prompt, localContext)
  if (node.kind === 'input') return { ...values, prompt, uploads: node.uploads.map((asset) => asset.name) }
  if (node.kind === 'text') return { ...values, text: `已生成文本：${prompt}`, model: node.modelId }
  if (node.kind === 'image') return { url: node.uploads[loopIndex ?? 0]?.name ?? `${node.resultVar}-${(loopIndex ?? 0) + 1}.png`, prompt, model: node.modelId, params: values }
  return { url: `${node.resultVar}-${(loopIndex ?? 0) + 1}.mp4`, prompt, duration: values.duration, model: node.modelId }
}

function executeWorkflow(workflow: Workflow) {
  const context: Record<string, unknown> = {}
  const logs: string[] = []
  const { ordered, hasCycle } = getExecutionOrder(workflow)
  ordered.forEach((node) => {
    const source = resolvePath(context, node.loop.sourcePath)
    const loopItems = Array.isArray(source) ? source : Array.from({ length: node.loop.fallbackCount }, (_, index) => `片段 ${index + 1}`)
    if ((node.kind === 'image' || node.kind === 'video') && node.loop.enabled) {
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

function readUploads(files: FileList | null, onDone: (assets: UploadedAsset[]) => void) {
  if (!files?.length) return
  Promise.all(
    Array.from(files).map(
      (file) =>
        new Promise<UploadedAsset>((resolve) => {
          const reader = new FileReader()
          reader.onload = () => resolve({ id: createId('asset'), name: file.name, dataUrl: String(reader.result) })
          reader.readAsDataURL(file)
        }),
    ),
  ).then(onDone)
}

function App() {
  const viewportRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState<'workflow' | 'models'>('workflow')
  const [workflows, setWorkflowsState] = useState<Workflow[]>(initialWorkflows)
  const [models, setModelsState] = useState<ModelConfig[]>(initialModels)
  const [draftModels, setDraftModels] = useState<ModelConfig[]>(initialModels)
  const [activeWorkflowId, setActiveWorkflowId] = useState(workflows[0]?.id ?? '')
  const [selectedNodeId, setSelectedNodeId] = useState(workflows[0]?.nodes[0]?.id ?? '')
  const [modelTab, setModelTab] = useState<ModelCapability>('text')
  const [modelView, setModelView] = useState<ModelView>({ mode: 'list' })
  const [drag, setDrag] = useState<GraphDrag>(null)
  const [zoom, setZoom] = useState(1)
  const [storageDiagnostic, setStorageDiagnostic] = useState('')
  const [configLoaded, setConfigLoaded] = useState(false)
  const [configStatus, setConfigStatus] = useState('正在连接 PostgreSQL 配置库...')
  const activeWorkflow = workflows.find((workflow) => workflow.id === activeWorkflowId) ?? workflows[0]
  const selectedNode = activeWorkflow.nodes.find((node) => node.id === selectedNodeId) ?? activeWorkflow.nodes[0]
  const liveResult = useMemo(() => executeWorkflow(activeWorkflow), [activeWorkflow])
  const [runResult, setRunResult] = useState(() => executeWorkflow(activeWorkflow))
  const availableModels = models.filter((model) => selectedNode?.kind !== 'input' && model.capability === selectedNode?.kind)
  const executionOrder = getExecutionOrder(activeWorkflow)
  const graphWidth = Math.max(1300, ...activeWorkflow.nodes.map((node) => node.position.x + 280))
  const graphHeight = Math.max(560, ...activeWorkflow.nodes.map((node) => node.position.y + 180))

  const fitGraph = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const nextZoom = Math.min(1, Math.max(0.35, Math.min((viewport.clientWidth - 28) / graphWidth, (viewport.clientHeight - 64) / graphHeight)))
    setZoom(Number(nextZoom.toFixed(2)))
    viewport.scrollTo({ left: 0, top: 0 })
  }, [graphWidth, graphHeight])

  useEffect(() => {
    const id = window.requestAnimationFrame(fitGraph)
    return () => window.cancelAnimationFrame(id)
  }, [activeWorkflow.id, fitGraph])

  useEffect(() => {
    let cancelled = false
    async function hydrateConfig() {
      try {
        const stored = await loadConfigFromDatabase()
        if (cancelled) return
        const nextModels = stored.models.length ? stored.models : initialModels
        const nextWorkflows = stored.workflows.length ? stored.workflows : initialWorkflows
        setModelsState(nextModels)
        setDraftModels(nextModels)
        setWorkflowsState(nextWorkflows)
        setActiveWorkflowId(nextWorkflows[0]?.id ?? '')
        setSelectedNodeId(nextWorkflows[0]?.nodes[0]?.id ?? '')
        setRunResult(executeWorkflow(nextWorkflows[0]))
        setConfigLoaded(true)
        setConfigStatus(stored.models.length || stored.workflows.length ? 'PostgreSQL 配置已加载' : 'PostgreSQL 空库已写入默认配置')
        if (!stored.models.length) void saveModelsToDatabase(nextModels)
        if (!stored.workflows.length) void saveWorkflowsToDatabase(nextWorkflows)
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

  const setWorkflows = (recipe: (current: Workflow[]) => Workflow[]) => setWorkflowsState((current) => recipe(current))
  const saveSingleModel = async (modelId: string) => {
    const model = draftModels.find((item) => item.id === modelId)
    if (!model) return
    const nextModels = models.map((item) => (item.id === modelId ? model : item))
    const mergedModels = nextModels.some((item) => item.id === modelId) ? nextModels : [...nextModels, model]
    try {
      await saveModelsToDatabase(mergedModels)
      setModelsState(mergedModels)
      setConfigStatus('模型配置已写入 PostgreSQL')
      setStorageDiagnostic(JSON.stringify({ saved: true, storage: 'postgresql', models: getModelStorageSummary([model]) }, null, 2))
    } catch (error) {
      setConfigStatus(`模型配置保存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const updateActiveWorkflow = (recipe: (workflow: Workflow) => Workflow) =>
    setWorkflows((current) => current.map((workflow) => (workflow.id === activeWorkflow.id ? recipe(workflow) : workflow)))
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

  const onCanvasWheel = (event: WheelEvent) => {
    event.preventDefault()
    const direction = event.deltaY > 0 ? -1 : 1
    setZoom((current) => Number(Math.min(1.8, Math.max(0.35, current + direction * 0.08)).toFixed(2)))
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
    setRunResult(executeWorkflow(workflow))
  }
  const duplicateWorkflow = () => {
    const idMap = new Map(activeWorkflow.nodes.map((node) => [node.id, createId('node')]))
    const copy: Workflow = {
      ...activeWorkflow,
      id: createId('wf'),
      name: `${activeWorkflow.name} 副本`,
      nodes: activeWorkflow.nodes.map((node) => ({ ...node, id: idMap.get(node.id) ?? createId('node'), uploads: [...node.uploads] })),
      edges: activeWorkflow.edges.map((edge) => ({ id: createId('edge'), from: idMap.get(edge.from) ?? edge.from, to: idMap.get(edge.to) ?? edge.to })),
    }
    setWorkflows((current) => [...current, copy])
    setActiveWorkflowId(copy.id)
    setSelectedNodeId(copy.nodes[0]?.id ?? '')
  }
  const addNode = (kind: NodeKind, position = { x: 160 + activeWorkflow.nodes.length * 80, y: 140 + (activeWorkflow.nodes.length % 3) * 110 }) => {
    const id = createId('node')
    const node: WorkflowNode = {
      id,
      title: nodeMeta[kind].label,
      kind,
      resultVar: `${kind}_${activeWorkflow.nodes.length + 1}`,
      prompt: kind === 'input' ? '输入 ${name}' : `使用上下文变量生成${nodeMeta[kind].label}`,
      modelId: models.find((model) => model.capability === kind)?.id,
      params: [{ id: createId('param'), name: 'name', type: 'text', required: false, value: '' }],
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
      params: [...selectedNode.params, { id: createId('param'), name: `param_${selectedNode.params.length + 1}`, type: 'text', required: false, value: '' }],
    })
  const removeParam = (paramId: string) => updateNode(selectedNode.id, { params: selectedNode.params.filter((param) => param.id !== paramId) })
  const updateModel = (id: string, patch: Partial<ModelConfig>) => setDraftModels((current) => current.map((model) => (model.id === id ? { ...model, ...patch } : model)))
  const updateModelSetting = (id: string, key: string, value: string) =>
    setDraftModels((current) => current.map((model) => (model.id === id ? { ...model, settings: { ...model.settings, [key]: value } } : model)))
  const addModel = () =>
    setDraftModels((current) => [
      ...current,
      { id: createId('model'), name: `自定义模型 ${current.length + 1}`, provider: 'Custom', capability: modelTab, settings: { endpoint: '', apiKey: '', model: '' }, testInput: '输入测试内容', testResult: '' },
    ])
  const removeModel = (id: string) => setDraftModels((current) => current.filter((model) => model.id !== id))

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

  const testModel = async (model: ModelConfig) => {
    updateModel(model.id, { testResult: '正在测试真实接口...' })
    try {
      const response = await fetch('/api/model-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(model),
      })
      const result = await response.json()
      updateModel(model.id, { testResult: `HTTP ${result.status ?? response.status}\n${JSON.stringify(result.body ?? result, null, 2).slice(0, 1800)}` })
    } catch (error) {
      updateModel(model.id, { testResult: `测试失败：${error instanceof Error ? error.message : String(error)}` })
    }
  }

  const renderModelFields = (model: ModelConfig) => {
    if (model.provider === 'Kling') {
      return (
        <>
          <div className="position-grid"><label>Access Key<input value={model.settings.accessKey ?? ''} onChange={(e) => updateModelSetting(model.id, 'accessKey', e.target.value)} /></label><label>Secret Key<input type="password" value={model.settings.secretKey ?? ''} onChange={(e) => updateModelSetting(model.id, 'secretKey', e.target.value)} /></label></div>
          <label>Endpoint<input value={model.settings.endpoint ?? ''} onChange={(e) => updateModelSetting(model.id, 'endpoint', e.target.value)} /></label>
          <div className="position-grid"><label>Duration<input value={model.settings.duration ?? ''} onChange={(e) => updateModelSetting(model.id, 'duration', e.target.value)} /></label><label>Aspect Ratio<input value={model.settings.aspectRatio ?? ''} onChange={(e) => updateModelSetting(model.id, 'aspectRatio', e.target.value)} /></label></div>
          <label>Mode<input value={model.settings.mode ?? ''} onChange={(e) => updateModelSetting(model.id, 'mode', e.target.value)} /></label>
        </>
      )
    }
    if (model.provider === 'OpenAI' && model.capability === 'image') {
      return (
        <>
          <label>API Key<input type="password" value={model.settings.apiKey ?? ''} onChange={(e) => updateModelSetting(model.id, 'apiKey', e.target.value)} /></label>
          <label>Endpoint<input value={model.settings.endpoint ?? ''} onChange={(e) => updateModelSetting(model.id, 'endpoint', e.target.value)} /></label>
          <div className="position-grid"><label>Size<input value={model.settings.size ?? ''} onChange={(e) => updateModelSetting(model.id, 'size', e.target.value)} /></label><label>Quality<input value={model.settings.quality ?? ''} onChange={(e) => updateModelSetting(model.id, 'quality', e.target.value)} /></label></div>
          <label>N<input value={model.settings.n ?? ''} onChange={(e) => updateModelSetting(model.id, 'n', e.target.value)} /></label>
        </>
      )
    }
    return (
      <>
        <label>API Key<input type="password" value={model.settings.apiKey ?? ''} onChange={(e) => updateModelSetting(model.id, 'apiKey', e.target.value)} /></label>
        <label>Endpoint<input value={model.settings.endpoint ?? ''} onChange={(e) => updateModelSetting(model.id, 'endpoint', e.target.value)} /></label>
        <div className="position-grid"><label>Max Tokens<input value={model.settings.maxTokens ?? ''} onChange={(e) => updateModelSetting(model.id, 'maxTokens', e.target.value)} /></label><label>Temperature<input value={model.settings.temperature ?? ''} onChange={(e) => updateModelSetting(model.id, 'temperature', e.target.value)} /></label></div>
      </>
    )
  }

  const detailModel = modelView.mode === 'detail' ? draftModels.find((model) => model.id === modelView.modelId) : undefined

  return (
    <main className="app-shell">
      <aside className="side-nav">
        <div className="brand"><Sparkles size={22} /><div><strong>短视频生成系统</strong><span>Workflow AIGC Studio</span></div></div>
        <button className={page === 'workflow' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('workflow')}><Layers size={18} />工作流编排</button>
        <button className={page === 'models' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('models')}><Settings size={18} />模型管理</button>
      </aside>

      {page === 'workflow' ? (
        <section className="workspace">
          <header className="topbar"><div><h1>短视频工作流</h1><p>节点可在画布上拖动，拖拽输出点到输入点即可建立依赖；点击连线可删除依赖。</p></div><button className="primary-btn" onClick={() => setRunResult(executeWorkflow(activeWorkflow))}><Play size={17} />执行工作流</button></header>
          <div className="workflow-grid">
            <section className="node-palette">
              <div className="panel-title"><h2>工作流</h2><button className="icon-btn" title="新增工作流" onClick={addWorkflow}><Plus size={16} /></button></div>
              <div className="workflow-list">{workflows.map((workflow) => <button key={workflow.id} className={workflow.id === activeWorkflow.id ? 'workflow-item active' : 'workflow-item'} onClick={() => { setActiveWorkflowId(workflow.id); setSelectedNodeId(workflow.nodes[0]?.id ?? ''); setRunResult(executeWorkflow(workflow)) }}><strong>{workflow.name}</strong><span>{workflow.nodes.length} 节点 · {workflow.edges.length} 连线</span></button>)}</div>
              <button className="ghost-btn wide" onClick={duplicateWorkflow}><Copy size={16} />复制当前工作流</button>
              <h2>画布新增节点</h2>
              {(Object.keys(nodeMeta) as NodeKind[]).map((kind) => { const Icon = nodeMeta[kind].icon; return <button className="palette-item" key={kind} onClick={() => addNode(kind)}><Icon size={18} /><span>{nodeMeta[kind].label}</span><Plus size={16} /></button> })}
            </section>

            <section className="canvas">
              <div className="canvas-header"><div><h2>{activeWorkflow.name}</h2><span>{activeWorkflow.description}</span></div><span>{executionOrder.hasCycle ? '存在循环依赖' : `执行顺序 ${executionOrder.ordered.length} 步`}</span></div>
              <div className="dag-canvas" ref={viewportRef} onWheel={onCanvasWheel} onMouseMove={onSurfaceMove} onMouseUp={() => setDrag(null)}>
                <div className="dag-toolbar">
                  {(Object.keys(nodeMeta) as NodeKind[]).map((kind) => { const Icon = nodeMeta[kind].icon; return <button className="icon-btn" title={nodeMeta[kind].label} key={kind} onClick={() => addNode(kind, { x: 120, y: 80 })}><Icon size={16} /></button> })}
                  <button className="ghost-btn zoom-fit" onClick={fitGraph}>适配</button>
                  <span className="zoom-value">{Math.round(zoom * 100)}%</span>
                </div>
                <div className="dag-zoom-layer" style={{ width: graphWidth * zoom, height: graphHeight * zoom }}>
                <div className="dag-surface" ref={surfaceRef} style={{ width: graphWidth, height: graphHeight, transform: `scale(${zoom})` }}>
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
                  {activeWorkflow.nodes.map((node) => {
                    const Icon = nodeMeta[node.kind].icon
                    const model = models.find((item) => item.id === node.modelId)
                    return (
                      <article className={selectedNode?.id === node.id ? 'dag-node selected' : 'dag-node'} key={node.id} style={{ left: node.position.x, top: node.position.y }} onMouseDown={(e) => startNodeDrag(e, node)} onClick={() => setSelectedNodeId(node.id)}>
                        <button className="port port-in" title="输入连接点" onMouseUp={(e) => finishEdgeDrag(e, node.id)} />
                        <button className="port port-out" title="输出连接点" onMouseDown={(e) => startEdgeDrag(e, node)} />
                        <span className="dag-node-top"><Icon size={20} /><strong>{node.title}</strong><button className="node-action" title="删除节点" onClick={(e) => { e.stopPropagation(); removeNode(node.id) }}><Trash2 size={14} /></button></span>
                        <small>{nodeMeta[node.kind].label}{model ? ` · ${model.name}` : ''}</small>
                        <code>${'{' + node.resultVar + '}'}</code>
                        {node.loop.enabled ? <span className="loop-badge"><Repeat size={13} />循环 {node.loop.fallbackCount}</span> : null}
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
              {selectedNode.kind !== 'input' ? <label>使用模型<select value={selectedNode.modelId ?? ''} onChange={(event) => updateNode(selectedNode.id, { modelId: event.target.value })}>{availableModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label> : null}
              <label>提示词 / 模板<textarea rows={5} value={selectedNode.prompt} onChange={(event) => updateNode(selectedNode.id, { prompt: event.target.value })} /></label>
              {(selectedNode.kind === 'image' || selectedNode.kind === 'video') ? <div className="loop-config"><label className="check-label"><input type="checkbox" checked={selectedNode.loop.enabled} onChange={(event) => updateNode(selectedNode.id, { loop: { ...selectedNode.loop, enabled: event.target.checked } })} />启用循环执行器</label><label>循环来源变量<input value={selectedNode.loop.sourcePath} onChange={(event) => updateNode(selectedNode.id, { loop: { ...selectedNode.loop, sourcePath: event.target.value } })} /></label><div className="position-grid"><label>默认次数<input type="number" value={selectedNode.loop.fallbackCount} onChange={(event) => updateNode(selectedNode.id, { loop: { ...selectedNode.loop, fallbackCount: Number(event.target.value) } })} /></label><label>单项变量名<input value={selectedNode.loop.itemVar} onChange={(event) => updateNode(selectedNode.id, { loop: { ...selectedNode.loop, itemVar: event.target.value } })} /></label></div></div> : null}
              <div className="panel-title compact"><h3>入参字段</h3><button className="ghost-btn" onClick={addParam}><Plus size={16} />添加</button></div>
              <div className="param-list">{selectedNode.params.map((param) => <div className="param-editor" key={param.id}><input value={param.name} onChange={(event) => updateParam(selectedNode.id, param.id, { name: event.target.value })} /><select value={param.type} onChange={(event) => updateParam(selectedNode.id, param.id, { type: event.target.value as ParamType })}><option value="text">文本</option><option value="number">数字</option><option value="boolean">布尔</option><option value="image">单图</option><option value="images">多图</option><option value="json">JSON</option></select><label className="check-label"><input type="checkbox" checked={param.required} onChange={(event) => updateParam(selectedNode.id, param.id, { required: event.target.checked })} />必填</label><input value={param.value} onChange={(event) => updateParam(selectedNode.id, param.id, { value: event.target.value })} /><button className="icon-btn" title="删除入参" onClick={() => removeParam(param.id)}><Trash2 size={15} /></button></div>)}</div>
              {selectedNode.kind === 'image' || selectedNode.params.some((param) => param.type === 'image' || param.type === 'images') ? <div className="upload-box"><div><strong>手工上传图片</strong><span>支持 1 张或多张，上传后会进入该节点上下文。</span></div><label className="upload-btn"><Upload size={16} />选择图片<input type="file" accept="image/*" multiple onChange={(event) => readUploads(event.target.files, (assets) => updateNode(selectedNode.id, { uploads: [...selectedNode.uploads, ...assets] }))} /></label><div className="thumb-grid">{selectedNode.uploads.map((asset) => <img key={asset.id} src={asset.dataUrl} alt={asset.name} title={asset.name} />)}</div></div> : null}
            </section>

            <section className="context-panel"><div><h2>上下文变量</h2><p>DAG 按依赖拓扑排序执行，循环结果会以 items 数组写入变量。</p></div><pre>{JSON.stringify(liveResult.context, null, 2)}</pre><div className="run-log"><h3>最近执行</h3>{runResult.logs.map((log) => <span key={log}><CheckCircle2 size={15} />{log}</span>)}</div></section>
          </div>
        </section>
      ) : (
        <section className="workspace">
          {modelView.mode === 'list' ? (
            <>
              <header className="topbar">
                <div>
                  <h1>模型管理</h1>
                  <p>先编辑模型调用属性，点击保存后写入配置库；测试和体验在模型详情页完成。</p>
                </div>
                <div className="topbar-actions">
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
                {(['text', 'image', 'video'] as ModelCapability[]).map((capability) => (
                  <button key={capability} className={modelTab === capability ? 'tab-btn active' : 'tab-btn'} onClick={() => setModelTab(capability)}>
                    {capability === 'text' ? '文本推理模型' : capability === 'image' ? '图片生成模型' : '视频生成模型'}
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
                      <label>Provider<select value={model.provider} onChange={(event) => updateModel(model.id, { provider: event.target.value as ModelProvider })}><option value="Anthropic">Anthropic</option><option value="OpenAI">OpenAI</option><option value="Kling">Kling</option><option value="Custom">Custom</option></select></label>
                      <label>Model ID<input value={model.settings.model ?? ''} onChange={(event) => updateModelSetting(model.id, 'model', event.target.value)} /></label>
                    </div>
                    {renderModelFields(model)}
                    <div className="model-card-actions">
                      <button className="primary-btn" onClick={() => saveSingleModel(model.id)}>保存配置</button>
                      <button className="ghost-btn" onClick={() => setModelView({ mode: 'detail', modelId: model.id })}><FlaskConical size={17} />测试 / 体验</button>
                    </div>
                  </article>
                ))}
              </div>
            </>
          ) : detailModel ? (
            <section className="model-detail">
              <header className="topbar">
                <div>
                  <h1>{detailModel.name}</h1>
                  <p>{detailModel.provider} · {detailModel.capability} 模型测试与体验</p>
                </div>
                <div className="topbar-actions">
                  <button className="ghost-btn" onClick={() => setModelView({ mode: 'list' })}>返回模型列表</button>
                  <button className="primary-btn" onClick={() => saveSingleModel(detailModel.id)}>保存配置</button>
                </div>
              </header>
              <article className="model-card detail-card">
                <div className="model-card-head">
                  <div>
                    <h2>调用体验</h2>
                    <span>使用当前草稿配置发起测试，建议先保存配置。</span>
                  </div>
                </div>
                <label>测试输入<textarea rows={6} value={detailModel.testInput} onChange={(event) => updateModel(detailModel.id, { testInput: event.target.value })} /></label>
                <button className="primary-btn" onClick={() => testModel(detailModel)}><FlaskConical size={17} />测试模型</button>
                <pre className="model-result">{detailModel.testResult || '等待测试结果...'}</pre>
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
