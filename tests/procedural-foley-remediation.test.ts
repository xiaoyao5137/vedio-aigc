import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ffmpeg from 'ffmpeg-static'

const script = fileURLToPath(new URL('../scripts/remediate-video-foley.mjs', import.meta.url))
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'procedural-foley-'))
  const generated = path.join(root, 'public/generated')
  await mkdir(generated, { recursive: true })
  const source = path.join(generated, 'quiet.mp4')
  execFileSync(ffmpeg!, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=2:r=24',
    '-f', 'lavfi', '-i', 'aevalsrc=0.0003*sin(2*PI*210*t):s=44100:d=2',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', source])
  const recipeFile = path.join(root, 'recipe.json')
  const recipe = { version: 'procedural-foley-v1', seed: 87431, targetLufs: -23,
    ambience: { ventilationHz: 68, strength: .15 }, events: [
      { type: 'breath', start: .2, duration: .5, strength: .3 },
      { type: 'fabric-touch', start: 1.1, duration: .4, strength: .7 },
    ] }
  await writeFile(recipeFile, JSON.stringify(recipe))
  return { root, generated, source, recipeFile, recipe }
}

function run(root: string, recipeFile: string, apply = false) {
  return spawnSync(process.execPath, [script, '--source', '/generated/quiet.mp4', '--recipe', recipeFile,
    ...(apply ? ['--apply'] : [])], { cwd: root, encoding: 'utf8', timeout: 30000 })
}

function decodedFrames(file: string) {
  return execFileSync(ffmpeg!, ['-hide_banner', '-v', 'error', '-xerror', '-i', file,
    '-map', '0:v:0', '-f', 'framemd5', '-'], { encoding: 'utf8' }).split(/\r?\n/)
    .filter(line => line.trim() && !line.startsWith('#')).map(line => line.split(',').at(-1)?.trim())
}

test('invalid foley timing fails before creating derivative media', async () => {
  const files = await fixture()
  try {
    await writeFile(files.recipeFile, JSON.stringify({ ...files.recipe, events: [
      ...files.recipe.events.slice(0, 1), { type: 'fabric-touch', start: 1.8, duration: .4, strength: .7 },
    ] }))
    const result = run(files.root, files.recipeFile, true)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /recipe event is invalid or exceeds video duration/)
    assert.deepEqual(await readdir(files.generated), ['quiet.mp4'])
  } finally { await rm(files.root, { recursive: true, force: true }) }
})

test('disclosed foley derivative preserves each decoded frame, original bytes and fail-closed manifest', async () => {
  const files = await fixture()
  try {
    const sourceSha = sha256(await readFile(files.source))
    const dryRun = run(files.root, files.recipeFile)
    assert.equal(dryRun.status, 0, dryRun.stderr)
    assert.equal(JSON.parse(dryRun.stdout).applied, false)
    assert.deepEqual(await readdir(files.generated), ['quiet.mp4'])
    const applied = run(files.root, files.recipeFile, true)
    assert.equal(applied.status, 0, applied.stderr)
    const result = JSON.parse(applied.stdout)
    const outputFile = path.join(files.generated, path.basename(result.outputUrl))
    const manifestFile = path.join(files.generated, path.basename(result.manifestUrl))
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
    assert.equal(sha256(await readFile(files.source)), sourceSha)
    assert.equal(manifest.sourceSha256, sourceSha)
    assert.equal(manifest.outputSha256, sha256(await readFile(outputFile)))
    assert.equal(manifest.audioSource, 'deterministic post-production DSP synthesis; no external recording, model or provider')
    assert.equal(manifest.soundContentSemanticReview, 'pending-human-listen')
    assert.ok(manifest.outputAudio.meanDbfs > -50)
    assert.ok(Math.abs(manifest.outputAudio.integratedLufs + 23) <= 2)
    assert.ok(manifest.outputAudio.truePeakDbfs < -1)
    assert.deepEqual(decodedFrames(outputFile), decodedFrames(files.source))
    assert.equal(manifest.everyDecodedVideoFrameMatched, true)
    await writeFile(manifestFile, JSON.stringify({ ...manifest, outputSha256: '0'.repeat(64) }))
    const tampered = run(files.root, files.recipeFile, true)
    assert.notEqual(tampered.status, 0)
    assert.match(tampered.stderr, /existing manifest differs/)
  } finally { await rm(files.root, { recursive: true, force: true }) }
})
