import { isDeepStrictEqual } from 'node:util'

type SavedWorkflow = { name: string; description: string; nodes: unknown[]; edges: unknown[];
  voice_policy?: string | null }
type IncomingWorkflow = { name: string; description: string; nodes: unknown[]; edges: unknown[];
  voicePolicy?: string | null }

export function assertWorkflowSchemaNotStale(id: string, incoming: number, persisted: number) {
  if (incoming < persisted) throw Error(`工作流 ${id} 的页面副本是 schema ${incoming}，数据库已是 ${persisted}。已拒绝回滚已部署的升级，请刷新页面后重试`)
}

/** JSONB object key order is irrelevant. A schema number alone is not a graph
 * edit, and stale browser tabs must not keep rewriting the same workflow. */
export function workflowConfigContentChanged(saved: SavedWorkflow | undefined, incoming: IncomingWorkflow) {
  if (!saved) return true
  return saved.name !== incoming.name || saved.description !== incoming.description
    || !isDeepStrictEqual(saved.nodes, incoming.nodes)
    || !isDeepStrictEqual(saved.edges, incoming.edges)
    || (incoming.voicePolicy !== undefined && incoming.voicePolicy !== null
      && saved.voice_policy !== incoming.voicePolicy)
}
