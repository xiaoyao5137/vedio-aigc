import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import {
  composeHistoricalMapAnnotationFrame, composeHistoricalMapAnnotationsVideo, historicalMapAnnotationSha256,
  historicalMapAnnotationSvg, issueHistoricalMapAnnotationApproval, validateHistoricalMapAnnotations,
} from '../server/historical-map-annotations.ts'

const exec = promisify(execFile)
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string
const sourceRef = '[史料2]'
const plan = () => ({ version: 'historical-map-annotations-v1' as const, orientation: 'north-up' as const,
  sourceRefs: [sourceRef], labels: [{ text: '当阳长坂', x: .5, y: .5, sourceRef }],
  routes: [
    { id: 'liu', party: '刘备', direction: 'south' as const, color: 'blue' as const,
      points: [{ x: .25, y: .2 }, { x: .25, y: .8 }], startSecond: 0, endSecond: 3, sourceRef },
    { id: 'cao', party: '曹军', direction: 'south' as const, color: 'red' as const,
      points: [{ x: .35, y: .1 }, { x: .35, y: .72 }], startSecond: 0, endSecond: 3, sourceRef },
  ], relations: [{ type: 'approaches' as const, leaderRouteId: 'liu', followerRouteId: 'cao', direction: 'south' as const }],
})
const review = () => ({ decision: 'pass', issues: [], evidence: ['[史料2] 曹公追之，一日一夜，及於當陽之長阪。'],
  approvedSourceRefs: [sourceRef], approvedLabels: ['当阳长坂'], approvedParties: ['刘备', '曹军'], approvedRouteIds: ['liu', 'cao'] })
const historicalSources = { citations: [{ index: 2, title: '三國志/卷36', content: '曹公追之，一日一夜，及於當陽之長阪。' }] }
const approvedScene = { id: 'scene-01', editorialRole: 'episode_opening', animationStyle: 'historical_map',
  targetDuration: 3, title: '当阳长坂追击', historicalBasis: '[史料2] 曹公追之，及於當陽之長阪。',
  contextPayload: { geographicFocus: ['当阳长坂'], narration: '刘备南撤，曹军从后追赶。' },
  requiredBeats: [{ description: '刘备向南撤离，曹军向南追近。' }] }
const approvalInput = (annotations: unknown, decision: unknown = review()) =>
  ({ plan: annotations, review: decision, historicalSources, approvedScene, reviewExecutionId: 'model-run-test-annotation-review' })

test('only an independent source-bound approval can authorize local map labels and southbound routes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'historical-map-approval-'))
  try {
    const annotations = plan()
    const approval = await issueHistoricalMapAnnotationApproval(approvalInput(annotations), root)
    assert.equal(approval.annotationSha256, historicalMapAnnotationSha256(annotations))
    assert.equal(approval.status, 'approved')
    assert.deepEqual(validateHistoricalMapAnnotations(annotations, approval, 3, root), annotations)
    assert.throws(() => validateHistoricalMapAnnotations(annotations, { ...approval, signature: '0'.repeat(64) }, 3, root),
      /MAP_ANNOTATIONS_UNAPPROVED/)
    assert.throws(() => validateHistoricalMapAnnotations(annotations, { ...approval, approvedLabels: ['当阳方'] }, 3, root),
      /MAP_ANNOTATIONS_UNAPPROVED/)
    assert.throws(() => validateHistoricalMapAnnotations(annotations, { status: 'approved', annotationSha256: approval.annotationSha256,
      approvedSourceRefs: [sourceRef], approvedLabels: ['当阳长坂'], approvedParties: ['刘备', '曹军'], approvedRouteIds: ['liu', 'cao'] }, 3, root),
    /MAP_ANNOTATIONS_UNAPPROVED/)
    const changed = plan(); changed.routes[0].points[1].y = .75
    assert.throws(() => validateHistoricalMapAnnotations(changed, approval, 3, root), /MAP_ANNOTATIONS_UNAPPROVED/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('review cannot sign reversed arrows, unapproved sources or invented places', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'historical-map-invalid-'))
  try {
    const reverse = plan(); reverse.routes[0].points[1].y = .1
    await assert.rejects(() => issueHistoricalMapAnnotationApproval(approvalInput(reverse), root),
      /MAP_ANNOTATIONS_INVALID|逆向|方向/)
    const forgedSource = plan(); forgedSource.sourceRefs = ['[史料9]']; forgedSource.routes[0].sourceRef = '[史料9]'
    await assert.rejects(() => issueHistoricalMapAnnotationApproval(approvalInput(forgedSource, {
      ...review(), approvedSourceRefs: ['[史料9]'] }), root), /MAP_ANNOTATIONS_UNAPPROVED/)
    const inventedPlace = plan(); inventedPlace.labels[0].text = '当阳方'
    await assert.rejects(() => issueHistoricalMapAnnotationApproval(approvalInput(inventedPlace, {
      ...review(), approvedLabels: ['当阳方'] }), root), /MAP_ANNOTATIONS_UNAPPROVED/)
    await assert.rejects(() => issueHistoricalMapAnnotationApproval(approvalInput(plan(), { ...review(), decision: 'revise' }), root),
      /MAP_ANNOTATIONS_UNAPPROVED/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('source-approved label-only and clean-plate plans do not invent route arrows', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'historical-map-empty-route-'))
  try {
    for (const labels of [plan().labels, []]) {
      const annotations = { version: 'historical-map-annotations-v1' as const, orientation: 'north-up' as const,
        sourceRefs: [sourceRef], labels, routes: [] }
      const decision = { ...review(), approvedLabels: labels.map(label => label.text), approvedParties: [], approvedRouteIds: [] }
      await assert.rejects(() => issueHistoricalMapAnnotationApproval(approvalInput(annotations, decision), root),
        /MAP_ANNOTATIONS_UNAPPROVED|MAP_ANNOTATIONS_INVALID|路线|追逃|行军/,
        'a chase beat must not silently lose both movement routes')
      const geographicScene = { ...approvedScene,
        requiredBeats: [{ description: '介绍当阳长坂的山川与城址方位。' }],
        contextPayload: { geographicFocus: ['当阳长坂'], narration: '此处为当阳长坂，山川环绕。' } }
      const approval = await issueHistoricalMapAnnotationApproval({ ...approvalInput(annotations, decision),
        approvedScene: geographicScene }, root)
      const validated = validateHistoricalMapAnnotations(annotations, approval, 3, root)
      assert.deepEqual(validated.routes, [])
      assert.doesNotMatch(historicalMapAnnotationSvg(validated, 3, 640, 360), /<path\b|<circle\b/)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('approved labels and routes are composited locally after clean moving map and keep environmental sound', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'historical-map-overlay-'))
  const dir = path.join(root, 'public/generated'); await mkdir(dir, { recursive: true })
  try {
    const annotations = plan(), approval = await issueHistoricalMapAnnotationApproval(approvalInput(annotations), root)
    await sharp({ create: { width: 640, height: 360, channels: 3, background: '#f8efd9' } }).png().toFile(path.join(dir, 'clean-map.png'))
    const early = await composeHistoricalMapAnnotationFrame('/generated/clean-map.png', annotations, approval, 0, 3, root)
    const late = await composeHistoricalMapAnnotationFrame('/generated/clean-map.png', annotations, approval, 3, 3, root)
    assert.notEqual(early.url, late.url)
    const crop = (url: string) => sharp(path.join(root, 'public', url))
      .extract({ left: 154, top: 245, width: 12, height: 18 }).removeAlpha().raw().toBuffer()
    const [before, after] = await Promise.all([crop(early.url), crop(late.url)])
    const difference = before.reduce((sum, byte, index) => sum + Math.abs(byte - after[index]), 0) / before.length
    assert.ok(difference > 5, 'route should appear near its approved southbound destination')
    await exec(ffmpeg, ['-v', 'error', '-loop', '1', '-i', path.join(dir, 'clean-map.png'), '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3',
      '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'clean-map.mp4')])
    const video = await composeHistoricalMapAnnotationsVideo('/generated/clean-map.mp4', annotations, approval, 3, '16:9', root)
    assert.equal(video.route, 'historical-map-annotations-v1')
    assert.equal(video.environmentalTrack, 'preserved')
    const probe = await exec(ffmpeg, ['-hide_banner', '-i', path.join(root, 'public', video.url), '-f', 'null', '-'])
    assert.match(probe.stderr, /Audio:/)
    assert.doesNotMatch(probe.stderr, /Subtitle:/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
