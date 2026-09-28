import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildBailianTtsParameters, pcmToWav } from '../server/bailian-tts.ts'
import { originalVoiceScope } from '../server/bailian-voice-design.ts'
import { composeNarration, NARRATION_SYNTHESIS_RECEIPT_DIRECTORY, narrationSynthesisReceiptIdentity, rawReceiptKey, synthesizeNarrationTrack } from '../server/independent-narration.ts'
import type { callBailianTts } from '../server/bailian-tts.ts'
import type { ExternalModelConfig } from '../server/model-adapters.ts'

const model: ExternalModelConfig = { id: 'tts', provider: 'Bailian', capability: 'audio', settings: { model: 'qwen-audio-3.0-tts-plus', apiKey: 'fixture-only', endpoint: 'https://dashscope.aliyuncs.com' } }
const voice = { voiceId: 'original-voice', accountScope: originalVoiceScope(model), targetModel: model.settings.model, modelId: model.id, characterId: 'actor-narrator', synthesisSeed: 28241, characterName: '旁白' }
const segment = { beatId: 'narration-context', text: '汉末，当阳长坂。曹军追上南逃的刘备，', start: 0, end: 3.528, ttsRate: 5.8 / 4.5, maximumRate: 6.5 }
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function wave(seconds: number, head = 0, tail = 0, internalPause = false) {
  const count = Math.round(seconds * 24000), pcm = Buffer.alloc(count * 2)
  for (let sample = Math.round(head * 24000); sample < count - Math.round(tail * 24000); sample++) {
    if (internalPause && sample >= 48000 && sample < 55200) continue
    pcm.writeInt16LE(Math.round(6000 * Math.sin(sample * 2 * Math.PI * 440 / 24000)), sample * 2)
  }
  return pcmToWav(pcm, 24000)
}

async function fixture(bytes: Buffer) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'narration-synthesis-'))
  await mkdir(path.join(root, 'public/generated'), { recursive: true })
  let calls = 0
  const synthesize: typeof callBailianTts = async (configured, text, params = {}) => {
    calls++
    const settings = buildBailianTtsParameters(configured.settings, params), url = '/generated/tts-aaaaaaaa.wav'
    await writeFile(path.join(root, 'public', url), bytes)
    return { status: 200, body: { status: 'succeeded', taskId: 'aaaaaaaa', url, duration: (bytes.length - 44) / 48000,
      durationSource: 'pcm-samples', sampleRate: 24000, channels: 1, format: 'wav', bytes: bytes.length, sha256: sha(bytes),
      model: configured.settings.model, voice: settings.voice, rate: settings.rate, seed: settings.seed, instruction: settings.instruction ?? '',
      transcript: text, transcriptSource: 'input-text', characterName: String(params.characterName ?? ''), synthesisMs: 0, providerEvents: [] } }
  }
  return { root, synthesize, calls: () => calls, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('raw synthesis identity is canonical and excludes scheduling while preserving every actual audio parameter', () => {
  const key = rawReceiptKey(model, voice, segment)
  assert.equal(rawReceiptKey(model, voice, { ...segment, beatId: 'later', start: 2, end: 9, maximumRate: 5 }), key)
  const reordered = Object.fromEntries(Object.entries(voice).reverse()) as typeof voice
  assert.equal(rawReceiptKey(model, reordered, segment), key, 'PostgreSQL key reordering must not buy another synthesis')
  assert.notEqual(rawReceiptKey(model, { ...voice, synthesisSeed: 42 }, segment), key)
  assert.notEqual(rawReceiptKey(model, voice, { ...segment, text: '另一句旁白。' }), key)
  assert.notEqual(rawReceiptKey({ ...model, settings: { ...model.settings, pitch: '1.1' } }, voice, segment), key)
  assert.notEqual(rawReceiptKey({ ...model, settings: { ...model.settings, instruction: '清楚朗读' } }, voice, segment), key)
  const guided = { ...segment, pronunciationHints: [{ term: '长坂', pinyin: ['chang2', 'ban3'], meaning: '地名', source: '已核对字典' }] }
  assert.notEqual(rawReceiptKey(model, voice, guided), key)
  assert.equal(JSON.stringify(narrationSynthesisReceiptIdentity(model, voice, segment)).includes('fixture-only'), false)
})

test('completed TTS is persisted before a hard fit failure and reused after rescheduling without another synthesis', async () => {
  const f = await fixture(wave(4.5))
  try {
    await assert.rejects(synthesizeNarrationTrack(model, voice, segment, f.root, { synthesize: f.synthesize }), /NARRATION_DURATION_CONFLICT/)
    assert.equal(f.calls(), 1)
    const saved = JSON.parse(await readFile(path.join(f.root, NARRATION_SYNTHESIS_RECEIPT_DIRECTORY, rawReceiptKey(model, voice, segment) + '.json'), 'utf8'))
    assert.equal(saved.result.sampleCount, 108000)
    assert.equal(saved.result.sha256, sha(wave(4.5)))
    await assert.rejects(synthesizeNarrationTrack(model, voice, segment, f.root, { synthesize: f.synthesize }), /NARRATION_DURATION_CONFLICT/)
    const revised = await synthesizeNarrationTrack(model, voice, { ...segment, start: 1, end: 6 }, f.root, { synthesize: f.synthesize })
    assert.equal(f.calls(), 1)
    assert.equal(revised.start, 1)
    assert.equal(revised.tempo, 1)
    assert.equal(revised.normalization, undefined)
  } finally { await f.cleanup() }
})

test('actual first-window fixture only trims quiet edges and keeps every internal PCM sample and pause', async () => {
  const original = wave(4.456875, .106375, .084125, true), f = await fixture(original)
  try {
    const track = await synthesizeNarrationTrack(model, voice, segment, f.root, { synthesize: f.synthesize })
    assert.ok(track.normalization)
    const evidence = track.normalization!
    assert.equal(evidence.sourceDuration, 4.456875)
    assert.equal(evidence.sourceSha256, sha(original))
    assert.equal(evidence.sourceSampleCount, 106965)
    assert.equal(evidence.paddingSeconds, .05)
    assert.ok(evidence.trimStartSamples <= 2400 && evidence.trimEndSamples <= 2400)
    assert.ok(track.tempo > 1.2 && track.tempo <= 1.25)
    const derived = await readFile(path.join(f.root, 'public', track.url))
    assert.deepEqual(derived.subarray(44), original.subarray(44 + evidence.trimStartSamples * 2, original.length - evidence.trimEndSamples * 2), 'lossless contiguous sample slice preserves internal silence and all speech')
    assert.equal(sha(derived), track.sha256)
    assert.deepEqual(await readFile(path.join(f.root, 'public', evidence.sourceUrl)), original, 'original paid WAV is untouched')
    const recalled = await synthesizeNarrationTrack(model, voice, segment, f.root, { synthesize: f.synthesize })
    assert.deepEqual(recalled, track)
    assert.equal(f.calls(), 1)
  } finally { await f.cleanup() }
})

test('edge trimming remains bounded and a still-overlong track fails without repurchasing or deleting internal pauses', async () => {
  const original = wave(6, .4, .4, true), f = await fixture(original)
  try {
    await assert.rejects(synthesizeNarrationTrack(model, voice, segment, f.root, { synthesize: f.synthesize }), /NARRATION_DURATION_CONFLICT/)
    await assert.rejects(synthesizeNarrationTrack(model, voice, segment, f.root, { synthesize: f.synthesize }), /NARRATION_DURATION_CONFLICT/)
    assert.equal(f.calls(), 1)
    const derivedName = (await readdir(path.join(f.root, 'public/generated'))).find(name => name.startsWith('tts-edge-'))!
    const derived = await readFile(path.join(f.root, 'public/generated', derivedName))
    assert.equal((original.length - derived.length) / 48000, .2, 'each edge removes at most 100ms, never the larger pauses')
    assert.deepEqual(derived.subarray(44), original.subarray(44 + 4800, original.length - 4800))
  } finally { await f.cleanup() }
})

test('accepted lossless edge derivative reaches the real video mixer without changing approved duration', async () => {
  const f = await fixture(wave(4.456875, .106375, .084125))
  try {
    const track = await synthesizeNarrationTrack(model, voice, segment, f.root, { synthesize: f.synthesize })
    const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string
    await promisify(execFile)(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=4', '-f', 'lavfi', '-i', 'sine=frequency=100:duration=4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(f.root, 'public/generated/picture.mp4')])
    const result = await composeNarration('/generated/picture.mp4', [track], 4, '16:9', f.root)
    assert.ok(Math.abs(result.metadata.duration - 4) < .1)
    assert.equal(result.tracks[0].normalization?.sourceUrl, '/generated/tts-aaaaaaaa.wav')
    assert.equal(result.metadata.hasAudio, true)
    assert.equal(f.calls(), 1)
  } finally { await f.cleanup() }
})

test('fitting raw tracks never run edge normalization and corrupted receipts never trigger a replacement purchase', async () => {
  const original = wave(3, .12, .12, true), f = await fixture(original)
  try {
    const fitted = await synthesizeNarrationTrack(model, voice, segment, f.root, { synthesize: f.synthesize })
    assert.equal(fitted.url, '/generated/tts-aaaaaaaa.wav')
    assert.equal(fitted.normalization, undefined)
    await writeFile(path.join(f.root, 'public', fitted.url), wave(2.9))
    await assert.rejects(synthesizeNarrationTrack(model, voice, { ...segment, end: 5 }, f.root, { synthesize: f.synthesize }), /NARRATION_RECEIPT_INVALID/)
    assert.equal(f.calls(), 1)
    await rm(path.join(f.root, 'public', fitted.url))
    await assert.rejects(synthesizeNarrationTrack(model, voice, { ...segment, end: 6 }, f.root, { synthesize: f.synthesize }), /ENOENT/)
    assert.equal(f.calls(), 1, 'a missing source behind an existing receipt is a recovery gap, never permission to buy again')
  } finally { await f.cleanup() }
})
