import test from 'node:test'
import assert from 'node:assert/strict'
import { upgradeMediaReviewRetryGroup } from '../src/quality-node-presets.ts'
import { migrateBranchWorkflow } from '../src/branch-migration.ts'

const node = (id: string, kind: string) => ({ id, title: id, kind, resultVar: id.replaceAll('-', '_'), prompt: '', params: [] as Array<{id:string;name:string;englishName:string;type:string;required:boolean;value:string}>, uploads: [], loop: { enabled: false, sourcePath: '', fallbackCount: 1, itemVar: 'item' }, position: { x: 0, y: 0 } })
const fixture = () => ({ id: 'wf-sanguo-history-drama', schemaVersion: 103,
  nodes: [node('sanguo-requirement-review','text'), node('sanguo-media-review','text'), { ...node('sanguo-media-accept','code'), code: '// independent-media-review-view-v1\nreturn context.media_review;', errorRetry: { retryFrom: 'sanguo-requirement-review', maxAttempts: 7, patterns: ['REVIEW_RESULT_INVALID:'] } }, node('tail','code')],
  edges: [{ id: 'reviews', from: 'sanguo-requirement-review', to: 'sanguo-media-review' }, {id:'gate',from:'sanguo-media-review',to:'sanguo-media-accept'}, {id:'tail',from:'sanguo-media-accept',to:'tail'}] })

test('review group upgrade survives both fresh legacy policies and already editable branches without changing budgets or media', () => {
  for (const source of [fixture(), migrateBranchWorkflow(fixture())]) {
    const original = structuredClone(source), upgraded = upgradeMediaReviewRetryGroup(source)
    assert.equal(upgraded.schemaVersion, 104);assert.deepEqual(source, original)
    assert.equal(upgraded.edges, source.edges);assert.equal(upgradeMediaReviewRetryGroup(upgraded), upgraded)
    const routed = migrateBranchWorkflow(upgraded), branch = routed.nodes.find(row => row.id === 'sanguo-media-accept-error-branch')!
    assert.deepEqual(JSON.parse(branch.params.find(p => p.englishName === 'reviewRetryTargets')!.value), ['sanguo-requirement-review','sanguo-media-review'])
    assert.equal(branch.params.find(p => p.englishName === 'maxAttempts')!.value, '7')
    assert.equal(routed.edges.find(edge => edge.from === branch.id && edge.branch === 'false')?.to, 'sanguo-requirement-review')
    for (const id of ['sanguo-requirement-review','sanguo-media-review','tail']) assert.deepEqual(upgraded.nodes.find(row => row.id === id), source.nodes.find(row => row.id === id))
  }
})

test('review group upgrade preserves user group configuration and refuses custom return routes', () => {
  const source = migrateBranchWorkflow(fixture()), branch = source.nodes.find(row => row.id === 'sanguo-media-accept-error-branch')!
  branch.params.push({ id:'custom',name:'reviewRetryTargets',englishName:'reviewRetryTargets',type:'json',required:true,value:'["sanguo-media-review"]' })
  const upgraded = upgradeMediaReviewRetryGroup(source)
  assert.equal(upgraded.nodes.find(row => row.id === branch.id)!.params, branch.params)
  const custom = {...source, edges:source.edges.map(edge => edge.from === branch.id && edge.branch === 'false' ? {...edge,to:'sanguo-media-review'}:edge)}
  assert.equal(upgradeMediaReviewRetryGroup(custom),custom)
  assert.equal(upgradeMediaReviewRetryGroup({...source,id:'other'}).schemaVersion,103)
})
