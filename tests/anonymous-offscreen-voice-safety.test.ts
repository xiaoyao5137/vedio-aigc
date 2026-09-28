import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import { anonymousVoiceRoles, compileKlingVoices, explicitlyOffscreenSpeaker, nativeGroupVoicePlan, speechStagingConflict, voiceSpeakers } from '../src/character-voice.ts'
import { voiceCharacterInputs } from '../src/voice-character-input.ts'
import { projectIndependentOffscreenDialogue } from '../server/narration-projection.ts'
import { cachedNarrationPicture, composeNarration } from '../server/independent-narration.ts'
import { resolveVoiceGateDecision, voiceReviewTarget } from '../src/voice-review.ts'
import { acceptPrincipleMedia } from '../src/principle-media-quality.ts'

const exec = promisify(execFile)
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string
function shot() {
  return { id: 'shot-09-part1', dramaticSceneId: 'unit-09', duration: 5, audioType: '对白', audioText: '弟子（画外）：苍天已死。\n弟子（画外）：黄天当立。',
    characters: [], initialCharacters: [], endCharacters: [], pacing: {
      actorGroups: [{ id: 'group-disciple', label: '弟子', memberDescription: '聚集村民中的青年弟子' }],
      beats: [{ id: 'speech-1', kind: 'speech', deliveryStyle: 'dialogue', actorIds: ['group-disciple'], textOrVocalization: '苍天已死。' },
        { id: 'speech-2', kind: 'speech', deliveryStyle: 'dialogue', actorIds: ['group-disciple'], textOrVocalization: '黄天当立。' }],
      timingPolicy: { speech: { dialogue: { referenceRate: 4.5, maximumRate: 5 } } },
      schedule: [{ beatId: 'speech-1', startSecond: .5, endSecond: 2 }, { beatId: 'speech-2', startSecond: 2.2, endSecond: 4.5 }],
      timelineWindows: [{ beatQuotes: [{ beatId: 'speech-1', quote: '弟子在画外说出苍天已死。' }, { beatId: 'speech-2', quote: '弟子在画外接着说黄天当立。' }] }],
    } }
}

test('anonymous offscreen dialogue keeps the real role and every spoken line without inventing a portrait or narrator', () => {
  const input = shot(), before = structuredClone(input)
  assert.deepEqual(voiceSpeakers(input), ['弟子'])
  const roles = voiceCharacterInputs([], input)
  assert.equal(roles.length, 1)
  assert.equal(roles[0].name, '弟子')
  assert.equal(roles[0].audioRole, 'offscreen-dialogue')
  assert.ok(roles[0].continuityKey.startsWith('anonymous-voice:unit-09:'))
  assert.notEqual(roles[0].continuityKey, '__narrator__')
  const projection = projectIndependentOffscreenDialogue('村民围在庭中。弟子在画外说出苍天已死。弟子在画外接着说黄天当立。', input)
  assert.equal(projection.speakerName, '弟子')
  assert.equal(projection.audioRole, 'offscreen-dialogue')
  assert.deepEqual(projection.segments.map(segment => segment.text), ['苍天已死。', '黄天当立。'])
  assert.match(projection.prompt, /村民围在庭中/)
  assert.match(projection.prompt, /画外角色弟子的对白/)
  assert.doesNotMatch(projection.prompt, /旁白|苍天已死|黄天当立/)
  assert.equal(projection.params.audioType, '环境声', 'only the provider picture request omits speech')
  assert.deepEqual(input, before)
  assert.equal(input.audioType, '对白')
  assert.ok(input.pacing.beats.every(beat => beat.deliveryStyle === 'dialogue'))
  assert.deepEqual(input.characters, [])
})

test('visible, negative, ambiguous and mixed speaker declarations cannot enter the independent role track', () => {
  for (const label of ['弟子', '弟子（画内）', '弟子（非画外）', '弟子（不在画外）', '弟子（画外转画内）']) {
    const input = shot(); input.audioText = `${label}：苍天已死。\n${label}：黄天当立。`
    assert.throws(() => projectIndependentOffscreenDialogue('', input), /VOICE_|NARRATION_/, label)
    assert.throws(() => voiceCharacterInputs([], input), /VOICE_/, label)
  }
  const mixed = shot(); mixed.audioText = '弟子（画外）：苍天已死。\n张角（画外）：黄天当立。'
  assert.throws(() => projectIndependentOffscreenDialogue('', mixed), /NARRATION_|VOICE_/)
  for (const audioType of ['旁白', '环境声']) assert.throws(() => projectIndependentOffscreenDialogue('', { ...shot(), audioType }), /NARRATION_|VOICE_/, audioType)
  const reserved = shot(); reserved.pacing.actorGroups[0].label = '旁白'; reserved.audioText = '旁白（画外）：苍天已死。\n旁白（画外）：黄天当立。'
  assert.throws(() => voiceCharacterInputs([], reserved), /VOICE_/)
  const collision = shot()
  assert.throws(() => voiceCharacterInputs([{ name: '弟子', continuityKey: 'named-portrait' }], collision), /VOICE_IDENTITY_AMBIGUOUS/)
})

test('negative mouth instructions remain offscreen, and named speakers share the same staging conflict check', () => {
  for (const label of ['弟子（画外，不对口型）', '弟子（画外，无需同步口型）', '弟子（画外，禁止说话口型）', '弟子（画外，不在画内）']) {
    assert.equal(explicitlyOffscreenSpeaker(label), true, label)
    const input = { ...shot(), audioText: `${label}：苍天已死。\n${label}：黄天当立。` }
    assert.equal(anonymousVoiceRoles(input)[0].offscreen, true)
    assert.equal(projectIndependentOffscreenDialogue('', input).segments.length, 2)
  }
  for (const label of ['弟子（非画外）', '弟子（画外，必须同步口型）', '弟子（画外转画内）']) assert.equal(explicitlyOffscreenSpeaker(label), false, label)
  for (const requirement of [{ lipSync: 'required' }, { completion: { modality: 'audio-visual' } }]) {
    const params = { audioType: '对白', audioText: '张角（画外）：黄天当立。', pacing: { beats: [
      { kind: 'speech', actorIds: ['张角'], deliveryStyle: 'dialogue', ...requirement },
    ] } }
    assert.equal(speechStagingConflict(params, '张角')?.code, 'VOICE_STAGING_CONFLICT')
    assert.equal(speechStagingConflict(params, '听众'), undefined)
  }
})

test('an offscreen label cannot erase its own visible speech obligation; manual native route retains both lines', () => {
  const input = { ...shot(), visualPrompt: '弟子正面向百姓讲述，嘴部清晰可见。', pacing: { ...shot().pacing,
    beats: shot().pacing.beats.map(beat => ({ ...beat, completion: { modality: 'audio-visual', evidenceAnchor: '弟子向百姓讲述' } })) } }
  const before = structuredClone(input)
  const role = anonymousVoiceRoles(input)[0]
  assert.equal(role.offscreen, false)
  assert.equal(role.stagingConflict?.code, 'VOICE_STAGING_CONFLICT')
  assert.deepEqual(role.stagingConflict?.paths, ['pacing.beats[0].completion.modality', 'pacing.beats[1].completion.modality'])
  assert.throws(() => voiceCharacterInputs([], input), /VOICE_STAGING_CONFLICT:.*保留原台词/)
  assert.throws(() => projectIndependentOffscreenDialogue(input.visualPrompt, input), /VOICE_STAGING_CONFLICT/)
  const manual = { ...input, qualityDisposition: 'manual-review-v1', sound: 'on' }
  const nativeGroupVoices = nativeGroupVoicePlan(manual)
  assert.equal(nativeGroupVoices[0].offscreen, false)
  assert.equal(nativeGroupVoices[0].speechVerified, false)
  const compiled = compileKlingVoices(input.audioText, { ...manual, nativeGroupVoices }, 'kling-v3', false)
  assert.match(compiled.prompt, /画内同期声优先/)
  assert.match(compiled.prompt, /苍天已死/)
  assert.match(compiled.prompt, /黄天当立/)
  assert.deepEqual(input, before)
})

test('explicit onscreen mouth requirements conflict, while unrelated listener reactions and no-mouth guards stay legal', () => {
  for (const instruction of ['正脸可见开口说话', '嘴唇必须同步', '画内发声', '双唇必须可见']) {
    const input = { ...shot(), pacing: { ...shot().pacing, beats: shot().pacing.beats.map(beat => ({ ...beat, performanceInstruction: instruction })) } }
    assert.throws(() => projectIndependentOffscreenDialogue('', input), /VOICE_STAGING_CONFLICT/, instruction)
  }
  const input = { ...shot(), pacing: { ...shot().pacing, beats: [
    ...shot().pacing.beats.map(beat => ({ ...beat, performanceInstruction: '不作说话口型；镜头看听众反应' })),
    { id: 'listener', kind: 'action', actorIds: ['listeners'], completion: { modality: 'audio-visual' } },
  ] } }
  assert.equal(anonymousVoiceRoles(input)[0].offscreen, true)
  assert.equal(projectIndependentOffscreenDialogue('', input).segments.length, 2)
})

test('missing speech, conflicting identities, chorus and invalid timing stay blocking', () => {
  const cases: Array<(value: ReturnType<typeof shot>) => void> = [
    value => { value.audioText = '弟子（画外）：苍天已死。' },
    value => { value.pacing.beats[1].textOrVocalization = '另一段完全不同的话。' },
    value => { value.pacing.actorGroups.push({ ...value.pacing.actorGroups[0] }) },
    value => { value.pacing.actorGroups.push({ ...value.pacing.actorGroups[0], id: 'other' }) },
    value => { value.pacing.beats[0].actorIds.push('other') },
    value => { value.pacing.beats[1].deliveryStyle = 'narration' },
    value => { value.pacing.schedule.pop() },
    value => { value.pacing.schedule[1].startSecond = 1 },
    value => { value.pacing.schedule[1].endSecond = 6 },
  ]
  for (const change of cases) {
    const input = shot(); change(input)
    assert.throws(() => projectIndependentOffscreenDialogue('', input), /VOICE_|NARRATION_/)
  }
  const visible = { characterId: 'anonymous-disciple', characterName: '弟子', voiceId: 'fixed-voice', version: 1, modelId: 'tts', accountScope: 'scope', voiceName: '弟子', previewUrl: '/preview.wav' }
  assert.throws(() => compileKlingVoices('弟子在画内说话', { characterVoices: [visible], sound: 'on' }, 'kling-v3', true), /VOICE_ELEMENT_MISSING/)
  assert.notEqual(anonymousVoiceRoles(shot())[0].continuityKey, anonymousVoiceRoles({ ...shot(), dramaticSceneId: 'unit-other' })[0].continuityKey)
})

test('actual server picture identity preserves same-request recovery but new manual attempts purchase a fresh picture', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'offscreen-picture-key-'))
  try {
    const source = await readFile(new URL('../vite.config.ts', import.meta.url), 'utf8')
    const identityStatement = source.match(/^\s*const pictureIdentity = .*$/m)?.[0]
    assert.ok(identityStatement, 'test the production identity expression rather than copying its logic')
    const identity = new Function('model', 'executionContext', 'params', 'picturePrompt', 'pictureParams', identityStatement + '\nreturn pictureIdentity;')
    const projection = projectIndependentOffscreenDialogue('庭中村民聚集。', shot())
    const params = { voiceManifest: { executionId: 'original-voice-lock' } }, model = { id: 'kling-omni' }
    const pictureIdentity = (requestKey: string, picture = projection) =>
      identity(model, { requestKey }, params, picture.prompt, picture.params)
    let requests = 0
    const generate = async () => ({ status: 200, body: { data: { task_status: 'succeed', task_result: { videos: [{ url: `/generated/new-picture-${++requests}.mp4` }] } } } })
    const first = pictureIdentity('retake-a:video:revision-0')
    const a = await cachedNarrationPicture(first, generate, root)
    const recovered = await cachedNarrationPicture(pictureIdentity('retake-a:video:revision-0',
      { ...projection, params: { ...projection.params, resumeTaskId: 'paid-task', resumeQueryMode: 'omni' } }), generate, root)
    assert.deepEqual(recovered, a)
    assert.equal(requests, 1)
    const b = await cachedNarrationPicture(pictureIdentity('retake-b:video:revision-0'), generate, root)
    assert.equal(requests, 2)
    assert.notDeepEqual(b, a)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('decoded offscreen dialogue composition remains unreviewed speech and lip sync; explicit failed listening still blocks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'offscreen-dialogue-qa-'))
  const dir = path.join(root, 'public/generated'); await mkdir(dir, { recursive: true })
  try {
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=3', '-f', 'lavfi', '-i', 'sine=frequency=100:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'picture.mp4')])
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', path.join(dir, 'tts-aaaaaaaa.wav')])
    const output = await composeNarration('/generated/picture.mp4', [{ beatId: 'speech', text: '对白测试', start: .5, end: 2, url: '/generated/tts-aaaaaaaa.wav', sourceDuration: 1, duration: 1, tempo: 1, voiceId: 'original', sha256: 'fixture' }], 3, '16:9', root, '720p', 'offscreen-dialogue')
    assert.equal(output.route, 'independent-offscreen-dialogue-v1')
    assert.equal(output.audioRole, 'offscreen-dialogue')
    assert.equal(output.voiceConsistency.status, 'uncertain')
    assert.match(output.voiceConsistency.reason, /角色画外对白/)
    assert.doesNotMatch(output.voiceConsistency.reason, /旁白/)
    assert.equal(output.metadata.hasAudio, true)
    const voice = { characterId: 'scene-disciple', characterName: '弟子', voiceId: 'original', version: 1, modelId: 'tts', accountScope: 'scope', voiceName: '弟子', previewUrl: '/preview.wav' }
    const take = { url: output.url, characterVoices: [voice], voiceConsistency: output.voiceConsistency }
    const accepted = acceptPrincipleMedia({ shot_script: { audioType: '对白', audioText: '弟子（画外）：对白测试', duration: 3 }, video_take: take,
      video_evidence: { decoded: true, url: output.url, originalUrl: output.url, evidenceUrl: '/generated/evidence.json', duration: output.metadata.duration,
        width: output.width, height: output.height, frames: ['/generated/end.jpg'], lastFrameUrl: '/generated/end.jpg', hasAudio: true, transcript: [] },
      media_review: { version: 'principle-review-v1', decision: 'uncertain', issues: [], warnings: ['合成样本为测试音调，未进行真实台词识别或听审'] } })
    assert.equal(accepted.technicalValidation.speechVerified, false)
    assert.equal(accepted.visualReview.lipSyncVerified, false)
    const target = voiceReviewTarget(accepted)!
    assert.equal(target.characters[0].characterName, '弟子')
    const fallback = resolveVoiceGateDecision(target, null)
    assert.equal(fallback.method, 'automatic-binding-fallback')
    assert.equal(fallback.recognitionCapability, 'unavailable')
    assert.throws(() => resolveVoiceGateDecision(target, { status: 'failed', note: '明确听到声音不符', reviewedAt: new Date().toISOString(), method: 'user-listening' }), /VOICE_REVIEW_REJECTED/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
