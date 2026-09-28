import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptPrincipleTextQuality, PRINCIPLE_TEXT_ACCEPT_CODE } from '../src/principle-text-quality.ts'
import { acceptPrincipleImages, acceptPrincipleMedia, PRINCIPLE_MEDIA_RUNTIME_CODE } from '../src/principle-media-quality.ts'
import { acceptPrincipleEpisodeQuality, PRINCIPLE_EPISODE_ACCEPT_CODE } from '../src/principle-episode-quality.ts'
import { upgradeManualReviewQuality, setQualityDisposition, upgradeLeanPrincipleQuality } from '../src/principle-quality-budget.ts'
import { upgradeWorkflowRetryAttempts } from '../src/retry-budget.ts'
import { createDramaGenerationBudget, resolveDramaGenerationLimit } from '../src/drama-generation-budget.ts'
import { isManualReview } from '../src/quality-disposition.ts'
import { principleMediaEvidenceIssue, principleQualityCanProceed } from '../src/history-cinema.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'

const manual = { qualityDisposition: 'manual-review-v1' }
const report = () => ({ version: 'principle-review-v1', decision: 'revise', issues: [{ code: 'wrong_character', problem: '人物身份与批准角色不符', repair: '按需重新抽图', evidence: { source: 'frame', frameIndices: [0], finding: '当前人物外观与原身份不符' } }], warnings: [] })
function mediaContext() {
  const shot = { id: 'shot-1', duration: 8, audioType: '环境声', audioText: '', videoPrompt: '群众围拢', pacing: { version: 'duration-v2', scheduleHash: 'current', speechWindows: [] } }
  const take = { url: 'https://example.com/current.mp4', params: { scheduleHash: 'current' } }
  return { shot_script: shot, video_take: take, media_review: report(), video_evidence: {
    decoded: true, originalUrl: take.url, url: '/generated/current.mp4', evidenceUrl: '/generated/current.json', duration: 8, width: 1280, height: 720,
    frames: ['/generated/current-0.jpg', '/generated/current-1.jpg'], lastFrameUrl: '/generated/current-1.jpg', frameTimes: [0, 7.9],
    hasAudio: true, meanVolumeDb: -33.7, transcript: [{ start: .72, end: 1.78, text: '北京旧大', words: [.6044357419, .9256300330, .6695599258, .9801586270].map(probability => ({ probability })) }],
  } }
}

test('manual text retains a grounded identity issue and original body without routing into a rewrite', async () => {
  const candidate = { id: 'shot-1', videoPrompt: '甲把信交给乙' }
  const review = { version: 'principle-review-v1', decision: 'revise', warnings: [], issues: [{ code: 'character_identity', problem: '主体身份错误', repair: '恢复乙的身份', itemId: 'shot-1', evidence: { source: 'candidate', path: 'videoPrompt', quote: '甲把信交给乙', sourceQuote: '乙把信交给甲' } }] }
  const input = { candidate, review, sourceCandidate: { description: '乙把信交给甲' } }
  assert.equal(acceptPrincipleTextQuality(input).passed, false)
  const result = acceptPrincipleTextQuality({ ...input, ...manual })
  assert.equal(result.passed, true)
  assert.equal(result.qualityReview.status, 'needs_attention')
  assert.equal(result.qualityReview.manualReviewRequired, true)
  assert.equal(result.qualityReview.automaticRetakeAllowed, false)
  assert.equal(result.qualityReview.principleIssues.length, 1)
  assert.deepEqual(result.qualityReview.rawReport, review)
  assert.equal(result.videoPrompt, candidate.videoPrompt)
  const code = await executeCodeNode({ code: PRINCIPLE_TEXT_ACCEPT_CODE, params: { ...input, ...manual } })
  assert.equal(code.passed, true)
  assert.equal((code.qualityReview as typeof result.qualityReview).manualReviewRequired, true)
  assert.throws(() => acceptPrincipleTextQuality({ candidate: {}, ...manual }), /PRINCIPLE_TEXT_INPUT_INVALID/)
})

test('manual images preserve wrong-identity and unusable-picture reports while real decode remains required', async () => {
  const input = { character_candidates: { items: [{ characterName: '甲', url: '/generated/portrait.png' }] },
    character_image_evidence: { items: [{ characterName: '甲', url: '/generated/portrait.png', decoded: true, referenceImage: '/generated/portrait-evidence.png' }] },
    character_image_review: { version: 'principle-review-v1', decision: 'revise', warnings: [], issues: ['wrong_character', 'unusable_picture'].map(code => ({ code, characterName: '甲', problem: code, repair: '用户可重新生成', evidence: { imageIndex: 0, finding: '当前图片的可见问题' } })) } }
  assert.equal(acceptPrincipleImages(input).passed, false)
  const result = acceptPrincipleImages(input, manual)
  assert.equal(result.passed, true)
  assert.equal(result.qualityReview.status, 'needs_attention')
  assert.equal(result.qualityReview.principleIssues.length, 2)
  assert.deepEqual(result.qualityReview.rawReport, input.character_image_review)
  const code = await executeCodeNode({ code: PRINCIPLE_MEDIA_RUNTIME_CODE + '\nreturn principleMediaQuality.acceptImages(context,params);', context: input, params: manual })
  assert.equal(code.passed, true)
  input.character_image_evidence.items[0].decoded = false
  assert.throws(() => acceptPrincipleImages(input, manual), /IMAGE_EVIDENCE_MISSING/)
})

test('manual video does not buy another take for actual high-confidence ASR or identity findings', async () => {
  const input = mediaContext(), before = structuredClone(input)
  const strict = acceptPrincipleMedia(input)
  assert.equal(strict.passed, false)
  const result = acceptPrincipleMedia(input, manual)
  assert.equal(result.passed, true)
  assert.equal(result.qualityReview.status, 'needs_attention')
  assert.deepEqual(result.qualityReview.principleIssues, strict.qualityReview.principleIssues)
  assert.equal(result.technicalValidation.passed, false, 'the original ASR assessment is not rewritten as verified')
  assert.equal(result.technicalValidation.speechVerified, false)
  assert.equal(result.visualReview.lipSyncVerified, false)
  assert.equal(principleQualityCanProceed(result), true)
  assert.equal(principleMediaEvidenceIssue(result, input.shot_script), undefined)
  assert.deepEqual(input, before)
  const code = await executeCodeNode({ code: PRINCIPLE_MEDIA_RUNTIME_CODE + '\nreturn principleMediaQuality.acceptMedia(context,params);', context: input, params: manual })
  assert.equal(code.passed, true)
  assert.deepEqual((code.qualityReview as typeof result.qualityReview).principleIssues, result.qualityReview.principleIssues)
  input.video_evidence.hasAudio = false
  const silent = acceptPrincipleMedia(input, manual)
  assert.equal(silent.passed, true)
  assert.equal(silent.hasAudio, false)
  assert.equal(silent.audioEmbedded, false)
  assert.equal(principleMediaEvidenceIssue(silent, input.shot_script), undefined)
  for (const change of [
    (value: ReturnType<typeof mediaContext>) => { value.video_evidence.decoded = false },
    (value: ReturnType<typeof mediaContext>) => { value.video_evidence.width = 0 },
    (value: ReturnType<typeof mediaContext>) => { value.video_evidence.duration = 0 },
    (value: ReturnType<typeof mediaContext>) => { value.video_evidence.originalUrl = 'https://example.com/stale.mp4' },
    (value: ReturnType<typeof mediaContext>) => { value.video_evidence.frames = [] },
  ]) { const broken = mediaContext(); change(broken); assert.throws(() => acceptPrincipleMedia(broken, manual), /MEDIA_EVIDENCE_MISSING/) }
})

test('manual review unavailable remains unavailable and cannot certify quality or listening', () => {
  const input = { ...mediaContext(), media_review: { reviewUnavailable: true, warnings: ['未审查'] } }
  const result = acceptPrincipleMedia(input, manual)
  assert.equal(result.passed, true)
  assert.equal(result.qualityReview.status, 'unavailable')
  assert.equal(result.qualityReview.manualReviewRequired, true)
  assert.equal(result.visualReview.passed, false)
  assert.equal(result.technicalValidation.speechVerified, false)
})

test('manual episode retains inherited rejections without pretending a full playback, but missing media blocks', async () => {
  const segment = mediaContext(), rejected = acceptPrincipleMedia(segment)
  const input = { shot_script: [segment.shot_script], video_shot: [rejected], episode_timeline: { clips: [{ shotId: 'shot-1', videoUrl: rejected.url }] }, episode_dramaturgy_review: { version: 'principle-review-v1', decision: 'pass', issues: [], warnings: [] } }
  assert.equal(acceptPrincipleEpisodeQuality(input).passed, false)
  const result = acceptPrincipleEpisodeQuality(input, manual)
  assert.equal(result.passed, true)
  assert.equal(result.status, 'needs_attention')
  assert.ok(result.qualityReview.principleIssues.length > 0)
  assert.equal(result.fullVideoWatched, false)
  assert.equal(result.renderedEpisodeVerified, false)
  assert.equal(result.automaticReshoot, false)
  const code = await executeCodeNode({ code: renderWorkflowTemplate(PRINCIPLE_EPISODE_ACCEPT_CODE, {}), context: input, params: manual })
  assert.equal(code.passed, true)
  input.video_shot = []
  assert.equal(acceptPrincipleEpisodeQuality(input, manual).passed, false)
})

const param = (key: string, value: string) => ({ id: key, name: key, englishName: key, value, type: 'text', required: true })
const value = (node: { params: ReturnType<typeof param>[] }, key: string) => node.params.find(param => param.englishName === key)?.value
test('manual migration budgets, strict restoration and later user edits survive normalization without changing history', () => {
  const workflow = { id: 'wf-sanguo-history-drama', nodes: [
    { id: 'sanguo-shot-script', kind: 'text', params: [param('maxGenerationAttempts', '5'), param('primaryTransportAttempts', '5')] },
    { id: 'sanguo-media-review', kind: 'text', params: [param('qualityMode', 'principle-v1'), param('maxReviewAttempts', '2')] },
    { id: 'video', kind: 'video', params: [] },
    { id: 'branch', kind: 'branch', params: [param('maxAttempts', '2')], acceptance: { maxAttempts: 2, retryFrom: 'video' } },
  ], edges: [{ from: 'video', to: 'branch' }], history: { rejected: true } }
  const before = structuredClone(workflow), migrated = upgradeManualReviewQuality(workflow)
  assert.deepEqual(workflow, before)
  assert.equal(migrated.edges, workflow.edges)
  assert.equal(migrated.history, workflow.history)
  assert.equal(value(migrated.nodes[0], 'maxGenerationAttempts'), '2')
  assert.equal(value(migrated.nodes[0], 'primaryTransportAttempts'), '1')
  assert.equal(value(migrated.nodes[1], 'maxReviewAttempts'), '1')
  assert.equal(value(migrated.nodes[2], 'maxGenerationAttempts'), '1')
  assert.equal(value(migrated.nodes[3], 'maxAttempts'), '1')
  assert.equal(migrated.nodes[3].acceptance?.maxAttempts, 1)
  assert.ok(migrated.nodes.every(node => isManualReview(value(node, 'qualityDisposition'))))
  assert.equal(upgradeManualReviewQuality(upgradeLeanPrincipleQuality(upgradeWorkflowRetryAttempts(migrated))), migrated)
  const strict = setQualityDisposition(migrated, 'strict-v1')
  assert.equal(value(strict.nodes[0], 'maxGenerationAttempts'), '5')
  assert.equal(value(strict.nodes[1], 'maxReviewAttempts'), '2')
  assert.equal(value(strict.nodes[2], 'maxGenerationAttempts'), undefined, 'restore the original implicit provider budget')
  assert.equal(strict.nodes[3].acceptance?.maxAttempts, 2)
  strict.nodes[0].params.find(param => param.englishName === 'maxGenerationAttempts')!.value = '4'
  assert.equal(upgradeManualReviewQuality(upgradeWorkflowRetryAttempts(strict)), strict)
  const roundTrip = setQualityDisposition(setQualityDisposition(strict, 'manual-review-v1'), 'strict-v1')
  assert.equal(value(roundTrip.nodes[0], 'maxGenerationAttempts'), '4')
  assert.equal(upgradeManualReviewQuality({ ...workflow, id: 'custom' }).nodes, workflow.nodes)
})

test('writer default and manual structure repair share a two-attempt bound without weakening explicit strict budgets', () => {
  assert.equal(resolveDramaGenerationLimit(undefined), 2)
  assert.equal(resolveDramaGenerationLimit(5, 5, 'manual-review-v1'), 2)
  assert.equal(resolveDramaGenerationLimit(1, 5, 'manual-review-v1'), 1)
  assert.equal(resolveDramaGenerationLimit(5, 2, 'strict-v1'), 5)
  const budget = createDramaGenerationBudget(undefined)
  budget.consume(); budget.consume()
  assert.equal(budget.canConsume(), false)
  assert.throws(() => budget.consume(), /已达 2 次/)
})
