import test from 'node:test'
import assert from 'node:assert/strict'
import { expandSelection, moveSelection, nodesInSelection } from '../src/canvas-selection.ts'

test('marquee works in either direction and includes intersecting node bounds', () => {
  const bounds = [{ id: 'a', x: 20, y: 30, width: 100, height: 150 }, { id: 'b', x: 300, y: 30, width: 100, height: 100 }]
  assert.deepEqual(nodesInSelection(bounds, { x: 150, y: 200 }, { x: 100, y: 100 }), ['a'])
  assert.deepEqual(nodesInSelection(bounds, { x: 0, y: 0 }, { x: 0, y: 0 }), [])
})
test('loop selection expands nested children once even with overlapping selection and cycles', () => {
  const children: Record<string, string[]> = { loop: ['a', 'nested'], nested: ['b', 'loop'] }
  assert.deepEqual(expandSelection(['loop', 'a'], id => children[id] ?? []), ['loop', 'a', 'nested', 'b'])
})
test('group movement preserves relative positions at canvas boundaries and uses drag origins', () => {
  const origins = { a: { x: 20, y: 40 }, b: { x: 120, y: 180 } }
  assert.deepEqual(moveSelection(origins, { x: -90, y: -100 }), { a: { x: 0, y: 0 }, b: { x: 100, y: 140 } })
  assert.deepEqual(moveSelection(origins, { x: 30, y: 60 }), { a: { x: 50, y: 100 }, b: { x: 150, y: 240 } })
  assert.deepEqual(origins.a, { x: 20, y: 40 })
})
