#!/usr/bin/env node
/** QA only: wall and gate piers from one archived imagegen output. */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const pinned = {
  base: { path: 'public/generated/image-7313b043adc16dc9fc7f6ee7512f2a37.png',
    sha256: '7313b043adc16dc9fc7f6ee7512f2a377f8218e6e0fba11bea91ef943fc7fac7' },
  wall: { path: 'qa/staged-scene-cut/wall-imagegen-v4-raw.png',
    sha256: '241ff3bbb9b100385e1c2dd01dc79124523111242bf0da29660711da1e9015c3' },
}
const bytes = {}
for (const [key, item] of Object.entries(pinned)) {
  bytes[key] = await readFile(path.join(root, item.path))
  if (sha(bytes[key]) !== item.sha256) throw Error(`V4_QA_INVALID: ${key} changed`)
}
const crop = { left: 430, top: 0, width: 704, height: 704 }
const polygons = [
  // Left earth wall and the formerly masonry-looking tall pier.
  [[430, 71], [493, 70], [539, 79], [552, 170], [544, 195],
    [548, 294], [520, 321], [478, 321], [477, 180],
    [436, 180], [430, 160]],
  // Broad upper earth face below the crenels, clear of the tower roof.
  [[546, 86], [767, 85], [805, 76], [855, 73], [921, 82],
    [938, 127], [923, 167], [882, 166], [856, 153], [820, 151],
    [768, 150], [747, 179], [542, 178]],
  // Timber lintel and left wooden post in the unchanged gate opening.
  [[540, 158], [744, 157], [750, 177], [741, 201], [546, 201],
    [539, 194]],
  // The V3 gate's gray gridded infill directly below the timber lintel.
  [[554, 197], [737, 197], [736, 249], [555, 249]],
  [[543, 188], [573, 186], [575, 316], [558, 329], [542, 322]],
  // Right wooden post; stops at the foreground guard silhouette.
  [[722, 185], [750, 183], [748, 252], [738, 271], [722, 255]],
  // Exposed right earth wall above and to the right of the guard.
  [[844, 151], [909, 151], [947, 166], [938, 204], [920, 250],
    [899, 280], [870, 272], [852, 249], [842, 211]],
]
const feather = 28
const inside = (polygon, px, py) => {
  let found = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j]
    if ((yi > py) !== (yj > py)
      && px < (xj - xi) * (py - yi) / (yj - yi) + xi) found = !found
  }
  return found
}
const distance = (polygon, px, py) => {
  let nearest = Infinity
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = polygon[i], [bx, by] = polygon[(i + 1) % polygon.length]
    const vx = bx - ax, vy = by - ay
    const t = Math.max(0, Math.min(1,
      ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)))
    nearest = Math.min(nearest, Math.hypot(px - (ax + vx * t),
      py - (ay + vy * t)))
  }
  return nearest
}
const smooth = value => {
  const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t)
}
const base = await sharp(bytes.base).removeAlpha().raw()
  .toBuffer({ resolveWithObject: true })
const donor = await sharp(bytes.wall).resize(crop.width, crop.height,
  { kernel: 'lanczos3' }).removeAlpha().raw()
  .toBuffer({ resolveWithObject: true })
if (base.info.width !== 1536 || base.info.height !== 864
  || base.info.channels !== 3 || donor.info.width !== crop.width
  || donor.info.height !== crop.height || donor.info.channels !== 3)
  throw Error('V4_QA_INVALID: image shape changed')
const output = Buffer.from(base.data)
const mask = Buffer.alloc(crop.width * crop.height)
for (let y = crop.top; y < crop.top + crop.height; y++) {
  for (let x = crop.left; x < crop.left + crop.width; x++) {
    const px = x + .5, py = y + .5
    const alpha = Math.max(...polygons.map(polygon =>
      inside(polygon, px, py)
        ? smooth(distance(polygon, px, py) / feather) : 0))
    const di = ((y - crop.top) * crop.width + x - crop.left) * 3
    const oi = (y * 1536 + x) * 3
    mask[(y - crop.top) * crop.width + x - crop.left]
      = Math.round(alpha * 255)
    for (let c = 0; c < 3; c++)
      output[oi + c] = Math.round(output[oi + c] * (1 - alpha)
        + donor.data[di + c] * alpha)
  }
}
const outputBytes = await sharp(output,
  { raw: { width: 1536, height: 864, channels: 3 } })
  .png({ compressionLevel: 9 }).toBuffer()
let changedPixels = 0, outsideAllowedChangedPixels = 0
let minX = 1536, minY = 864, maxX = -1, maxY = -1
for (let y = 0; y < 864; y++) for (let x = 0; x < 1536; x++) {
  const i = (y * 1536 + x) * 3
  if (output[i] === base.data[i] && output[i + 1] === base.data[i + 1]
    && output[i + 2] === base.data[i + 2]) continue
  changedPixels++
  minX = Math.min(minX, x); minY = Math.min(minY, y)
  maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
  if (!polygons.some(polygon => inside(polygon, x + .5, y + .5)))
    outsideAllowedChangedPixels++
}
const dir = path.join(root, 'qa/staged-scene-cut')
await writeFile(path.join(dir, 'local-wall-v4-preview.png'), outputBytes)
await writeFile(path.join(dir, 'local-wall-v4-mask.png'),
  await sharp(mask, { raw: { width: crop.width, height: crop.height,
    channels: 1 } }).png().toBuffer())
await writeFile(path.join(dir, 'local-wall-v4-detail.png'),
  await sharp(outputBytes).extract({ left: 420, top: 65,
    width: 550, height: 285 }).resize(1100, 570).png().toBuffer())
const report = { approvedForWorkflow: false,
  sourceSha256s: [pinned.base.sha256, pinned.wall.sha256],
  outputSha256: sha(outputBytes), crop, polygons, feather,
  changedPixels, outsideAllowedChangedPixels,
  changedBounds: { minX, minY, maxX, maxY } }
await writeFile(path.join(dir, 'local-wall-v4-preview.json'),
  JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ outputSha256: report.outputSha256,
  changedPixels, outsideAllowedChangedPixels,
  changedBounds: report.changedBounds }))
