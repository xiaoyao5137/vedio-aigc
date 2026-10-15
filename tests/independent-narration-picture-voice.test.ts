import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { composeNarration, planPictureVoiceIsolation } from '../server/independent-narration.ts'
import { collectIndependentNarrationTransferEvidence, decodedAudioDuration } from '../server/narration-transfer-evidence.ts'

const exec = promisify(execFile)
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string
const sha256 = 'a'.repeat(64)

test('ASR and VAD remain diagnostics while the independent speech route mutes all supplier audio', () => {
  const result = planPictureVoiceIsolation({ detector: 'fixture', observations: [
    { source: 'asr', start: .88, end: 1.52, text: '张飞' },
    { source: 'vad', start: 1.28, end: 1.664 },
  ] }, 3, sha256)
  assert.equal(result.version, 'picture-voice-isolation-v2')
  assert.equal(result.status, 'fully-muted-unverified')
  assert.deepEqual(result.mutedWindows.map(({ start, end }) => ({ start, end })), [{ start: 0, end: 3 }])
  assert.equal(result.mutedWindows[0].observations.length, 2)
  assert.equal(result.preservedOutsideWindows, false)
  const empty = planPictureVoiceIsolation({ detector: 'fixture', observations: [] }, 3, sha256)
  assert.equal(empty.status, 'fully-muted-unverified')
  assert.deepEqual(empty.mutedWindows.map(({ start, end }) => ({ start, end })), [{ start: 0, end: 3 }])
  assert.equal(empty.fallbackReason, 'picture-voice-absence-unverified')
  assert.equal(empty.preservedOutsideWindows, false)
  assert.throws(() => planPictureVoiceIsolation({ detector: 'fixture', observations: [
    { source: 'asr', start: .5, end: 1.2, text: '' },
  ] }, 3, sha256), /PICTURE_VOICE_EVIDENCE_INVALID/)
})

async function toneAmplitude(filename: string, second: number, frequency: number) {
  const { stdout } = await exec(ffmpeg, ['-v', 'error', '-ss', String(second), '-i', filename, '-t', '0.2', '-vn',
    '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 })
  const bytes = stdout as Buffer
  const samples = bytes.length / 2
  let real = 0, imaginary = 0
  for (let i = 0; i < samples; i++) {
    const sample = bytes.readInt16LE(i * 2) / 32768
    const phase = 2 * Math.PI * frequency * i / 8000
    real += sample * Math.cos(phase)
    imaginary += sample * Math.sin(phase)
  }
  return Math.hypot(real, imaginary) * 2 / samples
}

test('real mixer removes all supplier audio, including speech outside detected windows, and retains TTS', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'picture-voice-isolation-'))
  const dir = path.join(root, 'public/generated'); await mkdir(dir, { recursive: true })
  const picture = path.join(dir, 'picture.mp4')
  try {
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=3',
      '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=800:sample_rate=48000:duration=0.8',
      '-f', 'lavfi', '-i', 'sine=frequency=900:sample_rate=48000:duration=0.35',
      '-filter_complex', '[2:a]adelay=800:all=1[voice];[3:a]adelay=2200:all=1[missed];[1:a][voice][missed]amix=inputs=3:duration=first:normalize=0[a]',
      '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', picture])
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.4',
      path.join(dir, 'tts-aaaaaaaa.wav')])
    const track = { beatId: 'n', text: '旁白', start: .8, end: 1.4, url: '/generated/tts-aaaaaaaa.wav',
      sourceDuration: .4, duration: .4, tempo: 1, voiceId: 'original', sha256: 'fixture' }
    const result = await composeNarration('/generated/picture.mp4', [track], 3, '16:9', root, '720p', 'narration', {
      detectPictureVoice: async () => ({ detector: 'fixture', observations: [
        { source: 'asr', start: .8, end: 1.6, text: '张飞' },
        { source: 'vad', start: .9, end: 1.5 },
      ] }),
    })
    assert.equal(result.environmentalTrack, 'muted-unverified')
    assert.deepEqual(result.pictureVoiceIsolation.mutedWindows.map(({ start, end }) => ({ start, end })),
      [{ start: 0, end: 3 }])
    const output = path.join(root, 'public', result.url)
    assert.ok(await decodedAudioDuration(output) >= result.metadata.duration - .05,
      'final decoded soundtrack must reach the actual video tail')
    const key = result.url.match(/^\/generated\/narrated-([a-f0-9]{64})\.mp4$/)?.[1]
    assert.ok(key)
    const receipt = JSON.parse(await readFile(path.join(root, '.runtime/narration-compositions', `${key}.json`), 'utf8'))
    assert.equal(receipt.mixerVersion, 6, 'the v7 composition key writes the v6 longest-duration mixer receipt')
    assert.match(receipt.filterGraph, /amix=inputs=2:duration=longest/)
    const outputSha = createHash('sha256').update(await readFile(output)).digest('hex')
    const transfer = await collectIndependentNarrationTransferEvidence(result.url, output, '/generated/fixture-evidence.json', outputSha, root)
    assert.equal(transfer?.status, 'unverified', 'fixture has no paid TTS synthesis receipt')
    assert.equal(transfer?.sourceSpeechIsolation?.status, 'confirmed',
      'the bound source mute remains independently provable when TTS proof is unavailable')
    const [sourceVoice, sourceMissedVoice, mutedVoice, missedVoice, mutedAmbient, laterAmbient, narration] = await Promise.all([
      toneAmplitude(picture, .95, 800), toneAmplitude(picture, 2.3, 900),
      toneAmplitude(output, .95, 800), toneAmplitude(output, 2.3, 900),
      toneAmplitude(output, .95, 300), toneAmplitude(output, 2.3, 300), toneAmplitude(output, .95, 440),
    ])
    assert.ok(sourceVoice > .02, `fixture supplier voice should exist: ${sourceVoice}`)
    assert.ok(sourceMissedVoice > .02, `an unobserved later supplier voice should exist: ${sourceMissedVoice}`)
    assert.ok(mutedVoice < sourceVoice * .08, `supplier voice must be suppressed: ${mutedVoice}`)
    assert.ok(missedVoice < sourceMissedVoice * .08, `unobserved supplier voice must also be suppressed: ${missedVoice}`)
    assert.ok(laterAmbient < .002, `supplier audio is muted after the detected speech window: ${laterAmbient}`)
    assert.ok(mutedAmbient < .002, `supplier audio is muted in the speech window: ${mutedAmbient}`)
    assert.ok(narration > .02, `independent TTS remains audible: ${narration}`)

    const noDetectedVoice = await composeNarration('/generated/picture.mp4', [track], 3, '16:9', root, '720p', 'narration', {
      detectPictureVoice: async () => ({ detector: 'fixture', observations: [] }),
    })
    assert.equal(noDetectedVoice.environmentalTrack, 'muted-unverified')
    assert.equal(noDetectedVoice.pictureVoiceIsolation.fallbackReason, 'picture-voice-absence-unverified')
    const noDetectedVoiceFile = path.join(root, 'public', noDetectedVoice.url)
    assert.ok((await toneAmplitude(noDetectedVoiceFile, .95, 800)) < sourceVoice * .08,
      'a false-negative detector cannot leave supplier speech beneath narration')
    assert.ok((await toneAmplitude(noDetectedVoiceFile, 2.3, 300)) < .002,
      'fail-closed isolation also removes supplier ambience, for explicit later review')
    assert.ok((await toneAmplitude(noDetectedVoiceFile, .95, 440)) > .02,
      'independent TTS remains audible when the supplier track is unverified')

    const unavailable = await composeNarration('/generated/picture.mp4', [track], 3, '16:9', root, '720p', 'narration', {
      detectPictureVoice: async () => { throw Error('detector unavailable') },
    })
    assert.equal(unavailable.environmentalTrack, 'muted-unverified')
    assert.equal(unavailable.pictureVoiceIsolation.fallbackReason, 'picture-voice-detection-unavailable')
    assert.ok((await toneAmplitude(path.join(root, 'public', unavailable.url), 2.3, 300)) < .002,
      'unverified supplier audio must not be mixed with approved speech')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a supplier audio track shorter than its picture cannot truncate a later independent line', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'short-picture-audio-'))
  const dir = path.join(root, 'public/generated'); await mkdir(dir, { recursive: true })
  try {
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=3:r=24',
      '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=1',
      '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      path.join(dir, 'short-audio-picture.mp4')])
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.4',
      path.join(dir, 'tts-bbbbbbbb.wav')])
    const track = { beatId: 'late', text: '末句旁白', start: 2.2, end: 2.8, url: '/generated/tts-bbbbbbbb.wav',
      sourceDuration: .4, duration: .4, tempo: 1, voiceId: 'original', sha256: 'fixture' }
    const result = await composeNarration('/generated/short-audio-picture.mp4', [track], 3, '16:9', root, '720p', 'narration', {
      detectPictureVoice: async () => ({ detector: 'fixture', observations: [] }),
    })
    const output = path.join(root, 'public', result.url)
    assert.ok(await decodedAudioDuration(output) >= result.metadata.duration - .05)
    assert.ok((await toneAmplitude(output, 2.3, 440)) > .02, 'late TTS survives the short supplier track')
    assert.ok((await toneAmplitude(output, 2.3, 300)) < .002, 'unverified supplier track stays muted')
  } finally { await rm(root, { recursive: true, force: true }) }
})
