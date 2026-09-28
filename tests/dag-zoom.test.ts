import assert from 'node:assert/strict'
import test from 'node:test'
import { fitDagZoom, wheelDagZoom, zoomDagAt } from '../src/dag-zoom.ts'

test('long workflows fit completely below the former 35% floor in both views', () => {
  for (const padding of [28, 64]) {
    const zoom = fitDagZoom(900, 600, 12000, 1800, padding)
    assert.ok(zoom < 0.35)
    assert.ok(12000 * zoom <= 872)
    assert.ok(1800 * zoom <= 600 - padding)
    assert.ok(wheelDagZoom(zoom, 100, zoom) < zoom)
    assert.ok(wheelDagZoom(0.35, 100, zoom) < 0.35)
  }
})

test('very large graphs retain a positive scale and respond to small wheel deltas', () => {
  const fit = fitDagZoom(900, 600, 1e7, 1800)
  const smaller = wheelDagZoom(fit, 1, fit)
  assert.ok(smaller > 0 && smaller < fit)
  assert.equal(wheelDagZoom(fit, 1e6, fit), fit / 4)
  assert.equal(wheelDagZoom(fit, -1e6, fit), 1.8)
})

test('small graphs fit at natural size and collapsed viewports stay finite', () => {
  assert.equal(fitDagZoom(900, 600, 200, 200), 1)
  assert.ok(fitDagZoom(0, 0, 12000, 1800) > 0)
})

test('a bottom node moved to the viewport center stays there when enlarged', () => {
  const node = { x: 5970, y: 560 }
  const pointer = { x: 300, y: 240 }
  const view = { zoom: 0.5, x: pointer.x - node.x * 0.5, y: pointer.y - node.y * 0.5 }
  const enlarged = zoomDagAt(view, 1.8, pointer)
  assert.equal(node.x * enlarged.zoom + enlarged.x, pointer.x)
  assert.equal(node.y * enlarged.zoom + enlarged.y, pointer.y)
  assert.ok(enlarged.x < 0 && enlarged.y < 0)
})

test('zooming preserves the pointer anchor after panning beyond any graph edge', () => {
  for (const x of [-10000, 10000]) for (const y of [-10000, 10000]) {
    const view = { x, y, zoom: 0.1 }
    const pointer = { x: 200, y: 300 }
    const enlarged = zoomDagAt(view, 1, pointer)
    const restored = zoomDagAt(enlarged, 0.1, pointer)
    assert.deepEqual(restored, view)
  }
})
