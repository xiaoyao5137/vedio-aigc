#!/usr/bin/env node
// Local visual inspection only. Writes contact sheets and original-size JPEGs
// under /tmp; cannot issue a stage acceptance or call a provider.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { readStageMediaReceipt } from '../server/staged-scene-cut.mjs'

const exec = promisify(execFile), ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
const fail = message => { throw Error(`STAGED_PHASE_INSPECTION_INVALID: ${message}`) }
const args = process.argv.slice(2), options = {}
for (let i = 0; i < args.length; i++) {
  const key = { '--plan-id': 'planId', '--phase': 'phase', '--output': 'output' }[args[i]]
  if (!key || !args[i + 1] || options[key]) fail(`invalid or repeated ${args[i]}`)
  options[key] = args[++i]
}
if (!/^[a-f0-9]{64}$/.test(options.planId ?? '') || !['A', 'B'].includes(options.phase))
  fail('plan ID and phase A/B required')
const output = options.output ?? path.join(os.tmpdir(), `staged-scene-cut-${options.planId.slice(0, 12)}-${options.phase}`)
if (!path.isAbsolute(output) || !output.startsWith(os.tmpdir() + path.sep))
  fail('inspection output must be an absolute /tmp path')
const root = process.cwd(), media = await readStageMediaReceipt(options.planId, options.phase, root)
const filename = path.join(root, 'public', media.videoUrl.slice(1))
const indices = options.phase === 'A'
  ? [0, 12, 24, 36, 48, 60, 66, 72, 78, 84, 90, 96, 102, 108, 114, 120, 126,
    132, 138, 144, 150, 156, 162, 168, 174, 180, 186, 192]
  : [0, 1, 6, 12, 18, 24, 30, 36, 42, 48, 60, 72, 84, 96, 108, 120, 132, 138, 144]
await mkdir(output, { recursive: true })
const samples = []
const composites = []
const tileWidth = 480, tileHeight = 300, columns = 4
for (const [position, index] of indices.entries()) {
  const { stdout } = await exec(ffmpeg, ['-v', 'error', '-xerror', '-i', filename,
    '-vf', `select=eq(n\\,${index})`, '-vsync', 'vfr', '-frames:v', '1',
    '-q:v', '2', '-f', 'image2', '-'],
  { encoding: 'buffer', timeout: 120000, maxBuffer: 20 * 1024 * 1024 })
  if (!Buffer.isBuffer(stdout) || stdout.length < 1000) fail(`native frame ${index} missing`)
  const sha256 = createHash('sha256').update(stdout).digest('hex')
  const imageFile = path.join(output, `f${String(index).padStart(3, '0')}.jpg`)
  await writeFile(imageFile, stdout)
  const thumb = await sharp(stdout).resize(480, 270).jpeg({ quality: 88 }).toBuffer()
  composites.push({ input: thumb, top: Math.floor(position / columns) * tileHeight,
    left: (position % columns) * tileWidth })
  const label = `<svg width="480" height="30"><rect width="480" height="30" fill="#101820"/><text x="10" y="21" font-size="18" fill="white">${options.phase} f${index}  ${(index / 24).toFixed(3)}s</text></svg>`
  composites.push({ input: Buffer.from(label), top: Math.floor(position / columns) * tileHeight + 270,
    left: (position % columns) * tileWidth })
  samples.push({ frameIndex: index, ptsSeconds: index / 24, sha256, imageFile })
}
const contactSheet = path.join(output, 'contact-sheet.png')
await sharp({ create: { width: columns * tileWidth,
  height: Math.ceil(indices.length / columns) * tileHeight,
  channels: 3, background: '#101820' } }).composite(composites).png().toFile(contactSheet)
const mapFile = path.join(output, 'samples.json')
await writeFile(mapFile, JSON.stringify({ planId: options.planId, phase: options.phase,
  videoUrl: media.videoUrl, videoSha256: media.videoSha256,
  nativeFrameDigestSha256: media.nativeFrameDigestSha256,
  contactSheet, samples, reviewStatus: 'unreviewed' }, null, 2) + '\n')
console.log(JSON.stringify({ phase: options.phase, videoSha256: media.videoSha256,
  contactSheet, samplesJson: mapFile, originalFrameDirectory: output,
  reviewStatus: 'unreviewed', acceptanceWritten: false }, null, 2))
