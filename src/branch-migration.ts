import { insertMissingExecutionNodes } from './execution-topology.ts'
import type { AcceptancePolicy, ErrorRetryPolicy } from './node-retry.ts'
import type { RouteEdge, RouteWorkflow } from './workflow-branch.ts'
import type { GraphNode } from './workflow-core.ts'
import { isDurationPolicyTransition } from './workflow-core.ts'
import { resolveRetryContextPatch } from './retry-context.ts'

type MigratableNode = GraphNode & {
  title: string; resultVar: string; code?: string; prompt: string; position: { x: number; y: number }
  params: Array<{ id: string; name: string; englishName?: string; type: string; value: string; required: boolean }>
  acceptance?: AcceptancePolicy; errorRetry?: ErrorRetryPolicy; runIf?: { path: string; equals: unknown }
}
const param = (id: string, name: string, value: string, type = 'number') => ({ id, name, englishName: name, type, value, required: true })
const readPath = `const at = (obj, path) => path.split('.').reduce((v,k) => v?.[k], obj);`
const subtitleReviewGuard = `if (report?.subtitleAssessment?.status === 'unverified' || report?.qualityReview?.subtitleAssessment?.status === 'unverified') throw Error('SUBTITLE_REVIEW_REQUIRED: 无字幕要求尚未完成当前素材审核；复核同一素材，不自动付费重拍');`
function acceptanceBranchCode(resultVar: string, guardSubtitles = true) {
  return `${readPath}
const report = context[${JSON.stringify(resultVar)}];
${guardSubtitles ? subtitleReviewGuard + '\n' : ''}const passed = at(report, params.passedPath);
if (typeof passed !== 'boolean') throw Error('质检结果缺少布尔判定：' + params.passedPath);
if (passed) return true;
const limit = Number(params.maxAttempts);
if (!Number.isInteger(limit) || limit < 1) throw Error('maxAttempts 必须是正整数');
if (branch.counts.false + 1 >= limit) throw Error('验收重试达到上限 ' + limit + '；修改 maxAttempts 后重试本分支');
return { value: false, feedback: at(report, params.feedbackPath) };`
}
/** Refresh the exact generated template only. User-authored branch code,
 * route edges, budgets and persisted execution snapshots remain untouched. */
export function refreshSubtitleReviewBranches<N extends MigratableNode, W extends RouteWorkflow<N>>(workflow: W): W {
  let changed = false
  const nodes = workflow.nodes.map(node => {
    if (node.kind !== 'branch' || !node.code) return node
    const match = node.code.match(/^const report = context\[("(?:[^"\\]|\\.)*")\];$/m)
    if (!match) return node
    let resultVar: unknown
    try { resultVar = JSON.parse(match[1]) } catch { return node }
    if (typeof resultVar !== 'string' || node.code !== acceptanceBranchCode(resultVar, false)) return node
    changed = true
    return { ...node, code: acceptanceBranchCode(resultVar) }
  })
  return changed ? { ...workflow, nodes } : workflow
}
export const REPORT_FORMAT_FEEDBACK_RETURN = `return { value: false, feedback: /^(?:REVIEW_RESULT_INVALID|HISTORY_REVIEW_INVALID|VIDEO_REVIEW_INVALID):/.test(error) ? {kind:'report-format',error} : error };`

/** Opt-in code generation only; unconfigured branches retain exact old text. */
export function reportFormatRetryBranchReturn(withRetryContextSources = false): string {
  return withRetryContextSources ? REPORT_FORMAT_FEEDBACK_RETURN.replace(/ };$/, () => ', contextPatch: (' + resolveRetryContextPatch.toString() + ')(context,params.retryContextSources) };')
    : REPORT_FORMAT_FEEDBACK_RETURN
}

/** Refresh only the generated error-feedback return. Budget checks, user-edited
 * routes and business-content retry branches remain untouched. */
export function refreshReportRetryBranches<N extends MigratableNode, W extends RouteWorkflow<N>>(workflow: W): W {
  let changed = false
  const nodes = workflow.nodes.map(node => {
    if (node.kind !== 'branch' || !node.code?.includes('?.routeError') || !node.code.includes('return { value: false, feedback: error };')) return node
    changed = true
    return { ...node, code: node.code.replace('return { value: false, feedback: error };', REPORT_FORMAT_FEEDBACK_RETURN) }
  })
  return changed ? { ...workflow, nodes } : workflow
}

/** One-time structural migration for ANY legacy policy-bearing workflow.
 * After policies are removed, user-edited code/edges are never regenerated. */
export function migrateBranchWorkflow<N extends MigratableNode, W extends RouteWorkflow<N>>(workflow: W): W {
  workflow = refreshSubtitleReviewBranches(workflow)
  if (!workflow.nodes.some(n => n.acceptance || n.errorRetry)) return workflow
  let edges: RouteEdge[] = [...workflow.edges]
  const inserted = new Map<string, N[]>()
  const changed = new Map<string, N>()
  const used = new Set(workflow.nodes.map(n => n.id))
  const unique = (base: string) => { let id = base, i = 1; while (used.has(id)) id = `${base}-${i++}`; used.add(id); return id }
  for (const gate of workflow.nodes) {
    if (!gate.acceptance && !gate.errorRetry) continue
    const chain: N[] = []
    const branch = (suffix: string, title: string, code: string, params: MigratableNode['params']) => ({
      ...gate, id: unique(`${gate.id}-${suffix}`), title, kind: 'branch', operation: undefined,
      acceptance: undefined, errorRetry: undefined, mapInput: undefined, request: undefined, modelId: undefined, runIf: gate.runIf,
      resultVar: `${gate.resultVar}_${suffix.replaceAll('-', '_')}`, uploads: [], code,
      prompt: '代码返回 true / false，沿对应出口连线执行。达到代码中的次数条件会暂停，可在单步调试中修改参数后重试本分支。',
      params, position: { x: gate.position.x + 280 * (chain.length + 1), y: gate.position.y },
    } as N)
    if (gate.errorRetry) {
      const policy = gate.errorRetry
      const node = branch('error-branch', `${gate.title} · 异常分支`, `const error = context[${JSON.stringify(gate.resultVar)}]?.routeError;
if (!error) return true;
const patterns = params.patterns;
if (!patterns.some(p => error.includes(p))) throw Error(error);
const limit = Number(params.maxAttempts);
if (!Number.isInteger(limit) || limit < 1) throw Error('maxAttempts 必须是正整数');
if (branch.counts.false + 1 >= limit) throw Error('异常复核达到上限 ' + limit + '：' + error + '；修改 maxAttempts 后重试本分支');
${reportFormatRetryBranchReturn(policy.retryContextSources !== undefined)}`, [param(`${gate.id}-error-limit`, 'maxAttempts', String(policy.maxAttempts)), param(`${gate.id}-error-patterns`, 'patterns', JSON.stringify(policy.patterns), 'json'),
        ...(policy.reviewRetryTargets === undefined ? [] : [param(`${gate.id}-error-review-targets`, 'reviewRetryTargets', JSON.stringify(policy.reviewRetryTargets), 'json')]),
        ...(policy.retryContextSources === undefined ? [] : [param(`${gate.id}-error-context-sources`, 'retryContextSources', JSON.stringify(policy.retryContextSources), 'json')])])
      chain.push(node)
      edges.push({ id: `${node.id}-false`, from: node.id, to: policy.retryFrom, branch: 'false' })
    }
    if (gate.acceptance) {
      const policy = gate.acceptance
      const node = branch('accept-branch', `${gate.title} · 结果分支`, acceptanceBranchCode(gate.resultVar), [param(`${gate.id}-accept-limit`, 'maxAttempts', String(policy.maxAttempts)), param(`${gate.id}-passed-path`, 'passedPath', policy.passedPath, 'text'), param(`${gate.id}-feedback-path`, 'feedbackPath', policy.feedbackPath ?? 'issues', 'text')])
      chain.push(node)
      edges.push({ id: `${node.id}-false`, from: node.id, to: policy.retryFrom, branch: 'false' })
    }
    const outgoing = edges.filter(e => e.from === gate.id)
    // Legacy terminal gates get an explicit no-op terminal so both ports remain
    // editable real edges. No invisible 'continue' destination.
    let end = outgoing[0]?.to
    if (!end) {
      const terminal = { ...gate, id: unique(`${gate.id}-done`), title: `${gate.title} · 完成`, kind: 'code', resultVar: `${gate.resultVar}_done`, code: 'return { completed: true };', operation: undefined, acceptance: undefined, errorRetry: undefined, params: [], uploads: [], position: { x: gate.position.x + 280 * (chain.length + 1), y: gate.position.y } } as N
      end = terminal.id
      chain.push(terminal)
    }
    const branches = chain.filter(n => n.kind === 'branch')
    // A legacy fan-out is preserved by a visible continuation node.
    if (outgoing.length > 1) {
      const continuation = { ...gate, id: unique(`${gate.id}-continue`), title: `${gate.title} · 继续`, kind: 'code', resultVar: `${gate.resultVar}_continue`, code: 'return { continued: true };', operation: undefined, acceptance: undefined, errorRetry: undefined, params: [], uploads: [], position: { x: gate.position.x + 280 * (chain.length + 1), y: gate.position.y } } as N
      chain.push(continuation); end = continuation.id
      edges = edges.map(e => e.from === gate.id ? { ...e, from: continuation.id } : e)
    } else edges = edges.filter(e => e.from !== gate.id)
    edges.push({ id: `${gate.id}-branch-entry`, from: gate.id, to: branches[0].id })
    branches.forEach((node, i) => edges.push({ id: `${node.id}-true`, from: node.id, to: branches[i + 1]?.id ?? end!, branch: 'true' }))
    inserted.set(gate.id, chain)
    const code = gate.code && gate.errorRetry ? `// 质检只报告结果；异常也交给后面的可编辑分支判断。\ntry {\nreturn (() => {\n${gate.code}\n})();\n} catch (error) {\nreturn { routeError: String(error?.message ?? error) };\n}` : gate.code
    changed.set(gate.id, { ...gate, acceptance: undefined, errorRetry: undefined, code })
  }
  const nodes = workflow.nodes.flatMap(node => {
    const shift = workflow.nodes.filter(g => inserted.has(g.id) && g.position.y === node.position.y && g.position.x < node.position.x).reduce((n, g) => n + inserted.get(g.id)!.length * 280, 0)
    return [changed.get(node.id) ?? node, ...(inserted.get(node.id) ?? [])].map(n => ({ ...n, position: { ...n.position, x: n.position.x + shift }, childIds: n.childIds?.flatMap(id => [id, ...(inserted.get(id) ?? []).map(c => c.id)]) }))
  })
  return { ...workflow, nodes, edges } as W
}

/** Adds branch snapshots and compatible new nodes without replaying the paid prefix.
 * The caller saves a new recovery record, leaving the old record immutable. */
export function migrateBranchRuns<N extends MigratableNode, R extends {
  id: string; node: N; status: string; context: Record<string, unknown>; output?: unknown; inputContext?: Record<string, unknown>
  inputs?: Record<string, unknown>; error?: string; attempt?: number; errorAttempt?: number; durationMs: number
  loopIsLast?: boolean; loopNode?: N
}>(workflow: RouteWorkflow<N>, runs: R[]): R[] {
  if (isDurationPolicyTransition(workflow, runs)) return runs
  const current = new Map(workflow.nodes.map(n => [n.id,n]))
  if (!runs.some(r => r.node.acceptance || r.node.errorRetry)) return insertMissingExecutionNodes(workflow, runs)
  let changed = false
  const result = runs.flatMap(run => {
    if (!run.node.acceptance && !run.node.errorRetry) return [run.node.kind === 'loop' && current.has(run.node.id) ? { ...run, node: current.get(run.node.id)! } : run]
    const gate = current.get(run.node.id)
    if (!gate || gate.acceptance || gate.errorRetry) return [run]
    const branches: N[] = []
    let id = workflow.edges.find(e => e.from === gate.id && e.branch === undefined)?.to
    while (id && current.get(id)?.kind === 'branch' && !branches.some(n => n.id === id)) {
      const n = current.get(id)!
      branches.push(n)
      id = workflow.edges.find(e => e.from === n.id && e.branch === 'true')?.to
    }
    if (!branches.length) return [run]
    changed = true
    const failed = run.status === 'failed'
    const raw = run.output as Record<string, unknown> | undefined
    const errorFailure = failed && run.node.errorRetry && run.node.errorRetry.patterns.some(p => String(run.error ?? raw?.error ?? '').includes(p))
    const output = errorFailure ? { routeError: run.error ?? raw?.error } : run.output
    const context = { ...run.context, [gate.resultVar]: output }
    const gateRun = { ...run, node: gate, ...(failed ? {status:'success',error:undefined,output,context}:{}), loopIsLast:false } as R
    const blockedIndex = errorFailure ? 0 : branches.length - 1
    const extra = branches.map((node, i) => {
      const isError = Boolean(run.node.errorRetry) && i === 0
      const count = Math.max(0, (isError ? run.errorAttempt ?? 1 : run.attempt ?? 1) - 1)
      const status = failed ? i < blockedIndex ? 'success' : i === blockedIndex ? 'failed' : 'idle' : run.status === 'success' ? 'success' : run.status === 'skipped' ? 'skipped' : 'idle'
      return { ...run, id:`${run.id}:${node.id}`,node,status,output:status==='success'?{value:true}:undefined,
        inputContext:context,routeInputContext:context,context,inputs:{},durationMs:0,
        error:status==='failed'?run.error:undefined,attempt:1,errorAttempt:undefined,attempts:[],
        branchState:{visits:count+(status==='success'?1:0),counts:{true:status==='success'?1:0,false:count}},
        loopNode:run.loopNode?current.get(run.loopNode.id)??run.loopNode:undefined,
        loopIsLast:run.loopIsLast && i===branches.length-1,
      } as R
    })
    return [gateRun,...extra]
  })
  return insertMissingExecutionNodes(workflow, changed ? result : runs)
}
