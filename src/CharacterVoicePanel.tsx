import { useEffect, useState } from 'react'
import type { CharacterVoice } from './character-voice'
import './character-voice.css'

type Voice = { voiceId: string; voiceName: string; previewUrl: string; source: string }
type Job = { modelId: string; id: string; status: string; kind: string; error?: string }
type VoiceState = { current: CharacterVoice | null; versions: CharacterVoice[]; jobs: Job[]; originalVoice?: { voiceId: string; description: string; previewUrl: string | null; targetModel: string; status: string }; availability?: Array<{ version: number; enabled: boolean; reason: string }> }
type VoiceImpact = { executionCount: number; requestCount: number; executions: Array<{ executionId: string; version: number }>; requests: Array<{ id: string; executionId: string; requestKey: string; nodeName: string; taskId: string; status: string; version: number }> }
async function api<T>(route: string, body?: object): Promise<T> {
  const response = await fetch(`/api/character-voices/${route}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  const value = await response.json()
  if (!response.ok) throw Error(value.error || `HTTP ${response.status}`)
  return value
}

export default function CharacterVoicePanel({ characterId, characterName, onChanged }: { characterId: string; characterName: string; onChanged?: () => void }) {
  const [state, setState] = useState<VoiceState>({ current: null, versions: [], jobs: [] })
  const [models, setModels] = useState<Array<{ id: string; name: string; modelName: string }>>([])
  const [modelId, setModelId] = useState('')
  const [voices, setVoices] = useState<Voice[]>([])
  const [voiceId, setVoiceId] = useState('')
  const [played, setPlayed] = useState(false)
  const [page, setPage] = useState(1)
  const [voiceName, setVoiceName] = useState(`${characterName}声音`)
  const [voiceUrl, setVoiceUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [impact, setImpact] = useState<VoiceImpact | null>(null)
  const [availabilityReason, setAvailabilityReason] = useState('')
  const unavailable = (version: number) => state.availability?.find(a => a.version === version)?.enabled === false
  const selected = voices.find(v => v.voiceId === voiceId)
  useEffect(() => {
    let active = true
    Promise.all([api<VoiceState>(`character?id=${encodeURIComponent(characterId)}`), api<{ models: typeof models }>('models')])
      .then(([value, catalog]) => { if (active) { setState(value); const supported = characterId.startsWith('narrator:') ? catalog.models.filter(m => m.modelName === 'kling-v2-6') : catalog.models; setModels(supported); setModelId(supported.find(m => m.id === value.current?.modelId)?.id ?? supported[0]?.id ?? '') } })
      .catch(error => { if (active) setMessage(String(error)) })
    return () => { active = false }
  }, [characterId])

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setMessage('')
    try { await action() } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const reload = async () => { setState(await api<VoiceState>(`character?id=${encodeURIComponent(characterId)}`)); onChanged?.() }
  const catalog = async (nextPage: number) => {
    const value = await api<{ voices: Voice[] }>(`catalog?modelId=${encodeURIComponent(modelId)}&page=${nextPage}`)
    setVoices(value.voices); setVoiceId(''); setPlayed(false); setPage(nextPage)
    if (!value.voices.length) setMessage('本页没有可用音色，可返回上一页或创建自定义音色。')
  }
  if (characterId.startsWith('narrator:') && state.originalVoice) return <section className="character-voice-panel" aria-label={`${characterName}声音`}>
    <div><h3>原创旁白音色</h3><p>{state.originalVoice.description}</p><p>{state.originalVoice.status === 'ready' ? '已归档 · 后续分镜自动召回' : '创建处理中 · 不会重复创建'} · {state.originalVoice.targetModel}</p>
      {state.originalVoice.status === 'ready' ? <p>执行首次使用时会同时锁定音色和合成配置；循环、断点续跑与重试继续复用同一份旁白资产。</p> : null}
      {state.originalVoice.previewUrl ? <audio controls preload="none" src={state.originalVoice.previewUrl} /> : null}<small>{state.originalVoice.voiceId}</small></div>
    {message ? <p role="status" className="voice-message">{message}</p> : null}
  </section>
  return <section className="character-voice-panel" aria-label={`${characterName}声音`}>
    {state.originalVoice ? <div><h3>{characterId.startsWith('narrator:') ? '原创旁白音色' : '原创人物音色'}</h3><p>{state.originalVoice.description}</p><p>{state.originalVoice.status === 'ready' ? '已归档 · 后续分镜自动召回' : '创建处理中 · 不会重复创建'} · {state.originalVoice.targetModel}</p>{characterId.startsWith('narrator:') && state.originalVoice.status === 'ready' ? <p>执行首次使用时会同时锁定音色和合成配置；循环、断点续跑与重试继续复用同一份旁白资产。</p> : null}{state.originalVoice.previewUrl ? <audio controls preload="none" src={state.originalVoice.previewUrl} /> : null}<small>{state.originalVoice.voiceId}</small></div> : null}
    <header><h3>{characterId.startsWith('narrator:') ? '旁白声音' : '人物声音'}</h3><span>{state.current ? `${unavailable(state.current.version) ? '已停用' : '已绑定'} · V${state.current.version}` : '未绑定'}</span></header>
    {state.current ? <div className="voice-current"><strong>{state.current.voiceName}</strong><audio controls preload="none" src={state.current.previewUrl} /><p>{unavailable(state.current.version) ? '此声音版本已停用，不能用于新生成。请恢复可用状态或绑定新版本；原执行记录保持不变。' : '新执行使用此声音；已有执行与重试保持原声音版本。更换声音将创建新版本。'}</p></div>
      : <p>{characterId.startsWith('narrator:') ? '选择并试听声音后绑定，本工作流后续旁白自动复用，无需创建画面人物。' : '选择并试听声音后绑定，后续分镜自动复用。三视图变化不会自动更换声音。'}</p>}
    <label>视频服务<select value={modelId} onChange={e => { setModelId(e.target.value); setVoices([]); setVoiceId(''); setPlayed(false); setPage(1) }}>{!models.length ? <option value="">{characterId.startsWith('narrator:') ? '请先配置 Kling 2.6 视频服务' : '请先配置可灵视频服务'}</option> : null}{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
    <div className="voice-actions"><button type="button" className="ghost-btn" disabled={busy || !modelId} onClick={() => void run(() => catalog(1))}>读取预置与自定义音色</button>{page > 1 ? <button type="button" disabled={busy} onClick={() => void run(() => catalog(page - 1))}>上一页</button> : null}{voices.length >= 30 ? <button type="button" disabled={busy} onClick={() => void run(() => catalog(page + 1))}>下一页</button> : null}</div>
    {voices.length ? <label>选择音色<select value={voiceId} onChange={e => { setVoiceId(e.target.value); setPlayed(false) }}><option value="">请选择并试听</option>{voices.map(v => <option key={v.voiceId} value={v.voiceId}>{v.voiceName} · {v.source === 'preset' ? '预置' : '自定义'}</option>)}</select></label> : null}
    {selected ? <div className="voice-audition"><audio key={selected.voiceId} aria-label="候选音色试听" controls preload="none" src={selected.previewUrl} onPlaying={() => setPlayed(true)} /><button type="button" className="primary-btn" disabled={busy || !played} onClick={() => void run(async () => {
      const result = await api<{ status: string }>('bind', { characterId, modelId, ...selected }); await reload(); setMessage(result.status === 'succeeded' ? '旁白声音已绑定，新执行自动复用；原执行声音版本保持不变。' : '已提交人物与声音绑定。完成后刷新任务状态，新执行即可复用。')
    })}>试听确认并绑定</button></div> : null}
    <details><summary>从参考声音创建新音色</summary><p>使用 5–30 秒干净的单人声音（MP3 / WAV，或带声音的 MP4 / MOV）。可以使用录音，也可以先由配音模型生成样音。地址必须能被视频服务访问。</p><label>音色名称<input value={voiceName} maxLength={20} onChange={e => setVoiceName(e.target.value)} /></label><label>参考声音地址<input value={voiceUrl} placeholder="https://…/voice.wav" onChange={e => setVoiceUrl(e.target.value)} /></label><button type="button" className="ghost-btn" disabled={busy || !modelId || !voiceUrl.trim()} onClick={() => void run(async () => { await api('custom', { characterId, modelId, voiceName, voiceUrl }); await reload(); setMessage('音色创建已提交，完成后可从自定义音色中试听并绑定。') })}>创建音色</button></details>
    {state.jobs.length ? <div className="voice-jobs"><h4>声音任务</h4>{state.jobs.map(job => <div key={job.id}><span>{job.kind === 'element' ? '人物声音绑定' : '创建音色'} · {({ succeeded: '完成', failed: '失败', processing: '处理中', submitting: '提交中', uncertain: '待恢复查询' } as Record<string, string>)[job.status] ?? job.status}</span>{!['succeeded', 'failed'].includes(job.status) ? <button type="button" disabled={busy || !job.modelId} onClick={() => void run(async () => { await api('refresh', { modelId: job.modelId, id: job.id }); await reload() })}>刷新状态</button> : null}{job.error ? <small>{job.error}</small> : null}</div>)}</div> : null}
    {state.versions.length > 1 ? <details><summary>声音版本历史（{state.versions.length}）</summary>{state.versions.map(v => <p key={v.version}>V{v.version} · {v.voiceName}</p>)}</details> : null}
    {state.versions.length ? <details><summary>声音版本可用性</summary><p>停用后阻止使用该版本发起新的视频生成，旧视频和听审记录保留，已提交任务仍可查询。其他人物的音色不受影响。</p>
      <label>变更原因<input value={availabilityReason} maxLength={1000} onChange={e => setAvailabilityReason(e.target.value)} placeholder="例如：该音色不再适合此人物" /></label>
      {state.versions.map(v => <div key={v.version}><p>V{v.version} · {v.voiceName} · {unavailable(v.version) ? '已停用' : '可用'}{state.availability?.find(a => a.version === v.version)?.reason ? ` · ${state.availability.find(a => a.version === v.version)!.reason}` : ''}</p><button type="button" className="ghost-btn" disabled={busy || !availabilityReason.trim()} onClick={() => void run(async () => {
        await api('availability', { characterId, version: v.version, enabled: unavailable(v.version), reason: availabilityReason }); await reload(); setAvailabilityReason(''); setMessage('声音版本可用性已更新，原执行快照与视频保持不变。')
      })}>{unavailable(v.version) ? '恢复此版本' : '停用此版本'}</button></div>)}
    </details> : null}
    <button type="button" className="ghost-btn" disabled={busy} onClick={() => void run(async () => setImpact(await api<VoiceImpact>(`impact?id=${encodeURIComponent(characterId)}`)))}>查看已锁定执行及视频请求</button>
    {impact ? <details open><summary>已锁定 {impact.executionCount} 个执行 · {impact.requestCount} 条视频请求</summary>
      <p>更换默认声音不会改变这些执行、重试及原视频。若创建换声执行，需要重新生成所选镜头，并重新检查和合成使用它们的后续结果。此处每类最多显示最近 100 条；一次镜头重试可能对应多条请求。</p>
      {impact.executions.map(item => <p key={item.executionId}>执行 {item.executionId} · V{item.version}</p>)}
      {impact.requests.map(item => <p key={item.id}>{item.nodeName || '视频生成'} · V{item.version} · {item.status}<br /><small>执行：{item.executionId || '未记录'} · 请求：{item.requestKey || item.id}{item.taskId ? ` · 任务：${item.taskId}` : ''}</small></p>)}
    </details> : null}
    {message ? <p role="status" className="voice-message">{message}</p> : null}
  </section>
}
