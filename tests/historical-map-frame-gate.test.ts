import test from 'node:test'
import assert from 'node:assert/strict'
import { executeCodeNode } from '../server/code-node.ts'
import { insertMissingExecutionNodes } from '../src/execution-topology.ts'
import { firstBlockingRunIndex, hasExecutionPlanMismatch } from '../src/workflow-core.ts'
import {
  HISTORICAL_MAP_FIRST_FRAME_GATE_CODE, HISTORICAL_MAP_FRAME_GATE_CODE,
  upgradeHistoricalMapFrameGate, validateHistoricalMapFrameCertificate, validateHistoricalMapFrameReview,
} from '../src/historical-map-frame-gate.ts'

const shot = {
  visualPrompt: '当阳与长坂的历史地理底图；曹军从北向南追击，刘备从北向南撤离。',
  lastFramePrompt: '同一地图上，曹军向南推进，刘备向南撤至长坂。',
  videoPrompt: '两条路线分别向南渐显，山河和城址保持位置。',
}
const fingerprint = (role: string) => role === 'first' ? 'a'.repeat(24) : 'b'.repeat(24)
const image = (role: string) => ({ role, url: `/generated/map-${role}.png`,
  referenceImage: `/generated/image-evidence-${fingerprint(role)}.jpg`, decoded: true })
const evidence = (count: 1 | 2) => ({ evidenceUrl: `/generated/image-evidence-${'c'.repeat(24)}.json`,
  items: (count === 1 ? ['first'] : ['first', 'end']).map(image) })
const frame = (role: string) => ({ role, sourceUrl: image(role).url, evidenceReferenceImage: image(role).referenceImage,
  bakedPeople: false, unreadableText: false, observedLabels: [], approvedLabels: [],
  routeMarksVisible: false,
  routes: [] as Array<{ observedStart: string; observedEnd: string; observedDirection: string; approvedStart: string;
    approvedEnd: string; approvedDirection: string; sourceQuote: string; matchesApprovedRoute: boolean }>,
  hardChecks: { peopleFree: true, labelsApproved: true, routesCorrect: true, geographyConsistent: true }, issues: [] })
const report = (count: 1 | 2) => ({ version: 'historical-map-frame-review-v1', passed: true,
  evidenceUrl: evidence(count).evidenceUrl, frames: (count === 1 ? ['first'] : ['first', 'end']).map(frame), issues: [] })

test('actual first image is accepted before the paid end image; final certificate binds both decoded frames', async () => {
  const first = validateHistoricalMapFrameReview(report(1), evidence(1), shot)
  assert.equal(first.version, 'historical-map-first-frame-gate-v1')
  assert.deepEqual(await executeCodeNode({ code: HISTORICAL_MAP_FIRST_FRAME_GATE_CODE,
    params: { review: report(1), evidence: evidence(1), shot } }), { ...first, executionLogs: [] })
  const final = validateHistoricalMapFrameReview(report(2), evidence(2), shot, first)
  assert.equal(final.version, 'historical-map-frame-gate-v1')
  assert.deepEqual(await executeCodeNode({ code: HISTORICAL_MAP_FRAME_GATE_CODE,
    params: { review: report(2), evidence: evidence(2), shot, prior: first } }), { ...final, executionLogs: [] })
  assert.doesNotThrow(() => validateHistoricalMapFrameCertificate(final, image('first').url, image('end').url))
  assert.throws(() => validateHistoricalMapFrameCertificate(final, image('first').url, '/generated/replaced-end.png'),
    /HISTORICAL_MAP_FRAME_GATE_MISMATCH/)
})

test('a real-image report cannot mark baked portraits, wrong labels, unreadable text or reversed arrows as passed', async () => {
  const cases: Array<[string, (candidate: ReturnType<typeof report>) => void]> = [
    ['baked portrait', candidate => { candidate.frames[0].bakedPeople = true }],
    ['portrait check contradicts pass', candidate => { candidate.frames[0].hardChecks.peopleFree = false }],
    ['made-up place name', candidate => { candidate.frames[0].observedLabels.push('当阳方') }],
    ['approved place name baked into the image', candidate => { candidate.frames[0].observedLabels.push('当阳') }],
    ['unreadable pseudo text', candidate => { candidate.frames[0].unreadableText = true }],
    ['route points northeast', candidate => { candidate.frames[0].routeMarksVisible = true; candidate.frames[0].routes.push({
      observedStart: '北', observedEnd: '东北', observedDirection: 'northeast', approvedStart: '北', approvedEnd: '南',
      approvedDirection: 'south', sourceQuote: '从北向南', matchesApprovedRoute: false }) }],
    ['route marker is baked into the image', candidate => { candidate.frames[0].routeMarksVisible = true; candidate.frames[0].routes.push({
      observedStart: '北', observedEnd: '南', observedDirection: 'south', approvedStart: '北', approvedEnd: '南',
      approvedDirection: 'south', sourceQuote: '从北向南', matchesApprovedRoute: true }) }],
    ['route check contradicts pass', candidate => { candidate.frames[0].hardChecks.routesCorrect = false }],
    ['geography drifts between frames', candidate => { candidate.frames[1].hardChecks.geographyConsistent = false }],
  ]
  const first = validateHistoricalMapFrameReview(report(1), evidence(1), shot)
  for (const [name, change] of cases) {
    const candidate = report(2)
    change(candidate)
    assert.throws(() => validateHistoricalMapFrameReview(candidate, evidence(2), shot, first),
      /HISTORICAL_MAP_FRAME_REJECTED/, name)
    await assert.rejects(() => executeCodeNode({ code: HISTORICAL_MAP_FRAME_GATE_CODE,
      params: { review: candidate, evidence: evidence(2), shot, prior: first } }), /HISTORICAL_MAP_FRAME_REJECTED/, name)
  }
})

test('missing, uncertain or stale first-frame evidence fails before any paid tail request', async () => {
  const cases: Array<[string, (candidate: ReturnType<typeof report>, actual: ReturnType<typeof evidence>) => void]> = [
    ['review rejected', candidate => { candidate.passed = false }],
    ['review issue survives an inconsistent pass', candidate => { candidate.frames[0].issues.push('左上出现人物头像') }],
    ['report from another image', candidate => { candidate.frames[0].sourceUrl = '/generated/other.png' }],
    ['report from another evidence file', candidate => { candidate.evidenceUrl = '/generated/image-evidence-' + 'd'.repeat(24) + '.json' }],
    ['source image not decoded', (_candidate, actual) => { actual.items[0].decoded = false }],
  ]
  for (const [name, change] of cases) {
    const candidate = report(1), actual = evidence(1)
    change(candidate, actual)
    assert.throws(() => validateHistoricalMapFrameReview(candidate, actual, shot), /HISTORICAL_MAP_FRAME_REJECTED/, name)
    await assert.rejects(() => executeCodeNode({ code: HISTORICAL_MAP_FIRST_FRAME_GATE_CODE,
      params: { review: candidate, evidence: actual, shot } }), /HISTORICAL_MAP_FRAME_REJECTED/, name)
  }
  assert.throws(() => validateHistoricalMapFrameReview(report(2), evidence(2), shot),
    /首帧采证与付费前审核凭证不一致/)
})

test('schema 153 places a no-repurchase gate before each paid tail and video while preserving saved asset history', () => {
  const shared = { prompt: 'kept', params: [], uploads: [], loop: { enabled: false, sourcePath: '', fallbackCount: 1, itemVar: 'item' },
    position: { x: 0, y: 0 }, resultVar: 'kept', title: 'kept' }
  const node = (id: string, kind: string) => ({ ...shared, id, kind })
  const first = { ...node('sanguo-animated-map-first-frame', 'image'), parentId: 'sanguo-scene-loop' }
  const end = { ...node('sanguo-end-frame', 'image'), parentId: 'sanguo-scene-loop' }
  const video = { ...node('sanguo-video', 'video'), parentId: 'sanguo-scene-loop', modelId: 'selected-paid-video-model' }
  const branch = { ...node('sanguo-first-frame-branch', 'code'), parentId: 'sanguo-scene-loop', code: 'custom branch logic' }
  const owner = { ...node('sanguo-scene-loop', 'loop'), childIds: [branch.id, first.id, end.id, video.id] }
  const saved = [{ id: 'paid-prior-scene', output: { url: '/generated/already-paid.mp4' } }]
  const source = { id: 'wf-sanguo-history-drama', schemaVersion: 151, nodes: [owner, branch, first, end, video],
    edges: [{ id: 'old-first-end', from: first.id, to: end.id }, { id: 'old-end-video', from: end.id, to: video.id }],
    frozenExecutions: saved }
  const upgraded = upgradeHistoricalMapFrameGate(source)
  assert.equal(upgraded.schemaVersion, 153)
  assert.equal(upgraded.frozenExecutions, saved)
  const upgradedFirst = upgraded.nodes.find(item => item.id === first.id)!
  const upgradedEnd = upgraded.nodes.find(item => item.id === end.id)!
  assert.equal(upgradedFirst.prompt, first.prompt)
  assert.equal(upgradedEnd.prompt, end.prompt)
  assert.deepEqual(upgradedFirst.params.map(item => item.englishName),
    ['mapAnnotations', 'mapAnnotationApproval', 'mapApprovedScene', 'mapDuration', 'mapEditorialRole'],
  'old paid first images are preserved, but direct retries must carry a signed map-plan preflight')
  assert.deepEqual(upgradedEnd.params.map(item => item.englishName), ['mapFirstGate', 'mapShot', 'mapEditorialRole'],
    'old paid end images are preserved, but direct retries must carry the reviewed first-frame gate')
  assert.equal(upgraded.nodes.find(item => item.id === branch.id)?.code, branch.code)
  const childIds = upgraded.nodes.find(item => item.id === owner.id)?.childIds ?? []
  const firstGate = childIds.indexOf('sanguo-map-first-accept'), endGate = childIds.indexOf('sanguo-map-end-accept')
  assert.ok(childIds.indexOf('sanguo-map-annotation-review') < childIds.indexOf('sanguo-map-annotation-approval'))
  assert.ok(childIds.indexOf('sanguo-map-annotation-approval') < childIds.indexOf(first.id),
    'unapproved map labels and routes must stop before buying the first image')
  assert.ok(childIds.indexOf(first.id) < firstGate && firstGate < childIds.indexOf(end.id))
  assert.ok(childIds.indexOf(end.id) < endGate && endGate < childIds.indexOf(video.id))
  const afterRejectedFirstFrame = childIds.map((id, index) => ({ id,
    status: index < firstGate ? 'success' : index === firstGate ? 'failed' : 'idle' }))
  assert.equal(afterRejectedFirstFrame[firstBlockingRunIndex(afterRejectedFirstFrame as never,
    childIds.indexOf(end.id))].id, 'sanguo-map-first-accept',
  'retrying the paid end frame must stop at the rejected first-frame review')
  assert.equal(afterRejectedFirstFrame[childIds.indexOf(end.id)].status, 'idle')
  assert.ok(!upgraded.nodes.find(item => item.id === 'sanguo-map-first-accept')?.acceptance)
  assert.ok(!upgraded.nodes.find(item => item.id === 'sanguo-map-end-accept')?.acceptance)
  assert.equal(upgraded.nodes.find(item => item.id === video.id)?.modelId, 'selected-paid-video-model')
  assert.deepEqual(upgraded.nodes.find(item => item.id === video.id)?.params.slice(-4).map(item => item.englishName).sort(),
    ['mapFrameGate', 'mapAnnotations', 'mapAnnotationApproval', 'mapShot'].sort())
  assert.equal(upgradeHistoricalMapFrameGate(upgraded), upgraded)
  const oldCodeAccepts = { ...upgraded, schemaVersion: 152,
    nodes: upgraded.nodes.map(item => item.id === 'sanguo-map-first-accept'
      ? { ...item, kind: 'code', code: HISTORICAL_MAP_FIRST_FRAME_GATE_CODE }
      : item.id === 'sanguo-map-end-accept'
        ? { ...item, kind: 'code', code: HISTORICAL_MAP_FRAME_GATE_CODE } : item) }
  const migratedAccepts = upgradeHistoricalMapFrameGate(oldCodeAccepts)
  for (const id of ['sanguo-map-first-accept', 'sanguo-map-end-accept']) {
    const accepted = migratedAccepts.nodes.find(item => item.id === id)
    assert.equal(accepted?.kind, 'http', `${id} must issue a server signed certificate`)
    assert.deepEqual((accepted as { request?: unknown }).request,
      { url: '/api/historical-map-frame-approval', method: 'POST' })
  }
  assert.equal(migratedAccepts.schemaVersion, 153)
  assert.equal(migratedAccepts.frozenExecutions, saved)
  assert.equal(upgradeHistoricalMapFrameGate(migratedAccepts), migratedAccepts)
})

test('additive gate recovery keeps an old paid video and paid frames, but blocks a pending second video behind new reviews', () => {
  const shared = { prompt: 'kept', params: [], uploads: [], loop: { enabled: false, sourcePath: '', fallbackCount: 1, itemVar: 'item' },
    position: { x: 0, y: 0 }, resultVar: 'kept', title: 'kept' }
  const ownerId = 'sanguo-scene-loop'
  const child = (id: string, kind: string) => ({ ...shared, id, kind, parentId: ownerId })
  const branch = { ...child('sanguo-first-frame-branch', 'code'), code: 'custom' }
  const tail = child('sanguo-first-frame-tail', 'code')
  const first = child('sanguo-animated-map-first-frame', 'image')
  const end = child('sanguo-end-frame', 'image')
  const video = child('sanguo-video', 'video')
  const owner = { ...shared, id: ownerId, kind: 'loop', childIds: [branch.id, tail.id, first.id, end.id, video.id] }
  const children = [branch, tail, first, end, video]
  const source = { id: 'wf-sanguo-history-drama', schemaVersion: 151,
    nodes: [owner, ...children], edges: children.slice(1).map((node, index) => ({ id: `old-${index}`, from: children[index].id, to: node.id })) }
  const workflow = upgradeHistoricalMapFrameGate(source)
  const oldPaid = { url: '/generated/prior-paid.mp4', providerTaskId: 'old-task' }
  const firstPaid = { url: '/generated/current-first.png', providerTaskId: 'first-task' }
  const endPaid = { url: '/generated/current-end.png', providerTaskId: 'end-task' }
  const run = (node: typeof children[number], round: number) => ({ id: `${node.id}:${round}`, node,
    status: round === 0 || node.kind !== 'video' ? 'success' : 'idle',
    output: round === 0 && node.kind === 'video' ? oldPaid
      : round === 1 && node.id === first.id ? firstPaid : round === 1 && node.id === end.id ? endPaid : undefined,
    context: {}, durationMs: 1, loopNode: owner, loopGroupId: 'g', loopIndex: round,
    loopItem: { id: `scene-${round}` }, loopIsLast: round === 1 && node.id === video.id })
  const runs = [{ id: ownerId, node: owner, status: 'success', context: {}, durationMs: 1 },
    ...children.map(node => run(node, 0)), ...children.map(node => run(node, 1))]
  const recovered = insertMissingExecutionNodes(workflow, runs)
  assert.notEqual(recovered, runs, 'pending iteration must gain review nodes')
  const priorVideo = recovered.find(item => item.id === `${video.id}:0`)
  assert.equal(priorVideo?.status, 'success')
  assert.equal(priorVideo?.output, oldPaid)
  assert.equal(recovered.filter(item => item.loopIndex === 0 && item.node.id.startsWith('sanguo-map-')).length, 0)
  assert.equal(recovered.find(item => item.id === `${first.id}:1`)?.output, firstPaid)
  assert.equal(recovered.find(item => item.id === `${end.id}:1`)?.output, endPaid)
  assert.equal(recovered.find(item => item.id === `${first.id}:1`)?.status, 'success')
  assert.equal(recovered.find(item => item.id === `${end.id}:1`)?.status, 'success')
  assert.equal(recovered.find(item => item.id === `${video.id}:1`)?.status, 'idle')
  const reviewRuns = recovered.filter(item => item.loopIndex === 1 && item.node.id.startsWith('sanguo-map-'))
  assert.equal(reviewRuns.length, 8)
  assert.ok(reviewRuns.every(item => item.status === 'idle'))
  assert.equal(recovered[firstBlockingRunIndex(recovered as never, recovered.length - 1)].node.id, 'sanguo-map-annotation-review')
  assert.equal(insertMissingExecutionNodes(workflow, recovered), recovered, 'recovery is idempotent')
})

test('schema 152 code gate snapshots do not block a non-map pending scene or replay an earlier paid video', () => {
  const shared = { prompt: 'kept', params: [], uploads: [], loop: { enabled: false, sourcePath: '', fallbackCount: 1, itemVar: 'item' },
    position: { x: 0, y: 0 }, resultVar: 'kept', title: 'kept' }
  const ownerId = 'sanguo-scene-loop'
  const child = (id: string, kind: string) => ({ ...shared, id, kind, parentId: ownerId })
  const branch = { ...child('sanguo-first-frame-branch', 'code'), code: 'branch' }
  const tail = child('sanguo-first-frame-tail', 'code')
  const first = child('sanguo-animated-map-first-frame', 'image')
  const end = child('sanguo-end-frame', 'image')
  const video = child('sanguo-video', 'video')
  const owner = { ...shared, id: ownerId, kind: 'loop', childIds: [branch.id, tail.id, first.id, end.id, video.id] }
  const source = { id: 'wf-sanguo-history-drama', schemaVersion: 151,
    nodes: [owner, branch, tail, first, end, video],
    edges: [{ id: 'old-branch-tail', from: branch.id, to: tail.id },
      { id: 'old-tail-first', from: tail.id, to: first.id },
      { id: 'old-first-end', from: first.id, to: end.id },
      { id: 'old-end-video', from: end.id, to: video.id }] }
  const workflow = upgradeHistoricalMapFrameGate(source)
  const legacyNodes = new Map(workflow.nodes.map(node => [node.id,
    node.id === 'sanguo-map-first-accept'
      ? { ...node, kind: 'code', code: HISTORICAL_MAP_FIRST_FRAME_GATE_CODE }
      : node.id === 'sanguo-map-end-accept'
        ? { ...node, kind: 'code', code: HISTORICAL_MAP_FRAME_GATE_CODE } : node]))
  const childIds = workflow.nodes.find(node => node.id === ownerId)!.childIds!
  const paid = { url: '/generated/already-paid-non-map.mp4', providerTaskId: 'historic-paid-task' }
  const run = (id: string, round: number) => ({ id: `${id}:${round}`, node: legacyNodes.get(id)!,
    status: id === video.id ? round === 0 ? 'success' : 'idle'
      : id.startsWith('sanguo-map-') || id === first.id || id === end.id ? 'skipped' : 'success',
    output: id === video.id && round === 0 ? paid : undefined,
    context: { first_frame_branch: { animationStyle: 'live_action' } }, durationMs: 1,
    loopNode: legacyNodes.get(ownerId)!, loopGroupId: `non-map-${round}`, loopIndex: round,
    loopItem: { id: `scene-${round}`, animationStyle: 'live_action' }, loopIsLast: id === video.id })
  const runs = [{ id: ownerId, node: legacyNodes.get(ownerId)!, status: 'success', context: {}, durationMs: 1 },
    ...childIds.map(id => run(id, 0)), ...childIds.map(id => run(id, 1))]
  const recovered = insertMissingExecutionNodes(workflow, runs)
  assert.equal(recovered.find(item => item.id === `${video.id}:0`)?.status, 'success')
  assert.equal(recovered.find(item => item.id === `${video.id}:0`)?.output, paid)
  assert.equal(recovered.find(item => item.id === `${video.id}:1`)?.status, 'idle')
  assert.equal(recovered.find(item => item.id === 'sanguo-map-first-accept:1')?.status, 'skipped')
  assert.equal(recovered.find(item => item.id === 'sanguo-map-end-accept:1')?.status, 'skipped')
  const currentNodes = new Map(workflow.nodes.map(node => [node.id, node]))
  const staleIds = recovered.filter(item => JSON.stringify(item.node) !== JSON.stringify(currentNodes.get(item.node.id)))
    .map(item => item.id)
  assert.equal(hasExecutionPlanMismatch(workflow, recovered as never), false,
    `a known signed HTTP upgrade must not deadlock a non-map scene behind skipped old code gates: ${staleIds.join(', ')}`)
})
