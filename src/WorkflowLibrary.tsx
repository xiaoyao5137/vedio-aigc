import { useMemo, useState } from 'react'
import { Activity, ArrowUpRight, AudioLines, Bot, Clapperboard, Image, LayoutGrid, List, Network, Pencil, Play, Plus, Search, UsersRound, X } from 'lucide-react'

type LibraryNode = { id: string; title: string; kind: string; position: { x: number; y: number } }
type LibraryWorkflow = { id: string; name: string; description: string; nodes: LibraryNode[]; edges: { from: string; to: string }[] }
type Capability = 'all' | 'video' | 'image' | 'audio' | 'text'
type WorkflowLibraryProps<T extends LibraryWorkflow> = {
  workflows: T[]
  onCreate: () => void
  onDetails: (workflow: T) => void
  onEdit: (workflow: T) => void
  onRun: (workflow: T) => void
  onCharacters: () => void
  onModels: () => void
  busy?: boolean
  blockedReason?: string
  currentExecution?: { name: string; onReturn: () => void }
}

const capabilities = [
  { value: 'all', label: '全部工作流', icon: LayoutGrid },
  { value: 'video', label: '视频', icon: Clapperboard },
  { value: 'image', label: '图片', icon: Image },
  { value: 'audio', label: '音频', icon: AudioLines },
  { value: 'text', label: '文本', icon: Bot },
] as const

function hasCapability(workflow: LibraryWorkflow, capability: Capability) {
  return capability === 'all' || workflow.nodes.some(node => capability === 'video'
    ? ['video', 'videoConcat', 'compose'].includes(node.kind)
    : node.kind === capability)
}

function WorkflowOverview({ workflow }: { workflow: LibraryWorkflow }) {
  // The thumbnail is a scaled view of the saved graph, never a fabricated media output.
  const nodes = workflow.nodes.slice(0, 24)
  const nodeIds = new Set(nodes.map(node => node.id))
  const edges = workflow.edges.filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to))
  const minX = Math.min(0, ...nodes.map(node => node.position.x))
  const minY = Math.min(0, ...nodes.map(node => node.position.y))
  const width = Math.max(600, ...nodes.map(node => node.position.x + 250)) - minX
  const height = Math.max(260, ...nodes.map(node => node.position.y + 130)) - minY
  return <div className="studio-graph-preview" aria-hidden="true">
    <svg viewBox={`${minX - 40} ${minY - 40} ${width + 80} ${height + 80}`} focusable="false">
      {edges.map((edge, index) => {
        const from = nodes.find(node => node.id === edge.from)!
        const to = nodes.find(node => node.id === edge.to)!
        const x1 = from.position.x + 210
        const y1 = from.position.y + 40
        const x2 = to.position.x
        const y2 = to.position.y + 40
        const bend = Math.max(60, Math.abs(x2 - x1) / 2)
        return <path key={`${edge.from}-${edge.to}-${index}`} d={`M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`} className="studio-graph-edge" />
      })}
      {nodes.map(node => <g key={node.id} transform={`translate(${node.position.x},${node.position.y})`}>
        <rect width="210" height="80" rx="12" className={`studio-graph-node ${node.kind}`} />
        <text x="17" y="34" className="studio-graph-node-title">{node.title.length > 11 ? `${node.title.slice(0, 10)}…` : node.title}</text>
        <text x="17" y="59" className="studio-graph-node-kind">{node.kind}</text>
      </g>)}
    </svg>
    <span className="studio-graph-caption"><Network size={13} />{workflow.nodes.length > nodes.length ? `前 ${nodes.length} 个节点概览` : '编排概览'}</span>
  </div>
}

export default function WorkflowLibrary<T extends LibraryWorkflow>({ workflows, onCreate, onDetails, onEdit, onRun, onCharacters, onModels, busy = false, blockedReason = '有任务执行中，完成或暂停后可打开其他工作流', currentExecution }: WorkflowLibraryProps<T>) {
  const [query, setQuery] = useState('')
  const [capability, setCapability] = useState<Capability>('all')
  const [layout, setLayout] = useState<'grid' | 'list'>('grid')
  const filtered = useMemo(() => {
    const keywords = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    return workflows.filter(workflow => hasCapability(workflow, capability) && keywords.every(keyword =>
      `${workflow.name} ${workflow.description}`.toLocaleLowerCase().includes(keyword)))
  }, [workflows, capability, query])

  return <section className="workspace studio-library" aria-labelledby="studio-library-title">
    <header className="studio-library-heading">
      <div><h1 id="studio-library-title">短视频工作流</h1><p>从灵感到成片，让创作自然发生。</p></div>
      <span className="studio-workspace-label"><Clapperboard size={15} />创作工作台</span>
    </header>

    <button className="studio-create-banner" type="button" onClick={onCreate} disabled={busy}>
      <span className="studio-create-icon"><Plus size={28} strokeWidth={1.5} /></span>
      <span className="studio-create-copy"><strong>新建工作流</strong><span>连接脚本、画面与声音，开始你的下一部作品</span></span>
      <ArrowUpRight className="studio-create-arrow" size={24} />
    </button>

    <div className="studio-shortcuts">
      <button type="button" onClick={onCharacters}><UsersRound size={19} /><span><strong>人物库</strong><small>管理人物造型与声音</small></span><ArrowUpRight size={16} /></button>
      <button type="button" onClick={onModels}><Bot size={19} /><span><strong>模型管理</strong><small>配置与体验创作模型</small></span><ArrowUpRight size={16} /></button>
    </div>

    {currentExecution ? <div className="studio-current-execution"><Activity size={18} /><div><strong>当前执行</strong><span>{currentExecution.name}</span></div><button type="button" className="ghost-btn" onClick={currentExecution.onReturn}>返回当前执行<ArrowUpRight size={15} /></button></div> : null}

    <div className="studio-library-toolbar">
      <div className="studio-filters" role="group" aria-label="按生成能力筛选工作流">
        {capabilities.map(({ value, label, icon: Icon }) => <button type="button" key={value} aria-pressed={capability === value} onClick={() => setCapability(value)}>
          <Icon size={15} /><span>{label}</span>{value === 'all' ? <span className="studio-filter-count">{workflows.length}</span> : null}
        </button>)}
      </div>
      <div className="studio-library-tools">
        <label className="studio-search"><Search size={16} /><input aria-label="搜索工作流" placeholder="搜索工作流名称或描述" value={query} onChange={event => setQuery(event.target.value)} />{query ? <button type="button" aria-label="清空搜索" onClick={() => setQuery('')}><X size={15} /></button> : null}</label>
        <div className="studio-view-switch" role="group" aria-label="展示方式">
          <button type="button" aria-label="网格视图" title="网格视图" aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')}><LayoutGrid size={17} /></button>
          <button type="button" aria-label="列表视图" title="列表视图" aria-pressed={layout === 'list'} onClick={() => setLayout('list')}><List size={18} /></button>
        </div>
      </div>
    </div>
    <div className="studio-results-meta" role="status">{query.trim() || capability !== 'all' ? `找到 ${filtered.length} 个工作流` : `${workflows.length} 个工作流`}{busy ? <span>{blockedReason}</span> : null}</div>

    {filtered.length ? <div className={`studio-projects ${layout === 'list' ? 'is-list' : ''}`}>
      {filtered.map(workflow => <article className="studio-project" key={workflow.id}>
        <button className="studio-project-cover" type="button" disabled={busy} onClick={() => onDetails(workflow)} aria-label={`查看详情 ${workflow.name}`}>
          <WorkflowOverview workflow={workflow} />
          <span className="studio-project-open"><Network size={16} />查看详情</span>
        </button>
        <div className="studio-project-info">
          <h2><button type="button" disabled={busy} onClick={() => onDetails(workflow)}>{workflow.name}</button></h2>
          <p title={workflow.description}>{workflow.description || '添加节点与连接，构建你的创作流程。'}</p>
          <div className="studio-project-meta"><span>{workflow.nodes.length} 节点</span><span>{workflow.edges.length} 连线</span><span className="studio-project-capabilities">{capabilities.filter(item => item.value !== 'all' && hasCapability(workflow, item.value)).map(({ value, label, icon: Icon }) => <span key={value} title={label}><Icon size={14} /><span className="studio-sr-only">{label}</span></span>)}</span></div>
        </div>
        <div className="studio-project-actions">
          <button className="ghost-btn" type="button" disabled={busy} onClick={() => onEdit(workflow)} aria-label={`编辑编排 ${workflow.name}`}><Pencil size={15} />编辑编排</button>
          <button className="primary-btn" type="button" disabled={busy} onClick={() => onRun(workflow)} aria-label={`执行 ${workflow.name}`}><Play size={15} />执行</button>
        </div>
      </article>)}
    </div> : <div className="studio-library-empty">
      {workflows.length ? <><Search size={30} /><h2>没有找到匹配的工作流</h2><p>试试其他关键词，或清除筛选查看全部工作流。</p><button className="ghost-btn" type="button" onClick={() => { setQuery(''); setCapability('all') }}>清除筛选</button></>
        : <><Network size={30} /><h2>从第一个工作流开始</h2><p>点击上方“新建工作流”，把你的创作步骤连接起来。</p></>}
    </div>}
  </section>
}
