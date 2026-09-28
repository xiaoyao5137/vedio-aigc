import test from 'node:test'
import assert from 'node:assert/strict'
import { upgradeLeanPrincipleQuality } from '../src/principle-quality-budget.ts'
import { upgradeWorkflowRetryAttempts } from '../src/retry-budget.ts'
import { upgradePrincipleQuality } from '../src/principle-workflow.ts'
import { migrateBranchWorkflow } from '../src/branch-migration.ts'
import { executeCodeNode } from '../server/code-node.ts'

const param = (name: string, value: string) => ({ id: 'saved-' + name, name, englishName: name, type: 'number', required: true, value })
const node = (id: string, kind = 'code', params = [param('qualityMode', 'principle-v1')]) => ({
  id, title: id, kind, resultVar: id, code: 'return {};', prompt: '', position: { x: 0, y: 0 }, params,
})
const edge = (from: string, to: string) => ({ id: from + '-' + to, from, to })
const value = (n: ReturnType<typeof node>, key: string) => n.params.find(p => p.englishName === key)?.value
function fixture() {
  return { id: 'custom-principle-workflow', schemaVersion: 144, nodes: [
    node('author', 'text', [param('maxGenerationAttempts', '5')]),
    node('photo', 'image', [param('maxGenerationAttempts', '5')]),
    node('collect', 'http', []),
    node('review', 'text', [param('qualityMode', 'principle-v1'), param('maxReviewAttempts', '5')]),
    { ...node('gate'), params: [...node('gate').params, param('maxAdaptiveSamplingRounds', '5')],
      acceptance: { passedPath: 'passed', feedbackPath: 'issues', maxAttempts: 5, retryFrom: 'photo' },
      errorRetry: { maxAttempts: 5, retryFrom: 'collect', patterns: ['REVIEW_RESULT_INVALID:'] } },
    node('done', 'code', []),
  ], edges: [edge('author', 'photo'), edge('photo', 'collect'), edge('collect', 'review'), edge('review', 'gate'), edge('gate', 'done')],
  history: { nodeRuns: [{ node: node('gate'), output: { passed: false, issues: ['old evidence'] } }] } }
}

test('lean budgets follow generic principle gates and real retry targets, preserving writers and execution history', () => {
  const input = fixture(), before = structuredClone(input), migrated = upgradeLeanPrincipleQuality(input)
  assert.deepEqual(input, before)
  assert.equal(migrated.history, input.history)
  assert.equal(migrated.schemaVersion, 144)
  assert.equal(value(migrated.nodes[0], 'maxGenerationAttempts'), '5')
  assert.equal(value(migrated.nodes[1], 'maxGenerationAttempts'), '2')
  assert.equal(value(migrated.nodes[3], 'maxReviewAttempts'), '2')
  assert.equal(value(migrated.nodes[4], 'maxAdaptiveSamplingRounds'), '2')
  assert.equal(migrated.nodes[4].acceptance?.maxAttempts, 2)
  assert.equal(migrated.nodes[4].errorRetry?.maxAttempts, 2)
  assert.equal(upgradeLeanPrincipleQuality(migrated), migrated)
  assert.equal(upgradeWorkflowRetryAttempts(migrated), migrated)
})

test('migrated explicit branches stop after two real failed candidates while sampling routes keep the existing asset', async () => {
  const input = migrateBranchWorkflow(fixture()), migrated = upgradeLeanPrincipleQuality(input)
  const acceptance = migrated.nodes.find(n => n.id === 'gate-accept-branch')!
  const recovery = migrated.nodes.find(n => n.id === 'gate-error-branch')!
  assert.equal(value(acceptance, 'maxAttempts'), '2')
  assert.equal(value(recovery, 'maxAttempts'), '2')
  assert.deepEqual(migrated.edges, input.edges)
  assert.equal(migrated.edges.find(e => e.from === recovery.id && e.branch === 'false')?.to, 'collect')
  assert.equal(migrated.edges.find(e => e.from === acceptance.id && e.branch === 'false')?.to, 'photo')
  const params = { maxAttempts: 2, passedPath: 'passed', feedbackPath: 'issues' }
  const first = await executeCodeNode({ code: acceptance.code, params, context: { gate: { passed: false, issues: ['confirmed wrong identity'] }, branch: { counts: { true: 0, false: 0 } } } })
  assert.equal(first.value, false)
  await assert.rejects(() => executeCodeNode({ code: acceptance.code, params, context: { gate: { passed: false, issues: ['confirmed wrong identity'] }, branch: { counts: { true: 0, false: 1 } } } }), /上限 2/)
  assert.equal(upgradeLeanPrincipleQuality(migrated), migrated)
})

test('editable budgets survive future broad/principle migrations and opt-out workflows are untouched', () => {
  const migrated = upgradeLeanPrincipleQuality(migrateBranchWorkflow(fixture()))
  for (const n of migrated.nodes) for (const p of n.params) if (['maxAttempts', 'maxReviewAttempts', 'maxGenerationAttempts'].includes(p.englishName)) p.value = '1'
  const rebuilt = upgradeLeanPrincipleQuality(upgradeWorkflowRetryAttempts(migrated))
  for (const id of ['photo', 'review', 'gate-accept-branch', 'gate-error-branch']) {
    const n = rebuilt.nodes.find(item => item.id === id)!
    assert.ok(n.params.some(p => ['maxAttempts', 'maxReviewAttempts', 'maxGenerationAttempts'].includes(p.englishName) && p.value === '1'))
  }
  const custom = { nodes: [node('review', 'text', [param('maxReviewAttempts', '5')])] }
  assert.equal(upgradeLeanPrincipleQuality(custom), custom)
  const saved = { id: 'wf-sanguo-history-drama', schemaVersion: 144, nodes: [node('sanguo-media-review', 'text', [param('qualityMode', 'principle-v1'), param('maxReviewAttempts', '1'), param('retryBudgetProfile', 'principle-lean-v1')])] }
  const refreshed = upgradePrincipleQuality(saved)
  assert.equal(value(refreshed.nodes[0], 'maxReviewAttempts'), '1')
})

test('legacy image targets with implicit validation retries receive an explicit small budget', () => {
  const input = fixture()
  input.nodes[1].params = [param('validateThreeView', 'true')]
  const migrated = upgradeLeanPrincipleQuality(migrateBranchWorkflow(input))
  assert.equal(value(migrated.nodes.find(n => n.id === 'photo')!, 'maxGenerationAttempts'), '2')
  assert.equal(upgradeLeanPrincipleQuality(migrated), migrated)
})
