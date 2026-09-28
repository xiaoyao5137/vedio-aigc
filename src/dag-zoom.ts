/** Keep the exact scale so fitting never rounds a long graph outside the viewport. */
export function fitDagZoom(width: number, height: number, graphWidth: number, graphHeight: number, verticalPadding = 28): number {
  return Math.min(1, Math.max(1, width - 28) / Math.max(1, graphWidth), Math.max(1, height - verticalPadding) / Math.max(1, graphHeight))
}

export function wheelDagZoom(current: number, deltaY: number, fitZoom: number): number {
  // Leave room to zoom out beyond the full graph, even for very large workflows.
  const minimum = Math.min(0.05, fitZoom / 4)
  return Math.min(1.8, Math.max(minimum, current * Math.exp(-deltaY * 0.003)))
}

/** Zoom around the pointer in an unbounded viewport, including negative offsets. */
export function zoomDagAt(view: { zoom: number; x: number; y: number }, zoom: number, pointer: { x: number; y: number }) {
  return {
    zoom,
    x: pointer.x - (pointer.x - view.x) * zoom / view.zoom,
    y: pointer.y - (pointer.y - view.y) * zoom / view.zoom,
  }
}
