import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateBranchWorkflow } from '../src/branch-migration.ts'
import { routeBranch, type BranchRun } from '../src/workflow-branch.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { acceptanceTransition } from '../src/node-retry.ts'
import { collectTargetedRepairRetry, withTargetedRepairRetry } from '../src/targeted-repair-retry.ts'
import { acceptPrincipleMedia } from '../src/principle-media-quality.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'

const policy = { qualityDisposition: 'manual-review-v1', speechEvidencePolicy: 'enforce-evidenced-v1' }
const shot = { id: 'shot-16', audioType: '环境声', audioText: '', duration: 10 }
const evidence = (label = 'old') => ({ url: '/' + label + '.mp4', sha256: (label === 'old' ? 'a' : 'b').repeat(64), duration: 10,
  originalUrl: '/' + label + '-take.mp4', evidenceUrl: '/' + label + '.json', decoded: true, width: 1280, height: 720,
  frames: ['/first.jpg', '/last.jpg'], lastFrameUrl: '/last.jpg', hasAudio: true, meanVolumeDb: -25, transcript: [] })
const userReview = { version: 'audio-visual-event-review-v1', id: 'user-report', videoUrl: '/old.mp4', sha256: 'a'.repeat(64), duration: 10,
  method: 'user-report', reviewer: { kind: 'user', id: 'user' }, reviewedAt: '2026-09-26T10:00:00Z',
  userReport: { reference: 'conversation:actual-message', quote: '两版这处都没配音' },
  events: [{ id: 'mouth', code: 'unvoiced_visible_speech', status: 'reported', actorId: '张角', startSecond: 2, endSecond: 6, finding: '用户报告说话无声，待复核' }] }
const rejected = () => acceptPrincipleMedia({ shot_script: shot, video_take: { url: evidence().originalUrl, params: {} }, video_evidence: evidence(), audio_visual_review: userReview }, policy)
const node = (id: string, kind = 'code') => ({ id, kind, title: id, resultVar: id, code: 'return {};', prompt: '', position: { x: 0, y: 0 },
  params: [] as Array<{ id: string; name: string; englishName?: string; type: string; value: string; required: boolean }> })

test('actual generated branch retry carries user targets through new generation and evidence, confined to this loop', async () => {
  const original = rejected()
  const nodes = [node('video_take', 'video'), node('video_evidence'), { ...node('video_shot'), acceptance: { passedPath: 'passed', feedbackPath: 'retryPrompt', retryFrom: 'video_take', maxAttempts: 3 } }, node('tail')]
  const workflow = migrateBranchWorkflow({ nodes, edges: nodes.slice(1).map((n, i) => ({ id: 'edge-' + i, from: nodes[i].id, to: n.id })) })
  const branchIndex = workflow.nodes.findIndex(n => n.id === 'video_shot-accept-branch')
  const base = { shot_script: shot, video_take: { url: evidence().originalUrl, params: {} }, video_evidence: evidence(), video_shot: original }
  const runs: BranchRun[] = workflow.nodes.map((n, i) => ({ id: 'run-' + n.id, node: n, status: i < branchIndex ? 'success' : 'idle',
    context: base, inputContext: { shot_script: shot }, output: n.id === 'video_shot' ? original : n.id === 'video_evidence' ? evidence() : {},
    loopGroupId: 'scene-loop', loopIndex: 15, durationMs: 0 }))
  const future = { ...runs[0], id: 'future-video', status: 'idle', output: undefined, loopIndex: 16 }
  runs.push(future)
  const before = structuredClone(runs)
  const branch = workflow.nodes[branchIndex]
  const decision = await executeCodeNode({ code: branch.code, context: { ...base, branch: { counts: { false: 0, true: 0 } } }, params: { passedPath: 'passed', feedbackPath: 'retryPrompt', maxAttempts: 3 } })
  const routed = routeBranch(workflow, runs, branchIndex, decision, base)
  assert.deepEqual(runs, before)
  assert.equal(routed.index, 0)
  assert.equal(routed.runs.at(-1)?.retryFeedback, undefined)
  assert.equal(routed.runs[0].attempt, 2)
  assert.equal(routed.runs[branchIndex].branchState?.counts.false, 1)
  assert.deepEqual(routed.runs[0].attempts?.[0].output, runs[0].output)
  const next = evidence('new'), updatedBase = { shot_script: shot, video_take: { url: next.originalUrl, params: {} }, video_evidence: next }
  const completed = routed.runs.map((run, index) => index < 2 ? { ...run, status: 'success', context: updatedBase, output: index === 0 ? updatedBase.video_take : next } : run)
  const gateIndex = workflow.nodes.findIndex(n => n.id === 'video_shot')
  const prepared = prepareWorkflowRunContext(completed, gateIndex)!
  assert.equal(prepared.inputContext.targeted_repair_assessment, undefined, 'no permanent context root is introduced')
  const accepted = acceptPrincipleMedia(prepared.inputContext, policy)
  assert.equal(accepted.passed, false)
  assert.equal(accepted.targetedRepairAssessment?.videoUrl, next.url)
  assert.equal(accepted.targetedRepairAssessment?.sha256, next.sha256)
  assert.equal(accepted.audioVisualEvidenceAssessment.targetResults[0].status, 'unresolved')
  const carried = (accepted.targetedRepairAssessment?.targets as Array<Record<string, unknown>>)[0]
  assert.deepEqual(carried.userReport, userReview.userReport)
  assert.equal((carried.sourceDefect as Record<string, unknown>).videoUrl, '/old.mp4')
  assert.equal(carried.resolution, undefined, 'a previous review cannot resolve different bytes')
  const repeat = collectTargetedRepairRetry(completed.map((run, i) => i === gateIndex ? { ...run, output: accepted } : run), 0, gateIndex)!
  assert.equal(repeat.targets.length, 1, 'another failed pass does not multiply the target')
  const other = prepareWorkflowRunContext(completed, completed.length - 1)!
  assert.equal((other.inputContext.retry as Record<string, unknown>).feedback, '', 'next loop does not inherit the previous retry target')
})

test('legacy acceptance retry and report-format feedback preserve targets without changing budget or diagnostics', () => {
  const output = rejected()
  const runs = ['video', 'evidence', 'gate'].map((id, i) => ({ id, node: { id, resultVar: id, kind: i === 0 ? 'video' : 'code',
    ...(i === 2 ? { acceptance: { passedPath: 'passed', feedbackPath: 'retryPrompt', retryFrom: 'video', maxAttempts: 3 } } : {}) },
    status: 'success', context: {}, inputContext: {}, durationMs: 0, loopGroupId: 'loop', loopIndex: 2, output: i === 2 ? output : {} }))
  const retry = acceptanceTransition(runs, 2, output)!
  assert.equal(retry.index, 0); assert.equal(retry.exhausted, false)
  assert.ok(retry.runs.every(run => (run.retryFeedback as Record<string, unknown>).repairContext))
  const carry = collectTargetedRepairRetry(runs, 0, 2)!
  const diagnostics = { kind: 'report-format', error: 'fix review', previousReport: { issues: ['old'] } }
  const feedback = withTargetedRepairRetry(diagnostics, carry) as Record<string, unknown>
  assert.equal(feedback.kind, 'report-format'); assert.equal(feedback.previousReport, diagnostics.previousReport)
  assert.equal(collectTargetedRepairRetry([{ ...runs[0], loopIndex: 1 }, ...runs.slice(1)], 0, 2), undefined)
  assert.equal(withTargetedRepairRetry('ordinary feedback', undefined), 'ordinary feedback')
})

test('manual video retry and voice upgrade retain each invalidated loop target without copying it to another loop', () => {
  const output = rejected()
  const make = (loopIndex: number) => ['video', 'evidence', 'gate'].map((id, i) => ({ id: id + '-' + loopIndex,
    node: { id, kind: i === 0 ? 'video' : 'code' }, revision: 2, status: 'success', loopGroupId: 'loop', loopIndex,
    output: i === 2 && loopIndex === 2 ? output : {} }))
  const runs = [...make(2), ...make(3)], before = structuredClone(runs)
  const retried = manualRetryRuns(runs, 0)
  assert.ok(retried.slice(0, 3).every(run => (run as Record<string, unknown>).retryFeedback))
  assert.ok(retried.slice(3).every(run => !(run as Record<string, unknown>).retryFeedback))
  assert.deepEqual(runs, before)
  const subset = manualRetryRuns(runs, 0, new Set([0, 2]))
  assert.ok((subset[0] as Record<string, unknown>).retryFeedback)
  assert.equal(subset[1], runs[1]); assert.equal(subset[3], runs[3])
})
