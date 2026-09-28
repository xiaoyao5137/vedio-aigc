/** Pure execution-record decisions shared by the UI driver's watch and step modes. */
export function driveRecord(row) {
  const runs = Array.isArray(row.result?.nodeRuns) ? row.result.nodeRuns : []
  return {
    id: row.id,
    workflowId: row.workflow_id,
    requestScopeId: row.result?.requestScopeId || row.result?.id || row.id,
    createdAt: row.created_at,
    runtimeInputs: row.runtime_inputs ?? {},
    runs: runs.map((run, index) => ({
      index,
      key: typeof run?.id === 'string' ? run.id : '',
      id: run?.node?.id ?? '',
      title: run?.node?.title ?? '',
      kind: run?.node?.kind ?? '',
      modelId: run?.node?.modelId ?? '',
      status: run?.status ?? 'idle',
      attempt: run?.attempt ?? 1,
      revision: run?.revision ?? 0,
      loopIndex: run?.loopIndex ?? undefined,
      durationMs: run?.durationMs ?? undefined,
      error: typeof run?.error === 'string' ? run.error : '',
      outputSummary: validOutputSummary(run?._driveOutput) ? run._driveOutput : driveOutputSummary(run?.output),
    })),
  }
}

const hasOutput = value => {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return Boolean(value.trim())
  if (typeof value !== 'object') return true
  const keys = Object.keys(value).filter(key => key !== 'executionLogs')
  if (keys.length === 1 && keys[0] === 'value') return hasOutput(value.value)
  return keys.length > 0
}

const rejectedFlags = ['passed', 'accepted', 'videoAccepted', 'ok', 'success']
const validOutputSummary = value => value && typeof value === 'object'
  && typeof value.hasOutput === 'boolean' && typeof value.url === 'string'
  && (value.errorField === null || ['routeError', 'error'].includes(value.errorField))
  && typeof value.errorMessage === 'string' && (value.rejectedFlag === null || rejectedFlags.includes(value.rejectedFlag))
  && typeof value.manualDecisionRequired === 'boolean'

/** Preserve the decisions needed by the driver without retaining provider raw
 * data, model text, frame observations or any execution context. */
export function driveOutputSummary(output) {
  const errorField = output && typeof output === 'object' ? ['routeError', 'error'].find(field => output[field]) ?? null : null
  return {
    hasOutput: hasOutput(output),
    errorField,
    errorMessage: errorField ? typeof output[errorField] === 'string' ? output[errorField] : 'non-string error value' : '',
    rejectedFlag: output && typeof output === 'object' ? rejectedFlags.find(field => output[field] === false) ?? null : null,
    url: typeof output?.url === 'string' ? output.url.trim() : '',
    manualDecisionRequired: output?.qualityDisposition === 'manual-review-v1'
      && output?.manualDecisionRequired === true && output?.qualityReview?.manualDecisionRequired === true,
  }
}

// String.trim's complete whitespace set, supplied as a query parameter so SQL
// and JavaScript agree even for empty Unicode strings and whitespace-only URLs.
export const DRIVE_RECORD_TRIM_CHARS = '\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'

/** Appended to a read-only `record_row` CTE. Keeping the projection separate
 * allows fixture equivalence tests to execute the exact SQL with JSON input. */
export const DRIVE_RECORD_PROJECTION_SQL = `,
node_rows as (
  select ord, jsonb_build_object(
    'id', run->'id', 'node', jsonb_build_object('id',run->'node'->'id','kind',run->'node'->'kind','title',run->'node'->'title','modelId',run->'node'->'modelId'),
    'status',run->'status','attempt',run->'attempt','revision',run->'revision','loopIndex',run->'loopIndex',
    'durationMs',run->'durationMs','error',case when jsonb_typeof(run->'error')='string' then run->'error' end
  ) as run, run->'output' as output
  from record_row cross join lateral jsonb_array_elements(
    case when jsonb_typeof(result->'nodeRuns')='array' then result->'nodeRuns' else '[]'::jsonb end
  ) with ordinality n(run,ord)
), unwrapped(ord,output,depth) as (
  select ord,output,0 from node_rows
  union all
  select ord,output->'value',depth+1 from unwrapped
  where case when jsonb_typeof(output)='object' then output ? 'value' and output-'executionLogs'-'value'='{}'::jsonb else false end
), terminal as (
  select distinct on (ord) ord,output from unwrapped order by ord,depth desc
), projected as (
  select n.ord,n.run || jsonb_build_object('_driveOutput',jsonb_build_object(
    'hasOutput',case when t.output is null or t.output='null'::jsonb then false
      when jsonb_typeof(t.output)='string' then btrim(t.output#>>'{}',$2)<>''
      when jsonb_typeof(t.output)='array' then jsonb_array_length(t.output)>0
      when jsonb_typeof(t.output)='object' then t.output-'executionLogs'<>'{}'::jsonb else true end,
    'errorField',err.field,'errorMessage',case when err.field is null then '' when jsonb_typeof(err.value)='string' then err.value#>>'{}' else 'non-string error value' end,
    'rejectedFlag',rejected.field,
    'manualDecisionRequired',coalesce(n.output->>'qualityDisposition'='manual-review-v1'
      and n.output->'manualDecisionRequired'='true'::jsonb
      and n.output->'qualityReview'->'manualDecisionRequired'='true'::jsonb,false),
    'url',case when jsonb_typeof(n.output->'url')='string' then btrim(n.output->>'url',$2) else '' end
  )) as run
  from node_rows n join terminal t using(ord)
  left join lateral (
    select field,value from (values ('routeError',n.output->'routeError',0),('error',n.output->'error',1)) v(field,value,priority)
    where value is not null and value not in ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb) order by priority limit 1
  ) err on true
  left join lateral (
    select field from (values ('passed',0),('accepted',1),('videoAccepted',2),('ok',3),('success',4)) v(field,priority)
    where n.output->field='false'::jsonb order by priority limit 1
  ) rejected on true
)
select id,workflow_id,created_at,runtime_inputs,jsonb_build_object('id',result->'id','requestScopeId',result->'requestScopeId',
  'nodeRuns',coalesce((select jsonb_agg(run order by ord) from projected),'[]'::jsonb)) as result
from record_row`

export const DRIVE_RECORD_SQL = `with recursive record_row as (
  select id,workflow_id,created_at,runtime_inputs,result from execution_records where id=$1
)${DRIVE_RECORD_PROJECTION_SQL}`

/** The driver's Next click is an explicit human continuation. It may not
 * approve a newly reached text, image, or media accept gate on its own. A
 * later successful run proves a person already continued that checkpoint. */
export function pendingManualDecision(record) {
  const runs = Array.isArray(record?.runs) ? record.runs : []
  const lastSuccessIndex = runs.findLastIndex(run => run.status === 'success')
  if (lastSuccessIndex < 0) return undefined
  const run = runs[lastSuccessIndex]
  if (typeof run.id !== 'string' || !run.id.endsWith('-accept') || run.outputSummary?.manualDecisionRequired !== true) return undefined
  if (runs.slice(lastSuccessIndex + 1).some(next => next.status === 'running' || next.status === 'failed')) return undefined
  return run
}

/** A successful code invocation may still return a rejected quality report or a
 * routed error. Pin the first concrete occurrence: a later loop cannot satisfy it. */
export function targetOutcome(record, nodeId, nodeIndex) {
  const run = nodeIndex === undefined
    ? record.runs.find(candidate => candidate.id === nodeId)
    : record.runs.find(candidate => candidate.index === nodeIndex && candidate.id === nodeId)
  if (!run) return { done: false, settled: false, reason: 'target not scheduled' }
  if (run.status !== 'success') return { done: false, settled: false, run, reason: `target ${run.status}` }
  const rejected = reason => ({ done: false, settled: true, run, reason })
  const output = run.outputSummary ?? driveOutputSummary(run.output)
  if (!output.hasOutput) return rejected('target returned no output')
  if (output.errorField) return rejected(`${output.errorField}: ${output.errorMessage}`)
  if (output.rejectedFlag) return rejected(`${output.rejectedFlag}=false`)
  const url = output.url
  if (run.kind === 'video' && !url) return rejected('video returned no URL')
  return { done: true, settled: true, run, url }
}

/** A one-based round target checks every preceding occurrence too. Node indices
 * change whenever the workflow is upgraded, whereas loopIndex identifies the
 * actual iteration. A success in round five cannot conceal an earlier rejection. */
export function loopTargetOutcome(record, nodeId, loopCount) {
  if (!Number.isSafeInteger(loopCount) || loopCount < 1) throw new Error('--until-loop must be a positive integer')
  const completed = []
  for (let loopIndex = 0; loopIndex < loopCount; loopIndex += 1) {
    const candidates = record.runs.filter(run => run.id === nodeId && run.loopIndex === loopIndex)
    if (candidates.length !== 1) return { done: false, settled: candidates.length > 1,
      reason: candidates.length ? `ambiguous target in loop ${loopIndex + 1}` : `target not scheduled in loop ${loopIndex + 1}` }
    const outcome = targetOutcome(record, nodeId, candidates[0].index)
    if (!outcome.done) return { ...outcome, reason: `loop ${loopIndex + 1}: ${outcome.reason}` }
    completed.push(outcome.run)
  }
  const outcome = targetOutcome(record, nodeId, completed.at(-1).index)
  return { ...outcome, completed }
}

/** Runtime input overrides mirror collectRuntimeInputs: resultVar -> params.
 * They are a subset, preserving every other configured input. */
export function parseRuntimeInputs(source) {
  let inputs
  try { inputs = JSON.parse(source) } catch { throw new Error('--runtime-inputs must be valid JSON') }
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || !Object.keys(inputs).length) {
    throw new Error('--runtime-inputs must be a nonempty object of result variable names and parameter objects')
  }
  for (const [resultVar, params] of Object.entries(inputs)) {
    if (!resultVar || !params || typeof params !== 'object' || Array.isArray(params) || !Object.keys(params).length) {
      throw new Error(`--runtime-inputs ${resultVar || '(empty key)'} must contain a nonempty parameter object`)
    }
  }
  return inputs
}

const sameJsonValue = (left, right) => {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameJsonValue(left[key], right[key]))
}

export function runtimeInputMismatch(actual, requested) {
  for (const [resultVar, params] of Object.entries(requested)) {
    for (const [key, value] of Object.entries(params)) {
      if (!actual?.[resultVar] || !Object.hasOwn(actual[resultVar], key) || !sameJsonValue(actual[resultVar][key], value)) {
        return `${resultVar}.${key}: expected ${JSON.stringify(value)}, stored ${JSON.stringify(actual?.[resultVar]?.[key]) ?? 'undefined'}`
      }
    }
  }
  return undefined
}

/** App retries carry their original requestScopeId and revise the concrete run.
 * A matching success prefix alone is not ancestry: unrelated runs can share it.
 * Claim a pending/failed retry immediately so observation never retries its parent. */
export function isRetryFork(pinned, candidate) {
  if (!sameExecutionScope(pinned, candidate)
    || candidate.id === pinned.id || !(new Date(candidate.createdAt) > new Date(pinned.createdAt))) return false
  const failedIndex = pinned.runs.findIndex(run => run.status === 'failed')
  if (failedIndex < 0) return false
  const target = pinned.runs[failedIndex]
  const current = new Map(candidate.runs.filter(run => run.key).map(run => [run.key, run]))
  // requestScopeId groups every branch descended from the original execution,
  // not only descendants of this particular failed checkpoint. Require the
  // entire settled prefix before the failed node to survive unchanged; an old
  // sibling fork that stopped earlier must never steal a later resume.
  const prefixPreserved = pinned.runs.slice(0, failedIndex)
    .filter(run => run.key && ['success', 'skipped'].includes(run.status))
    .every(run => {
      const next = current.get(run.key)
      return next?.status === run.status && next.revision === run.revision
    })
  if (!prefixPreserved || !target.key) return false
  const retried = current.get(target.key)
  return Boolean(retried && (retried.revision > target.revision
    || (retried.status !== 'failed' && retried.status !== 'skipped')))
}

export function sameExecutionScope(left, right) {
  return Boolean(left?.workflowId && left?.requestScopeId && right?.workflowId === left.workflowId
    && right?.requestScopeId === left.requestScopeId)
}

/** A page reload may silently create a topology-migration fork. The UI driver
 * must not adopt one that made an already paid provider step runnable again. */
export function completedProviderRegression(source, candidate) {
  const next = new Map((candidate?.runs ?? []).filter(run => run.key).map(run => [run.key, run]))
  return (source?.runs ?? []).filter(run => run.key && run.status === 'success'
    && (['image', 'video', 'audio'].includes(run.kind) || Boolean(run.modelId))).flatMap(run => {
    const migrated = next.get(run.key)
    const beforeUrl = run.outputSummary?.url ?? ''
    const afterUrl = migrated?.outputSummary?.url ?? ''
    return migrated?.status === 'success' && (!beforeUrl || afterUrl === beforeUrl)
      ? [] : [{ key: run.key, nodeId: run.id, beforeStatus: run.status,
        afterStatus: migrated?.status ?? 'missing', beforeUrl, afterUrl }]
  })
}

export const failureSignature = record => `${record.id}:` + record.runs
  .filter(run => run.status === 'failed')
  .map(run => `${run.key || run.id}#${run.revision}:${run.error}`).join(' | ')
