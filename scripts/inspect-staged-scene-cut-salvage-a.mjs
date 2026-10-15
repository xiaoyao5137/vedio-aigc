#!/usr/bin/env node
// Read-only, labelled contact sheet for direct inspection of the signed A
// derivative and its exact paid-source endpoint. Writes only to /tmp.
import os from 'node:os'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import sharp from 'sharp'
import { readSalvageAReviewEvidence } from '../server/staged-scene-cut-salvage.mjs'

const planId = process.argv[2]
if (!/^[a-f0-9]{64}$/.test(planId ?? '') || process.argv.length !== 3)
  throw Error('INSPECT_STAGED_SALVAGE_INVALID: one signed salvage plan ID required')
const root = process.cwd()
const { evidence } = await readSalvageAReviewEvidence(planId, root)
const width = 480, height = 288, columns = 4
const rows = Math.ceil(evidence.frames.length / columns)
const tiles = await Promise.all(evidence.frames.map(async (frame, index) => {
  const label = frame.kind === 'derived'
    ? `A f${frame.frameIndex} / source f${frame.sourceFrameIndex}` : `PAID SOURCE f${frame.frameIndex}`
  const svg = Buffer.from(`<svg width="${width}" height="${height}"><rect x="0" y="0" width="${width}" height="30" fill="black" fill-opacity="0.82"/><text x="10" y="21" font-family="Arial" font-size="18" fill="white">${label}</text></svg>`)
  const image = await sharp(path.join(root, 'public', frame.url.slice(1)))
    .resize(width, height).composite([{ input: svg, top: 0, left: 0 }]).png().toBuffer()
  return { input: image, left: (index % columns) * width,
    top: Math.floor(index / columns) * height }
}))
const directory = path.join(os.tmpdir(), `staged-salvage-review-${planId.slice(0, 16)}`)
await mkdir(directory, { recursive: true })
const output = path.join(directory, 'contact-sheet.png')
await sharp({ create: { width: columns * width, height: rows * height,
  channels: 3, background: '#161616' } }).composite(tiles).png().toFile(output)
console.log(JSON.stringify({ planId, videoSha256: evidence.videoSha256,
  frameCount: evidence.frames.length, output, databaseReads: 0,
  providerCalls: 0, acceptanceWritten: false }, null, 2))
