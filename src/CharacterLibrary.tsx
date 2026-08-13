import { useEffect, useMemo, useState } from 'react'
import './character-library.css'
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Eye,
  ImagePlus,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  UserRoundSearch,
  UsersRound,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react'

type WorkflowOption = { id: string; name: string }

type CharacterAsset = {
  id: string
  workflowId: string | null
  characterName: string
  description: string
  threeViewUrl: string
  version: number
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

type CharacterDraft = {
  workflowId: string
  characterName: string
  description: string
  threeViewUrl: string
  continuityKey: string
}

type CharacterLibraryProps = {
  workflows: WorkflowOption[]
}

const PAGE_SIZE = 8
const emptyDraft: CharacterDraft = { workflowId: '', characterName: '', description: '', threeViewUrl: '', continuityKey: '' }

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error((body as { error?: string }).error || `请求失败：HTTP ${response.status}`)
  return body as T
}

function formatDate(value: string) {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function imageToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}

export default function CharacterLibrary({ workflows }: CharacterLibraryProps) {
  const [characters, setCharacters] = useState<CharacterAsset[]>([])
  const [query, setQuery] = useState('')
  const [workflowFilter, setWorkflowFilter] = useState('all')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [editor, setEditor] = useState<{ mode: 'create' | 'edit'; id?: string } | null>(null)
  const [draft, setDraft] = useState<CharacterDraft>(emptyDraft)
  const [detail, setDetail] = useState<CharacterAsset | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CharacterAsset | null>(null)

  const workflowNames = useMemo(() => new Map(workflows.map((workflow) => [workflow.id, workflow.name])), [workflows])

  const loadCharacters = async () => {
    setLoading(true)
    setStatus('')
    try {
      const body = await requestJson<{ characters: CharacterAsset[] }>('/api/characters')
      setCharacters(body.characters)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    requestJson<{ characters: CharacterAsset[] }>('/api/characters')
      .then((body) => { if (active) setCharacters(body.characters) })
      .catch((error: unknown) => { if (active) setStatus(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase()
    return characters.filter((character) => {
      if (workflowFilter !== 'all' && (workflowFilter === 'unassigned' ? character.workflowId !== null : character.workflowId !== workflowFilter)) return false
      if (!keyword) return true
      const workflowName = character.workflowId ? workflowNames.get(character.workflowId) ?? '' : '未关联工作流'
      return [character.characterName, character.description, workflowName, String(character.metadata.continuityKey ?? '')]
        .some((value) => value.toLocaleLowerCase().includes(keyword))
    })
  }, [characters, query, workflowFilter, workflowNames])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const visibleCharacters = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const associatedCount = characters.filter((item) => item.workflowId).length
  const activeWorkflowCount = new Set(characters.map((item) => item.workflowId).filter(Boolean)).size

  const openCreate = () => {
    setDraft({ ...emptyDraft, workflowId: workflowFilter !== 'all' && workflowFilter !== 'unassigned' ? workflowFilter : workflows[0]?.id ?? '' })
    setStatus('')
    setEditor({ mode: 'create' })
  }

  const openEdit = (character: CharacterAsset) => {
    setDraft({
      workflowId: character.workflowId ?? workflows[0]?.id ?? '',
      characterName: character.characterName,
      description: character.description,
      threeViewUrl: character.threeViewUrl,
      continuityKey: String(character.metadata.continuityKey ?? ''),
    })
    setStatus('')
    setEditor({ mode: 'edit', id: character.id })
  }

  const saveCharacter = async () => {
    if (!draft.characterName.trim()) return setStatus('请输入角色名称')
    if (!draft.workflowId) return setStatus('请选择所属工作流')
    if (!draft.threeViewUrl.trim()) return setStatus('请上传或填写角色三视图')
    setSaving(true)
    setStatus('')
    try {
      const payload = {
        workflowId: draft.workflowId,
        characterName: draft.characterName,
        description: draft.description,
        threeViewUrl: draft.threeViewUrl,
        metadata: { continuityKey: draft.continuityKey || `${draft.characterName.trim()}-v1`, source: 'character-library' },
      }
      const url = editor?.mode === 'edit' ? `/api/characters/${editor.id}` : '/api/characters'
      const body = await requestJson<{ character: CharacterAsset }>(url, {
        method: editor?.mode === 'edit' ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      setCharacters((current) => editor?.mode === 'edit'
        ? current.map((item) => item.id === body.character.id ? body.character : item)
        : [body.character, ...current])
      setEditor(null)
      setStatus(editor?.mode === 'edit' ? '角色资料已更新' : '角色已添加到人物库')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setSaving(true)
    setStatus('')
    try {
      await requestJson(`/api/characters/${deleteTarget.id}`, { method: 'DELETE' })
      setCharacters((current) => current.filter((item) => item.id !== deleteTarget.id))
      setDeleteTarget(null)
      setDetail((current) => current?.id === deleteTarget.id ? null : current)
      setStatus('角色已从人物库删除')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const uploadImage = async (file?: File) => {
    if (!file) return
    if (!file.type.startsWith('image/')) return setStatus('请选择图片文件')
    if (file.size > 8 * 1024 * 1024) return setStatus('图片不能超过 8MB')
    try {
      setDraft((current) => ({ ...current, threeViewUrl: '' }))
      const dataUrl = await imageToDataUrl(file)
      setDraft((current) => ({ ...current, threeViewUrl: dataUrl }))
      setStatus('')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <section className="workspace character-library">
      <header className="character-hero">
        <div className="character-hero-copy">
          <span className="character-eyebrow"><UserRoundSearch size={15} /> CHARACTER ARCHIVE</span>
          <h1>人物库</h1>
          <p>按工作流沉淀角色设定与三视图，让每一次生成都沿用一致的人物形象。</p>
        </div>
        <button className="primary-btn character-create-btn" onClick={openCreate}><Plus size={17} />新建角色</button>
      </header>

      <div className="character-stats" aria-label="人物库概览">
        <div><span className="stat-icon coral"><UsersRound size={18} /></span><p><strong>{characters.length}</strong><small>全部角色</small></p></div>
        <div><span className="stat-icon teal"><WorkflowIcon size={18} /></span><p><strong>{activeWorkflowCount}</strong><small>关联工作流</small></p></div>
        <div><span className="stat-icon blue"><UserRoundSearch size={18} /></span><p><strong>{associatedCount}</strong><small>已归档角色</small></p></div>
      </div>

      <section className="character-panel">
        <div className="character-toolbar">
          <div className="character-search"><Search size={18} /><input aria-label="搜索角色" placeholder="搜索角色名称、描述或连续性标识" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} />{query ? <button aria-label="清空搜索" onClick={() => { setQuery(''); setPage(1) }}><X size={15} /></button> : null}</div>
          <label className="character-filter"><span>所属工作流</span><select value={workflowFilter} onChange={(event) => { setWorkflowFilter(event.target.value); setPage(1) }}><option value="all">全部工作流</option>{workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}<option value="unassigned">未关联工作流</option></select></label>
          <button className="character-refresh" title="刷新人物库" onClick={() => void loadCharacters()} disabled={loading}><RefreshCw size={17} className={loading ? 'spinning' : ''} /></button>
        </div>

        <div className="character-table-meta"><div><strong>角色档案</strong><span>共 {filtered.length} 个结果</span></div>{status ? <span className="character-status" role="status">{status}</span> : null}</div>

        <div className="character-table-wrap">
          <table className="character-table">
            <thead><tr><th>角色</th><th>角色描述</th><th>三视图</th><th>所属工作流</th><th>更新时间</th><th><span className="sr-only">操作</span></th></tr></thead>
            <tbody>
              {visibleCharacters.map((character) => (
                <tr key={character.id}>
                  <td><div className="character-identity"><div className="character-avatar">{character.threeViewUrl ? <img src={character.threeViewUrl} alt="" /> : character.characterName.slice(0, 1)}</div><div><strong>{character.characterName}</strong><small>版本 V{character.version}</small></div></div></td>
                  <td><p className="character-description">{character.description || '尚未填写角色描述'}</p></td>
                  <td><button className="three-view-thumb" onClick={() => setDetail(character)} title={`查看 ${character.characterName} 三视图`}><img src={character.threeViewUrl} alt={`${character.characterName} 三视图`} /><span><Eye size={13} />查看大图</span></button></td>
                  <td><span className={character.workflowId ? 'workflow-pill' : 'workflow-pill muted'}><WorkflowIcon size={13} />{character.workflowId ? workflowNames.get(character.workflowId) ?? '未知工作流' : '未关联'}</span></td>
                  <td><span className="character-date">{formatDate(character.updatedAt)}</span></td>
                  <td><div className="row-actions"><button title="查看详情" onClick={() => setDetail(character)}><Eye size={16} /></button><button title="编辑角色" onClick={() => openEdit(character)}><Pencil size={16} /></button><button className="danger" title="删除角色" onClick={() => setDeleteTarget(character)}><Trash2 size={16} /></button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading ? <div className="character-empty"><RefreshCw className="spinning" size={24} /><strong>正在读取人物库</strong><span>从 PostgreSQL 同步角色资产...</span></div> : null}
          {!loading && !visibleCharacters.length ? <div className="character-empty"><span className="empty-portrait"><UserRoundSearch size={28} /></span><strong>{characters.length ? '没有匹配的角色' : '人物库还是空的'}</strong><span>{characters.length ? '尝试更换搜索词或工作流筛选。' : '创建第一个角色，为工作流建立稳定的人物视觉基线。'}</span>{!characters.length ? <button className="primary-btn" onClick={openCreate}><Plus size={16} />新建角色</button> : null}</div> : null}
        </div>

        <footer className="character-pagination"><span>第 {page} / {pageCount} 页</span><div><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={16} /></button><strong>{page}</strong><button disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}><ChevronRight size={16} /></button></div></footer>
      </section>

      {editor ? <div className="character-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditor(null) }}><aside className="character-drawer" role="dialog" aria-modal="true" aria-label={editor.mode === 'create' ? '新建角色' : '编辑角色'}><header><div><span>{editor.mode === 'create' ? 'NEW PROFILE' : 'EDIT PROFILE'}</span><h2>{editor.mode === 'create' ? '新建角色' : '编辑角色资料'}</h2><p>角色信息将用于工作流中的资产检索与画面一致性控制。</p></div><button className="drawer-close" aria-label="关闭" onClick={() => setEditor(null)}><X size={19} /></button></header><div className="drawer-body"><label><span>所属工作流 <em>*</em></span><select value={draft.workflowId} onChange={(event) => setDraft((current) => ({ ...current, workflowId: event.target.value }))}><option value="">请选择工作流</option>{workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</select></label><label><span>角色名称 <em>*</em></span><input autoFocus value={draft.characterName} maxLength={40} placeholder="例如：刘备" onChange={(event) => setDraft((current) => ({ ...current, characterName: event.target.value }))} /></label><label><span>角色描述</span><textarea rows={5} maxLength={500} value={draft.description} placeholder="描述年龄、脸型、发式、服装、体型与气质等稳定特征" onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} /><small>{draft.description.length}/500</small></label><label><span>连续性标识</span><input value={draft.continuityKey} placeholder="留空将根据角色名自动生成" onChange={(event) => setDraft((current) => ({ ...current, continuityKey: event.target.value }))} /></label><div className="three-view-field"><div><strong>角色三视图 <em>*</em></strong><span>建议上传包含正面、侧面、背面的横版合图，JPG / PNG，最大 8MB。</span></div>{draft.threeViewUrl ? <div className="three-view-upload-preview"><img src={draft.threeViewUrl} alt="待保存的角色三视图" /><label><ImagePlus size={16} />替换图片<input type="file" accept="image/*" onChange={(event) => void uploadImage(event.target.files?.[0])} /></label></div> : <label className="three-view-drop"><ImagePlus size={25} /><strong>上传三视图图片</strong><span>点击选择本地文件</span><input type="file" accept="image/*" onChange={(event) => void uploadImage(event.target.files?.[0])} /></label>}<label className="image-url-field"><span>或填写图片 URL</span><input value={draft.threeViewUrl.startsWith('data:') ? '' : draft.threeViewUrl} placeholder="https://..." onChange={(event) => setDraft((current) => ({ ...current, threeViewUrl: event.target.value }))} /></label></div>{status ? <p className="drawer-error" role="alert"><AlertTriangle size={15} />{status}</p> : null}</div><footer><button className="ghost-btn" onClick={() => setEditor(null)} disabled={saving}>取消</button><button className="primary-btn" onClick={() => void saveCharacter()} disabled={saving}>{saving ? '保存中...' : editor.mode === 'create' ? '创建角色' : '保存修改'}</button></footer></aside></div> : null}

      {detail ? <div className="character-overlay detail-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetail(null) }}><section className="character-detail-modal" role="dialog" aria-modal="true" aria-label={`${detail.characterName} 角色详情`}><header><div><span>角色档案 · V{detail.version}</span><h2>{detail.characterName}</h2></div><button className="drawer-close" aria-label="关闭" onClick={() => setDetail(null)}><X size={19} /></button></header><div className="detail-three-view"><img src={detail.threeViewUrl} alt={`${detail.characterName} 角色三视图`} /><span>FRONT · SIDE · BACK</span></div><div className="detail-info"><div><span>所属工作流</span><strong>{detail.workflowId ? workflowNames.get(detail.workflowId) ?? '未知工作流' : '未关联工作流'}</strong></div><div><span>连续性标识</span><strong>{String(detail.metadata.continuityKey ?? '—')}</strong></div><div className="wide"><span>角色描述</span><p>{detail.description || '尚未填写角色描述'}</p></div><div><span>创建时间</span><strong>{new Date(detail.createdAt).toLocaleString('zh-CN')}</strong></div><div><span>最近更新</span><strong>{new Date(detail.updatedAt).toLocaleString('zh-CN')}</strong></div></div><footer><button className="ghost-btn danger-text" onClick={() => { setDeleteTarget(detail); setDetail(null) }}><Trash2 size={16} />删除角色</button><button className="primary-btn" onClick={() => { openEdit(detail); setDetail(null) }}><Pencil size={16} />编辑资料</button></footer></section></div> : null}

      {deleteTarget ? <div className="character-overlay confirm-overlay"><section className="delete-confirm" role="alertdialog" aria-modal="true"><span className="delete-icon"><Trash2 size={22} /></span><h2>删除“{deleteTarget.characterName}”？</h2><p>该角色三视图将从人物库中永久删除，后续工作流无法再复用此资产。</p><div><button className="ghost-btn" onClick={() => setDeleteTarget(null)} disabled={saving}>取消</button><button className="delete-btn" onClick={() => void confirmDelete()} disabled={saving}>{saving ? '删除中...' : '确认删除'}</button></div></section></div> : null}
    </section>
  )
}
