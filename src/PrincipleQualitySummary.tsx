type Value = Record<string, unknown>
const record = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
function warningText(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value.trim()
  const item = record(value)
  const message = typeof item.problem === 'string' && item.problem.trim() ? item.problem.trim()
    : typeof item.message === 'string' && item.message.trim() ? item.message.trim()
      : typeof item.detail === 'string' && item.detail.trim() ? item.detail.trim()
        : typeof item.reason === 'string' && item.reason.trim() ? item.reason.trim()
      : typeof item.observation === 'string' && item.observation.trim() ? item.observation.trim()
        : depth < 5 ? warningText(item.warning ?? item.issue, depth + 1) : ''
  const suggestion = typeof item.suggestion === 'string' ? item.suggestion.trim() : ''
  const detail = message && suggestion && message !== suggestion ? message + '；建议：' + suggestion : message || suggestion
  const segment = Number.isInteger(item.segmentIndex) && Number(item.segmentIndex) >= 0 ? '第 ' + (Number(item.segmentIndex) + 1) + ' 段：' : ''
  return detail ? segment + detail : ''
}
export function PrincipleQualitySummary({ output }: { output: unknown }) {
  const value = record(output), review = record(value.qualityReview)
  if (value.qualityPolicy !== 'principle-v1' && review.scope !== 'individual-source-clips') return null
  const allowed = review.canProceed === true
  const manual = value.qualityDisposition === 'manual-review-v1'
  const manualDecisionRequired = manual && value.manualDecisionRequired === true && review.manualDecisionRequired === true
  const editorialHold = manualDecisionRequired && Array.isArray(record(review.editorialHold).findings)
  const status = String(review.status)
  const scriptCandidate = Array.isArray(value.scenes) || typeof value.videoPrompt === 'string'
  const title = editorialHold ? '需人工决定 · 剧情声画建议有相邻场证据，已暂停后续生成'
    : manualDecisionRequired ? '需人工决定 · 实测核心事件与分镜矛盾，已暂停后续镜头'
    : manual ? allowed ? '用户验收 · 可继续，待人工查看' : '存在执行或已证实的语音错误，需要修复'
    : !allowed ? '存在原则问题，需要修复' : status === 'passed' ? '原则检查通过，可以继续' : status === 'unavailable' ? '可以继续 · 质检暂不可用' : '可以继续 · 有质量建议'
  const warnings = [...new Set([
    ...(Array.isArray(review.warnings) ? review.warnings : []),
    ...(Array.isArray(value.qualityWarnings) ? value.qualityWarnings : []),
    ...(manual && Array.isArray(review.principleIssues) ? review.principleIssues : []),
  ].map(item => warningText(item)).filter(Boolean))]
  const editorialFeedback = collectPrincipleEditorialFeedback(output)
  const sources = Array.isArray(value.clipReviews) && value.clipReviews.length ? value.clipReviews.map((clip, index) => ({ index, source: deriveAudioSourceProvenance(clip) }))
    : [{ index: 0, source: deriveAudioSourceProvenance(value) }]
  const mediaLink = (reference: AudioSourceReference, label: string) => reference.redacted
    ? <span>{label}：{reference.url}（签名已隐藏，完整地址保留在原始记录）</span>
    : <a href={reference.url} target="_blank" rel="noreferrer">{label}</a>
  return <section className="variable-section" aria-label="原则质检结果">
    <strong>{title}</strong>
    {scriptCandidate ? <p>原则检查的“可继续”只确认可进入下一节点；剧情的冲突、温情、喜剧效果仍需根据实际成片验收。</p> : null}
    {editorialHold ? <p>当前大纲与审稿原文已保存，不会自动改写。核对相邻场的声画和建议后，可回退到大纲节点局部重做；若接受当前写法，可点击“从检查点继续”（单步模式点“下一步”）。</p>
      : manualDecisionRequired ? <p>本镜、实测帧和审稿已保存，不会自动重拍。核看片段后，可选中本镜视频生成节点使用“从此节点重试”，或回退到已到达的断点；若接受现有瑕疵，可点击“从检查点继续”（单步模式点“下一步”）。</p>
      : allowed && (manual || status !== 'passed') ? <p>{manual ? '自动报告仅供参考，未认证人工审片或听审。不会因内容建议自动重拍；看片后可用“本轮重做”选择起点。' : '作品已保留。建议供人工查看，可从对应节点重新执行。'}</p> : null}
    {editorialFeedback.length ? <section aria-label="剧情表达建议">
      <strong>剧情表达 · 待人工验收</strong>
      <p>以下建议只对当前候选声画定位；即使节点显示可继续，也不代表成片的冲突、温情或喜剧效果已通过验收。</p>
      <ul>{editorialFeedback.map((feedback, index) => <li key={index}>
        {feedback.status === 'located' ? <>
          <strong>{feedback.itemId}</strong> · {feedback.path}：“{feedback.quote}” · {feedback.problem}
          {feedback.suggestion ? <>；建议：{feedback.suggestion}</> : null}
          <span> · 可回到{feedback.repairNode === 'sanguo-scene-outline' ? '剧情大纲' : '分镜剧本'}节点局部调整</span>
        </> : <>
          <strong>定位待核实</strong> · {feedback.problem}
          {feedback.itemId ? <> · 报告所指：{feedback.itemId}</> : null}
          {feedback.path ? <> / {feedback.path}</> : null}
        </>}
      </li>)}</ul>
    </section> : null}
    {warnings.length ? <ul>{warnings.slice(0, 5).map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
    {warnings.length > 5 ? <details>
      <summary>查看其余 {warnings.length - 5} 条质量记录</summary>
      <ul>{warnings.slice(5).map((warning, index) => <li key={index}>{warning}</li>)}</ul>
    </details> : null}
    <details>
      <summary>声音来源{sources.length > 1 ? ` · ${sources.length} 段` : ` · ${audioSourceLabel(sources[0].source)}`}</summary>
      <p>记录声音生成方式；不代表发音、音色或口型已经验收。</p>
      <ul>{sources.map(({ index, source }) => <li key={index}>
        {sources.length > 1 ? `第 ${index + 1} 段：` : ''}{audioSourceLabel(source)}
        {source.reason ? <span> · {source.reason}</span> : null}
        {source.voices?.length ? <span> · {source.voices.map(voice => `${voice.name}（${voice.binding === 'fixed' ? '已绑定声音' : '未锁定音色'}）`).join('、')}</span> : null}
        {source.picture ? <div>{mediaLink(source.picture, '原画面与环境声')}</div> : null}
        {source.tracks?.map((track, trackIndex) => <div key={trackIndex}>{mediaLink(track, `独立音轨 ${trackIndex + 1}`)}</div>)}
      </li>)}</ul>
    </details>
  </section>
}
import { audioSourceLabel, deriveAudioSourceProvenance, type AudioSourceReference } from './audio-source-provenance.ts'
import { collectPrincipleEditorialFeedback } from './principle-editorial-feedback.ts'
