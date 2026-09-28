import { useState } from 'react'
import { bailianVoiceCatalog, bailianVoiceOptions } from './bailian-tts'

export function BailianVoicePicker({ model, value, disabled, onChange }: { model: string; value: string; disabled?: boolean; onChange: (voice: string) => void }) {
  const [search, setSearch] = useState('')
  const [previewError, setPreviewError] = useState('')
  const voices = bailianVoiceOptions(model)
  const selected = voices.find(v => v.value === value)
  const query = search.trim().toLowerCase()
  const filtered = voices.filter(v => `${v.label} ${v.value} ${v.scene ?? ''}`.toLowerCase().includes(query))
  const shown = selected && !filtered.includes(selected) ? [selected, ...filtered] : filtered
  return <section className="experience-field" aria-label="音色选择与试听">
    <label>搜索音色<input value={search} onChange={e => setSearch(e.target.value)} placeholder="名称、性别、年龄、语言、特质或 ID" disabled={disabled} /></label>
    <label>音色 ID<select value={selected ? value : '__custom__'} disabled={disabled} onChange={e => { setPreviewError(''); onChange(e.target.value === '__custom__' ? '' : e.target.value) }}>
      {['系统音色','基础音色'].map(kind => <optgroup label={kind} key={kind}>{shown.filter(v => v.kind === kind).map(v => <option value={v.value} key={v.value}>{v.label}</option>)}</optgroup>)}
      <option value="__custom__">自定义音色 ID</option>
    </select></label>
    {!selected ? <label>自定义音色 ID<input value={value} onChange={e => onChange(e.target.value)} disabled={disabled} placeholder="填写与当前模型匹配的定制音色 ID" /></label> : <>
      <small>{selected.value} · {selected.kind}{selected.scene ? ` · ${selected.scene}` : ''}</small>
      <audio key={selected.previewUrl} aria-label={`${selected.name} 官方样音试听`} controls preload="none" src={selected.previewUrl} onError={() => setPreviewError('样音加载失败，请稍后重试；仍可使用合成台词生成试听。')} />
    </>}
    {previewError ? <small role="alert">{previewError}</small> : null}
    {!selected ? <small>自定义音色没有公开样音，可填写短台词后发起生成试听。</small> : null}
    <small>当前模型共 {voices.length} 个音色，搜索匹配 {filtered.length} 个。官方样音用于选声，不受本次情绪及语速参数影响。</small>
    <small><a href={bailianVoiceCatalog.source} target="_blank" rel="noreferrer">阿里云完整音色来源</a> · 更新于 {bailianVoiceCatalog.updatedAt}</small>
  </section>
}
