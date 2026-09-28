import { MAX_NODE_ATTEMPTS, resolveRetryAttemptLimit } from './retry-budget.ts'
import { MANUAL_QUALITY_DISPOSITION, STRICT_QUALITY_DISPOSITION, type QualityDisposition } from './quality-disposition.ts'

/** This marker belongs to configuration, never to a saved execution result. */
export const LEAN_PRINCIPLE_RETRY_PROFILE = 'principle-lean-v1'
export const DEFAULT_PRINCIPLE_REVIEW_ATTEMPTS = 1
export const DEFAULT_PRINCIPLE_RETAKE_ATTEMPTS = 2

type Param = { id: string; name: string; englishName?: string; value: string; type: string; required: boolean }
type Node = {
  id: string; kind: string; params: Param[]
  acceptance?: { retryFrom: string; maxAttempts: number }
  errorRetry?: { retryFrom: string; maxAttempts: number }
}
type Edge = { from: string; to: string; branch?: string }
const name = (param: Param) => param.englishName || param.name
const parameter = (node: Node, key: string) => node.params.find(param => name(param) === key)

/** Opted-in principle gates share a small automatic retry budget. Discover
 * targets from actual retry policies/edges instead of Sanguo node names. The
 * first migration lowers old defaults; subsequent loads retain user edits. */
export function upgradeLeanPrincipleQuality<N extends Node, W extends { nodes: N[]; edges?: Edge[] }>(workflow: W): W {
  const nodesById = new Map(workflow.nodes.map(node => [node.id, node]))
  const isPrinciple = (node: Node | undefined) => Boolean(node && parameter(node, 'qualityMode')?.value === 'principle-v1')
  const targets = new Map<string, Set<string>>()
  const add = (id: string, ...keys: string[]) => targets.set(id, new Set([...(targets.get(id) ?? []), ...keys]))
  const includeGenerator = (id: string) => {
    const target = nodesById.get(id)
    if (target && ['image', 'video'].includes(target.kind) && (parameter(target, 'maxGenerationAttempts')
      || (target.kind === 'image' && parameter(target, 'validateThreeView')))) add(id, 'maxGenerationAttempts')
  }
  const edges = workflow.edges ?? []
  function principleGateBefore(node: Node, visited = new Set<string>()): Node | undefined {
    if (visited.has(node.id)) return undefined
    if (isPrinciple(node)) return node
    if (node.kind !== 'branch') return undefined
    const incoming = edges.filter(edge => edge.to === node.id && edge.branch !== 'false')
    if (incoming.length !== 1) return undefined
    const previous = nodesById.get(incoming[0].from)
    return previous ? principleGateBefore(previous, new Set([...visited, node.id])) : undefined
  }
  for (const node of workflow.nodes) {
    if (isPrinciple(node)) {
      const keys = ['maxReviewAttempts', 'maxSamplingRounds', 'maxAdaptiveSamplingRounds'].filter(key => parameter(node, key))
      if (node.acceptance) { keys.push('acceptance'); includeGenerator(node.acceptance.retryFrom) }
      if (node.errorRetry) keys.push('errorRetry')
      if (keys.length) add(node.id, ...keys)
    }
    // Only explicit gate branches, not arbitrary user-authored control flow.
    if (node.kind === 'branch' && parameter(node, 'maxAttempts')
      && (parameter(node, 'passedPath') || parameter(node, 'patterns')) && principleGateBefore(node)) {
      add(node.id, 'maxAttempts')
      for (const edge of edges.filter(edge => edge.from === node.id && edge.branch === 'false')) includeGenerator(edge.to)
    }
  }
  let changed = false
  const nodes = workflow.nodes.map(node => {
    if (parameter(node, 'retryBudgetProfile')?.value === MANUAL_QUALITY_DISPOSITION) return node
    const keys = targets.get(node.id)
    if (!keys) return node
    const migrated = parameter(node, 'retryBudgetProfile')?.value === LEAN_PRINCIPLE_RETRY_PROFILE
    const limit = (value: unknown) => Math.min(migrated ? MAX_NODE_ATTEMPTS : DEFAULT_PRINCIPLE_RETAKE_ATTEMPTS, resolveRetryAttemptLimit(value, DEFAULT_PRINCIPLE_REVIEW_ATTEMPTS))
    const params = node.params.map(param => keys.has(name(param)) ? { ...param, value: String(limit(param.value)) } : param)
    if (keys.has('maxGenerationAttempts') && !parameter(node, 'maxGenerationAttempts')) params.push({
      id: node.id + '-generation-attempts', name: '生成尝试上限', englishName: 'maxGenerationAttempts', value: String(DEFAULT_PRINCIPLE_RETAKE_ATTEMPTS), type: 'number', required: true,
    })
    if (!migrated) {
      const marker: Param = { id: node.id + '-retry-profile', name: '自动重试策略', englishName: 'retryBudgetProfile', value: LEAN_PRINCIPLE_RETRY_PROFILE, type: 'text', required: false }
      const index = params.findIndex(param => name(param) === 'retryBudgetProfile')
      if (index >= 0) params[index] = { ...params[index], value: LEAN_PRINCIPLE_RETRY_PROFILE }
      else params.push(marker)
    }
    const next = { ...node, params,
      ...(keys.has('acceptance') && node.acceptance ? { acceptance: { ...node.acceptance, maxAttempts: limit(node.acceptance.maxAttempts) } } : {}),
      ...(keys.has('errorRetry') && node.errorRetry ? { errorRetry: { ...node.errorRetry, maxAttempts: limit(node.errorRetry.maxAttempts) } } : {}),
    }
    if (JSON.stringify(next) === JSON.stringify(node)) return node
    changed = true
    return next
  })
  return changed ? { ...workflow, nodes } : workflow
}

const budgetKeys = new Set(['maxAttempts', 'maxGenerationAttempts', 'maxReviewAttempts', 'maxSamplingRounds', 'maxAdaptiveSamplingRounds', 'primaryTransportAttempts'])
type BudgetSnapshot = { params: Array<{ key: string; value: string }>; acceptance?: number; errorRetry?: number }
const snapshot = (node: Node): BudgetSnapshot => ({
  params: node.params.filter(param => budgetKeys.has(name(param))).map(param => ({ key: name(param), value: param.value })),
  ...(node.acceptance ? { acceptance: node.acceptance.maxAttempts } : {}),
  ...(node.errorRetry ? { errorRetry: node.errorRetry.maxAttempts } : {}),
})
function savedBudget(node: Node): BudgetSnapshot | undefined {
  try {
    const value = JSON.parse(parameter(node, 'qualityStrictBudgetSnapshot')?.value ?? 'null') as BudgetSnapshot | null
    return value && Array.isArray(value.params) && value.params.every(param => budgetKeys.has(param.key) && typeof param.value === 'string') ? value : undefined
  } catch { return undefined }
}
function dispositionNode<N extends Node>(node: N, disposition: QualityDisposition, explicit: boolean): N {
  const previous = parameter(node, 'qualityDisposition')?.value
  const migrated = parameter(node, 'retryBudgetProfile')?.value === MANUAL_QUALITY_DISPOSITION
  if (!explicit && migrated && [MANUAL_QUALITY_DISPOSITION, STRICT_QUALITY_DISPOSITION].includes(previous ?? '')) return node
  const strict = previous === STRICT_QUALITY_DISPOSITION && explicit && disposition === MANUAL_QUALITY_DISPOSITION
    ? snapshot(node) : savedBudget(node) ?? snapshot(node)
  const manual = disposition === MANUAL_QUALITY_DISPOSITION
  const set = (params: Param[], key: string, value: string, type = 'text') => {
    const index = params.findIndex(param => name(param) === key)
    if (index >= 0) params[index] = { ...params[index], value }
    else params.push({ id: node.id + '-' + key, name: key, englishName: key, value, type, required: false })
  }
  const restored = new Map(strict.params.map(param => [param.key, param.value]))
  const params = node.params.filter(param => manual || !budgetKeys.has(name(param)) || restored.has(name(param))).map(param => ({ ...param }))
  for (const param of params) if (budgetKeys.has(name(param))) {
    param.value = manual ? String(name(param) === 'maxGenerationAttempts' && node.kind === 'text'
      ? Math.min(2, resolveRetryAttemptLimit(param.value, 2)) : 1) : restored.get(name(param)) ?? param.value
  }
  if (manual && ['image', 'video'].includes(node.kind) && !parameter(node, 'maxGenerationAttempts')) set(params, 'maxGenerationAttempts', '1', 'number')
  if (manual && node.kind === 'text' && ['sanguo-scene-outline', 'sanguo-shot-script'].includes(node.id) && !parameter(node, 'maxGenerationAttempts')) set(params, 'maxGenerationAttempts', '2', 'number')
  set(params, 'qualityDisposition', disposition)
  set(params, 'retryBudgetProfile', MANUAL_QUALITY_DISPOSITION)
  set(params, 'qualityStrictBudgetSnapshot', JSON.stringify(strict))
  const next = { ...node, params,
    ...(node.acceptance ? { acceptance: { ...node.acceptance, maxAttempts: manual ? 1 : strict.acceptance ?? node.acceptance.maxAttempts } } : {}),
    ...(node.errorRetry ? { errorRetry: { ...node.errorRetry, maxAttempts: manual ? 1 : strict.errorRetry ?? node.errorRetry.maxAttempts } } : {}),
  }
  return JSON.stringify(next) === JSON.stringify(node) ? node : next
}

/** User-facing policy switch. It changes execution settings, never graph/model/history. */
export function setQualityDisposition<N extends Node, W extends { nodes: N[] }>(workflow: W, disposition: QualityDisposition): W {
  const nodes = workflow.nodes.map(node => dispositionNode(node, disposition, true))
  return nodes.every((node, index) => node === workflow.nodes[index]) ? workflow : { ...workflow, nodes }
}

/** Migrate this production workflow once; an explicit strict choice survives reload. */
export function upgradeManualReviewQuality<N extends Node, W extends { id: string; nodes: N[] }>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama') return workflow
  const nodes = workflow.nodes.map(node => dispositionNode(node,
    parameter(node, 'qualityDisposition')?.value === STRICT_QUALITY_DISPOSITION ? STRICT_QUALITY_DISPOSITION : MANUAL_QUALITY_DISPOSITION, false))
  return nodes.every((node, index) => node === workflow.nodes[index]) ? workflow : { ...workflow, nodes }
}
