import assert from 'node:assert/strict'
import test from 'node:test'
import { CANVAS_BASE_NODE_HEIGHT, CANVAS_MEDIA_NODE_HEIGHT, canvasMediaDragDelta, canvasMediaScale, projectCanvasNodes } from '../src/canvas-media-layout.ts'
import { moveSelection } from '../src/canvas-selection.ts'

test('media projection preserves saved positions and unrelated node fields across toggles', () => {
  const nodes = [
    { id: 'image', position: { x: 90, y: 80 }, params: [{ value: '${picture}' }] },
    { id: 'unknown-kind', position: { x: 370, y: 300 }, params: [] },
  ]
  const original = structuredClone(nodes)
  const projected = projectCanvasNodes(nodes, true)
  assert.deepEqual(nodes, original)
  assert.notEqual(projected[0].position, nodes[0].position)
  assert.equal(projected[0].params, nodes[0].params)
  assert.equal(projected[0].position.x, 90)
  assert.equal(projected[1].position.y, 300 * canvasMediaScale(true))
  assert.deepEqual(projectCanvasNodes(nodes, false), original)
  assert.deepEqual(projectCanvasNodes(nodes, true), projected)
})

test('non-overlapping saved rows stay non-overlapping at the full media footprint', () => {
  const nodes = [
    { position: { x: 90, y: 0 } },
    { position: { x: 90, y: CANVAS_BASE_NODE_HEIGHT } },
    { position: { x: 90, y: CANVAS_BASE_NODE_HEIGHT * 2 + 20 } },
  ]
  const projected = projectCanvasNodes(nodes, true)
  assert.equal(projected[1].position.y - projected[0].position.y, CANVAS_MEDIA_NODE_HEIGHT)
  assert.ok(projected[2].position.y - projected[1].position.y > CANVAS_MEDIA_NODE_HEIGHT)
})

test('selection dragging in media view moves each rendered node by the exact pointer delta', () => {
  const originals = [{ id: 'a', position: { x: 90, y: 80 } }, { id: 'b', position: { x: 370, y: 300 } }]
  const origins = Object.fromEntries(originals.map(node => [node.id, node.position]))
  const delta = { x: 37, y: 133 }
  for (const enabled of [false, true]) {
    const before = projectCanvasNodes(originals, enabled)
    const positions = moveSelection(origins, canvasMediaDragDelta(delta, enabled))
    const after = projectCanvasNodes(originals.map(node => ({ ...node, position: positions[node.id] })), enabled)
    before.forEach((node, index) => {
      assert.equal(after[index].position.x - node.position.x, delta.x)
      assert.ok(Math.abs(after[index].position.y - node.position.y - delta.y) < 1e-9)
    })
  }
  assert.deepEqual(origins.a, { x: 90, y: 80 })
})

test('projected group drag retains the existing canvas boundary clamp and relative placement', () => {
  const origins = { a: { x: 20, y: 40 }, b: { x: 120, y: 180 } }
  const positions = moveSelection(origins, canvasMediaDragDelta({ x: -90, y: -1000 }, true))
  assert.deepEqual(positions, { a: { x: 0, y: 0 }, b: { x: 100, y: 140 } })
  assert.equal(canvasMediaScale(false), 1)
  assert.deepEqual(projectCanvasNodes([], true), [])
})
