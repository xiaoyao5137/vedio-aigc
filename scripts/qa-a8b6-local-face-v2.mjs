#!/usr/bin/env node
/** QA only: splice a face-only imagegen crop into the rejected V7 layout. */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sha = value => createHash('sha256').update(value).digest('hex')
const basePath = path.join(root,
  'public/generated/image-b96d9804eb28771cbe2cc2d5d6edc532.png')
const donorPath = path.join(root,
  'qa/staged-scene-cut/yan-imagegen-v2-raw-1494cbd3.png')
const baseBytes = await readFile(basePath)
const donorBytes = await readFile(donorPath)
if (sha(baseBytes) !==
  'b96d9804eb28771cbe2cc2d5d6edc532ab3275abcbc71a4155e2da6d05b782be'
  || sha(donorBytes) !==
  '1494cbd3acc592bdf181723115fdb653215c95071b35e8424f9d360c9769b4df')
  throw Error('LOCAL_V2_QA_INVALID: source bytes changed')
const crop = { left: 940, top: 35, width: 285, height: 285 }
const polygons = [
  // Skin and cheek shape; crown, hair and robe stay on the V7 base.
  [[1060, 103], [1098, 103], [1125, 117], [1146, 146],
    [1144, 171], [1129, 193], [1105, 209], [1078, 219],
    [1048, 212], [1027, 194], [1017, 166], [1023, 138],
    [1039, 116]],
  // Beard fringe needs its own signed region so old gray tufts do not peek out.
  [[1038, 178], [1096, 174], [1112, 194], [1105, 218],
    [1089, 240], [1063, 250], [1038, 239], [1017, 222],
    [1007, 205], [1018, 186]],
]
const feather = 8
const inside = (polygon, px, py) => {
  let result = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j]
    if ((yi > py) !== (yj > py)
      && px < (xj - xi) * (py - yi) / (yj - yi) + xi) result = !result
  }
  return result
}
const boundaryDistance = (polygon, px, py) => {
  let nearest = Infinity
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = polygon[i], [bx, by] = polygon[(i + 1) % polygon.length]
    const vx = bx - ax, vy = by - ay
    const t = Math.max(0, Math.min(1,
      ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)))
    nearest = Math.min(nearest,
      Math.hypot(px - (ax + vx * t), py - (ay + vy * t)))
  }
  return nearest
}
const smooth = value => {
  const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t)
}
const base = await sharp(baseBytes).removeAlpha().raw()
  .toBuffer({ resolveWithObject: true })
const donor = await sharp(donorBytes)
  .resize(crop.width, crop.height, { kernel: 'lanczos3' })
  .removeAlpha().raw().toBuffer({ resolveWithObject: true })
if (base.info.width !== 1536 || base.info.height !== 864
  || base.info.channels !== 3 || donor.info.width !== crop.width
  || donor.info.height !== crop.height || donor.info.channels !== 3)
  throw Error('LOCAL_V2_QA_INVALID: source dimensions changed')
const output = Buffer.from(base.data)
const mask = Buffer.alloc(crop.width * crop.height)
let changedPixels = 0, outsideChangedPixels = 0, donorBoundaryDifference = 0
let boundarySamples = 0, minX = 1536, minY = 864, maxX = -1, maxY = -1
for (let y = crop.top; y < crop.top + crop.height; y++) {
  for (let x = crop.left; x < crop.left + crop.width; x++) {
    const px = x + .5, py = y + .5
    const alpha = Math.max(...polygons.map(polygon =>
      inside(polygon, px, py)
        ? smooth(boundaryDistance(polygon, px, py) / feather) : 0))
    const donorIndex = ((y - crop.top) * crop.width + x - crop.left) * 3
    const baseIndex = (y * 1536 + x) * 3
    mask[(y - crop.top) * crop.width + x - crop.left] = Math.round(alpha * 255)
    if (alpha > 0 && alpha < 1) {
      for (let channel = 0; channel < 3; channel++)
        donorBoundaryDifference += Math.abs(
          donor.data[donorIndex + channel] - base.data[baseIndex + channel])
      boundarySamples += 3
    }
    for (let channel = 0; channel < 3; channel++)
      output[baseIndex + channel] = Math.round(base.data[baseIndex + channel]
        * (1 - alpha) + donor.data[donorIndex + channel] * alpha)
    if (output[baseIndex] !== base.data[baseIndex]
      || output[baseIndex + 1] !== base.data[baseIndex + 1]
      || output[baseIndex + 2] !== base.data[baseIndex + 2]) {
      changedPixels++
      minX = Math.min(minX, x); minY = Math.min(minY, y)
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
      if (!polygons.some(polygon => inside(polygon, px, py)))
        outsideChangedPixels++
    }
  }
}
const outputBytes = await sharp(output, { raw: { width: 1536,
  height: 864, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer()
const preview = path.join(root,
  'qa/staged-scene-cut/yan-local-face-v2-preview.png')
const detail = path.join(root,
  'qa/staged-scene-cut/yan-local-face-v2-detail.png')
const maskFile = path.join(root,
  'qa/staged-scene-cut/yan-local-face-v2-mask.png')
await writeFile(preview, outputBytes)
await writeFile(detail, await sharp(outputBytes)
  .extract({ left: 990, top: 70, width: 215, height: 215 })
  .resize(860, 860).png().toBuffer())
await writeFile(maskFile, await sharp(mask,
  { raw: { width: crop.width, height: crop.height, channels: 1 } })
  .png().toBuffer())
const report = { purpose: 'QA-only imagegen face-region composite',
  approvedForWorkflow: false,
  sources: { baseSha256: sha(baseBytes), imageGenRawSha256: sha(donorBytes) },
  crop, polygons, feather,
  outputSha256: sha(outputBytes), changedPixels, outsideChangedPixels,
  changedBounds: { minX, minY, maxX, maxY },
  donorBoundaryMeanAbsoluteRgbDifference:
    donorBoundaryDifference / boundarySamples }
await writeFile(path.join(root,
  'qa/staged-scene-cut/yan-local-face-v2-preview.json'),
JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ ...report, preview, detail, maskFile }, null, 2))
