import test from 'node:test'
import assert from 'node:assert/strict'
import { validateDramaturgyReview, DRAMATURGY_ACCEPT_CODE, refreshEmbeddedDramaturgyReviewCode } from '../src/drama-quality-presets.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { upgradeDurationQuality, upgradeQualityWorkflow } from '../src/quality-node-presets.ts'
import { migrateBranchWorkflow } from '../src/branch-migration.ts'
import { partitionDramaBeat, validateDramaStoryboard, validateDramaStoryboardAllocation } from '../src/history-drama.ts'

// Relevant authored/report excerpts from the real run-3 reviewer. The separate
// walk and chant remain a substantive refusal; path repair cannot accept them.
const candidate = { id: 'scene-01', contentContractVersion: 'cinematic-v1',
  requiredBeats: [{ id: 'beat-01', mustShow: ['乡人边走边哼唱'] }],
  beatDramaturgy: [{ beatId: 'beat-01', visual: ['乡人行走'], audio: ['天下规矩房伯武，因师获印周仲进'] }],
  pacing: { version: 'duration-v2', scheduleHash: 'existing-compiled-hash', beats: [{ id: 'beat-01-walk', sourceBeatId: 'beat-01', kind: 'action',
    textOrVocalization: '从街巷左侧沿土路向画面中央偏左位置走来', performanceInstruction: '乡人行走',
    completion: { finalState: '乡人已走至画面中央偏左位置', evidenceAnchor: '乡人行走' }, durationEstimate: { source: '乡人行走' }, dependsOn: [] }] },
  videoPrompt: '0-5秒：乡人行走。5-10.5秒：乡人哼唱歌谣。',
  audioText: '传唱歌谣的乡人：天下规矩房伯武，因师获印周仲进' }
const check = { status: 'passed', reason: '候选声画正文已定位。', evidenceRefs: [0] }
const report = () => ({ version: 'dramaturgy-v1', passed: false, orientation: check, dramaticProgression: check, characterDistinction: check,
  payoff: { status: 'not_applicable', reason: '本场为首场，后续回应尚未到本镜。' },
  evidence: [{ itemId: 'scene-01', path: 'pacing.beats', quote: '乡人行走', finding: '观众看到乡人行走入画。' }],
  issues: [{ code: 'lost_approved_beat', itemId: 'scene-01', beatId: 'beat-01', path: 'videoPrompt', quote: candidate.videoPrompt,
    problem: '原批准节拍要求边走边哼唱，候选先走后唱丢失同时性。', repair: '恢复原义务的行走与哼唱重叠。', scope: 'scene' }], warnings: [], repairScope: 'scene' })

test('real parent-array locator stays invalid while indexed v2 body leaves preserve the semantic refusal and originals', () => {
  assert.throws(() => validateDramaturgyReview(candidate, report()), /正文叶子/)
  const original = structuredClone(candidate)
  for (const field of ['textOrVocalization', 'performanceInstruction'] as const) {
    const review = report()
    Object.assign(review.evidence[0], { path: 'pacing.beats.0.' + field, quote: candidate.pacing.beats[0][field], beatId: 'beat-01' })
    const before = structuredClone(review), result = validateDramaturgyReview(candidate, review)
    assert.equal(result.passed, false)
    assert.deepEqual(result.issues, review.issues)
    assert.deepEqual(result.evidence, review.evidence)
    assert.deepEqual(review, before)
  }
  assert.deepEqual(candidate, original, 'citation validation never rewrites a schedule or its hash')
})

test('v2 citations cannot cite metadata, invented leaves, different text, legacy pacing or unrelated source beats', () => {
  const attempt = (path: string, quote = '乡人行走', input: Record<string, unknown> = candidate, beatId?: string) => {
    const review = report(); Object.assign(review.evidence[0], { path, quote, ...(beatId ? { beatId } : {}) })
    return () => validateDramaturgyReview(input, review)
  }
  for (const path of ['pacing.beats.0', 'pacing.beats.99.performanceInstruction', 'pacing.beats.0.inventedBody',
    'pacing.beats.0.completion.finalState', 'pacing.beats.0.completion.evidenceAnchor', 'pacing.beats.0.durationEstimate.source', 'pacing.beats.0.dependsOn']) {
    assert.throws(attempt(path), /正文叶子/)
  }
  assert.throws(attempt('pacing.beats.0.performanceInstruction', '乡人挥手跳跃'), /引文不在候选声画原文中/)
  assert.throws(attempt('pacing.beats.0.performanceInstruction', '乡人行走', candidate, 'beat-01-walk'), /原sourceBeatId/)
  assert.throws(attempt('pacing.beats.0.performanceInstruction', '乡人行走', { ...candidate, pacing: { ...candidate.pacing, version: 'dynamic-v1' } }), /正文叶子/)
  const unrelated = structuredClone(candidate); unrelated.pacing.beats[0].sourceBeatId = 'other-scene-beat'
  assert.throws(attempt('pacing.beats.0.performanceInstruction', '乡人行走', unrelated), /正文叶子/)
})

test('shot beatDramaturgy keeps its original beat binding when requiredBeats belongs to the approved source scene', () => {
  const shot = { ...candidate, requiredBeats: undefined }
  const review = report(); Object.assign(review.evidence[0], { path: 'pacing.beats.0.performanceInstruction', beatId: 'beat-01' })
  assert.equal(validateDramaturgyReview(shot, review).passed, false)
  const orphan = { ...shot, beatDramaturgy: undefined }
  assert.throws(() => validateDramaturgyReview(orphan, review), /正文叶子/)
})

test('refreshed isolated dramaturgy gate uses v2 body grounding and keeps the factual and narrative outcomes separate', async () => {
  const review = report(); Object.assign(review.evidence[0], { path: 'pacing.beats.0.performanceInstruction', beatId: 'beat-01' })
  const code = 'const candidate=params.candidate,review=params.review,combinedIssues=[],accepted=true;' + DRAMATURGY_ACCEPT_CODE
  // Exercise the same surgical refresh used for persisted workflow gate code.
  const stale = code.replace(/\(function validateDramaturgyReview[\s\S]*?\)\(candidate, review\.dramaturgyReview\)/,
    '(function validateDramaturgyReview(){throw Error("stale validator")})(candidate, review.dramaturgyReview)')
  assert.notEqual(stale, code)
  const refreshed = refreshEmbeddedDramaturgyReviewCode(stale)
  const result = await executeCodeNode({ code: refreshed, params: { candidate, review: { passed: true, issues: [], dramaturgyReview: review } } })
  assert.equal(result.passed, false)
  assert.equal(result.factualReview.passed, true)
  assert.equal(result.dramaturgyReview.passed, false)
  assert.equal(result.dramaturgyReview.issues[0].code, 'lost_approved_beat')
  assert.equal(result.pacing.scheduleHash, candidate.pacing.scheduleHash)
})

test('113 migration and 115 managed refresh replace only the embedded validator even when its saved function name was minified', async () => {
  const base = { id: 'wf-sanguo-history-drama', schemaVersion: 59,
    nodes: ['sanguo-scene-outline', 'sanguo-shot-script', 'sanguo-character-image', 'sanguo-video', 'sanguo-last-frame', 'loop'].map(id => ({
      id, title: id, kind: id === 'sanguo-video' ? 'video' : id === 'sanguo-shot-script' ? 'text' : 'code', modelId: 'configured-model', resultVar: id,
      prompt: 'test', params: [], uploads: [], loop: { enabled: false, sourcePath: '', fallbackCount: 1, itemVar: 'item' },
      position: { x: 0, y: 0 }, parentId: 'loop', ...(id === 'loop' ? { childIds: ['sanguo-shot-script', 'sanguo-character-image', 'sanguo-video', 'sanguo-last-frame'] } : {}) })),
    edges: [{ id: 'v-tail', from: 'sanguo-video', to: 'sanguo-last-frame' }] }
  const previous = migrateBranchWorkflow(upgradeQualityWorkflow(base))
  const prefix = 'const candidate=params.candidate,review=params.review,combinedIssues=[],accepted=true;\n// saved custom gate prelude\n'
  const currentCode = prefix + DRAMATURGY_ACCEPT_CODE
  const oldCode = currentCode.replace(/\(function validateDramaturgyReview[\s\S]*?\)\(candidate, review\.dramaturgyReview\)/,
    '(function oldMinifiedName(){throw Error("old validator rejects v2 body")})(candidate, review.dramaturgyReview)')
  const stale = { ...previous, nodes: previous.nodes.map(node => node.id === 'sanguo-shot-script-accept' ? { ...node, code: oldCode } : node) }
  const before = structuredClone(stale), migrated = upgradeDurationQuality(stale)
  assert.deepEqual(stale, before)
  assert.equal(migrated.schemaVersion, 115)
  const review = report(); Object.assign(review.evidence[0], { path: 'pacing.beats.0.performanceInstruction', beatId: 'beat-01' })
  const params = { candidate, review: { passed: true, issues: [], dramaturgyReview: review } }
  await assert.rejects(() => executeCodeNode({ code: oldCode, params }), /old validator rejects/)
  for (const workflow of [migrated, upgradeDurationQuality({ ...migrated, schemaVersion: 114,
    nodes: migrated.nodes.map(node => node.id === 'sanguo-shot-script-accept' ? { ...node, code: oldCode } : node) })]) {
    const code = workflow.nodes.find(node => node.id === 'sanguo-shot-script-accept')!.code!
    assert.equal(code, currentCode, 'managed refresh preserves all surrounding editable code')
    const result = await executeCodeNode({ code, params })
    assert.equal(result.passed, false)
    assert.equal(result.dramaturgyReview.issues[0].code, 'lost_approved_beat')
    assert.equal(result.pacing.scheduleHash, candidate.pacing.scheduleHash)
    assert.match(workflow.nodes.find(node => node.id === 'sanguo-shot-script-review')!.prompt, /pacing\.beats\.0\.textOrVocalization/)
  }
})

// Exact voice-bearing excerpts from record-kfldy2's approved scene-01. Its
// audio anchors omit the delivery type, which lives in description instead.
const productionVoiceBeats = [
  { id: 'beat-01', description: "甘陵街市,乡人行走其间,画外旁白:'桓帝初为蠡吾侯时,曾受学于甘陵周福。延熹九年,桓帝即位,擢周福为尚书。'",
    function: '建立桓帝与周福师生关系及周福得官的史实背景', stateChange: '从无背景信息到观众知晓周福因师生关系得官',
    observable: { visual: ['乡人行走', '街市景象'], audio: ['桓帝初为蠡吾侯时,曾受学于甘陵周福。延熹九年,桓帝即位,擢周福为尚书'] } },
  { id: 'beat-03', description: "乡人驻足,开始传唱:'天下规矩房伯武,因师获印周仲进。'",
    function: '呈现歌谣原文,对比二人', stateChange: '从背景介绍到歌谣传播开始',
    observable: { visual: ['乡人驻足'], audio: ['天下规矩房伯武,因师获印周仲进'] } },
]
function voiceFixture(index: number) {
  const beat = structuredClone(productionVoiceBeats[index])
  const scene = { contentContractVersion: 'cinematic-v1', dramaticSceneId: 'drama-01', cast: ['传谣乡人'], requiredBeats: [beat] }
  const shot = { contentContractVersion: 'cinematic-v1', dramaticSceneId: 'drama-01',
    presentCharacters: ['传谣乡人'], shotIntent: { viewpointCharacter: '传谣乡人', purpose: beat.function, cameraReason: '保留原动作' },
    beatDramaturgy: [{ beatId: beat.id, function: beat.function, stateChange: beat.stateChange,
      visual: beat.observable.visual, audio: beat.observable.audio }],
    visualPrompt: beat.observable.visual.join('。'), videoPrompt: beat.observable.visual.join('。'), audioText: beat.observable.audio.join('\n'),
    pacing: { version: 'duration-v2', actorGroups: [] as { id: string; label: string; memberDescription: string }[],
      beats: [{ id: beat.id + '-voice', sourceBeatId: beat.id, kind: 'speech', deliveryStyle: index ? 'chant' : 'narration',
        actorIds: [index ? '传谣乡人' : '旁白'], textOrVocalization: beat.observable.audio[0] }] } }
  return { scene, shot }
}

test('real approved narration and singing cannot change channel or performer while retaining the same words', () => {
  for (const index of [0, 1]) {
    const { scene, shot } = voiceFixture(index)
    const before = structuredClone({ scene, shot })
    assert.equal(validateDramaStoryboard(shot, scene), shot)
    assert.deepEqual({ scene, shot }, before)
    for (const deliveryStyle of index ? ['narration', 'dialogue'] : ['chant', 'singing', 'dialogue']) {
      const wrong = structuredClone(shot)
      wrong.pacing.beats[0].deliveryStyle = deliveryStyle
      wrong.pacing.beats[0].actorIds = [deliveryStyle === 'narration' ? '旁白' : '传谣乡人']
      assert.throws(() => validateDramaStoryboard(wrong, scene), /原声部.*继承 description 明示/)
    }
    const otherActor = structuredClone(shot)
    otherActor.pacing.beats[0].actorIds = ['旁听乡人']
    assert.throws(() => validateDramaStoryboard(otherActor, scene), /原发声主体/)
  }
  const { scene, shot } = voiceFixture(1)
  shot.pacing.beats[0].deliveryStyle = 'singing'
  assert.equal(validateDramaStoryboard(shot, scene), shot, 'source transmission does not invent a narrower musical style')
})

test('an explicitly named singer remains bound among several cast members', () => {
  const { scene, shot } = voiceFixture(1)
  scene.cast.push('旁听乡人')
  scene.requiredBeats[0].description = scene.requiredBeats[0].description.replace('乡人驻足', '传谣乡人驻足')
  shot.pacing.beats[0].actorIds = ['旁听乡人']
  assert.throws(() => validateDramaStoryboard(shot, scene), /原发声主体 传谣乡人/)
})

test('partitioned quoted audio retains its original voice without requiring the unallocated remainder', () => {
  const { scene, shot } = voiceFixture(1)
  const pieces = ['天下规矩房伯武', '因师获印周仲进']
  const parts = pieces.map((piece, index) => {
    const part = structuredClone(shot)
    part.beatDramaturgy[0].audio = [piece]
    part.beatDramaturgy[0].visual = index ? [] : shot.beatDramaturgy[0].visual
    part.audioText = piece
    part.pacing.beats[0].textOrVocalization = piece
    return part
  })
  validateDramaStoryboardAllocation(parts, scene)
  for (const part of parts) {
    const scoped = { ...scene, requiredBeats: [partitionDramaBeat(scene.requiredBeats[0], part)] }
    assert.equal(validateDramaStoryboard(part, scoped), part)
    part.pacing.beats[0].deliveryStyle = 'narration'
    part.pacing.beats[0].actorIds = ['旁白']
    assert.throws(() => validateDramaStoryboard(part, scoped), /原声部.*传唱\/吟唱/)
  }
})

test('song mentions, reported singing and unbound prose do not invent source voice restrictions', () => {
  for (const description of [
    "乡人转述歌谣:'天下规矩房伯武,因师获印周仲进。'",
    "乡人提到曾经传唱:'天下规矩房伯武,因师获印周仲进。'",
    "乡人听见别人传唱:'天下规矩房伯武,因师获印周仲进。'",
    "乡人不再传唱:'天下规矩房伯武,因师获印周仲进。'",
    '乡人驻足，歌谣用于交代背景，发声方式由分镜决定。',
    "乡人传唱:'另一段歌。'随后转述:'天下规矩房伯武,因师获印周仲进。'",
  ]) {
    const { scene, shot } = voiceFixture(1)
    scene.requiredBeats[0].description = description
    shot.pacing.beats[0].deliveryStyle = 'narration'
    shot.pacing.beats[0].actorIds = ['旁白']
    assert.equal(validateDramaStoryboard(shot, scene), shot)
  }
})
