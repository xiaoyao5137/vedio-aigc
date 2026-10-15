import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pcmToWav } from '../server/bailian-tts.ts'
import { assessPictureVoiceIsolation, buildNarrationMixFilter, measureNarrationWindow, sourceAsr } from '../server/narration-transfer-evidence.ts'

const sampleRate = 16000

test('audio mixer explicitly fills the picture tail, and a no-line mix omits only that TTS input', () => {
  const tracks = [{ beatId: 'n', text: '旁白', start: .5, end: 2, url: '/generated/tts-aaa.wav', sha256: 'a'.repeat(64),
    sourceDuration: 1, duration: 1, tempo: 1, voiceId: 'narrator' }]
  const picture = { status: 'locally-muted', mutedWindows: [{ start: .8, end: 1.3 }] }
  const full = buildNarrationMixFilter(tracks, picture, 3)
  const absent = buildNarrationMixFilter(tracks, picture, 3, 0)
  assert.match(full, /apad,atrim=duration=3\[a\]/)
  assert.match(full, /\[ambient\]\[n0\]amix=inputs=2:duration=longest/)
  assert.match(buildNarrationMixFilter(tracks, picture, 3, -1, 5), /amix=inputs=2:duration=first/)
  assert.doesNotMatch(absent, /\[1:a\]atempo/)
  assert.match(absent, /\[ambient\]anull,alimiter/)
})

test('source speech isolation rejects empty preserved v5 audio and binds accepted mute evidence', () => {
  const sha = 'a'.repeat(64)
  const empty = { status: 'preserved', detector: 'whisper-small+silero-vad-v1', sourceSha256: sha,
    observations: [], mutedWindows: [], preservedOutsideWindows: true }
  assert.equal(assessPictureVoiceIsolation(empty, 10, sha, 5).status, 'unverified')
  const full = { ...empty, status: 'fully-muted-unverified', mutedWindows: [{ start: 0, end: 10 }], preservedOutsideWindows: false }
  assert.equal(assessPictureVoiceIsolation(full, 10, sha, 6).mode, 'full-source-mute')
  assert.equal(assessPictureVoiceIsolation(full, 10, sha, 5).status, 'confirmed',
    'an old receipt with a bound full source mute is still safe to audit')
  assert.equal(assessPictureVoiceIsolation(full, 10, 'b'.repeat(64), 6).status, 'unverified')
  const observed = { ...empty, status: 'locally-muted', observations: [{ source: 'vad', start: 1, end: 2 }],
    mutedWindows: [{ start: .65, end: 2.35 }] }
  assert.equal(assessPictureVoiceIsolation(observed, 10, sha, 5).status, 'unverified',
    'covering every detector observation does not exclude a missed speaker elsewhere')
  assert.equal(assessPictureVoiceIsolation({ ...observed, mutedWindows: [{ start: 1.2, end: 2.35 }] }, 10, sha, 5).status, 'unverified')
  assert.equal(assessPictureVoiceIsolation({ ...observed, detector: 'unavailable' }, 10, sha, 5).status, 'unverified')
})

test('decoded sample test rejects a wrong soundtrack, a missing track, and a missing final word', () => {
  const length = 3 * sampleRate
  const expected = new Float32Array(length), actual = new Float32Array(length), withoutLine = new Float32Array(length)
  const wrongSoundtrack = new Float32Array(length), missingTail = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate
    const ambience = .015 * Math.sin(2 * Math.PI * 240 * t)
    const voice = t >= .5 && t < 2.1 ? .11 * Math.sin(2 * Math.PI * 440 * t) : 0
    withoutLine[i] = ambience
    expected[i] = ambience + voice
    actual[i] = expected[i] + .0007 * Math.sin(2 * Math.PI * 1710 * t)
    wrongSoundtrack[i] = ambience + (t >= .5 && t < 2.1 ? .11 * Math.sin(2 * Math.PI * 660 * t) : 0)
    missingTail[i] = ambience + (t < 1.75 ? voice : 0)
  }
  assert.equal(measureNarrationWindow(expected, actual, withoutLine, .5, 2.1).passed, true)
  assert.equal(measureNarrationWindow(expected, actual, withoutLine, 1.75, 2.1).passed, true)
  assert.equal(measureNarrationWindow(expected, wrongSoundtrack, withoutLine, .5, 2.1).passed, false)
  assert.equal(measureNarrationWindow(expected, withoutLine, withoutLine, .5, 2.1).passed, false)
  assert.equal(measureNarrationWindow(expected, missingTail, withoutLine, 1.75, 2.1).passed, false)
  assert.equal(measureNarrationWindow(expected, actual.subarray(0, Math.floor(1.8 * sampleRate)), withoutLine, 1.75, 2.1).passed, false)
})

test('isolated medium fallback preserves small evidence and binds model, WAV, text and window in an immutable receipt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'narration-source-asr-'))
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const wav = pcmToWav(Buffer.alloc(3 * 24000 * 2), 24000)
  const track = { beatId: 'speech-identity', text: '部将张飞在江州生擒了刘璋的巴郡太守严颜。', start: 1.9, end: 6,
    url: '/generated/tts-aaaaaaaa.wav', sha256: sha(wav), sourceDuration: 3, duration: 3, tempo: 1, voiceId: 'narrator' }
  const alignment = (model: 'small' | 'medium') => ({ boundaryStatus: model === 'small' ? 'uncertain' : 'reliable', boundaryEvidenceVersion: 2,
    alignmentCoverage: model === 'small' ? .89 : 1, firstTokenMatched: true, lastTokenMatched: true,
    boundaryUncertaintyReasons: model === 'small' ? ['partial-phonetic-alignment'] : [],
    startBoundaryRange: { lower: .05, upper: .05 }, endBoundaryRange: { lower: 2.77, upper: 2.77 },
    rawUtteranceCandidate: { text: model === 'small' ? '不将张飞在江州申请了刘璋的八郡太守言言' : '不讲张飞在江州生擒了刘璋的八郡太守严严' } })
  const result = (model: 'small' | 'medium') => Buffer.from(JSON.stringify({ speechValidation: {
    method: `local-whisper-${model}-phonetic-alignment`, passed: model === 'medium', alignment: [alignment(model)],
    issues: model === 'small' ? ['partial-phonetic-alignment'] : [] } }))
  const calls: Array<{ model: string; text: string; duration: number }> = []
  const dependencies = { resolveMediumModel: async () => '/pinned/medium',
    transcribe: async (model: 'small' | 'medium', _modelPath: string, _wav: string, text: string, _windows: unknown, duration: number) => {
      calls.push({ model, text, duration }); return result(model)
    } }
  try {
    await mkdir(path.join(root, 'public/generated'), { recursive: true })
    await mkdir(path.join(root, 'scripts'), { recursive: true })
    await writeFile(path.join(root, 'public', track.url), wav)
    for (const name of ['transcribe-quality.py', 'speech_boundaries.py', 'speech_pronunciation.py']) await writeFile(path.join(root, 'scripts', name), name)
    const proof = await sourceAsr(track, root, dependencies)
    assert.equal(proof.method, 'isolated-source-asr-v3')
    assert.equal(proof.reliable, true)
    assert.equal(proof.boundaryStatus, 'reliable')
    assert.equal(proof.primaryAsr?.reliable, false)
    assert.equal(proof.primaryAsr?.recognizedText, '不将张飞在江州申请了刘璋的八郡太守言言')
    assert.deepEqual(calls.map(call => call.model), ['small', 'medium'])
    const receiptPath = path.join(root, '.runtime/narration-source-asr-medium', proof.receiptKey + '.json')
    const receiptBytes = await readFile(receiptPath), receipt = JSON.parse(receiptBytes.toString())
    assert.equal(sha(receiptBytes), proof.receiptSha256)
    assert.equal(receipt.identity.modelVersion, proof.modelVersion)
    assert.equal(receipt.identity.fittedWavSha256, track.sha256)
    assert.equal(receipt.identity.expectedText, track.text)
    assert.deepEqual(receipt.identity.windows, [{ beatId: track.beatId, text: track.text, start: 0, end: 3, actorIds: ['旁白'] }])
    assert.deepEqual(await sourceAsr(track, root, dependencies), proof)
    assert.equal(calls.length, 2, 'rechecking identical paid audio reads both saved ASR receipts')
    const shifted = await sourceAsr({ ...track, sourceDuration: 3.2 }, root, dependencies)
    assert.notEqual(shifted.receiptKey, proof.receiptKey)
    assert.equal(calls.length, 4, 'a changed expected window gets a new primary and medium receipt')
    const revisedText = await sourceAsr({ ...track, text: '部将赵云在江州生擒了刘璋的巴郡太守严颜。' }, root, dependencies)
    assert.notEqual(revisedText.receiptKey, proof.receiptKey)
    assert.equal(calls.length, 6, 'a changed expected text cannot borrow the prior receipt')
    assert.equal((await readdir(path.join(root, '.runtime/narration-source-asr-medium'))).length, 3)
    await writeFile(path.join(root, 'public', track.url), Buffer.concat([wav, Buffer.from([1, 2])]))
    await assert.rejects(sourceAsr(track, root, dependencies), /TTS_TRACK_CHANGED/)
    await writeFile(path.join(root, 'public', track.url), wav)
    receipt.identity.expectedText = '篡改台词'
    await writeFile(receiptPath, JSON.stringify(receipt))
    await assert.rejects(sourceAsr(track, root, dependencies), /NARRATION_ASR_RECEIPT_MISMATCH/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('missing medium model or already reliable small ASR never manufactures fallback certainty', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'narration-source-asr-unavailable-'))
  const wav = pcmToWav(Buffer.alloc(24000 * 2), 24000)
  const track = { beatId: 'line', text: '他会低头吗？', start: 0, end: 2, url: '/generated/tts-aaaaaaaa.wav',
    sha256: createHash('sha256').update(wav).digest('hex'), sourceDuration: 1, duration: 1, tempo: 1, voiceId: 'narrator' }
  try {
    await mkdir(path.join(root, 'public/generated'), { recursive: true })
    await mkdir(path.join(root, 'scripts'), { recursive: true })
    await writeFile(path.join(root, 'public', track.url), wav)
    for (const name of ['transcribe-quality.py', 'speech_boundaries.py', 'speech_pronunciation.py']) await writeFile(path.join(root, 'scripts', name), name)
    let mediumCalls = 0
    const uncertain = await sourceAsr(track, root, { resolveMediumModel: async () => undefined,
      transcribe: async model => {
        if (model === 'medium') mediumCalls++
        return Buffer.from(JSON.stringify({ speechValidation: { method: 'local-whisper-small-phonetic-alignment', passed: false,
          alignment: [{ boundaryStatus: 'uncertain', rawUtteranceCandidate: { text: '他会低头吗' } }], issues: ['uncertain'] } }))
      } })
    assert.equal(uncertain.method, 'isolated-source-asr-v2')
    assert.equal(uncertain.reliable, false)
    assert.equal(mediumCalls, 0)
    const reliable = await sourceAsr({ ...track, beatId: 'different-line' }, root, {
      resolveMediumModel: async () => { mediumCalls++; return '/pinned/medium' },
      transcribe: async () => Buffer.from(JSON.stringify({ speechValidation: { method: 'local-whisper-small-phonetic-alignment', passed: true,
        alignment: [{ boundaryStatus: 'reliable', boundaryEvidenceVersion: 2, alignmentCoverage: 1,
          firstTokenMatched: true, lastTokenMatched: true, boundaryUncertaintyReasons: [],
          startBoundaryRange: { lower: .05, upper: .05 }, endBoundaryRange: { lower: .8, upper: .8 },
          rawUtteranceCandidate: { text: '他会低头吗' } }], issues: [] } })) })
    assert.equal(reliable.method, 'isolated-source-asr-v2')
    assert.equal(reliable.reliable, true)
    assert.equal(mediumCalls, 0, 'a reliable small boundary must not trigger medium')
  } finally { await rm(root, { recursive: true, force: true }) }
})
