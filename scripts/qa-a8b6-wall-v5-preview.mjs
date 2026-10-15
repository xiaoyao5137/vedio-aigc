#!/usr/bin/env node
/** Inspect an ImageGen wall-only V5 layer without altering the approved people. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const root = process.cwd()
const dir = path.join(root, 'qa/staged-scene-cut')
const baseFile = path.join(dir, 'local-wall-v4-preview.png')
const rawFile = path.join(dir, 'wall-imagegen-v5-full-raw.png')
const w = 1536, h = 864
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const polygons = [
  [[194, 0], [261, 0], [261, 183], [253, 222], [203, 226], [194, 180]],
  [[1218, 0], [1310, 0], [1321, 130], [1321, 270], [1310, 392], [1231, 392], [1218, 270]],
  [[479, 90], [547, 90], [547, 338], [502, 341], [479, 285]],
  [[899, 89], [967, 89], [967, 174], [951, 193], [945, 337], [915, 333], [899, 243]],
  [[706, 182], [746, 182], [747, 248], [731, 266], [706, 266]],
]
const polygonSvg = Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="black"/>${polygons.map(p => `<polygon points="${p.map(([x,y])=>`${x},${y}`).join(' ')}" fill="white"/>`).join('')}</svg>`)
const [baseBytes, rawBytes] = await Promise.all([readFile(baseFile), readFile(rawFile)])
const rawScaled = await sharp(rawBytes).resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer()
const base = await sharp(baseBytes).removeAlpha().raw().toBuffer()
const mask = await sharp(polygonSvg).removeAlpha().blur(11).raw().toBuffer()
const out = Buffer.alloc(base.length)
let changed = 0, outside = 0
let minX = w, minY = h, maxX = -1, maxY = -1
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const index = y * w + x, alpha = mask[index * 3] / 255, at = index * 3
  for (let channel = 0; channel < 3; channel++) out[at + channel]
    = Math.round(base[at + channel] * (1 - alpha) + rawScaled[at + channel] * alpha)
  if (out[at] !== base[at] || out[at + 1] !== base[at + 1]
    || out[at + 2] !== base[at + 2]) {
    changed++; minX = Math.min(minX, x); minY = Math.min(minY, y)
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
    if (alpha === 0) outside++
  }
}
const preview = await sharp(out, { raw: { width: w, height: h,
  channels: 3 } }).png().toBuffer()
await mkdir(dir, { recursive: true })
await writeFile(path.join(dir, 'local-wall-v5-preview.png'), preview)
await sharp(mask, { raw: { width: w, height: h, channels: 3 } })
  .png().toFile(path.join(dir, 'local-wall-v5-mask.png'))
console.log(JSON.stringify({ baseSha256: sha(baseBytes), rawSha256: sha(rawBytes),
  previewSha256: sha(preview), changedPixels: changed, outsideMaskChanged: outside,
  changedBounds: { minX, minY, maxX, maxY }, polygons }, null, 2))
