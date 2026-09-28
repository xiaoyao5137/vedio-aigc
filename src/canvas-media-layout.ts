export const CANVAS_BASE_NODE_HEIGHT = 154
export const CANVAS_MEDIA_NODE_HEIGHT = 400

type PositionedNode = { position: { x: number; y: number } }

/**
 * Media mode is a reversible view projection, never a workflow migration.
 * A constant scale keeps dragging stable even while the source positions change;
 * nodes, connections, loop bounds and viewport fitting must share this projection.
 */
export function canvasMediaScale(enabled: boolean): number {
  return enabled ? CANVAS_MEDIA_NODE_HEIGHT / CANVAS_BASE_NODE_HEIGHT : 1
}

export function projectCanvasNodes<T extends PositionedNode>(nodes: readonly T[], enabled: boolean): T[] {
  const yScale = canvasMediaScale(enabled)
  return nodes.map(node => enabled
    ? { ...node, position: { ...node.position, y: node.position.y * yScale } }
    : node)
}

/** Convert a drag measured on the displayed canvas into a saved-coordinate delta. */
export function canvasMediaDragDelta(delta: { x: number; y: number }, enabled: boolean) {
  return { x: delta.x, y: delta.y / canvasMediaScale(enabled) }
}
