import { useEffect, useState } from 'react'
import { voiceReviewTarget, type VoiceListeningReview as ListeningReview } from './voice-review'

export default function VoiceListeningReview({ output, readOnly, onPassed }: { output: unknown; readOnly: boolean; onPassed?: () => void }) {
  return <VoiceListeningReviewContent key={JSON.stringify(voiceReviewTarget(output))} output={output} readOnly={readOnly} onPassed={onPassed} />
}

function VoiceListeningReviewContent({ output, readOnly, onPassed }: { output: unknown; readOnly: boolean; onPassed?: () => void }) {
  const target = voiceReviewTarget(output)
  const key = JSON.stringify(target)
  const [review, setReview] = useState<ListeningReview | null>(null)
  const [note, setNote] = useState('')
  const [listened, setListened] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (key === 'null') return
    let active = true
    fetch('/api/character-voices/review-read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: JSON.parse(key) }) })
      .then(async r => { const value = await r.json(); if (!r.ok) throw Error(value.error); return value })
      .then(value => { if (active) setReview(value.review) }).catch(e => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [key])
  if (!target) return null
  const save = async (status: ListeningReview['status']) => {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/character-voices/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, status, note }) })
      const value = await response.json()
      if (!response.ok) throw Error(value.error)
      setReview(value.review)
      if (status === 'passed') onPassed?.()
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  return <section className="character-voice-panel" aria-label="成片音色听审"><h3>成片音色听审 · {review ? ({ passed: '通过', failed: '不一致', uncertain: '待复核' })[review.status] : '待复核'}</h3>
    <p>{target.nativeGroupVoices?.length ? '具名人物沿用已锁定音色；群体使用原生声音，未锁定群体音色。请听取完整片段，检查台词、群体表演、串角和口型。' : '已固定生成输入的音色。请对照下面的样音，连续播放相关分镜，检查是否变声、串角或出现双重人声；台词和口型仍需单独验收。'}</p>
    {target.nativeGroupVoices?.map(group => <p key={group.continuityKey}>{group.name} · 原生群体声音 · 待人工复核</p>)}
    {target.characters.map(v => <div key={v.characterId}><strong>{v.characterName} · {v.voiceName} · V{v.version}</strong><audio controls preload="none" src={v.previewUrl} /></div>)}
    {review ? <p>{review.note} · {new Date(review.reviewedAt).toLocaleString()}</p> : null}
    {!readOnly ? <><label><span><input type="checkbox" checked={listened} onChange={e => setListened(e.target.checked)} style={{width:'auto'}} /> {target.nativeGroupVoices?.length ? '我已听取本片段及相邻分镜，并检查完整台词与群体声音' : '我已对照样音听取本片段及相邻分镜'}</span></label><label>听审记录<textarea value={note} onChange={e => setNote(e.target.value)} placeholder="记录检查的分镜、说话人以及是否存在变声" /></label><div className="voice-actions">{(['passed','failed','uncertain'] as const).map(status => <button key={status} type="button" className="ghost-btn" disabled={busy || !listened || !note.trim()} onClick={() => void save(status)}>{status === 'passed' && onPassed ? '听审通过并继续' : ({passed:'听审通过',failed:'听审不通过',uncertain:'证据不足'})[status]}</button>)}</div></> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>
}
