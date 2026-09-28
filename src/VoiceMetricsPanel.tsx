import { useState } from 'react'

type Metrics = { windowDays: number; requests: number; totalMatchingRequests: number; capped: boolean; bindingBlocks: number; bindingBlockRate: number | null; unsupportedBlocks: number; unavailableBlocks: number; preparationMeasured: number; preparationMeanMs: number | null; remoteTasks: number; additionalTasksAtSamePosition: number; completedTasks: number; reviewedTaskDenominator: number; completedWithoutVoiceBinding: number; reviews: { passed: number; failed: number; uncertain: number; missing: number }; failedReviewRate: number | null; unresolvedReviewRate: number | null; costs: Array<{ modelId: string; tasks: number; reported: number; units: number | null }> }
const percent = (n: number | null) => n === null ? '暂无样本' : `${(n * 100).toFixed(1)}%`
export default function VoiceMetricsPanel({ workflowId }: { workflowId: string }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = async () => {
    setBusy(true); setError('')
    try {
      const r = await fetch(`/api/character-voices/metrics?workflowId=${encodeURIComponent(workflowId)}`)
      const value = await r.json()
      if (!r.ok) throw Error(value.error)
      setMetrics(value)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  return <details className="character-voice-panel"><summary>人物声音运行统计</summary>
    <button type="button" className="ghost-btn" disabled={busy} onClick={() => void refresh()}>{busy ? '读取中' : '刷新统计'}</button>
    {metrics ? <div>
      <p>最近 {metrics.windowDays} 天，共 {metrics.totalMatchingRequests} 条声音相关视频请求，本次统计 {metrics.requests} 条{metrics.capped ? '（仅最近 1000 条，以下为局部统计）' : ''}。早期没有声音字段的普通视频不计入。</p>
      <p>绑定缺失或歧义拦截：{metrics.bindingBlocks} 次（{percent(metrics.bindingBlockRate)}）；能力不足：{metrics.unsupportedBlocks} 次；声音停用或不可用：{metrics.unavailableBlocks} 次。</p>
      <p>音色校验平均耗时：{metrics.preparationMeanMs === null ? '未记录' : `${Math.round(metrics.preparationMeanMs)} ms`}，覆盖 {metrics.preparationMeasured} 条请求。</p>
      <p>去重后供应商任务：{metrics.remoteTasks} 个；同一请求位置额外生成任务：{metrics.additionalTasksAtSamePosition} 个。重复查询同一任务不算新增生成。</p>
      <p>已完成任务 {metrics.completedTasks} 个，其中有声音绑定 {metrics.reviewedTaskDenominator} 个：听审通过 {metrics.reviews.passed}，不一致 {metrics.reviews.failed}，证据不足 {metrics.reviews.uncertain}，无对应听审 {metrics.reviews.missing}。不一致率 {percent(metrics.failedReviewRate)}；待复核率 {percent(metrics.unresolvedReviewRate)}（均以有声音绑定的已完成任务为分母）。另有 {metrics.completedWithoutVoiceBinding} 个已完成任务没有声音绑定记录，不参与音色听审统计，也不视为通过。</p>
      <h4>供应商计费单位</h4>
      {metrics.costs.length ? metrics.costs.map(c => <p key={c.modelId}>{c.modelId}：{c.units === null ? '未返回' : c.units.toFixed(3)}；{c.reported}/{c.tasks} 个任务有费用字段。{c.reported < c.tasks ? '合计仅含已返回部分。' : ''}</p>) : <p>暂无任务费用数据。</p>}
      <p>计费单位按模型分别展示，不换算成货币；未返回不视为零费用。听审状态只反映已记录的实际意见，不能用请求成功率代替。</p>
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}
  </details>
}
