import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { InspectorDisclosure, InspectorEntries, INSPECTOR_PAGE_SIZE } from '../src/InspectorDisclosure.ts'

test('closed inspector never traverses descendants or mounts media', () => {
  const html = renderToStaticMarkup(createElement(InspectorDisclosure, {
    summary: 'snapshot', children: () => { throw new Error('hidden subtree evaluated') },
  }))
  assert.match(html, /snapshot/)
  assert.doesNotMatch(html, /textarea|video/)
})
test('explicitly open disclosure renders its content', () => {
  let visits = 0
  const html = renderToStaticMarkup(createElement(InspectorDisclosure, {
    summary: 'snapshot', defaultOpen: true,
    children: () => { visits++; return createElement('textarea', { defaultValue: 'evidence' }) },
  }))
  assert.equal(visits, 1)
  assert.match(html, /evidence/)
})
test('huge arrays have a bounded initial render without discarding remaining entries', () => {
  const visited: number[] = []
  const html = renderToStaticMarkup(createElement(InspectorEntries, {count: 100_000,
    renderEntry: index => { visited.push(index); return createElement('span', {key:index}, index) },
  }))
  assert.equal(visited.length, INSPECTOR_PAGE_SIZE)
  assert.equal(visited.at(-1), 49)
  assert.match(html, /1–50 \/ 100000/)
  assert.match(html, /下一页/)
})
