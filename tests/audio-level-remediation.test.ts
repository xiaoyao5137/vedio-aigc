import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ffmpeg from 'ffmpeg-static'
import { applyAudioLevelRemediation, chooseAudioLevelGain, planAudioLevelRemediation } from '../server/audio-level-remediation.ts'

test('gain is allowed for measured sparse sound, but not for silent or clipping material', () => {
  const quiet = { meanDbfs: -55.4, maxDbfs: -25.5, integratedLufs: -45.6, truePeakDbfs: -24.9,
    silenceSecondsBelowMinus50: 5.3, activeSecondsAboveMinus50: 2.74 }
  assert.deepEqual(chooseAudioLevelGain(quiet, 8.04), { gainDb: 22.6,
    predictedMeanDbfs: -32.8, predictedTruePeakDbfs: -2.3 })
  assert.throws(() => chooseAudioLevelGain({ ...quiet, meanDbfs: -90, maxDbfs: -88 }, 8.04), /NO_MEANINGFUL_SOUND/)
  assert.throws(() => chooseAudioLevelGain({ ...quiet, activeSecondsAboveMinus50: .04 }, 8.04), /NO_MEANINGFUL_SOUND/)
  assert.throws(() => chooseAudioLevelGain({ ...quiet, truePeakDbfs: -2 }, 8.04), /UNSAFE_GAIN/)
})

test('an audio-level derivative preserves every decoded video frame and the original file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'audio-level-remediation-'))
  const generated = path.join(root, 'public/generated')
  await mkdir(generated, { recursive: true })
  const source = path.join(generated, 'quiet.mp4')
  const expression = '0.006*sin(2*PI*440*t)*between(t\\,1.5\\,2.6)'
    + '+0.006*sin(2*PI*550*t)*between(t\\,4.3\\,5.4)'
    + '+0.025*sin(2*PI*1200*t)*between(t\\,2.0\\,2.008)'
    + '+0.025*sin(2*PI*1000*t)*between(t\\,4.8\\,4.808)'
  try {
    execFileSync(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=8:r=24',
      '-f', 'lavfi', '-i', `aevalsrc=${expression}:s=44100:d=8`, '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source])
    const originalSha = createHash('sha256').update(await readFile(source)).digest('hex')
    const plan = await planAudioLevelRemediation('/generated/quiet.mp4', { root })
    assert.ok(plan.source.audio.meanDbfs < -50)
    assert.ok(plan.gainDb > 20 && plan.predictedTruePeakDbfs < -1)
    const first = await applyAudioLevelRemediation(plan)
    assert.equal(first.everyDecodedVideoFrameMatched, true)
    assert.equal(first.sourceVideoFramesSha256, first.outputVideoFramesSha256)
    assert.ok(first.outputAudio.meanDbfs > -50)
    assert.ok(Math.abs(first.outputAudio.integratedLufs + 23) < 1)
    assert.ok(first.outputAudio.truePeakDbfs < -1)
    assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), originalSha)
    const second = await applyAudioLevelRemediation(plan)
    assert.equal(second.outputSha256, first.outputSha256)
    assert.equal(second.outputUrl, first.outputUrl)
    const manifestFile = path.join(generated, path.basename(plan.manifestUrl))
    assert.equal(JSON.parse(await readFile(manifestFile, 'utf8')).outputSha256, first.outputSha256)
    assert.equal((await readdir(generated)).some(name => name.endsWith('.tmp')), false)
    await writeFile(manifestFile, JSON.stringify({ sourceSha256: first.sourceSha256, outputSha256: first.outputSha256 }))
    await assert.rejects(applyAudioLevelRemediation(plan), /MANIFEST_CONFLICT/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('analysis and derivative target the first audio stream when another louder stream exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'audio-level-multitrack-'))
  const generated = path.join(root, 'public/generated')
  await mkdir(generated, { recursive: true })
  try {
    const first = '0.006*sin(2*PI*440*t)*between(t\\,1.5\\,2.6)'
      + '+0.025*sin(2*PI*1200*t)*between(t\\,2.0\\,2.008)'
    execFileSync(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=8:r=24',
      '-f', 'lavfi', '-i', `aevalsrc=${first}:s=44100:d=8`,
      '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100:duration=8',
      '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(generated, 'two-tracks.mp4')])
    const plan = await planAudioLevelRemediation('/generated/two-tracks.mp4', { root })
    assert.ok(plan.source.audio.meanDbfs < -50)
    assert.ok(plan.source.audio.maxDbfs > -40)
    const result = await applyAudioLevelRemediation(plan)
    assert.equal(result.everyDecodedVideoFrameMatched, true)
    assert.ok(result.outputAudio.meanDbfs > -50)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('an absent track and digital silence cannot become an accepted derived video', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'audio-level-reject-'))
  const generated = path.join(root, 'public/generated')
  await mkdir(generated, { recursive: true })
  try {
    execFileSync(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=2',
      '-c:v', 'libx264', path.join(generated, 'no-audio.mp4')])
    await assert.rejects(planAudioLevelRemediation('/generated/no-audio.mp4', { root }), /NO_TRACK/)
    execFileSync(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=2',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=2', '-c:v', 'libx264',
      '-c:a', 'aac', '-shortest', path.join(generated, 'silent.mp4')])
    await assert.rejects(planAudioLevelRemediation('/generated/silent.mp4', { root }),
      /NO_MEANINGFUL_SOUND|ANALYSIS_INVALID/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
