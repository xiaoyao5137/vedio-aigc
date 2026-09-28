export type Point = { x: number; y: number }
export type NodeBounds = Point & { id: string; width: number; height: number }

export function selectionRect(start: Point, end: Point) {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }
}

export function nodesInSelection(bounds: NodeBounds[], start: Point, end: Point) {
  const rect = selectionRect(start, end)
  if (rect.width < 2 && rect.height < 2) return []
  return bounds.filter(node => node.x <= rect.x + rect.width && node.x + node.width >= rect.x
    && node.y <= rect.y + rect.height && node.y + node.height >= rect.y).map(node => node.id)
}

export function expandSelection(ids: string[], childrenOf: (id: string) => string[]): string[] {
  const selected = new Set(ids)
  for (const id of selected) for (const child of childrenOf(id)) selected.add(child)
  return [...selected]
}

export function moveSelection(origins: Record<string, Point>, delta: Point): Record<string, Point> {
  const points = Object.values(origins)
  const dx = Math.max(delta.x, -Math.min(...points.map(point => point.x)))
  const dy = Math.max(delta.y, -Math.min(...points.map(point => point.y)))
  return Object.fromEntries(Object.entries(origins).map(([id, point]) => [id, { x: point.x + dx, y: point.y + dy }]))
}
