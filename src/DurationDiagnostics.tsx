import { durationExecutionSummary } from './duration-observability'
import './duration-diagnostics.css'

type Value = Record<string, unknown>
type Props = { context?: Value; output?: unknown; runStatus?: string; runError?: string; resultVar?: string }
const secondsLabel = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? `${Number(value.toFixed(2))} 秒` : '—'
const timeSpan = (start: unknown, end: unknown) => typeof start === 'number' && typeof end === 'number' ? `${Number(start.toFixed(2))}–${Number(end.toFixed(2))} 秒` : '待核实'

export function DurationDiagnostics({ context = {}, output, runStatus, runError, resultVar }: Props) {
  const value = output && typeof output === 'object' && !Array.isArray(output) ? output as Value : undefined
  const summary = durationExecutionSummary(context, value, { status: runStatus, error: runError, resultVar })
  if (!summary) return null
  const tone = summary.status === '已验收' ? 'accepted' : ['失败', '未通过验收', '需重新排镜'].includes(summary.status) ? 'failed' : 'pending'
  const values = [
    ['大纲预估', summary.plan], ['内容预算', summary.contentBudget], ['生成请求', summary.requested], ['实际片长', summary.actual],
  ] as const
  return <section className="duration-diagnostics" aria-label="镜头时长诊断">
    <div className="duration-diagnostics-heading"><strong>镜头时长诊断</strong><span className={`duration-status ${tone}`}>{summary.status}</span></div>
    <dl className="duration-values">{values.map(([label, seconds]) => <div key={label}><dt>{label}</dt><dd>{secondsLabel(seconds)}</dd></div>)}</dl>
    {summary.safeBudget !== null && <p className="duration-budget-note">含收尾的安全预算 {secondsLabel(summary.safeBudget)}{summary.endingReserve !== null ? `，其中可读收尾 ${secondsLabel(summary.endingReserve)}` : ''}。</p>}
    <p className={`duration-completion ${summary.completion}`}><strong>本镜完成证据</strong><span>{summary.completion === 'complete' ? '已证实完整' : summary.completion === 'incomplete' ? '已证实未完成' : '尚不确定 · uncertain'}</span></p>
    {summary.completionInterval && <p className="duration-budget-note">实际收束 {timeSpan(summary.completionInterval.lower, summary.completionInterval.upper)}；
      收束后剩余 {secondsLabel(summary.remainingAfterCompletion)}
      {summary.completionBudgetDelta !== null ? `；相对内容预算${summary.completionBudgetDelta > 0 ? '延后' : '提前'} ${secondsLabel(Math.abs(summary.completionBudgetDelta))}` : ''}。</p>}
    {summary.error && <p className="duration-error">{summary.error}</p>}
    {summary.speech.length > 0 && <details className="duration-speech" open={summary.speech.some(row => row.timingAssessment === 'uncertain')}>
      <summary>逐句音频边界 · {summary.speech.length} 句</summary>
      {summary.speech.map((row, index) => <div className="duration-speech-row" key={index}>
        <p>{String(row.text ?? `第 ${index + 1} 句`)}</p>
        <dl><div><dt>已匹配片段</dt><dd>{timeSpan(row.matchedStart ?? row.actualStart, row.matchedEnd ?? row.actualEnd)}</dd></div>
          <div><dt>原始人声候选</dt><dd>{timeSpan(row.utteranceCandidateStart, row.utteranceCandidateEnd)}</dd></div></dl>
        <small className={row.timingAssessment === 'uncertain' ? 'duration-uncertain' : ''}>{row.timingAssessment === 'uncertain'
          ? '句首或句尾尚未可靠确认，不能据此证明完整对白或自然语速。'
          : row.timingAssessment === 'outside-allowance' ? '超出本句时长预算，需结合音频复核。' : '句首、句尾已匹配；节奏仍须结合实际音频判断。'}</small>
      </div>)}
    </details>}
    {summary.completionReasons.length > 0 && <details className="duration-evidence-reasons"><summary>完成证据说明</summary><ul>{summary.completionReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></details>}
    {summary.legacy && <p className="duration-budget-note">历史时长策略；旧版语速通过不等于本镜已完整执行。</p>}
  </section>
}
