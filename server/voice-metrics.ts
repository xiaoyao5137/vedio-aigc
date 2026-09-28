import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { voiceReviewIdentity } from '../src/voice-review.ts'
import type { CharacterVoice } from '../src/character-voice.ts'

export type VoiceMetricRow = { id: string; modelId: string; taskId?: string; requestKey?: string; status: string; error?: string; preparationMs?: unknown; units?: unknown; videoUrl?: string; characters?: CharacterVoice[] }
const number = (v: unknown) => (typeof v === 'number' || typeof v === 'string' && /^\d+(?:\.\d+)?$/.test(v.trim())) && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null

export function summarizeVoiceRequests(rows: VoiceMetricRow[]) {
  const tasks = new Map<string, VoiceMetricRow>()
  for (const row of rows) {
    if (!row.taskId) continue
    const key = `${row.modelId}:${row.characters?.[0]?.accountScope ?? ''}:${row.taskId}`, old = tasks.get(key)
    const terminal = (r: VoiceMetricRow) => r.status === 'succeeded' || r.status === 'failed'
    if (!old || terminal(row) && !terminal(old)) tasks.set(key, { ...row, units: number(row.units) ?? old?.units })
    else if (number(old.units) === null && number(row.units) !== null) tasks.set(key, { ...old, units: row.units })
  }
  const costs = new Map<string, { modelId: string; tasks: number; reported: number; units: number | null }>()
  const positions = new Map<string, number>()
  for (const task of tasks.values()) {
    const cost = costs.get(task.modelId) ?? { modelId: task.modelId, tasks: 0, reported: 0, units: null }
    cost.tasks++
    const units = number(task.units)
    if (units !== null) { cost.reported++; cost.units = (cost.units ?? 0) + units }
    costs.set(task.modelId, cost)
    if (task.requestKey) {
      const key = `${task.modelId}:${task.requestKey.replace(/:attempt-\d+:revision-\d+:/, ':')}`
      positions.set(key, (positions.get(key) ?? 0) + 1)
    }
  }
  const times = rows.map(r => number(r.preparationMs)).filter((v): v is number => v !== null)
  const bindingBlocks = rows.filter(r => /VOICE_(?:BINDING_MISSING|IDENTITY_AMBIGUOUS)/.test(r.error ?? '')).length
  return {
    requests: rows.length, bindingBlocks, bindingBlockRate: rows.length ? bindingBlocks / rows.length : null,
    unsupportedBlocks: rows.filter(r => /VOICE_PROVIDER_UNSUPPORTED/.test(r.error ?? '')).length,
    unavailableBlocks: rows.filter(r => /VOICE_ASSET_UNAVAILABLE/.test(r.error ?? '')).length,
    preparationMeasured: times.length, preparationMeanMs: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null,
    remoteTasks: tasks.size, additionalTasksAtSamePosition: [...positions.values()].reduce((n, c) => n + Math.max(0, c - 1), 0),
    costs: [...costs.values()], completed: [...tasks.values()].filter(r => r.status === 'succeeded'),
  }
}

export async function readVoiceMetrics(db: Pool, workflowId: string) {
  if (!workflowId) throw Error('请选择工作流')
  const result = await db.query(`select id,model_id as "modelId",task_id as "taskId",status,error,
    request_data->>'requestKey' as "requestKey",request_data->>'voicePreparationMs' as "preparationMs",
    request_data->'params'->'characterVoices' as characters,
    coalesce(response_data->'data'->>'final_unit_deduction',response_data->'raw'->'data'->>'final_unit_deduction') as units,
    coalesce(response_data->>'originalUrl',response_data->>'url',response_data->'data'->'task_result'->'videos'->0->>'url',response_data->'raw'->'data'->'task_result'->'videos'->0->>'url') as "videoUrl",
    count(*) over()::int as total from model_execution_records
    where workflow_id=$1 and capability='video' and created_at > now()-interval '30 days'
    and (request_data->>'voicePolicy'='strict' or request_data->'params' ? 'characterVoices' or error like '%VOICE_%')
    order by updated_at desc,id limit 1000`, [workflowId])
  const summary = summarizeVoiceRequests(result.rows)
  const boundCompleted = summary.completed.filter(row => Array.isArray(row.characters) && row.characters.length > 0)
  const ids: Array<string | null> = boundCompleted.map(row => {
    try { return createHash('sha256').update(voiceReviewIdentity({ videoUrl: row.videoUrl!, characters: row.characters! })).digest('hex') } catch { return null }
  })
  const reviews = (await db.query('select id,review from voice_listening_reviews where id=any($1::text[])', [ids.filter(Boolean)])).rows
  const counts = { passed: 0, failed: 0, uncertain: 0, missing: 0 }
  for (const id of ids) {
    const status: unknown = reviews.find(r => r.id === id)?.review?.status
    if (status === 'passed' || status === 'failed' || status === 'uncertain') counts[status]++
    else counts.missing++
  }
  const { completed, ...stats } = summary
  return { ...stats, windowDays: 30, totalMatchingRequests: result.rows[0]?.total ?? 0, capped: (result.rows[0]?.total ?? 0) > result.rows.length,
    completedTasks: completed.length, reviewedTaskDenominator: boundCompleted.length, completedWithoutVoiceBinding: completed.length - boundCompleted.length,
    reviews: counts, failedReviewRate: boundCompleted.length ? counts.failed / boundCompleted.length : null,
    unresolvedReviewRate: boundCompleted.length ? (counts.uncertain + counts.missing) / boundCompleted.length : null }
}
