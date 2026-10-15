#!/usr/bin/env node
/** QA-only four-byte-source, three-ROI composite; not an approved first frame. */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = {
  base: { filename: 'public/generated/image-63a701c1c4b38ae9fa04c450d13b8089.png',
    sha256: '63a701c1c4b38ae9fa04c450d13b8089b3220977ea2df55d86061c7a75e1d0f5' },
  wall: { filename: 'qa/staged-scene-cut/wall-imagegen-v3-raw.png',
    sha256: '3af90de3b8af4b87e484b7f576e4e84c22f9df4ff12de6b780ec3e35efc70f9a' },
  gate: { filename: 'qa/staged-scene-cut/gate-imagegen-v3-raw.png',
    sha256: '89123113a9a0ff726542fd643c05c5b2992adcf570ba181ff58de63239338df2' },
  face: { filename: 'qa/staged-scene-cut/yan-imagegen-v3b-raw.png',
    sha256: 'ce9820011e1df7e5380c6d9270649a0c201e8edab80c8530c0e0fda45f2b1e9d' },
}
const source = Object.fromEntries(await Promise.all(Object.entries(inputs)
  .map(async ([key, item]) => {
    const bytes = await readFile(path.join(root, item.filename))
    if (sha(bytes) !== item.sha256) throw Error(`V3_QA_INVALID: ${key} bytes changed`)
    return [key, bytes]
  })))
const edits = [
  { role: 'wall', crop: { left: 430, top: 0, width: 704, height: 704 },
    feather: 10, polygons: [
      [[420, 93], [496, 91], [541, 94], [565, 106], [781, 111],
        [824, 98], [898, 98], [936, 125], [928, 160],
        [904, 181], [876, 204], [859, 189], [858, 150],
        [840, 145], [774, 145], [750, 175], [563, 178],
        [557, 265], [516, 317], [478, 317], [477, 169],
        [441, 167],
        [420, 160]],
      [[547, 179], [585, 179], [588, 236], [572, 292],
        [548, 308]],
      [[849, 150], [900, 150], [931, 162], [947, 179],
        [939, 237], [920, 265], [903, 291], [890, 274],
        [862, 260], [845, 230], [842, 190]],
      [[746, 134], [858, 134], [858, 159], [801, 159],
        [797, 172], [774, 172], [746, 158]],
      [[745, 156], [772, 159], [772, 174], [760, 184],
        [750, 199], [748, 255], [746, 255]],
      [[800, 156], [858, 151], [858, 190], [852, 220],
        [844, 259], [842, 272], [833, 270], [835, 251],
        [839, 220], [830, 198], [817, 184], [797, 174]],
    ] },
  { role: 'gate-frame', crop: { left: 430, top: 0, width: 704, height: 704 },
    feather: 6, polygons: [
      [[543, 158], [741, 158], [747, 168], [747, 198],
        [739, 201], [547, 201], [540, 194], [540, 168]],
      [[545, 188], [573, 188], [574, 314], [556, 327],
        [542, 321]],
      [[723, 188], [748, 188], [747, 251], [735, 268],
        [722, 253]],
    ] },
  { role: 'yan-face', crop: { left: 940, top: 35, width: 285, height: 285 },
    feather: 8, polygons: [
      [[1060, 103], [1098, 103], [1125, 117], [1146, 146],
        [1144, 171], [1129, 193], [1105, 209], [1078, 219],
        [1048, 212], [1027, 194], [1017, 166], [1023, 138],
        [1039, 116]],
      [[1038, 178], [1096, 174], [1112, 194], [1105, 218],
        [1089, 240], [1063, 250], [1038, 239], [1017, 222],
        [1007, 205], [1018, 186]],
    ] },
]
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
    nearest = Math.min(nearest,
      Math.hypot(px - (ax + vx * t), py - (ay + vy * t)))
  }
  return nearest
}
const smooth = value => { const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t) }
const base = await sharp(source.base).removeAlpha().raw()
  .toBuffer({ resolveWithObject: true })
if (base.info.width !== 1536 || base.info.height !== 864
  || base.info.channels !== 3) throw Error('V3_QA_INVALID: base shape')
const output = Buffer.from(base.data)
const masks = []
for (const edit of edits) {
  const donor = await sharp(source[{
    wall: 'wall', 'gate-frame': 'gate', 'yan-face': 'face',
  }[edit.role]])
    .resize(edit.crop.width, edit.crop.height, { kernel: 'lanczos3' })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true })
  if (donor.info.width !== edit.crop.width
    || donor.info.height !== edit.crop.height || donor.info.channels !== 3)
    throw Error(`V3_QA_INVALID: ${edit.role} donor shape`)
  const mask = Buffer.alloc(edit.crop.width * edit.crop.height)
  for (let y = edit.crop.top; y < edit.crop.top + edit.crop.height; y++) {
    for (let x = edit.crop.left; x < edit.crop.left + edit.crop.width; x++) {
      const px = x + .5, py = y + .5
      const alpha = Math.max(...edit.polygons.map(polygon =>
        inside(polygon, px, py) ? smooth(distance(polygon, px, py)
          / edit.feather) : 0))
      const di = ((y - edit.crop.top) * edit.crop.width
        + x - edit.crop.left) * 3
      const oi = (y * 1536 + x) * 3
      mask[(y - edit.crop.top) * edit.crop.width + x - edit.crop.left]
        = Math.round(alpha * 255)
      for (let c = 0; c < 3; c++)
        output[oi + c] = Math.round(output[oi + c] * (1 - alpha)
          + donor.data[di + c] * alpha)
    }
  }
  masks.push({ edit, mask })
}
const outputBytes = await sharp(output,
  { raw: { width: 1536, height: 864, channels: 3 } })
  .png({ compressionLevel: 9 }).toBuffer()
let changedPixels = 0, outsideAllowedChangedPixels = 0
let minX = 1536, minY = 864, maxX = -1, maxY = -1
const byRole = { wall: 0, 'gate-frame': 0, 'yan-face': 0 }
for (let y = 0; y < 864; y++) for (let x = 0; x < 1536; x++) {
  const i = (y * 1536 + x) * 3
  if (output[i] === base.data[i] && output[i + 1] === base.data[i + 1]
    && output[i + 2] === base.data[i + 2]) continue
  changedPixels++
  minX = Math.min(minX, x); minY = Math.min(minY, y)
  maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
  const matches = edits.filter(edit => edit.polygons.some(polygon =>
    inside(polygon, x + .5, y + .5)))
  if (!matches.length) outsideAllowedChangedPixels++
  else byRole[matches[0].role]++
}
const dir = path.join(root, 'qa/staged-scene-cut')
await writeFile(path.join(dir, 'local-face-wall-v3-preview.png'), outputBytes)
for (const { edit, mask } of masks) {
  await writeFile(path.join(dir, `local-face-wall-v3-${edit.role}-mask.png`),
    await sharp(mask, { raw: { width: edit.crop.width,
      height: edit.crop.height, channels: 1 } }).png().toBuffer())
}
await writeFile(path.join(dir, 'local-face-wall-v3-wall-detail.png'),
  await sharp(outputBytes).extract({ left: 450, top: 70,
    width: 520, height: 270 }).resize(1040, 540).png().toBuffer())
await writeFile(path.join(dir, 'local-face-wall-v3-face-detail.png'),
  await sharp(outputBytes).extract({ left: 990, top: 70,
    width: 215, height: 215 }).resize(860, 860).png().toBuffer())
const report = { approvedForWorkflow: false, sourceSha256s: Object.fromEntries(
  Object.entries(inputs).map(([key, value]) => [key, value.sha256])),
outputSha256: sha(outputBytes), edits, changedPixels,
outsideAllowedChangedPixels, byRole,
changedBounds: { minX, minY, maxX, maxY } }
await writeFile(path.join(dir, 'local-face-wall-v3-preview.json'),
  JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ outputSha256: report.outputSha256,
  changedPixels, outsideAllowedChangedPixels, byRole,
  changedBounds: report.changedBounds }, null, 2))
