import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { deriveAudioSourceProvenance, audioSourceLabel } from '../src/audio-source-provenance.ts'
import { aggregateConcatReviews } from '../src/concat-review.ts'

const providerUrl = 'https://cdn.example.com/video.mp4?signature=secret'
const direct = { model: 'keling3', url: providerUrl, params: { sound: 'on', audioType: '对白', audioText: '张角：出发。' },
  raw: { code: 0, data: { task_id: 'task-16', task_status: 'succeed', task_result: { videos: [{ url: providerUrl }] } },
    characterVoices: [{ characterName: '张角', voiceId: 'voice-1', elementId: 'element-1', previewUrl: 'data:audio/wav;base64,PRIVATE' }] } }
const narrated = { ...direct, url: '/generated/narrated.mp4', params: { sound: 'on', audioType: '旁白', audioText: '天下大疫。' },
  raw: { ...direct.raw, narration: { route: 'independent-narration-v1', pictureUrl: providerUrl, url: '/generated/narrated.mp4',
    tracks: [{ url: '/generated/tts-1.wav', voiceId: 'narrator-1', start: 0, end: 5, tempo: 1.1, sha256: 'a'.repeat(64), text: '天下大疫。' }] } } }

test('real response mixing receipt identifies narration when take.params predates voice binding', () => {
  const source = deriveAudioSourceProvenance(narrated)
  assert.equal(source.kind, 'independent-narration')
  assert.equal(source.evidence, 'composition-receipt')
  assert.equal(source.taskId, 'task-16')
  assert.deepEqual(source.picture, { url: 'https://cdn.example.com/video.mp4', redacted: true })
  assert.equal(source.tracks?.[0].url, '/generated/tts-1.wav')
  assert.equal(source.tracks?.[0].tempo, 1.1)
  assert.doesNotMatch(JSON.stringify(source), /secret|PRIVATE|天下大疫|previewUrl/)
  assert.equal(audioSourceLabel(source), '独立 TTS 旁白')
})

test('a separate offscreen-dialogue receipt remains dialogue and native custom-voice samples remain native', () => {
  const source = deriveAudioSourceProvenance({ ...narrated, raw: undefined,
    response: { body: { ...direct.raw, offscreenDialogue: { ...narrated.raw.narration, route: 'independent-offscreen-dialogue-v1' } } } })
  assert.equal(source.kind, 'independent-offscreen-dialogue')
  const native = deriveAudioSourceProvenance({ ...direct, params: { ...direct.params, voiceAssets: [{ previewAudio: 'data:audio/wav;base64,PRIVATE' }] } })
  assert.equal(native.kind, 'native-speech')
  assert.deepEqual(native.voices, [{ name: '张角', voiceId: 'voice-1', elementId: 'element-1', binding: 'fixed' }])
  assert.doesNotMatch(JSON.stringify(native), /PRIVATE|signature/)
})

test('provider labels, plans and mismatched result URLs cannot prove native audio', () => {
  assert.equal(deriveAudioSourceProvenance({ model: 'keling3', provider: 'Kling', audioMode: 'speech', hasAudio: true }).kind, 'unknown')
  assert.equal(deriveAudioSourceProvenance({ ...direct, raw: undefined, params: { ...direct.params, narrationVoice: { voiceId: 'voice-1' } } }).kind, 'unknown')
  assert.equal(deriveAudioSourceProvenance({ ...direct, url: '/generated/replaced.mp4' }).kind, 'unknown')
  assert.equal(deriveAudioSourceProvenance({ ...direct, params: { ...direct.params, sound: 'off' } }).kind, 'unknown')
})

test('native ambient and unbound anonymous voices retain distinct identities without quality claims', () => {
  assert.equal(deriveAudioSourceProvenance({ ...direct, params: { sound: 'on', audioType: '环境声', audioText: '' } }).kind, 'native-ambient')
  const source = deriveAudioSourceProvenance({ ...direct, raw: { ...direct.raw, characterVoices: [], nativeGroupVoices: [{ name: '传道弟子', status: 'unbound' }] } })
  assert.deepEqual(source.voices, [{ name: '传道弟子', binding: 'unbound' }])
  assert.doesNotMatch(JSON.stringify(source), /passed|speechVerified|lipSyncVerified/)
})

test('persisted provenance is compact and sanitized again, while invalid source evidence remains unknown', () => {
  const source = deriveAudioSourceProvenance({ audioSource: { ...deriveAudioSourceProvenance(narrated),
    picture: { url: 'https://user:password@example.com/a.mp4' },
    tracks: [{ url: 'data:audio/wav;base64,PRIVATE' }, { url: 'https://cdn.example.com/a.wav?token=SECRET', token: 'SECRET' }], token: 'SECRET' } })
  assert.equal(source.picture, undefined)
  assert.deepEqual(source.tracks, [{ url: 'https://cdn.example.com/a.wav', redacted: true }])
  assert.doesNotMatch(JSON.stringify(source), /SECRET|PRIVATE|password|token/)
  assert.equal(deriveAudioSourceProvenance({ audioSource: { version: 'audio-source-v1', kind: 'native-speech' } }).kind, 'unknown')
})

test('the quality node can serialize provenance into an isolated VM without module helpers or URL globals', () => {
  const value = runInNewContext(`(${deriveAudioSourceProvenance.toString()})(take)`, { take: narrated })
  assert.deepEqual(JSON.parse(JSON.stringify(value)), deriveAudioSourceProvenance(narrated))
})

test('rolling concat preserves each source and expires provenance when source bytes change', () => {
  const current = { url: '/generated/verified.mp4', audioSource: deriveAudioSourceProvenance(narrated) }
  const first = aggregateConcatReviews({ currentVideo: current }, [{ url: current.url, sha256: 'old' }])
  const next = { url: '/generated/native.mp4', audioSource: deriveAudioSourceProvenance(direct) }
  const output = aggregateConcatReviews({ previousVideo: { ...first, clips: [{ url: current.url, sha256: 'old' }] }, currentVideo: next },
    [{ url: current.url, sha256: 'old' }, { url: next.url, sha256: 'native' }])
  assert.deepEqual(output.clipReviews.map(clip => clip.audioSource.kind), ['independent-narration', 'native-speech'])
  assert.equal(output.voiceConsistency.fullVideoListened, false)
  const changed = aggregateConcatReviews({ previousVideo: { ...output, clips: [{ url: current.url }, { url: next.url }] } },
    [{ url: current.url, sha256: 'new' }, { url: next.url, sha256: 'native' }])
  assert.deepEqual(changed.clipReviews.map(clip => clip.audioSource.kind), ['unknown', 'native-speech'])
})

test('concat preserves pronunciation evidence meaning alongside its source without inheriting a later pass', () => {
  const pronunciationAssessment = { status: 'unverified', toneVerified: false }
  const current = { url: '/generated/a.mp4', pronunciationAssessment,
    speechValidation: { passed: true, phoneticErrorRate: 0, phoneticErrorRateMeaning: 'lexical pinyin proxy', pronunciationAssessment } }
  const output = aggregateConcatReviews({ currentVideo: current }, [{ url: current.url }])
  assert.deepEqual(output.clipReviews[0].pronunciationAssessment, pronunciationAssessment)
  assert.equal((output.clipReviews[0].speechValidation as Record<string, unknown>).phoneticErrorRateMeaning, 'lexical pinyin proxy')
})
