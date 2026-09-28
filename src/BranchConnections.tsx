import { branchOutputOffset } from './branch-node-geometry'
import type { RouteEdge } from './workflow-branch'

type Node = { id: string; title: string; position: { x: number; y: number } }
export function BranchConnections<T extends Node>({ nodes, edges, prefix, onRemove, nodeHeight }: { nodes: T[]; edges: RouteEdge[]; prefix: string; onRemove?: (id: string) => void; nodeHeight?: (node: T) => number }) {
  return <>
    <defs>{['true', 'false'].map(port => <marker key={port} id={`${prefix}-${port}`} markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill={port === 'true' ? 'var(--studio-success)' : 'var(--studio-warning)'} /></marker>)}</defs>
    {edges.filter(e => e.branch !== undefined).map(edge => {
      const from = nodes.find(n => n.id === edge.from), to = nodes.find(n => n.id === edge.to)
      if (!from || !to) return null
      const backwards = to.position.x <= from.position.x
      const offset = branchOutputOffset(edge.branch)
      const x1 = from.position.x + offset.x, y1 = from.position.y + offset.y
      const controlX = edge.branch === 'false' ? x1 : x1 + 70
      const controlY = edge.branch === 'false' ? y1 + 60 : y1
      const x2 = to.position.x, y2 = to.position.y + 62
      const legacyLane = Math.max(from.position.y, to.position.y) + (edge.branch === 'true' ? 174 : 216)
      // Keep return routes below enlarged media surfaces; callers without media
      // retain the existing geometry exactly.
      const lane = nodeHeight
        ? Math.max(legacyLane, Math.max(from.position.y + nodeHeight(from), to.position.y + nodeHeight(to)) + (edge.branch === 'true' ? 50 : 92))
        : legacyLane
      const mid = Math.max(48, Math.abs(x2 - x1) / 2)
      const d = backwards ? `M ${x1} ${y1} C ${controlX} ${controlY}, ${x1 + 70} ${lane}, ${x1} ${lane} L ${x2 - 40} ${lane} Q ${x2 - 70} ${lane}, ${x2 - 70} ${lane - 30} L ${x2 - 70} ${y2 + 30} Q ${x2 - 70} ${y2}, ${x2} ${y2}` : `M ${x1} ${y1} C ${edge.branch === 'false' ? x1 : x1 + mid} ${edge.branch === 'false' ? y1 + 60 : y1}, ${x2 - mid} ${y2}, ${x2} ${y2}`
      const label = `${edge.branch} → ${to.title}`
      return <g key={edge.id} className="branch-connection">
        <title>{`${from.title} / ${label}${onRemove ? '；点击连线删除，可从分支出口重新拖线' : ''}`}</title>
        <path className="edge-path" d={d} fill="none" stroke={edge.branch === 'true' ? 'var(--studio-success)' : 'var(--studio-warning)'} strokeWidth="2.5" strokeDasharray={backwards ? '8 5' : undefined} markerEnd={`url(#${prefix}-${edge.branch})`} onClick={() => onRemove?.(edge.id)} />
        <text x={(x1 + x2) / 2} y={backwards ? lane + 15 : (y1 + y2) / 2 - 10} textAnchor="middle" fill={edge.branch === 'true' ? 'var(--studio-success)' : 'var(--studio-warning)'}>{label}</text>
      </g>
    })}
  </>
}
