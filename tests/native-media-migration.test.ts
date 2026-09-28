import test from 'node:test'
import assert from 'node:assert/strict'
import {
  upgradeNativeSequenceMediaEvidence, ADAPTIVE_MEDIA_SAMPLING_REQUEST_CODE,
  REQUIREMENT_REVIEW_METRICS_CODE, INDEPENDENT_MEDIA_REVIEW_VIEW_CODE, ADAPTIVE_MEDIA_REVIEW_GUARD_CODE,
  NATIVE_MEDIA_OBSERVATION_GUARD_CODE, upgradeQualityWorkflow,
} from '../src/quality-node-presets.ts'
import { CANONICAL_MEDIA_REVIEW_PROMPT } from '../src/canonical-media-review.ts'
import { REQUIREMENT_MEDIA_REVIEW_PROMPT } from '../src/media-requirement-review.ts'

const parameter = (name: string, value: string, type = 'json', required = true) => ({ id: name, name, englishName: name, value, type, required })
const node = (id: string, kind: string) => ({ id, kind, title: id, resultVar: id, prompt: '', code: '', modelId: 'saved-model',
  params: [] as ReturnType<typeof parameter>[], uploads: [], position: { x: 1, y: 2 },
  loop: { enabled: false, sourcePath: '', fallbackCount: 1, itemVar: 'item' } })
const metricsReturn = 'return {requirementReviewInputs,requirements,tailTiming,frames:evidence.frames.map((url,index)=>({url,index,second:evidence.frameTimes[index]})),'
const requestReturn = 'return { sampleTimes:samplingPlan.sampleTimes,'
const oldObservationGuard = "if (!Array.isArray(observations?.frames) || observations.frames.length !== e.frames.length\n  || observations.frames.some((r,i) => r.index !== i || !Array.isArray(r.people) || typeof r.setting !== 'string') || !observations.tailObservation) invalid('逐帧观察不完整');"
const fixture = () => ({ id: 'wf-sanguo-history-drama', schemaVersion: 109, nodes: [
  { ...node('sanguo-media-request', 'code'), code: '// request-custom-before\nconst shot=context.shot_script;\n' + ADAPTIVE_MEDIA_SAMPLING_REQUEST_CODE
    + '\n' + requestReturn + 'samplingPlan,audioType:shot.audioType,custom:"request"};\n// request-custom-after', params: [parameter('maxSamplingFrames', '24', 'number')] },
  { ...node('sanguo-video-evidence', 'request'), request: { url: '/api/video-evidence', method: 'POST' as const },
    params: [parameter('sampleTimes', '${media_request.sampleTimes}'), parameter('custom', 'retain-evidence-option', 'text')] },
  { ...node('sanguo-media-metrics', 'code'), code: '// metrics-custom-before\nconst shot=context.shot_script,evidence=context.video_evidence;const requirements=[],tailTiming={};\n'
    + REQUIREMENT_REVIEW_METRICS_CODE + '\n' + metricsReturn + 'custom:"metrics"};\n// metrics-custom-after' },
  { ...node('sanguo-requirement-review', 'text'), prompt: '单项用户前缀\n' + REQUIREMENT_MEDIA_REVIEW_PROMPT + '\n单项用户后缀',
    params: [parameter('reviewImages', '${requirementInput.reviewImages}'), parameter('timeoutMs', '900000', 'number')] },
  { ...node('sanguo-media-review', 'text'), prompt: '综合用户前缀\n' + CANONICAL_MEDIA_REVIEW_PROMPT + '\n综合用户后缀',
    params: [parameter('reviewImages', '${video_evidence.frames}'), parameter('reviewImageDetail', '{"indices":[0],"columns":2,"rows":2,"overlap":0.25}'), parameter('reasoningEffort', 'ultra', 'text')] },
  { ...node('sanguo-media-accept', 'code'), code: '// gate-custom-before\n' + INDEPENDENT_MEDIA_REVIEW_VIEW_CODE + '\n// gate-custom-between\n'
    + ADAPTIVE_MEDIA_REVIEW_GUARD_CODE + '\n' + oldObservationGuard + '\nreturn review;\n// gate-custom-after',
    params: [parameter('maxAdaptiveSamplingFrames', '24', 'number'), parameter('maxAdaptiveSamplingRounds', '2', 'number'), parameter('customThreshold', '.12', 'number')] },
  { ...node('sanguo-media-observe', 'text'), prompt: '现有无剧本观察', mapInput: { sourcePath: 'media_metrics.frames', itemVar: 'frame', maxItems: 24, concurrency: 4 } },
  { ...node('sanguo-media-accept-error-branch', 'branch'), code: 'return false;', params: [parameter('maxAttempts', '4', 'number')] },
  { ...node('sanguo-video', 'video'), prompt: '原付费视频请求', params: [parameter('duration', '14', 'number')], captureTail: true },
], edges: [
  { id: 'preserved-paid-edge', from: 'sanguo-video', to: 'sanguo-media-request' },
  { id: 'preserved-error-edge', from: 'sanguo-media-accept-error-branch', to: 'sanguo-media-request', branch: 'false' },
] })
type Fixture = ReturnType<typeof fixture>
const get = (workflow: Fixture, id: string) => workflow.nodes.find(node => node.id === id)!
const param = (workflow: Fixture, id: string, name: string) => get(workflow, id).params.find(value => value.englishName === name)
const execute = (code: string, context: Record<string, unknown>, params: Record<string, unknown> = {}) => new Function('context', 'params', code)(context, params)
const shot = { duration: 4, audioType: '对白', visualPrompt: '人物站立。', videoPrompt: '0-1秒：人物站立。1-3秒：人物抬手回应。3-4秒：人物保持姿态。', lastFramePrompt: '人物保持姿态。' }
const evidence = () => ({ frames: Array.from({ length: 9 }, (_, i) => '/generated/frame-' + i + '.jpg'), frameTimes: [0, .5, 1, 1.5, 2, 2.5, 3, 3.5, 4] })

test('schema110 preserves custom contract surroundings, model configuration, paid nodes, topology and sparse budgets', () => {
  const source = fixture(), before = structuredClone(source), next = upgradeNativeSequenceMediaEvidence(source)
  assert.equal(next.schemaVersion, 110)
  assert.deepEqual(source, before)
  assert.equal(next.edges, source.edges)
  assert.equal(upgradeNativeSequenceMediaEvidence(next), next)
  assert.equal(get(next, 'sanguo-requirement-review').prompt, '单项用户前缀\n' + REQUIREMENT_MEDIA_REVIEW_PROMPT + '\n单项用户后缀')
  assert.equal(get(next, 'sanguo-media-review').prompt, '综合用户前缀\n' + CANONICAL_MEDIA_REVIEW_PROMPT + '\n综合用户后缀')
  for (const [id, label] of [['sanguo-media-request', 'request'], ['sanguo-media-metrics', 'metrics'], ['sanguo-media-accept', 'gate']]) {
    assert.ok(get(next, id).code.startsWith('// ' + label + '-custom-before\n'))
    assert.ok(get(next, id).code.endsWith('// ' + label + '-custom-after'))
  }
  assert.ok(get(next, 'sanguo-media-accept').code.includes('// gate-custom-between'))
  for (const original of source.nodes) {
    assert.equal(get(next, original.id).modelId, original.modelId)
    for (const value of original.params.filter(p => p.englishName !== 'reviewImageDetail')) assert.equal(param(next, original.id, value.englishName), value)
  }
  for (const id of ['sanguo-video', 'sanguo-media-observe', 'sanguo-media-accept-error-branch']) assert.equal(get(next, id), get(source, id))
  assert.equal(param(next, 'sanguo-media-accept', 'maxAdaptiveSamplingFrames')?.value, '24')
  assert.equal(param(next, 'sanguo-media-accept', 'maxAdaptiveSamplingRounds')?.value, '2')
  assert.deepEqual(param(next, 'sanguo-media-accept', 'nativeSequenceEvidence'), { id: 'qa-nativeSequenceEvidence', name: 'nativeSequenceEvidence', englishName: 'nativeSequenceEvidence', value: 'true', type: 'boolean', required: true })
  assert.equal(param(next, 'sanguo-media-accept', 'maxNativeReviewFrames')?.value, '160')
  assert.equal(param(next, 'sanguo-media-accept', 'maxNativeReviewFrames')?.type, 'number')
  assert.equal(param(next, 'sanguo-video-evidence', 'nativeSequence')?.required, false)
  assert.equal(param(next, 'sanguo-requirement-review', 'reviewImageDetail')?.required, false)
  assert.equal(param(next, 'sanguo-media-review', 'reviewImageDetail')?.value, '${media_metrics.reviewImageDetail}')
  assert.ok(get(next, 'sanguo-media-accept').code.includes('nativeSequence:params.nativeSequenceEvidence,nativeReviewMaxFrames:params.maxNativeReviewFrames'))
})

test('native configuration respects explicit existing opt-out and native budget without relaxing sparse limits', () => {
  const source = fixture(), gate = get(source, 'sanguo-media-accept')
  const optOut = parameter('nativeSequenceEvidence', 'false', 'boolean'), limit = parameter('maxNativeReviewFrames', '96', 'number')
  gate.params.push(optOut, limit)
  const next = upgradeNativeSequenceMediaEvidence(source)
  assert.equal(param(next, gate.id, optOut.englishName), optOut)
  assert.equal(param(next, gate.id, limit.englishName), limit)
  assert.equal(get(next, gate.id).params.filter(p => p.englishName === optOut.englishName).length, 1)
  assert.equal(param(next, gate.id, 'maxAdaptiveSamplingRounds')?.value, '2')
  assert.equal(param(next, gate.id, 'maxAdaptiveSamplingFrames')?.value, '24')
})

test('migrated native request forwards same-source sequence metadata and legacy requests keep optional native fields empty', () => {
  const source = fixture(), next = upgradeNativeSequenceMediaEvidence(source), code = get(next, 'sanguo-media-request').code
  const context = { shot_script: shot, video_take: { url: '/generated/paid.mp4' } }
  const old = execute(get(source, 'sanguo-media-request').code, context, { maxSamplingFrames: 24 })
  const ordinary = execute(code, context, { maxSamplingFrames: 24 })
  assert.equal(ordinary.nativeSequence, undefined)
  assert.deepEqual(JSON.parse(JSON.stringify(ordinary)), old)
  const nativeSequence = { enabled: true, windows: [{ start: 1, end: 3 }], reviewMaxFrames: 160 }
  const retry = { sourceUrl: context.video_take.url, round: 2, sampleTimes: [0, 1, 2, 3, 3.96], nativeSequence }
  const before = structuredClone(retry)
  const actual = execute(code, { ...context, mediaSamplingRetry: retry }, { maxSamplingFrames: 24 })
  assert.deepEqual(actual.nativeSequence, nativeSequence)
  assert.deepEqual(actual.sampleTimes, retry.sampleTimes)
  assert.equal(actual.samplingPlan.adaptiveRound, 2)
  assert.deepEqual(retry, before)
  assert.equal(execute(code, { ...context, mediaSamplingRetry: { ...retry, sourceUrl: '/generated/other.mp4' } }, { maxSamplingFrames: 24 }).nativeSequence, undefined)
})

test('migrated metrics keep observer coverage separate from full native review images and local requirement frame numbers', () => {
  const next = upgradeNativeSequenceMediaEvidence(fixture()), media = evidence()
  const refs = media.frames.map((url, i) => ({ evidenceIndex: i, nativeFrameIndex: i * 12, url, second: media.frameTimes[i], pts: i * 6144, timeBase: '1/12288', sourceSha256: 'a'.repeat(64) }))
  const native = { ...media, frameReferences: refs, nativeSequence: { windows: [{ start: 1, end: 3, complete: true }],
    preservedSamples: [0, 2, 6, 8].map(i => ({ evidenceIndex: i, nativeFrameIndex: refs[i].nativeFrameIndex })) } }
  const before = structuredClone(native)
  const output = execute(get(next, 'sanguo-media-metrics').code, { shot_script: shot, video_evidence: native })
  assert.deepEqual(output.frames.map((frame: { index: number }) => frame.index), [0, 2, 6, 8])
  assert.equal(output.reviewImageDetail.frameMetadata.length, 9)
  assert.deepEqual(output.reviewImageDetail.frameMetadata.map((frame: { evidenceIndex: number }) => frame.evidenceIndex), Array.from({ length: 9 }, (_, i) => i))
  assert.deepEqual(output.reviewImageDetail.transport, { mode: 'sequence-grid', columns: 2, rows: 2, format: 'jpeg', quality: 95, chromaSubsampling: '4:4:4' })
  const interval = output.requirementReviewInputs.find((row: { requirement: { startSecond: number; endSecond: number } }) => row.requirement.startSecond === 1 && row.requirement.endSecond === 3)
  assert.deepEqual(interval.frameReferences.map((ref: { index: number }) => ref.index), [2, 3, 4, 5, 6])
  assert.deepEqual(interval.reviewImageDetail.frameMetadata.map((ref: { evidenceIndex: number }) => ref.evidenceIndex), [0, 1, 2, 3, 4])
  assert.deepEqual(interval.reviewImageDetail.frameMetadata.map((ref: { nativeFrameIndex: number }) => ref.nativeFrameIndex), [24, 36, 48, 60, 72])
  assert.deepEqual(native, before)
  const ordinary = execute(get(next, 'sanguo-media-metrics').code, { shot_script: shot, video_evidence: media })
  assert.equal(ordinary.frames.length, media.frames.length)
  assert.deepEqual(ordinary.reviewImageDetail, { indices: [0], columns: 2, rows: 2, overlap: .25 })
  assert.ok(ordinary.requirementReviewInputs.every((row: { reviewImageDetail?: unknown }) => row.reviewImageDetail === undefined))
})

test('missing managed blocks, return anchors, required endpoint or reviewer contracts do not partially migrate', () => {
  const mutations: Array<[string, (node: Fixture['nodes'][number]) => void]> = [
    ['sanguo-media-request', node => { node.code = node.code.replace('// media-sampling-plan-v2', '// user-owned-sampling') }],
    ['sanguo-media-request', node => { node.code = node.code.replace(requestReturn, 'return { userOwned:samplingPlan.sampleTimes,') }],
    ['sanguo-media-metrics', node => { node.code = node.code.replace('// media-requirement-review-input-v1', '// user-owned-input') }],
    ['sanguo-media-metrics', node => { node.code = node.code.replace(metricsReturn, 'return { customOnly:true,') }],
    ['sanguo-media-accept', node => { node.code = node.code.replace('// independent-media-review-view-v1', '// user-owned-view') }],
    ['sanguo-media-accept', node => { node.code = node.code.replace('// media-uncertainty-diagnostic-v2', '// user-owned-guard') }],
    ['sanguo-media-accept', node => { node.code = node.code.replace(oldObservationGuard, 'userObservationGuard(observations);') }],
    ['sanguo-requirement-review', node => { node.prompt = '用户独立审核契约' }],
    ['sanguo-media-review', node => { node.prompt = '用户综合审核契约' }],
    ['sanguo-video-evidence', node => { if ('request' in node) node.request.url = '/api/custom-evidence' }],
  ]
  for (const [id, mutate] of mutations) {
    const source = fixture();mutate(get(source, id));const before = structuredClone(source)
    assert.equal(upgradeNativeSequenceMediaEvidence(source), source, id)
    assert.deepEqual(source, before)
  }
  const other = { ...fixture(), id: 'custom-workflow' };assert.equal(upgradeNativeSequenceMediaEvidence(other), other)
})

test('duplicate managed code blocks, reviewer contracts and return anchors are ambiguous and must not migrate', () => {
  const duplicates: Array<[string, string, 'code' | 'prompt']> = [
    ['sanguo-media-request', ADAPTIVE_MEDIA_SAMPLING_REQUEST_CODE, 'code'],
    ['sanguo-media-metrics', REQUIREMENT_REVIEW_METRICS_CODE, 'code'],
    ['sanguo-media-accept', INDEPENDENT_MEDIA_REVIEW_VIEW_CODE, 'code'],
    ['sanguo-media-accept', ADAPTIVE_MEDIA_REVIEW_GUARD_CODE, 'code'],
    ['sanguo-media-accept', oldObservationGuard, 'code'],
    ['sanguo-requirement-review', REQUIREMENT_MEDIA_REVIEW_PROMPT, 'prompt'],
    ['sanguo-media-review', CANONICAL_MEDIA_REVIEW_PROMPT, 'prompt'],
    ['sanguo-media-request', requestReturn, 'code'],
    ['sanguo-media-metrics', metricsReturn, 'code'],
  ]
  for (const [id, duplicate, field] of duplicates) {
    const source = fixture();get(source, id)[field] += '\n' + duplicate
    const before = structuredClone(source)
    assert.equal(upgradeNativeSequenceMediaEvidence(source), source, 'ambiguous ' + id + ' ' + field)
    assert.deepEqual(source, before)
  }
})

test('migrated observation guard accepts exactly five sparse observations over eighty authoritative native frames', () => {
  const next = upgradeNativeSequenceMediaEvidence(fixture()), code = get(next, 'sanguo-media-accept').code
  assert.ok(code.includes(NATIVE_MEDIA_OBSERVATION_GUARD_CODE))
  assert.ok(!code.includes(oldObservationGuard))
  const frames = Array.from({ length: 80 }, (_, i) => '/generated/native-' + i + '.jpg'), indices = [0, 20, 40, 60, 79]
  const frameTimes = frames.map((_, i) => i / 24)
  const native = { frames, frameTimes,
    frameReferences: frames.map((url, i) => ({ evidenceIndex: i, nativeFrameIndex: i, pts: i * 512, timeBase: '1/12288', second: frameTimes[i], url, sourceSha256: 'a'.repeat(64) })),
    nativeSequence: { preservedSamples: indices.map(i => ({ evidenceIndex: i, nativeFrameIndex: i })) } }
  const observation = (index: number) => ({ index, second: frameTimes[index], setting: '人物所在庭院', people: [] })
  const observations = { frames: indices.map(observation), tailObservation: '末尾人物位于庭院。' }
  const context = { evidence: native, observations }, before = structuredClone(context)
  const guard = 'const e=context.evidence,observations=context.observations;const invalid=message=>{throw Error(message)};\n'
    + NATIVE_MEDIA_OBSERVATION_GUARD_CODE + '\nreturn true;'
  assert.equal(execute(guard, context), true)
  assert.deepEqual(context, before)
  for (const draft of [
    { ...observations, frames: observations.frames.slice(1) },
    { ...observations, frames: observations.frames.map((row, i) => i === 1 ? { ...row, second: row.second + .1 } : row) },
    { ...observations, frames: observations.frames.map((row, i) => i === 1 ? { ...row, index: 21 } : row) },
    { ...observations, frames: frames.map((_, i) => observation(i)) },
  ]) assert.throws(() => execute(guard, { evidence: native, observations: draft }), /草稿须覆盖其明确采样范围/)
})

test('shipped presence, continuity and performance checks may cite real native frames outside the observer sample', () => {
  const ids = ['sanguo-scene-outline', 'sanguo-shot-script', 'sanguo-character-image', 'sanguo-video', 'sanguo-last-frame', 'loop']
  const base = { id: 'wf-sanguo-history-drama', schemaVersion: 59,
    nodes: ids.map(id => ({ ...node(id, id === 'sanguo-video' ? 'video' : id === 'sanguo-shot-script' ? 'text' : 'code'),
      ...(id === 'loop' ? { childIds: ids.slice(1, -1) } : { parentId: 'loop' }) })),
    edges: [{ id: 'video-tail', from: 'sanguo-video', to: 'sanguo-last-frame' }] }
  const latest = upgradeQualityWorkflow(base)
  assert.equal(latest.schemaVersion, 113)
  const code = latest.nodes.find(node => node.id === 'sanguo-media-accept')!.code
  const evidence = { frames: Array.from({ length: 80 }, (_, i) => '/generated/' + i + '.jpg') }
  const observations = { frames: [0, 20, 40, 60, 79].map(index => ({ index })) }
  for (const diagnostic of ['真实离场不能用画外或单帧证明', '同场切镜未引用实际首帧', '表演留白不能由单一静帧或计划意图证明']) {
    const line = code.split('\n').find(line => line.includes(diagnostic))!
    const predicate = line.match(/frameIndices\.some\((index=>.*?)\)\)/)?.[1]
    assert.ok(predicate, diagnostic)
    const check = new Function('e', 'observations', 'return (' + predicate + ');')(evidence, observations)
    for (const index of [0, 1, 21, 78, 79]) assert.equal(check(index), false, diagnostic + ' valid source ' + index)
    for (const index of [-1, 80, .5, '21', NaN]) assert.equal(check(index), true, diagnostic + ' invalid source ' + index)
  }
})
