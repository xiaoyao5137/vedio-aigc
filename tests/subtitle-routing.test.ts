import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateBranchWorkflow, refreshSubtitleReviewBranches } from '../src/branch-migration.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { acceptPrincipleMedia } from '../src/principle-media-quality.ts'
import { assertConcatSubtitleEvidence, aggregateConcatReviews } from '../src/concat-review.ts'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'

const node = (id: string, kind = 'code') => ({ id, title: id, kind, resultVar: id, prompt: '', code: 'return {};', position: { x: 0, y: 0 }, params: [] })
const fixture = () => {
  const gate = { ...node('accept'), acceptance: { passedPath: 'passed', retryFrom: 'video', maxAttempts: 5, feedbackPath: 'retryPrompt' } }
  return migrateBranchWorkflow({ nodes: [node('video'), gate, node('done')], edges: [{ id: 'gate-done', from: 'accept', to: 'done' }] })
}
const branchContext = (report: unknown) => ({ accept: report, branch: { visits: 0, counts: { true: 0, false: 0 } } })
const branchParams = { passedPath: 'passed', maxAttempts: 5, feedbackPath: 'retryPrompt' }
function cleanClip() {
  const url = '/generated/clean.mp4', frames = ['/generated/start.jpg', '/generated/end.jpg'], evidenceUrl = '/generated/clean-evidence.json'
  return acceptPrincipleMedia({ shot_script: { duration: 5, audioType: '环境声', audioText: '' },
    video_take: { url: '/generated/provider.mp4', params: { subtitlePolicy: 'none' } },
    video_evidence: { url, originalUrl: '/generated/provider.mp4', decoded: true, evidenceUrl, duration: 5.04, width: 1280, height: 720,
      frames, frameTimes: [0, 4.96], lastFrameUrl: frames[1], hasAudio: true, sha256: 'actual-current-sha256' },
    media_review: { version: 'principle-review-v1', decision: 'pass', issues: [], warnings: [],
      subtitleCheck: { status: 'clear', finding: '全部实际采样帧均未见字幕。', evidenceUrl, frameIndices: [0, 1] } },
  }, { subtitlePolicy: 'none', qualityDisposition: 'manual-review-v1' })
}

test('actual serialized accept branch never enters paid retry for unknown subtitle review under a strict budget', async () => {
  const workflow = fixture(), branch = workflow.nodes.find(item => item.kind === 'branch')!
  for (const report of [ { passed: false, subtitleAssessment: { status: 'unverified' } },
    { passed: true, qualityReview: { subtitleAssessment: { status: 'unverified' } } } ]) {
    await assert.rejects(() => executeCodeNode({ code: branch.code, context: branchContext(report), params: branchParams }), /SUBTITLE_REVIEW_REQUIRED.*同一素材.*不自动付费/)
  }
  assert.equal(migrateBranchWorkflow(workflow), workflow)
})

test('legacy acceptance and bounded confirmed-subtitle retries retain their existing decisions', async () => {
  const branch = fixture().nodes.find(item => item.kind === 'branch')!
  const legacy = await executeCodeNode({ code: branch.code, context: branchContext({ passed: false, retryPrompt: '原局部修复' }), params: branchParams })
  assert.deepEqual(legacy, { value: false, feedback: '原局部修复', executionLogs: [] })
  const present = await executeCodeNode({ code: branch.code, context: branchContext({ passed: false, subtitleAssessment: { status: 'present' }, retryPrompt: '去字幕' }), params: branchParams })
  assert.deepEqual(present, { value: false, feedback: '去字幕', executionLogs: [] })
  assert.deepEqual(await executeCodeNode({ code: branch.code, context: branchContext({ passed: true }), params: branchParams }), { value: true, executionLogs: [] })
  await assert.rejects(() => executeCodeNode({ code: branch.code, context: branchContext({ passed: false, subtitleAssessment: { status: 'present' } }), params: { ...branchParams, maxAttempts: 1 } }), /验收重试达到上限/)
})

test('persisted exact managed branch refreshes once without rewriting customized code, params or routes', () => {
  const workflow = fixture(), branch = workflow.nodes.find(item => item.kind === 'branch')!
  const legacyCode = branch.code.split('\n').filter(line => !line.startsWith('if (report?.subtitleAssessment?')).join('\n')
  const old = { ...workflow, nodes: workflow.nodes.map(item => item === branch ? { ...item, code: legacyCode } : item) }
  const before = structuredClone(old), upgraded = migrateBranchWorkflow(old)
  assert.deepEqual(old, before)
  assert.match(upgraded.nodes.find(item => item.kind === 'branch')!.code, /SUBTITLE_REVIEW_REQUIRED/)
  assert.equal(upgraded.edges, old.edges)
  assert.equal(upgraded.nodes.find(item => item.kind === 'branch')!.params, branch.params)
  assert.equal(refreshSubtitleReviewBranches(upgraded), upgraded)
  const custom = { ...old, nodes: old.nodes.map(item => item.kind === 'branch' ? { ...item, code: item.code + '\n// user-authored branch rule' } : item) }
  assert.equal(migrateBranchWorkflow(custom), custom)
})

test('concat permits a current fully bound clear clip and keeps legacy prefixes without inventing a review', () => {
  const currentVideo = cleanClip(), previousVideo = { url: '/generated/old-stage.mp4', clips: [{ url: '/generated/old-paid.mp4' }] }
  const params = { currentVideo, previousVideo, subtitlePolicy: 'none' }, before = structuredClone(params)
  assert.doesNotThrow(() => assertConcatSubtitleEvidence(params))
  const result = aggregateConcatReviews(params, [...previousVideo.clips, { url: currentVideo.url, sha256: currentVideo.sha256 }])
  assert.equal(result.clipReviews[0].qualityReview.status, 'unavailable')
  assert.deepEqual(result.clipReviews[1].subtitleAssessment, currentVideo.subtitleAssessment)
  assert.equal(result.clipReviews[1].subtitlePolicy, 'none')
  assert.equal(result.qualityReview.canProceed, true)
  assert.deepEqual(params, before)
})

test('concat rejects missing, unknown, stale or contradictory current subtitle proof before assembly', () => {
  const clean = cleanClip()
  for (const patch of [ { subtitleAssessment: undefined, qualityReview: { ...clean.qualityReview, subtitleAssessment: undefined } }, { passed: false }, { decoded: false },
    { subtitleAssessment: { ...clean.subtitleAssessment, status: 'unverified' } },
    { subtitleAssessment: { ...clean.subtitleAssessment, evidenceUrl: '/generated/old.json' } },
    { qualityReview: { ...clean.qualityReview, canProceed: false } },
    { qualityReview: { ...clean.qualityReview, rawReport: { ...clean.qualityReview.rawReport, subtitleCheck: { ...clean.qualityReview.rawReport.subtitleCheck, evidenceUrl: '/generated/old.json' } } } },
    { qualityReview: { ...clean.qualityReview, rawReport: { ...clean.qualityReview.rawReport, warnings: [{ code: 'unexpected_subtitle', evidence: { frameIndices: [1], finding: '底部可见乱码字幕。' } }] } } },
  ]) assert.throws(() => assertConcatSubtitleEvidence({ currentVideo: { ...clean, ...patch } }), /VIDEO_CONCAT_SUBTITLE_REJECTED/)
  assert.throws(() => aggregateConcatReviews({ currentVideo: clean }, [{ url: clean.url, sha256: 'changed-bytes' }]), /VIDEO_CONCAT_SUBTITLE_REJECTED/)
})

test('explicit allow is preserved, unknown policy is configuration failure, and absent legacy concat remains unchanged', () => {
  const legacy = { url: '/generated/legacy.mp4', qualityReview: { status: 'unavailable' } }
  assert.doesNotThrow(() => assertConcatSubtitleEvidence({ currentVideo: legacy }))
  assert.doesNotThrow(() => assertConcatSubtitleEvidence({ currentVideo: { ...legacy, subtitlePolicy: 'allow' }, subtitlePolicy: 'none' }))
  assert.doesNotThrow(() => assertConcatSubtitleEvidence({ currentVideo: { ...legacy, params: { subtitlePolicy: 'allow' } }, subtitlePolicy: 'none' }))
  assert.throws(() => assertConcatSubtitleEvidence({ currentVideo: { ...legacy, params: { subtitlePolicy: 'none' } }, subtitlePolicy: 'allow' }), /VIDEO_CONCAT_SUBTITLE_REJECTED/)
  for (const value of ['unknown', '', null, undefined]) {
    assert.throws(() => assertConcatSubtitleEvidence({ currentVideo: { ...legacy, subtitlePolicy: value } }), /SUBTITLE_POLICY_INVALID/)
    assert.throws(() => assertConcatSubtitleEvidence({ currentVideo: legacy, subtitlePolicy: value }), /SUBTITLE_POLICY_INVALID/)
  }
})

test('builtin concat checks subtitle policy before touching files, network, or assembly', async () => {
  let poolCalls = 0
  const pool = { query: async () => { poolCalls++; throw Error('must not reach database') } }
  await assert.rejects(() => executeBuiltinNode(pool as never, { operation: 'video.concat', params: { currentVideo: { url: '/generated/not-materialized.mp4', subtitlePolicy: 'none' } } }), /VIDEO_CONCAT_SUBTITLE_REJECTED/)
  assert.equal(poolCalls, 0)
})
