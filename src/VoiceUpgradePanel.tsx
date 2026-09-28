import { useState } from 'react'
import type { CharacterVoice } from './character-voice'
import { voiceReviewTarget } from './voice-review'
import { voiceUpgradeIndexes, type VoiceUpgradeRun } from './voice-upgrade'

type Change = { from: CharacterVoice; to: CharacterVoice }
export type VoiceUpgradePlan = { changes: Change[]; indexes: number[] }
export default function VoiceUpgradePanel({ sourceId, output, runs, historicalWorkflow, disabled, onCreate }: {
  sourceId: string; output: unknown; runs: Array<VoiceUpgradeRun & { label?: string; node: { kind: string; title: string } }>;
  historicalWorkflow: boolean; disabled: boolean; onCreate: (plan: VoiceUpgradePlan) => Promise<void>;
}) {
  const characters = voiceReviewTarget(output)?.characters ?? []
  const [selected, setSelected] = useState<string[]>([])
  const [plan, setPlan] = useState<VoiceUpgradePlan | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  if (!characters.length) return null
  return <details className="character-voice-panel"><summary>使用人物库新音色创建换声执行</summary>
    <p>先在人物库试听并绑定新声音。这里会列出所选人物的全部相关镜头和后续重做节点，确认后创建待执行分支，原记录与视频继续保留。</p>
    {characters.map(v => <label key={v.characterId}><span><input type="checkbox" style={{ width: 'auto' }} disabled={busy || disabled} checked={selected.includes(v.characterId)} onChange={e => { setSelected(ids => e.target.checked ? [...ids, v.characterId] : ids.filter(id => id !== v.characterId)); setPlan(null) }} /> {v.characterName} · 当前执行 V{v.version}</span></label>)}
    <button type="button" className="ghost-btn" disabled={busy || disabled || !selected.length} onClick={() => void perform(async () => {
      setPlan(null)
      const response = await fetch('/api/character-voices/upgrade-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId, characterIds: selected }) })
      const value = await response.json()
      if (!response.ok) throw Error(value.error)
      const impact = voiceUpgradeIndexes(runs, selected, historicalWorkflow)
      setPlan({ changes: value.changes, indexes: impact.invalidated })
    })}>检查换声范围</button>
    {plan ? <div>{plan.changes.map(c => <p key={c.from.characterId}>{c.from.characterName}：{c.from.voiceName} V{c.from.version} → {c.to.voiceName} V{c.to.version}</p>)}
      <p>将重做 {plan.indexes.filter(i => runs[i].node.kind === 'video').length} 个视频节点及 {plan.indexes.filter(i => runs[i].node.kind !== 'video').length} 个后续节点。检查与听审需重新通过；点击创建本身不会调用视频模型。</p>
      <ol>{plan.indexes.map(i => <li key={i}>{runs[i].label || runs[i].node.title}{runs[i].loopIndex !== undefined ? ` · 第 ${runs[i].loopIndex! + 1} 轮` : ''}</li>)}</ol>
      <button type="button" className="primary-btn" disabled={busy || disabled} onClick={() => void perform(() => onCreate(plan))}>确认范围并创建待执行分支</button>
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}
  </details>
}
