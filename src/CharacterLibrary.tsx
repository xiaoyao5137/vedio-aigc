import CharacterVoicePanel from './CharacterVoicePanel'
import { useEffect, useMemo, useState } from 'react'
import './character-library.css'
import {
  AlertTriangle, ChevronLeft, ChevronRight, Eye, ImagePlus, Pencil, Plus, RefreshCw,
  Search, Trash2, UserRoundSearch, UsersRound, Workflow as WorkflowIcon, X,
} from 'lucide-react'
import {
  AGE_BASES, AGE_STAGES, characterContextSummary, characterPersonAgeLabels,
  characterVersionMetadata, emptyVisualContextDraft, groupCharacterAssets, personMatchesContext, visualContextDraftFrom,
} from './character-library-model'
import type { VisualContextDraft } from './character-library-model'
import type { CharacterAsset, CharacterEquipment, CharacterEquipmentInput, CharacterPerson } from './character-asset'
import { CHARACTER_BIOGRAPHY_MAX_LENGTH } from './character-asset'
import { sharedHistoricalAppearanceEvidence } from './character-biography-view'
import { currentPortraits, isPendingIdentityReview, isRejectedPortraitReview, isSupersededPortrait,
  portraitReviewCandidateSha256, preferredPortrait } from './character-portrait-lifecycle'

type WorkflowOption = { id: string; name: string }
type CharacterDraft = { workflowId: string; characterName: string; biography?: string; description: string; threeViewUrl: string; visual: VisualContextDraft }
type CharacterLibraryProps = { workflows: WorkflowOption[] }
type Editor = { mode: 'create' | 'edit' | 'variant'; id?: string }
type EquipmentDraft = { id?: string; name: string; kind: CharacterEquipmentInput['kind']; description: string; imageUrl: string;
  aliases: string; ageStages: string[]; lookKeys: string; sceneTags: string }
const PAGE_SIZE = 8
const emptyDraft: CharacterDraft = { workflowId: '', characterName: '', description: '', threeViewUrl: '', visual: emptyVisualContextDraft }
const emptyEquipmentDraft: EquipmentDraft = { name: '', kind: 'weapon', description: '', imageUrl: '', aliases: '', ageStages: [], lookKeys: '', sceneTags: '' }
const EQUIPMENT_KINDS: Record<CharacterEquipmentInput['kind'], string> = { weapon: '武器', armor: '甲胄', prop: '道具', accessory: '配饰', other: '其他' }
const HAIR_LABELS = { dark: '黑发', graying: '花白', white: '白发', unknown: '未设定' }
const BEARD_LABELS = { dark: '黑须', graying: '花白', white: '白须', none: '无须', unknown: '未设定' }

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error((body as { error?: string }).error || `请求失败：HTTP ${response.status}`)
  return body as T
}
function formatDate(value: string) {
  return value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
}
function imageToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}
function safeSourceUrl(value: string) {
  return /^https?:\/\//i.test(value) ? value : undefined
}
function VisualContextFields({ value, onChange }: { value: VisualContextDraft; onChange: (value: VisualContextDraft) => void }) {
  const update = (patch: Partial<VisualContextDraft>) => onChange({ ...value, ...patch })
  return <section className="character-form-section">
    <div className="character-section-title"><h3>剧情年龄与适用造型</h3><p>按剧情时间设计外观。没有明确记载的具体岁数，请标为艺术设定。</p></div>
    <div className="character-form-grid">
      <label><span>年龄阶段</span><select value={value.stage} onChange={event => {
        const stage = event.target.value as VisualContextDraft['stage']
        update({ stage, ...(stage !== 'unknown' && value.basis === 'unknown' ? { basis: 'artistic' as const } : {}) })
      }}>{AGE_STAGES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label><span>年龄依据</span><select value={value.basis} onChange={event => {
        const basis = event.target.value as VisualContextDraft['basis']
        update({ basis, ...(basis === 'unknown' ? { stage: 'unknown' as const, minAge: '', maxAge: '' } : {}) })
      }}>{AGE_BASES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label className="wide"><span>年龄范围 <small>可留空</small></span><div className="character-age-range"><input aria-label="年龄范围起始" type="number" min="0" max="120" step="1" disabled={value.basis === 'unknown'} value={value.minAge} placeholder="起始年龄" onChange={event => update({ minAge: event.target.value })} /><span>至</span><input aria-label="年龄范围结束" type="number" min="0" max="120" step="1" disabled={value.basis === 'unknown'} value={value.maxAge} placeholder="结束年龄" onChange={event => update({ maxAge: event.target.value })} /><span>岁</span></div></label>
      <label className="wide"><span>适用剧情时间 / 年代</span><input value={value.asOf} maxLength={120} placeholder="例如：建安十三年（208年），长坂撤退时期" onChange={event => update({ asOf: event.target.value })} /></label>
      <label className="wide"><span>年龄依据与不确定性 <small>{['documented', 'estimated'].includes(value.basis) ? '使用史料依据时必填' : '可留空'}</small></span><textarea rows={2} value={value.sourceRefs} placeholder="每行一条史料来源或说明；艺术设定可写明本剧的年龄设计依据" onChange={event => update({ sourceRefs: event.target.value })} /></label>
      <label className="wide"><span>适用场合 / 造型名称 <em>*</em></span><input value={value.lookKey} maxLength={120} placeholder="例如：行军甲胄、便服、朝服" onChange={event => update({ lookKey: event.target.value })} /><small className="field-help">同一套服装沿用同名；更换主要服装或冠帽时，新建造型版本。</small></label>
      <label className="wide"><span>造型描述 <em>*</em></span><textarea rows={3} maxLength={500} value={value.lookDescription} placeholder="描述服装、冠帽与稳定配饰，例如：深色札甲、布帻，不露白发白须" onChange={event => update({ lookDescription: event.target.value })} /></label>
      <label><span>头发</span><select value={value.hair} onChange={event => update({ hair: event.target.value as VisualContextDraft['hair'] })}>{Object.entries(HAIR_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label><span>胡须</span><select value={value.facialHair} onChange={event => update({ facialHair: event.target.value as VisualContextDraft['facialHair'] })}>{Object.entries(BEARD_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label className="wide"><span>体型要求</span><input value={value.build} maxLength={200} placeholder="例如：壮实体型，肩背宽厚" onChange={event => update({ build: event.target.value })} /></label>
    </div>
  </section>
}

export default function CharacterLibrary({ workflows }: CharacterLibraryProps) {
  const [people, setPeople] = useState<CharacterPerson[]>([])
  const [characters, setCharacters] = useState<CharacterAsset[]>([])
  const [query, setQuery] = useState('')
  const [workflowFilter, setWorkflowFilter] = useState('all')
  const [ageFilter, setAgeFilter] = useState('all')
  const [basisFilter, setBasisFilter] = useState('all')
  const [lookFilter, setLookFilter] = useState('all')
  const [periodFilter, setPeriodFilter] = useState('all')
  const [narratorWorkflowId, setNarratorWorkflowId] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [draft, setDraft] = useState<CharacterDraft>(emptyDraft)
  const [detailPersonId, setDetailPersonId] = useState<string | null>(null)
  const [detailVersionId, setDetailVersionId] = useState<string | null>(null)
  const [equipmentDraft, setEquipmentDraft] = useState<EquipmentDraft | null>(null)
  const [equipmentDeleteTarget, setEquipmentDeleteTarget] = useState<CharacterEquipment | null>(null)
  const [voiceEditorId, setVoiceEditorId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CharacterAsset | null>(null)
  const [portraitReviewNote, setPortraitReviewNote] = useState('')
  const workflowNames = useMemo(() => new Map(workflows.map(workflow => [workflow.id, workflow.name])), [workflows])
  const contexts = useMemo(() => new Map(characters.map(character => [character.id, characterContextSummary(character)])), [characters])
  const workflowPeople = useMemo(() => people.filter(person => workflowFilter === 'all' ||
    (workflowFilter === 'unassigned' ? person.workflowId === null : person.workflowId === workflowFilter)), [people, workflowFilter])
  const workflowCharacters = workflowPeople.flatMap(person => currentPortraits(person.versions))
  const lookOptions = [...new Set(workflowCharacters.map(character => contexts.get(character.id)?.context?.look.key).filter((value): value is string => Boolean(value)))].sort()
  const periodOptions = [...new Set(workflowCharacters.map(character => contexts.get(character.id)?.context?.age.asOf).filter((value): value is string => Boolean(value)))].sort()
  const editorBase = editor?.id ? characters.find(item => item.id === editor.id) : undefined
  const matchingIdentity = editorBase ?? characters.find(item => item.workflowId === draft.workflowId && item.characterName === draft.characterName.trim() && !isSupersededPortrait(item))
  const matchingPerson = people.find(item => item.workflowId === draft.workflowId && item.characterName === draft.characterName.trim())
  const draftBiography = draft.biography ?? matchingPerson?.biography ?? matchingIdentity?.biography ?? ''
  const detailPerson = people.find(person => person.id === detailPersonId)
  const detail = detailPerson?.versions.find(version => version.id === detailVersionId) ?? (detailPerson ? preferredPortrait(detailPerson.versions) ?? detailPerson.versions[0] : undefined)
  const detailContext = detail ? characterContextSummary(detail) : null
  const detailReviewHash = detail ? portraitReviewCandidateSha256(detail) : undefined
  const detailIdentityConsistency = detail?.metadata.identityConsistency && typeof detail.metadata.identityConsistency === 'object'
    ? detail.metadata.identityConsistency as Record<string, unknown> : null
  const detailReviewDecision = detail?.metadata.portraitReviewDecision && typeof detail.metadata.portraitReviewDecision === 'object'
    ? detail.metadata.portraitReviewDecision as Record<string, unknown> : null
  const detailLifecycle = detail?.metadata.portraitLifecycle && typeof detail.metadata.portraitLifecycle === 'object'
    ? detail.metadata.portraitLifecycle as Record<string, unknown> : null
  const detailUnrecoverable = detailLifecycle?.status === 'pending-unrecoverable'
  const detailReviewSource = detailPerson?.versions.find(version => version.id === detailIdentityConsistency?.sourceAssetId)
  const detailVersions = detailPerson?.versions ?? []
  const detailPendingCount = detailVersions.filter(isPendingIdentityReview).length
  const detailHistoricalCount = detailVersions.filter(version => isSupersededPortrait(version) && !isPendingIdentityReview(version)).length
  const detailPortrait = detail?.metadata.historicalPortrait && typeof detail.metadata.historicalPortrait === 'object'
    ? detail.metadata.historicalPortrait as Record<string, unknown> : null
  const detailPortraitCitations = Array.isArray(detailPortrait?.citations)
    ? detailPortrait.citations.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : []
  const sharedPortraitEvidence = detailPerson ? sharedHistoricalAppearanceEvidence(detailPerson.biography) : undefined

  const readLibrary = async () => {
    try {
      return (await requestJson<{ people: CharacterPerson[] }>('/api/character-people')).people
    } catch (error) {
      // Older local services can still show the existing portraits while upgrading.
      if (!(error instanceof Error) || !error.message.includes('HTTP 404')) throw error
      const body = await requestJson<{ characters: CharacterAsset[] }>('/api/characters')
      return groupCharacterAssets(body.characters).map(group => ({ id: `legacy:${group.key}`, workflowId: group.workflowId,
        characterName: group.characterName, biography: group.latest.biography ?? '', versions: group.versions,
        equipment: [], updatedAt: group.latest.updatedAt })) as CharacterPerson[]
    }
  }
  const loadCharacters = async () => {
    setLoading(true)
    setStatus('')
    try {
      const next = await readLibrary()
      setPeople(next)
      setCharacters(next.flatMap(person => person.versions))
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }
  const refreshAfterWrite = async (successMessage: string) => {
    try {
      const next = await readLibrary()
      setPeople(next); setCharacters(next.flatMap(person => person.versions)); setStatus(successMessage)
    } catch (error) {
      setStatus(`${successMessage}；人物库刷新失败，请手动点击刷新。${error instanceof Error ? error.message : String(error)}`)
    }
  }
  useEffect(() => {
    let active = true
    readLibrary()
      .then(next => { if (active) { setPeople(next); setCharacters(next.flatMap(person => person.versions)) } })
      .catch((error: unknown) => { if (active) setStatus(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || saving) return
      setEditor(null); setDetailPersonId(null); setDetailVersionId(null); setEquipmentDraft(null); setEquipmentDeleteTarget(null); setVoiceEditorId(null); setDeleteTarget(null)
    }
    if (editor || detailPersonId || deleteTarget || equipmentDeleteTarget) window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [editor, detailPersonId, deleteTarget, equipmentDeleteTarget, saving])
  const filtered = useMemo(() => {
    return workflowPeople.filter(person => personMatchesContext(person, { age: ageFilter, basis: basisFilter,
      look: lookFilter, period: periodFilter, keyword: query,
      workflowName: person.workflowId ? workflowNames.get(person.workflowId) ?? '' : '未关联工作流',
      equipmentText: person.equipment.map(item => [item.name, item.kind, item.description, ...item.aliases].join(' ')).join(' ') }))
  }, [workflowPeople, query, ageFilter, basisFilter, lookFilter, periodFilter, workflowNames])
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const visiblePeople = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const identityCount = people.length
  const openCreate = () => {
    setDraft({ ...emptyDraft, visual: { ...emptyVisualContextDraft }, workflowId: workflowFilter !== 'all' && workflowFilter !== 'unassigned' ? workflowFilter : workflows[0]?.id ?? '' })
    setStatus(''); setEditor({ mode: 'create' })
  }
  const openEdit = (character: CharacterAsset) => {
    setDraft({ workflowId: character.workflowId ?? '', characterName: character.characterName,
      biography: character.biography ?? '', description: character.description, threeViewUrl: character.threeViewUrl, visual: visualContextDraftFrom(character) })
    setStatus(''); setEditor({ mode: 'edit', id: character.id })
  }
  const openVariant = (person: CharacterPerson, character?: CharacterAsset) => {
    if (!person.workflowId) return setStatus('此旧人物尚未关联工作流，不能新增三视图版本；原自传和装备仍会保留。')
    setDraft({ workflowId: person.workflowId ?? '', characterName: person.characterName,
      biography: person.biography ?? '', description: character?.description ?? '', threeViewUrl: '',
      visual: { ...(character ? visualContextDraftFrom(character) : emptyVisualContextDraft), enabled: true } })
    setStatus(''); setDetailPersonId(null); setDetailVersionId(null); setEditor({ mode: 'variant', id: character?.id })
  }
  const openDetail = (person: CharacterPerson, character?: CharacterAsset) => {
    setVoiceEditorId(null); setEquipmentDraft(null); setPortraitReviewNote(''); setDetailPersonId(person.id); setDetailVersionId(character?.id ?? preferredPortrait(person.versions)?.id ?? person.versions[0]?.id ?? null)
  }
  const reviewPortrait = async (decision: 'accept' | 'reject') => {
    if (!detail || !isPendingIdentityReview(detail) || !detailReviewHash) return setStatus('当前三视图缺少可审核的本地图像指纹，请刷新或联系管理员恢复原始候选图。')
    const note = portraitReviewNote.trim()
    if (note.length < 4 || note.length > 500) return setStatus('请填写 4–500 字的人工判断说明，再作出审核决定。')
    setSaving(true); setStatus('')
    try {
      await requestJson<{ character: CharacterAsset }>(`/api/characters/${encodeURIComponent(detail.id)}/portrait-review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, reviewedContentSha256: detailReviewHash, note }),
      })
      setPortraitReviewNote('')
      await refreshAfterWrite(decision === 'accept' ? '此图已由人工确认可用，审核记录及原始同脸结果已保留。' : '此图已拒绝并保留为历史候选，不再参与召回。')
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }
  const recoverPortrait = async (action: 'retry' | 'abandon') => {
    if (!detail || !detailUnrecoverable) return
    const note = portraitReviewNote.trim()
    if (action === 'abandon' && (note.length < 4 || note.length > 500)) return setStatus('放弃候选前请填写 4–500 字原因。')
    setSaving(true); setStatus('')
    try {
      await requestJson<{ character: CharacterAsset }>(`/api/characters/${encodeURIComponent(detail.id)}/portrait-recover`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...(action === 'abandon' ? { note } : {}) }),
      })
      setPortraitReviewNote('')
      await refreshAfterWrite(action === 'retry' ? '原始候选已恢复为本地图，请继续查看并人工核验。' : '不可读候选已放弃并保留记录；如需重生，请显式发起修订。')
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }
  const saveCharacter = async () => {
    if (!draft.characterName.trim()) return setStatus('请输入人物名称')
    if (!draft.workflowId) return setStatus('请选择所属工作流')
    if (!draft.threeViewUrl.trim()) return setStatus('请上传或填写此版本的三视图')
    setSaving(true); setStatus('')
    try {
      const isEdit = editor?.mode === 'edit'
      const metadata = characterVersionMetadata(matchingIdentity, draft.characterName, draft.visual, { newVersion: !isEdit })
      const payload = { workflowId: draft.workflowId, characterName: draft.characterName.trim(), biography: draftBiography, description: draft.description,
        threeViewUrl: draft.threeViewUrl, metadata }
      await requestJson<{ character: CharacterAsset }>(isEdit ? `/api/characters/${editor.id}` : '/api/characters', {
        method: isEdit ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      setEditor(null); setPage(1)
      await refreshAfterWrite(isEdit ? '人物版本已更新' : matchingPerson ? '三视图版本已添加，沿用同人物声音' : '三视图版本已添加')
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }
  const confirmDelete = async () => {
    if (!deleteTarget) return
    setSaving(true); setStatus('')
    try {
      await requestJson(`/api/characters/${deleteTarget.id}`, { method: 'DELETE' })
      const deletedId = deleteTarget.id
      setCharacters(current => current.filter(item => item.id !== deletedId))
      setPeople(current => current.map(person => ({ ...person, versions: person.versions.filter(item => item.id !== deletedId) })))
      setDeleteTarget(null)
      if (detailVersionId === deletedId) setDetailVersionId(null)
      await refreshAfterWrite('此三视图版本已删除')
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }
  const uploadImage = async (file?: File) => {
    if (!file) return
    if (!file.type.startsWith('image/')) return setStatus('请选择图片文件')
    if (file.size > 8 * 1024 * 1024) return setStatus('图片不能超过 8MB')
    try {
      const dataUrl = await imageToDataUrl(file)
      setDraft(current => ({ ...current, threeViewUrl: dataUrl })); setStatus('')
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
  }
  const openEquipmentEditor = (equipment?: CharacterEquipment) => {
    setStatus('')
    setEquipmentDraft(equipment ? { id: equipment.id, name: equipment.name, kind: equipment.kind,
      description: equipment.description, imageUrl: equipment.imageUrl, aliases: equipment.aliases.join('、'),
      ageStages: [...(equipment.applicability.ageStages ?? [])], lookKeys: (equipment.applicability.lookKeys ?? []).join('、'),
      sceneTags: (equipment.applicability.sceneTags ?? []).join('、') } : { ...emptyEquipmentDraft, ageStages: [] })
  }
  const splitLabels = (value: string) => [...new Set(value.split(/[、,，\n]/).map(item => item.trim()).filter(Boolean))]
  const saveEquipment = async () => {
    if (!detailPerson || !equipmentDraft) return
    if (!equipmentDraft.name.trim()) return setStatus('请输入装备名称')
    const payload: CharacterEquipmentInput = { name: equipmentDraft.name.trim(), kind: equipmentDraft.kind,
      description: equipmentDraft.description.trim(), imageUrl: equipmentDraft.imageUrl.trim(), aliases: splitLabels(equipmentDraft.aliases),
      applicability: { ageStages: equipmentDraft.ageStages as NonNullable<CharacterEquipment['applicability']['ageStages']>,
        lookKeys: splitLabels(equipmentDraft.lookKeys), sceneTags: splitLabels(equipmentDraft.sceneTags) } }
    setSaving(true); setStatus('')
    try {
      const base = `/api/character-people/${encodeURIComponent(detailPerson.id)}/equipment`
      const result = await requestJson<{ equipment: CharacterEquipment }>(equipmentDraft.id ? `${base}/${encodeURIComponent(equipmentDraft.id)}` : base,
        { method: equipmentDraft.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      setPeople(current => current.map(person => person.id === detailPerson.id ? { ...person, updatedAt: result.equipment.updatedAt,
        equipment: [...person.equipment.filter(item => item.id !== result.equipment.id), result.equipment] } : person))
      setEquipmentDraft(null)
      await refreshAfterWrite('装备已保存到人物资产')
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }
  const confirmDeleteEquipment = async () => {
    if (!detailPerson || !equipmentDeleteTarget) return
    setSaving(true); setStatus('')
    try {
      await requestJson(`/api/character-people/${encodeURIComponent(detailPerson.id)}/equipment/${encodeURIComponent(equipmentDeleteTarget.id)}`, { method: 'DELETE' })
      const deletedId = equipmentDeleteTarget.id
      setPeople(current => current.map(person => person.id === detailPerson.id ? {
        ...person, equipment: person.equipment.filter(item => item.id !== deletedId) } : person))
      setEquipmentDeleteTarget(null); setEquipmentDraft(null); setStatus('装备已删除')
      await refreshAfterWrite('装备已删除')
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }
  const uploadEquipmentImage = async (file?: File) => {
    if (!file) return
    if (!file.type.startsWith('image/')) return setStatus('请选择图片文件')
    if (file.size > 8 * 1024 * 1024) return setStatus('图片不能超过 8MB')
    try { const imageUrl = await imageToDataUrl(file); setEquipmentDraft(current => current ? { ...current, imageUrl } : current); setStatus('') }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
  }
  const editorTitle = editor?.mode === 'variant' ? `新增 ${draft.characterName} 的年龄/场景版本` : editor?.mode === 'edit' ? '编辑人物版本' : '新建人物版本'

  return <section className="workspace character-library">
    <details className="character-voice-panel"><summary>工作流旁白声音</summary><p>每个工作流沿用同一旁白声音，可在这里查看和调整。</p>
      <label>旁白所属工作流<select value={narratorWorkflowId} onChange={event => setNarratorWorkflowId(event.target.value)}><option value="">请选择工作流</option>{workflows.map(workflow => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</select></label>
      {narratorWorkflowId ? <CharacterVoicePanel key={narratorWorkflowId} characterId={`narrator:${narratorWorkflowId}`} characterName="旁白" /> : null}
    </details>
    <header className="character-hero">
      <div className="character-hero-copy"><span className="character-eyebrow"><UserRoundSearch size={15} /> CHARACTER ARCHIVE</span><h1>人物资产库</h1><p>每个人物集中管理不同年龄、场景的三视图、装备与声音；工作流按实际条件召回合适资产。</p></div>
      <button className="primary-btn character-create-btn" onClick={openCreate}><Plus size={17} />新建人物</button>
    </header>
    <div className="character-stats" aria-label="人物库概览">
      <div><span className="stat-icon coral"><UsersRound size={18} /></span><p><strong>{identityCount}</strong><small>人物资产</small></p></div>
      <div><span className="stat-icon teal"><WorkflowIcon size={18} /></span><p><strong>{characters.length}</strong><small>三视图版本</small></p></div>
      <div><span className="stat-icon blue"><UserRoundSearch size={18} /></span><p><strong>{people.reduce((count, person) => count + person.equipment.length, 0)}</strong><small>归属装备</small></p></div>
    </div>
    <section className="character-panel">
      <div className="character-toolbar">
        <div className="character-search"><Search size={18} /><input aria-label="搜索人物资产" placeholder="搜索人物、自传、年龄、场景或装备" value={query} onChange={event => { setQuery(event.target.value); setPage(1) }} />{query ? <button aria-label="清空搜索" onClick={() => { setQuery(''); setPage(1) }}><X size={15} /></button> : null}</div>
        <label className="character-filter"><span>所属工作流</span><select value={workflowFilter} onChange={event => { setWorkflowFilter(event.target.value); setLookFilter('all'); setPeriodFilter('all'); setPage(1) }}><option value="all">全部工作流</option>{workflows.map(workflow => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}<option value="unassigned">未关联工作流</option></select></label>
        <button className="character-refresh" title="刷新人物库" aria-label="刷新人物库" onClick={() => void loadCharacters()} disabled={loading}><RefreshCw size={17} className={loading ? 'spinning' : ''} /></button>
      </div>
      <div className="character-context-filters">
        <label className="character-filter"><span>年龄阶段</span><select value={ageFilter} onChange={event => { setAgeFilter(event.target.value); setPage(1) }}><option value="all">全部年龄阶段</option>{AGE_STAGES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}<option value="unmarked">旧版本未标注</option></select></label>
        <label className="character-filter"><span>年龄依据</span><select value={basisFilter} onChange={event => { setBasisFilter(event.target.value); setPage(1) }}><option value="all">全部年龄依据</option>{AGE_BASES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}<option value="unmarked">旧版本未标注</option></select></label>
        <label className="character-filter"><span>适用年代</span><select value={periodFilter} onChange={event => { setPeriodFilter(event.target.value); setPage(1) }}><option value="all">全部剧情时间</option>{periodOptions.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="character-filter"><span>适用场合 / 造型</span><select value={lookFilter} onChange={event => { setLookFilter(event.target.value); setPage(1) }}><option value="all">全部造型</option>{lookOptions.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      </div>
      <div className="character-table-meta"><div><strong>人物资产</strong><span>共 {filtered.length} 位人物</span></div>{status ? <span className="character-status" role="status">{status}</span> : null}</div>
      <div className="character-table-wrap"><table className="character-table">
        <thead><tr><th>人物</th><th>年龄 / 场景</th><th>三视图</th><th>归属装备</th><th>人物声音</th><th>所属工作流</th><th><span className="sr-only">操作</span></th></tr></thead>
        <tbody>{visiblePeople.map(person => {
          const currentVersions = currentPortraits(person.versions)
          const representative = preferredPortrait(person.versions)
          const pendingCount = person.versions.filter(isPendingIdentityReview).length
          const historicalCount = person.versions.filter(version => isSupersededPortrait(version) && !isPendingIdentityReview(version)).length
          const ageLabels = characterPersonAgeLabels(currentVersions)
          const lookLabels = [...new Set(currentVersions.map(version => contexts.get(version.id)?.look ?? '场景造型未标注'))]
          const voice = person.voice ?? person.versions.find(version => version.voice)?.voice
          return <tr key={person.id}>
            <td><div className="character-identity"><div className="character-avatar">{representative?.threeViewUrl ? <img src={representative.threeViewUrl} alt="" /> : person.characterName.slice(0, 1)}</div><div><strong>{person.characterName}</strong><small>{currentVersions.length} 个当前造型{pendingCount ? ` · ${pendingCount} 个待身份核验` : ''}{historicalCount ? ` · ${historicalCount} 个历史候选` : ''} · {formatDate(person.updatedAt)}</small>{person.biography ? <button className="character-biography-link" onClick={() => openDetail(person)} aria-label={`查看 ${person.characterName} 自传`}>查看自传</button> : null}</div></div></td>
            <td><div className="character-person-context"><strong>{ageLabels.slice(0, 2).join('、') || '尚无三视图'}</strong><small>{lookLabels.slice(0, 3).join('、') || '可新增年龄/场景版本'}{lookLabels.length > 3 ? ` 等 ${lookLabels.length} 种造型` : ''}</small></div></td>
            <td>{representative ? <button className="three-view-thumb" onClick={() => openDetail(person, representative)} title={`查看 ${person.characterName} 全部三视图`}><img src={representative.threeViewUrl} alt={`${person.characterName}三视图`} /><span><Eye size={13} />查看全部 {person.versions.length} 版</span></button> : <span className="character-muted">{person.versions.length ? '暂无可自动召回三视图' : '暂无三视图'}</span>}</td>
            <td><button className="character-person-equipment-link" onClick={() => openDetail(person)} aria-label={`查看 ${person.characterName} 装备`}><strong>{person.equipment.length} 件装备</strong><small>{person.equipment.slice(0, 2).map(item => item.name).join('、') || '点击添加人物装备'}</small></button></td>
            <td><button className="character-voice-link" title={`查看 ${person.characterName} 声音`} onClick={() => openDetail(person)}>{voice ? `${voice.voiceName} · V${voice.version}${person.voiceAvailable === false ? ' · 已停用' : ''}` : person.originalVoice?.status === 'ready' ? '原创声线已归档 · 待视频绑定' : person.voiceAmbiguous ? '多个声音身份待核对' : '查看 / 绑定声音'}</button><small className="character-shared-voice">同人物各造型共用</small></td>
            <td><span className={person.workflowId ? 'workflow-pill' : 'workflow-pill muted'}><WorkflowIcon size={13} />{person.workflowId ? workflowNames.get(person.workflowId) ?? '未知工作流' : '未关联'}</span></td>
            <td><div className="row-actions"><button title="查看人物资产" aria-label={`查看 ${person.characterName} 人物资产`} onClick={() => openDetail(person)}><Eye size={16} /></button><button title="新增年龄/场景版本" aria-label={`新增 ${person.characterName} 年龄/场景版本`} onClick={() => openVariant(person, representative)}><Plus size={16} /></button></div></td>
          </tr>
        })}</tbody>
      </table>
        {loading ? <div className="character-empty"><RefreshCw className="spinning" size={24} /><strong>正在读取人物库</strong><span>读取人物的三视图和声音资料...</span></div> : null}
        {!loading && !visiblePeople.length ? <div className="character-empty"><span className="empty-portrait"><UserRoundSearch size={28} /></span><strong>{people.length ? '没有匹配的人物' : '人物库还是空的'}</strong><span>{people.length ? '尝试更换搜索词、年龄阶段、年代或造型筛选。' : '创建第一个人物，填写剧情年龄和适用造型。'}</span>{!people.length ? <button className="primary-btn" onClick={openCreate}><Plus size={16} />新建人物</button> : null}</div> : null}
      </div>
      <footer className="character-pagination"><span>第 {currentPage} / {pageCount} 页</span><div><button aria-label="上一页" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} /></button><strong>{currentPage}</strong><button aria-label="下一页" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}><ChevronRight size={16} /></button></div></footer>
    </section>

    {editor ? <div className="character-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !saving) setEditor(null) }}><aside className="character-drawer" role="dialog" aria-modal="true" aria-label={editorTitle}>
      <header><div><span>{editor.mode === 'edit' ? 'EDIT VERSION' : 'NEW VERSION'}</span><h2>{editorTitle}</h2><p>{editor.mode === 'variant' ? '保存为独立三视图版本，沿用原人物身份和声音。' : '标明本版本的剧情年龄、年代与服装造型。'}</p></div><button className="drawer-close" aria-label="关闭" disabled={saving} onClick={() => setEditor(null)}><X size={19} /></button></header>
      <div className="drawer-body">
        <section className="character-form-section"><div className="character-section-title"><h3>人物身份</h3></div><div className="character-form-grid">
          <label><span>所属工作流 <em>*</em></span><select disabled={editor.mode !== 'create'} value={draft.workflowId} onChange={event => setDraft(current => ({ ...current, workflowId: event.target.value }))}><option value="">请选择工作流</option>{draft.workflowId && !workflows.some(workflow => workflow.id === draft.workflowId) ? <option value={draft.workflowId}>已归档工作流（{draft.workflowId}）</option> : null}{workflows.map(workflow => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</select></label>
          <label><span>人物名称 <em>*</em></span><input autoFocus={editor.mode === 'create'} disabled={editor.mode !== 'create'} list="character-identity-names" value={draft.characterName} maxLength={40} placeholder="例如：刘备" onChange={event => setDraft(current => ({ ...current, characterName: event.target.value }))} /><datalist id="character-identity-names">{[...new Set(characters.filter(item => item.workflowId === draft.workflowId).map(item => item.characterName))].map(name => <option key={name} value={name} />)}</datalist></label>
        </div><p className="character-identity-note">{matchingIdentity ? `${draft.characterName} 的新造型沿用同一人物声音${matchingPerson?.voice || matchingIdentity.voice ? `：${(matchingPerson?.voice ?? matchingIdentity.voice)?.voiceName}` : '；可在详情中查看或绑定'}。` : '同工作流中，同名人物的不同版本沿用同一声音。'}{editor.mode !== 'create' ? ' 已有人物的名称与工作流固定，以保护装备、自传和声音的归属。' : ''}</p>
          <label className="character-biography-field"><span>人物自传描述 <small>可留空</small></span><textarea aria-label="人物自传描述" rows={6} maxLength={CHARACTER_BIOGRAPHY_MAX_LENGTH} value={draftBiography} placeholder="记录人物的身世、重要经历、性格、信念与关系，可用第一人称讲述：我生于……，经历……，始终……" onChange={event => setDraft(current => ({ ...current, biography: event.target.value }))} /><small className="field-help">同一工作流中，同名人物的所有年龄与造型版本共用此自传，修改后同步更新。</small><small>{draftBiography.length}/{CHARACTER_BIOGRAPHY_MAX_LENGTH}</small></label>
        </section>
        {editor.mode === 'edit' && !draft.visual.enabled ? <label className="character-context-toggle"><input type="checkbox" checked={draft.visual.enabled} onChange={event => setDraft(current => ({ ...current, visual: { ...current.visual, enabled: event.target.checked } }))} /><span>为旧版本补充剧情年龄与造型</span><small>旧图未标注不代表人物处于任何确定年龄。</small></label> : null}
        {draft.visual.enabled ? <VisualContextFields value={draft.visual} onChange={visual => setDraft(current => ({ ...current, visual }))} /> : null}
        <label><span>人物补充描述</span><textarea rows={3} maxLength={500} value={draft.description} placeholder="脸型、气质等补充描述；年龄与服装请在上方单独填写" onChange={event => setDraft(current => ({ ...current, description: event.target.value }))} /><small>{draft.description.length}/500</small></label>
        <div className="three-view-field"><div><strong>此版本三视图 <em>*</em></strong><span>正面、侧面、背面的横版合图，JPG / PNG，最大 8MB。</span></div>
          {editor.mode === 'variant' && editorBase ? <div className="character-reference-image"><img src={editorBase.threeViewUrl} alt={`${editorBase.characterName} 原版本参考`} /><div><strong>原版本仅作参考</strong><span>上传符合新年龄或造型的三视图，原版本会继续保留。</span></div></div> : null}
          {draft.threeViewUrl ? <div className="three-view-upload-preview"><img src={draft.threeViewUrl} alt="待保存的此版本三视图" /><label><ImagePlus size={16} />替换图片<input type="file" accept="image/*" onChange={event => void uploadImage(event.target.files?.[0])} /></label></div> : <label className="three-view-drop"><ImagePlus size={25} /><strong>上传此版本三视图</strong><span>点击选择本地文件</span><input type="file" accept="image/*" onChange={event => void uploadImage(event.target.files?.[0])} /></label>}
          <label className="image-url-field"><span>或填写图片 URL</span><input value={draft.threeViewUrl.startsWith('data:') ? '' : draft.threeViewUrl} placeholder="https://..." onChange={event => setDraft(current => ({ ...current, threeViewUrl: event.target.value }))} /></label>
        </div>
        {status ? <p className="drawer-error" role="alert"><AlertTriangle size={15} />{status}</p> : null}
      </div><footer><button className="ghost-btn" onClick={() => setEditor(null)} disabled={saving}>取消</button><button className="primary-btn" onClick={() => void saveCharacter()} disabled={saving}>{saving ? '保存中...' : editor.mode === 'edit' ? '保存修改' : '保存新版本'}</button></footer>
    </aside></div> : null}

    {detailPerson ? <div className="character-overlay detail-overlay" onMouseDown={event => { if (event.target === event.currentTarget) setDetailPersonId(null) }}><section className="character-detail-modal" role="dialog" aria-modal="true" aria-label={`${detailPerson.characterName} 人物资产详情`}>
      <header><div><span>人物资产 · {currentPortraits(detailVersions).length} 个当前造型{detailPendingCount ? ` · ${detailPendingCount} 个待身份核验` : ''}{detailHistoricalCount ? ` · ${detailHistoricalCount} 个历史候选` : ''} · {detailPerson.equipment.length} 件装备</span><h2>{detailPerson.characterName}</h2><p className="character-detail-context">{detailPerson.workflowId ? workflowNames.get(detailPerson.workflowId) ?? '未知工作流' : '未关联工作流'} · 最近更新 {formatDate(detailPerson.updatedAt)}</p></div><button className="drawer-close" aria-label="关闭" onClick={() => setDetailPersonId(null)}><X size={19} /></button></header>
      <section className="character-related-versions"><div><h3>年龄 / 场景三视图</h3><span>{detailVersions.length} 个版本</span></div>
        {detailVersions.length ? <div className="character-version-list">{detailVersions.map(character => {
          const context = contexts.get(character.id)!
          return <article key={character.id} className={[character.id === detail?.id ? 'selected' : '', isSupersededPortrait(character) ? 'character-version-superseded' : '', isPendingIdentityReview(character) ? 'character-version-pending' : ''].filter(Boolean).join(' ')}><button className="character-version-select" onClick={() => { setDetailVersionId(character.id); setPortraitReviewNote(''); setVoiceEditorId(null) }} aria-label={`查看 ${character.characterName} ${context.age} ${context.look} 三视图`}><img src={character.threeViewUrl} alt="" /><span><strong>{context.look}</strong><small>{context.age}</small><small>{context.period}</small>{isRejectedPortraitReview(character) ? <small className="character-history-label">人工拒绝 / 放弃 · 历史留存</small> : isSupersededPortrait(character) ? <small className="character-history-label">历史候选 · 不再自动召回</small> : null}{isPendingIdentityReview(character) ? <small className="character-pending-label">{(character.metadata.portraitLifecycle as Record<string, unknown> | undefined)?.status === 'pending-unrecoverable' ? '原图待恢复 · 暂不召回' : '待身份核验 · 暂不自动召回'}</small> : null}</span></button><div className="character-version-actions"><button onClick={() => { openEdit(character); setDetailPersonId(null) }} aria-label={`编辑 ${context.look} 版本`}><Pencil size={14} />编辑</button><button className="danger-text" onClick={() => setDeleteTarget(character)} aria-label={`删除 ${context.look} 版本`}><Trash2 size={14} />删除</button></div></article>
        })}</div> : <p className="character-section-empty">此人物暂无三视图。装备与自传会保留，可继续新增年龄/场景版本。</p>}
      </section>
      {detail && detailContext ? <><div className="detail-three-view"><img src={detail.threeViewUrl} alt={`${detail.characterName} ${detailContext.look}三视图`} /><span>FRONT · SIDE · BACK</span></div>
        {detailUnrecoverable ? <section className="character-portrait-review" aria-label="不可读候选恢复">
          <h3>原始候选图暂不可读</h3><p>图片已付费生成，模型任务和原始地址已留存，但尚未能安全转存本地图。此图不能进入工作流。可尝试重新抓取原图；恢复成功后仍需查看三视图并作人工审核。如原图已过期，可写明原因放弃此候选，之后再显式发起修订。</p>
          <div className="character-portrait-review-evidence"><span>原地址指纹：{String(detailLifecycle?.originalUriFingerprint ?? '').slice(0, 16)}…</span><span>任务 ID：{String(detailLifecycle?.candidateTaskId ?? '未知')}</span><span>读取诊断：{String(detailLifecycle?.diagnostic ?? '未记录')}</span></div>
          <label><span>放弃候选原因（4–500 字）</span><textarea aria-label="放弃不可读候选原因" rows={3} maxLength={500} value={portraitReviewNote} onChange={event => setPortraitReviewNote(event.target.value)} placeholder="如原始地址已失效，请说明放弃原因" /></label>
          <div className="character-portrait-review-actions"><button className="ghost-btn" disabled={saving || portraitReviewNote.trim().length < 4} onClick={() => void recoverPortrait('abandon')}>放弃此不可读候选</button><button className="primary-btn" disabled={saving} onClick={() => void recoverPortrait('retry')}>尝试恢复原图</button></div>
        </section> : isPendingIdentityReview(detail) ? <section className="character-portrait-review" aria-label="待核验三视图人工审核">
          <h3>人工核验此三视图</h3>
          <p>请先查看上方候选图的正、侧、背三面，再与下方已归档人物参考图对照脸部、服装和三视图一致性。接受后此版本可进入工作流；拒绝后仅作历史留存。决定绑定当前图片字节，不会覆盖模型原始判断。</p>
          {detailReviewSource ? <div className="character-portrait-review-reference"><img src={detailReviewSource.threeViewUrl} alt={`${detail.characterName} 已归档人物身份参考三视图`} /><span>人物身份参考 · {characterContextSummary(detailReviewSource).look}</span></div>
            : <p className="character-portrait-review-unknown">此候选没有可显示的身份参考图，请结合人物既有版本和生成要求核验。</p>}
          <div className="character-portrait-review-evidence"><span>候选图指纹：{detailReviewHash ? `${detailReviewHash.slice(0, 16)}…` : '缺失，暂不可审核'}</span>
            <span>同脸检测：{typeof detailIdentityConsistency?.distance === 'number' ? `距离 ${detailIdentityConsistency.distance.toFixed(3)}（阈值 ${String(detailIdentityConsistency.threshold ?? '—')}）` : String(detailIdentityConsistency?.reason ?? '本批次审核未完成')}</span>
            {typeof detailIdentityConsistency?.diagnostic === 'string' ? <span>检测说明：{detailIdentityConsistency.diagnostic}</span> : null}</div>
          <label><span>人工判断说明（4–500 字）</span><textarea aria-label="三视图人工判断说明" rows={3} maxLength={500} value={portraitReviewNote} onChange={event => setPortraitReviewNote(event.target.value)} placeholder="说明面貌是否与参考一致、三面服装是否连贯，以及接受或拒绝的原因" /></label>
          <div className="character-portrait-review-actions"><button className="ghost-btn" disabled={saving || !detailReviewHash || portraitReviewNote.trim().length < 4} onClick={() => void reviewPortrait('reject')}>拒绝此图</button><button className="primary-btn" disabled={saving || !detailReviewHash || portraitReviewNote.trim().length < 4} onClick={() => void reviewPortrait('accept')}>确认此图可用</button></div>
        </section> : detailReviewDecision?.version === 'manual-portrait-review-v1' || detailReviewDecision?.version === 'manual-portrait-abandon-v1' ? <section className="character-portrait-review-record"><strong>{detailReviewDecision.decision === 'accept' ? '人工确认可用' : detailReviewDecision.decision === 'abandon' ? '原始候选已放弃' : '人工拒绝此图'}</strong><span>审核于 {formatDate(String(detailReviewDecision.reviewedAt ?? ''))}{detailReviewDecision.decision === 'abandon'
          ? ` · 原地址指纹 ${String(detailLifecycle?.originalUriFingerprint ?? '').slice(0, 16)}… · 任务 ID ${String(detailLifecycle?.candidateTaskId ?? '未知')}`
          : ` · 图像指纹 ${String(detailReviewDecision.reviewedContentSha256 ?? '').slice(0, 16)}…`}</span><p>{String(detailReviewDecision.note ?? '')}</p></section> : null}
        <div className="detail-info">
          <div><span>当前查看版本</span><strong>修订 V{detail.version}{isSupersededPortrait(detail) ? ' · 历史候选' : ''}</strong></div><div><span>最近更新</span><strong>{formatDate(detail.updatedAt)}</strong></div>
          <div><span>剧情年龄</span><strong>{detailContext.age}</strong></div><div><span>年龄依据</span><strong>{detailContext.basis}</strong></div>
          <div><span>适用剧情时间 / 年代</span><strong>{detailContext.period}</strong></div><div><span>适用场合 / 造型</span><strong>{detailContext.look}</strong></div>
          <div className="wide"><span>造型描述</span><p>{detailContext.description || '此旧版本尚未标注造型。可编辑资料补充。'}</p></div>
          {detailContext.context?.age.basis === 'artistic' ? <div className="wide character-context-notice">年龄属于本剧艺术设定，不作为历史确证。</div> : null}
          {detailContext.context?.age.basis === 'estimated' ? <div className="wide character-context-notice">年龄为史料估计，具体岁数仍有不确定性。</div> : null}
          {detailContext.sourceRefs.length ? <div className="wide"><span>年龄依据与不确定性</span><ul className="character-sources">{detailContext.sourceRefs.map(source => <li key={source}>{safeSourceUrl(source) ? <a href={source} target="_blank" rel="noreferrer">{source}</a> : source}</li>)}</ul></div> : null}
          {detailContext.context?.appearanceConstraints ? <div className="wide"><span>外观要求</span><p>{[HAIR_LABELS[detailContext.context.appearanceConstraints.hair ?? 'unknown'], BEARD_LABELS[detailContext.context.appearanceConstraints.facialHair ?? 'unknown'], detailContext.context.appearanceConstraints.build].filter(Boolean).join(' · ')}</p></div> : null}
          <div className="wide"><span>人物补充描述</span><p>{detail.description || '尚未填写补充描述'}</p></div>
          {sharedPortraitEvidence ? <div className="wide"><span>正史体貌记载 · 人物共用</span><p className="character-shared-portrait-evidence">{sharedPortraitEvidence.split('\n').map((line, index) => safeSourceUrl(line)
            ? <a key={index} href={line} target="_blank" rel="noreferrer">{line}</a>
            : <span key={index}>{line || '\u00a0'}</span>)}</p></div> : null}
          {detailPortrait ? <details className="wide character-portrait-retrieval-history" open={!sharedPortraitEvidence}><summary>此三视图生成时的史料检索记录</summary><p>{String(detailPortrait.description || detailPortrait.reason || '当时未取得可靠体貌引文')}</p>{detailPortraitCitations.map((citation, index) => {
            const url = String(citation.url || '')
            return <p key={`${url}-${index}`}>{safeSourceUrl(url) ? <a href={url} target="_blank" rel="noreferrer">{String(citation.title || `史料 ${index + 1}`)}</a> : String(citation.title || `史料 ${index + 1}`)}：{String(citation.quote || '')}</p>
          })}</details> : null}
        </div></> : null}
      <details className="character-person-profile"><summary>人物自传描述 · 同人物各版本共用{detailPerson.biography ? <small>点击展开全文</small> : null}</summary><p>{detailPerson.biography || '尚未填写自传描述，可在编辑三视图版本时补充。'}</p></details>
      <section className="character-equipment-section"><div className="character-section-heading"><div><h3>人物装备</h3><p>武器、甲胄和道具归属此人物，可限定适用年龄、造型与场景。</p></div><button className="ghost-btn" onClick={() => openEquipmentEditor()}><Plus size={15} />添加装备</button></div>
        {detailPerson.equipment.length ? <div className="character-equipment-list">{detailPerson.equipment.map(equipment => <article key={equipment.id}>
          {equipment.imageUrl ? <img src={equipment.imageUrl} alt={`${equipment.name} 装备图`} /> : <div className="character-equipment-placeholder">{EQUIPMENT_KINDS[equipment.kind]}</div>}
          <div className="character-equipment-copy"><strong>{equipment.name}</strong><small>{EQUIPMENT_KINDS[equipment.kind]}{equipment.aliases.length ? ` · 别名：${equipment.aliases.join('、')}` : ''}</small><p>{equipment.description || '尚未填写装备描述'}</p><small>适用：{[...(equipment.applicability.ageStages ?? []).map(stage => AGE_STAGES.find(option => option.value === stage)?.label ?? stage), ...(equipment.applicability.lookKeys ?? []), ...(equipment.applicability.sceneTags ?? [])].join(' · ') || '全部年龄与场景'}</small></div>
          <div className="character-equipment-actions"><button aria-label={`编辑装备 ${equipment.name}`} onClick={() => openEquipmentEditor(equipment)}><Pencil size={15} /></button><button aria-label={`删除装备 ${equipment.name}`} className="danger-text" onClick={() => setEquipmentDeleteTarget(equipment)}><Trash2 size={15} /></button></div>
        </article>)}</div> : <p className="character-section-empty">此人物暂无装备；添加后可在人物召回时按装备条件选择。</p>}
        {equipmentDraft ? <div className="character-equipment-editor"><h4>{equipmentDraft.id ? '编辑装备' : '添加人物装备'}</h4><div className="character-form-grid">
          <label><span>装备名称 <em>*</em></span><input value={equipmentDraft.name} maxLength={120} placeholder="例如：丈八蛇矛" onChange={event => setEquipmentDraft(current => current ? { ...current, name: event.target.value } : current)} /></label>
          <label><span>类型</span><select value={equipmentDraft.kind} onChange={event => setEquipmentDraft(current => current ? { ...current, kind: event.target.value as EquipmentDraft['kind'] } : current)}>{Object.entries(EQUIPMENT_KINDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="wide"><span>装备描述</span><textarea rows={2} value={equipmentDraft.description} maxLength={500} placeholder="材质、形制、颜色与稳定识别特征" onChange={event => setEquipmentDraft(current => current ? { ...current, description: event.target.value } : current)} /></label>
          <label className="wide"><span>别名 <small>用顿号分隔</small></span><input value={equipmentDraft.aliases} placeholder="例如：蛇矛、长矛" onChange={event => setEquipmentDraft(current => current ? { ...current, aliases: event.target.value } : current)} /></label>
          <fieldset className="wide character-equipment-age"><legend>适用年龄阶段 <small>不选即不限</small></legend>{AGE_STAGES.filter(option => option.value !== 'unknown').map(option => <label key={option.value}><input type="checkbox" checked={equipmentDraft.ageStages.includes(option.value)} onChange={event => setEquipmentDraft(current => current ? { ...current, ageStages: event.target.checked ? [...current.ageStages, option.value] : current.ageStages.filter(stage => stage !== option.value) } : current)} />{option.label}</label>)}</fieldset>
          <label><span>适用造型 <small>用顿号分隔；留空不限</small></span><input value={equipmentDraft.lookKeys} placeholder="例如：行军甲胄" onChange={event => setEquipmentDraft(current => current ? { ...current, lookKeys: event.target.value } : current)} /></label>
          <label><span>适用场景标签 <small>用顿号分隔；留空不限</small></span><input value={equipmentDraft.sceneTags} placeholder="例如：战场、骑行" onChange={event => setEquipmentDraft(current => current ? { ...current, sceneTags: event.target.value } : current)} /></label>
          <label className="wide"><span>装备图片</span><input value={equipmentDraft.imageUrl.startsWith('data:') ? '' : equipmentDraft.imageUrl} placeholder="图片 URL，或选择本地图片" onChange={event => setEquipmentDraft(current => current ? { ...current, imageUrl: event.target.value } : current)} /><input type="file" accept="image/*" aria-label="上传装备图片" onChange={event => void uploadEquipmentImage(event.target.files?.[0])} />{equipmentDraft.imageUrl ? <img className="character-equipment-preview" src={equipmentDraft.imageUrl} alt="待保存装备预览" /> : null}</label>
        </div><div className="character-equipment-editor-actions"><button className="ghost-btn" onClick={() => setEquipmentDraft(null)} disabled={saving}>取消</button><button className="primary-btn" onClick={() => void saveEquipment()} disabled={saving}>{saving ? '保存中...' : '保存装备'}</button></div></div> : null}
      </section>
      <div className="character-detail-voice"><h3>人物声音</h3>
        {detailPerson.voice ? <><p>{detailPerson.voice.voiceName} · V{detailPerson.voice.version}{detailPerson.voiceAvailable === false ? ' · 已停用' : ' · 已绑定视频服务'}。同人物的不同年龄和造型版本共用此声音。</p>
          {detailPerson.voice.previewUrl ? <div><small>视频服务声音试听</small><audio controls preload="none" src={detailPerson.voice.previewUrl} /></div> : null}</>
          : <p>{detailPerson.voiceAmbiguous ? '此人物有多个既有声音身份，请在配置中核对，避免错误替换。' : detailPerson.originalVoice?.status === 'ready' ? '原创声线已归档，视频服务人物声音尚未绑定。' : '尚未绑定人物声音。'}</p>}
        {detailPerson.originalVoice ? <div><strong>原创声线</strong><p>{detailPerson.originalVoice.description || '尚无声线描述'} · {detailPerson.originalVoice.status === 'ready' ? '已归档' : '创建处理中'}</p>
          {detailPerson.originalVoice.status === 'ready' && detailPerson.originalVoice.previewUrl ? <audio controls preload="none" src={detailPerson.originalVoice.previewUrl} /> : null}</div> : null}
        {detail ? voiceEditorId === detail.id ? <CharacterVoicePanel key={detail.id} characterId={detail.id} characterName={detail.characterName} onChanged={() => void loadCharacters()} /> : <button className="ghost-btn" onClick={() => setVoiceEditorId(detail.id)}>配置人物声音</button> : null}
      </div>
      {status ? <p className="character-detail-status" role="status">{status}</p> : null}
      <footer><button className="primary-btn" onClick={() => openVariant(detailPerson, detail)}><Plus size={16} />新增年龄/场景版本</button></footer>
    </section></div> : null}
    {deleteTarget ? <div className="character-overlay confirm-overlay"><section className="delete-confirm" role="alertdialog" aria-modal="true" aria-label="删除三视图版本"><span className="delete-icon"><Trash2 size={22} /></span><h2>删除“{deleteTarget.characterName}”此版本？</h2><p>此三视图版本将永久删除，其他年龄与造型版本继续保留。</p><div><button className="ghost-btn" onClick={() => setDeleteTarget(null)} disabled={saving}>取消</button><button className="delete-btn" onClick={() => void confirmDelete()} disabled={saving}>{saving ? '删除中...' : '确认删除'}</button></div></section></div> : null}
    {equipmentDeleteTarget ? <div className="character-overlay confirm-overlay"><section className="delete-confirm" role="alertdialog" aria-modal="true" aria-label="删除人物装备"><span className="delete-icon"><Trash2 size={22} /></span><h2>删除装备“{equipmentDeleteTarget.name}”？</h2><p>此装备将从人物资产中删除；三视图版本和其他装备继续保留。</p><div><button className="ghost-btn" onClick={() => setEquipmentDeleteTarget(null)} disabled={saving}>取消</button><button className="delete-btn" onClick={() => void confirmDeleteEquipment()} disabled={saving}>{saving ? '删除中...' : '确认删除'}</button></div></section></div> : null}
  </section>
}
