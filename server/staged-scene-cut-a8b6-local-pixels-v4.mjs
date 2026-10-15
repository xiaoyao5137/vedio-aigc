/** Deterministic wall-only V4 candidate. Its output still needs a real
 * node49 review and node50 certificate before any video request. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

export const A8B6_LOCAL_V4_PIXEL_ALGORITHM_ID =
  'v3-earth-wall-and-wood-gate-one-roi-v4'

const SHA = {
  base: '7313b043adc16dc9fc7f6ee7512f2a377f8218e6e0fba11bea91ef943fc7fac7',
  wall: '241ff3bbb9b100385e1c2dd01dc79124523111242bf0da29660711da1e9015c3',
  wallReference: 'c61fa0a1c3625017d4a0e83afe9b1f19dab61b5c2ee084e343b0078195fae683',
  promptManifest: '4f5658af2f9d5ffa66802a1e00c4499b19bf2f8eb8d9f4b18b0bdebc93ab8f72',
  output: 'de30188b2385c89494a294557044a0b0f7d42aefb82d090c7ab31dd7cf28861c',
}
const FILES = {
  base: 'public/generated/image-7313b043adc16dc9fc7f6ee7512f2a37.png',
  wall: 'qa/staged-scene-cut/wall-imagegen-v4-raw.png',
  wallReference: 'qa/staged-scene-cut/wall-target-local-crop-v4.png',
  promptManifest: 'qa/staged-scene-cut/v4-wall-imagegen-prompt.json',
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = reason => { throw Error(`A8B6_LOCAL_V4_PIXELS_INVALID: ${reason}`) }
const readPinned = (root, key) => {
  const bytes = readFileSync(path.join(root, FILES[key]))
  if (sha(bytes) !== SHA[key]) fail(`${key} bytes changed`)
  return bytes
}

export const A8B6_LOCAL_V4_PIXEL_PARAMETERS = Object.freeze({
  outputSha256: SHA.output,
  crop: { left: 430, top: 0, width: 704, height: 704 },
  featherPixels: 28,
  polygons: [
    [[430, 71], [493, 70], [539, 79], [552, 170], [544, 195],
      [548, 294], [520, 321], [478, 321], [477, 180],
      [436, 180], [430, 160]],
    [[546, 86], [767, 85], [805, 76], [855, 73], [921, 82],
      [938, 127], [923, 167], [882, 166], [856, 153], [820, 151],
      [768, 150], [747, 179], [542, 178]],
    [[540, 158], [744, 157], [750, 177], [741, 201], [546, 201],
      [539, 194]],
    [[554, 197], [737, 197], [736, 249], [555, 249]],
    [[543, 188], [573, 186], [575, 316], [558, 329], [542, 322]],
    [[722, 185], [750, 183], [748, 252], [738, 271], [722, 255]],
    [[844, 151], [909, 151], [947, 166], [938, 204], [920, 250],
      [899, 280], [870, 272], [852, 249], [842, 211]],
  ],
})

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

export async function renderA8B6LocalFirstFrameV4(root = process.cwd()) {
  const bytes = Object.fromEntries(Object.keys(FILES)
    .map(key => [key, readPinned(root, key)]))
  const crop = A8B6_LOCAL_V4_PIXEL_PARAMETERS.crop
  const derivedReference = await sharp(bytes.base).extract(crop)
    .resize(1024, 1024).png().toBuffer()
  if (sha(derivedReference) !== SHA.wallReference
    || !derivedReference.equals(bytes.wallReference))
    fail('wall imagegen reference is not derived from signed V3 pixels')
  const manifest = JSON.parse(bytes.promptManifest.toString('utf8'))
  if (typeof manifest?.prompt !== 'string' || !manifest.prompt.trim()
    || sha(manifest.prompt)
      !== '85d2a2c7535e64148ea319600776724856a8abb0a58c1115f74b3b5fae7948a7'
    || JSON.stringify(manifest.references)
      !== JSON.stringify([FILES.wallReference])
    || manifest.raw !== FILES.wall)
    fail('imagegen prompt, reference or raw source changed')
  const base = await sharp(bytes.base).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true })
  const donor = await sharp(bytes.wall).resize(crop.width, crop.height,
    { kernel: 'lanczos3' }).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true })
  if (base.info.width !== 1536 || base.info.height !== 864
    || base.info.channels !== 3 || donor.info.width !== crop.width
    || donor.info.height !== crop.height || donor.info.channels !== 3)
    fail('base or wall donor shape changed')
  const output = Buffer.from(base.data)
  const { polygons, featherPixels } = A8B6_LOCAL_V4_PIXEL_PARAMETERS
  for (let y = crop.top; y < crop.top + crop.height; y++) {
    for (let x = crop.left; x < crop.left + crop.width; x++) {
      const px = x + .5, py = y + .5
      const alpha = Math.max(...polygons.map(polygon =>
        inside(polygon, px, py)
          ? smooth(distance(polygon, px, py) / featherPixels) : 0))
      const di = ((y - crop.top) * crop.width + x - crop.left) * 3
      const oi = (y * 1536 + x) * 3
      for (let c = 0; c < 3; c++)
        output[oi + c] = Math.round(output[oi + c] * (1 - alpha)
          + donor.data[di + c] * alpha)
    }
  }
  const pngBytes = await sharp(output,
    { raw: { width: 1536, height: 864, channels: 3 } })
    .png({ compressionLevel: 9 }).toBuffer()
  const outputSha256 = sha(pngBytes)
  let changedPixels = 0, outsideAllowedChangedPixels = 0
  let minX = 1536, minY = 864, maxX = -1, maxY = -1
  for (let y = 0; y < 864; y++) for (let x = 0; x < 1536; x++) {
    const i = (y * 1536 + x) * 3
    if (output[i] === base.data[i]
      && output[i + 1] === base.data[i + 1]
      && output[i + 2] === base.data[i + 2]) continue
    changedPixels++
    minX = Math.min(minX, x); minY = Math.min(minY, y)
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
    if (!polygons.some(polygon => inside(polygon, x + .5, y + .5)))
      outsideAllowedChangedPixels++
  }
  if (outputSha256 !== SHA.output || changedPixels !== 74876
    || outsideAllowedChangedPixels !== 0)
    fail('selected V4 QA pixels changed')
  return { pngBytes, outputSha256,
    algorithmId: A8B6_LOCAL_V4_PIXEL_ALGORITHM_ID,
    algorithmParameters: A8B6_LOCAL_V4_PIXEL_PARAMETERS,
    sourceSha256s: [SHA.base, SHA.wall],
    allowedRegions: [{ role: 'wall', polygons }],
    pixelProof: { changedPixels, outsideAllowedChangedPixels,
      changedBounds: { minX, minY, maxX, maxY } },
    provenance: { imageGen: { wall: {
      tool: 'image_gen__imagegen', transparentBackground: false,
      prompt: manifest.prompt, promptSha256: sha(manifest.prompt),
      references: [{ path: FILES.wallReference,
        sha256: SHA.wallReference, sourceSha256: SHA.base,
        crop, resizedTo: { width: 1024, height: 1024 },
        identityAuthority: false }],
      rawOutput: { path: FILES.wall, sha256: SHA.wall },
    } } } }
}
