export type BreakpointOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'

export type BreakpointCondition = {
  path: string
  operator: BreakpointOperator
  value: unknown
}

export type WorkflowBreakpoint = {
  nodeId: string
  enabled: boolean
  condition?: BreakpointCondition
}

export type WorkflowBreakpoints = Record<string, WorkflowBreakpoint[]>

export const WORKFLOW_BREAKPOINTS_STORAGE_KEY = 'vedio-aigc:workflow-breakpoints:v2'
export const LEGACY_WORKFLOW_BREAKPOINTS_STORAGE_KEY = 'vedio-aigc:workflow-breakpoints:v1'

const BREAKPOINT_OPERATORS = new Set<BreakpointOperator>(['eq', 'ne', 'gt', 'gte', 'lt', 'lte'])

function sanitizeCondition(value: unknown): BreakpointCondition | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const condition = value as Record<string, unknown>
  if (typeof condition.path !== 'string' || !condition.path.trim() || !BREAKPOINT_OPERATORS.has(condition.operator as BreakpointOperator)) return undefined
  return { path: condition.path.trim(), operator: condition.operator as BreakpointOperator, value: condition.value }
}

function sanitizeBreakpoint(value: unknown): WorkflowBreakpoint | undefined {
  if (typeof value === 'string' && value.trim()) return { nodeId: value, enabled: true }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const breakpoint = value as Record<string, unknown>
  if (typeof breakpoint.nodeId !== 'string' || !breakpoint.nodeId.trim()) return undefined
  const condition = sanitizeCondition(breakpoint.condition)
  return {
    nodeId: breakpoint.nodeId.trim(),
    enabled: breakpoint.enabled !== false,
    ...(condition ? { condition } : {}),
  }
}

function sanitizeBreakpoints(value: unknown): WorkflowBreakpoints {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([workflowId, entries]) => {
    if (!Array.isArray(entries)) return []
    const byNodeId = new Map<string, WorkflowBreakpoint>()
    entries.forEach((entry) => {
      const breakpoint = sanitizeBreakpoint(entry)
      if (breakpoint) byNodeId.set(breakpoint.nodeId, breakpoint)
    })
    return [[workflowId, [...byNodeId.values()]]]
  }))
}

export function loadWorkflowBreakpoints(storage: Pick<Storage, 'getItem'>): WorkflowBreakpoints {
  try {
    const current = storage.getItem(WORKFLOW_BREAKPOINTS_STORAGE_KEY)
    if (current !== null) return sanitizeBreakpoints(JSON.parse(current))
    return sanitizeBreakpoints(JSON.parse(storage.getItem(LEGACY_WORKFLOW_BREAKPOINTS_STORAGE_KEY) ?? '{}'))
  } catch {
    return {}
  }
}

export function saveWorkflowBreakpoints(storage: Pick<Storage, 'setItem'>, value: WorkflowBreakpoints) {
  storage.setItem(WORKFLOW_BREAKPOINTS_STORAGE_KEY, JSON.stringify(sanitizeBreakpoints(value)))
}

export function workflowBreakpoint(value: WorkflowBreakpoints, workflowId: string, nodeId: string) {
  return value[workflowId]?.find((breakpoint) => breakpoint.nodeId === nodeId)
}

/**
 * Keeps a long-running debugger connected to the latest breakpoint state.
 * The returned resolver deliberately reads on every node boundary instead of
 * capturing the breakpoint collection from when "continue" was clicked.
 */
export function createWorkflowBreakpointResolver(readValue: () => WorkflowBreakpoints, workflowId: string) {
  return (nodeId: string) => {
    const breakpoint = workflowBreakpoint(readValue(), workflowId, nodeId)
    return breakpoint?.enabled ? breakpoint : undefined
  }
}

export function setWorkflowBreakpoint(value: WorkflowBreakpoints, workflowId: string, breakpoint: WorkflowBreakpoint): WorkflowBreakpoints {
  const entries = value[workflowId] ?? []
  const index = entries.findIndex((item) => item.nodeId === breakpoint.nodeId)
  const next = index < 0
    ? [...entries, breakpoint]
    : entries.map((item, itemIndex) => itemIndex === index ? breakpoint : item)
  return { ...value, [workflowId]: next }
}

export function removeWorkflowBreakpoint(value: WorkflowBreakpoints, workflowId: string, nodeId: string): WorkflowBreakpoints {
  return { ...value, [workflowId]: (value[workflowId] ?? []).filter((breakpoint) => breakpoint.nodeId !== nodeId) }
}

export function toggleWorkflowBreakpoint(value: WorkflowBreakpoints, workflowId: string, nodeId: string): WorkflowBreakpoints {
  return workflowBreakpoint(value, workflowId, nodeId)
    ? removeWorkflowBreakpoint(value, workflowId, nodeId)
    : setWorkflowBreakpoint(value, workflowId, { nodeId, enabled: true })
}

function resolveConditionPath(context: Record<string, unknown>, path: string) {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[key]
  }, context)
}

export function breakpointConditionMatches(condition: BreakpointCondition | undefined, context: Record<string, unknown>) {
  if (!condition) return true
  const actual = resolveConditionPath(context, condition.path)
  if (actual === undefined) return false
  const expected = condition.value
  switch (condition.operator) {
    case 'eq': return actual === expected
    case 'ne': return actual !== expected
    case 'gt': return typeof actual === 'number' && typeof expected === 'number' && actual > expected
    case 'gte': return typeof actual === 'number' && typeof expected === 'number' && actual >= expected
    case 'lt': return typeof actual === 'number' && typeof expected === 'number' && actual < expected
    case 'lte': return typeof actual === 'number' && typeof expected === 'number' && actual <= expected
  }
}

export function shouldPauseAtBreakpoint(
  breakpoint: WorkflowBreakpoint | undefined,
  nodeId: string,
  context: Record<string, unknown>,
) {
  return Boolean(breakpoint?.enabled && breakpoint.nodeId === nodeId && breakpointConditionMatches(breakpoint.condition, context))
}

export function shouldPauseBeforeRun(
  breakpoint: WorkflowBreakpoint | undefined,
  run: { id: string; node: { id: string } },
  context: Record<string, unknown>,
  ignoreBreakpointRunId?: string,
) {
  return run.id !== ignoreBreakpointRunId && shouldPauseAtBreakpoint(breakpoint, run.node.id, context)
}

export function parseBreakpointValue(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

export function formatBreakpointValue(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? ''
}
