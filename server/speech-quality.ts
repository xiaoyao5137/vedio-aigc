import { speechBoundaryEvidence } from './speech-metrics.ts'

type Value = Record<string, unknown>

/** ASR provides observations. Directorial timestamps are approximate; dialogue
 * content/order and a silent continuity handle are the blocking requirements. */
export function validateSpeechEvidence(evidence: Value, expectedWindows: number, latestSpeechEnd: number, options: { requireReliableBoundaries?: boolean } = {}) {
  const alignment = Array.isArray(evidence.alignment) ? evidence.alignment as Value[] : []
  const rate = Number(evidence.phoneticErrorRate)
  const end = Number(evidence.lastSpeechEnd)
  const issues: string[] = []
  const warnings: string[] = []
  if (!Number.isFinite(rate) || rate > 0.2 || !Number.isFinite(end) || end <= 0) issues.push('实际人声缺失或与计划台词差异过大')
  if (end > latestSpeechEnd + 0.25) issues.push(`最后人声延续至 ${end.toFixed(2)} 秒，侵入稳定尾帧`)
  if (alignment.length !== expectedWindows) issues.push('台词无法逐句可靠对齐，不能证明完整对白顺序')
  let previousEnd = -1
  let dialogueCompletenessVerified = alignment.length > 0 && alignment.length === expectedWindows
  for (const row of alignment) {
    const start = Number(row.actualStart)
    const finish = Number(row.actualEnd)
    const planned = row.planned as Value | undefined
    const boundaries = speechBoundaryEvidence(row)
    if (!boundaries.timingReliable) {
      dialogueCompletenessVerified = false
      if (options.requireReliableBoundaries || evidence.alignmentVersion === 2 || row.boundaryEvidenceVersion === 2) issues.push('台词首尾或对齐证据不确定，不能证明完整对白；须复核同一素材音频：' + String(planned?.text ?? ''))
    }
    if (!Number.isFinite(start) || !Number.isFinite(finish) || start < 0 || finish <= start || start < previousEnd - 0.25) issues.push('台词实际先后顺序或时间证据不完整')
    if (planned && (Math.abs(start - Number(planned.start)) > 0.8 || Math.abs(finish - Number(planned.end)) > 0.8)) {
      warnings.push(`朗读节奏偏移：实际 ${start.toFixed(2)}–${finish.toFixed(2)} 秒，计划 ${planned.start}–${planned.end} 秒；须结合画面核对剧情顺序`)
    }
    previousEnd = finish
  }
  return { ...evidence, passed: issues.length === 0, dialogueCompletenessVerified: dialogueCompletenessVerified && issues.length === 0,
    issues, warnings, scope: 'actual-speech-content-order-and-tail', lipSyncVerified: false }
}
