/** Deterministic wall-material correction over the signed, rejected V4 frame.
 * Foreground and every pixel outside the five wall polygons remain V4 bytes. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

export const A8B6_LOCAL_V5_PIXEL_ALGORITHM_ID =
  'v4-rejected-frame-five-wall-polygons-v5'
export const A8B6_LOCAL_V5_PIXEL_PARAMETERS = Object.freeze({
  outputWidth: 1536, outputHeight: 864,
  donorResizeKernel: 'lanczos3', featherPixels: 11,
  polygons: [
    [[194, 0], [261, 0], [261, 183], [253, 222], [203, 226], [194, 180]],
    [[1218, 0], [1310, 0], [1321, 130], [1321, 270], [1310, 392], [1231, 392], [1218, 270]],
    [[479, 90], [547, 90], [547, 338], [502, 341], [479, 285]],
    [[899, 89], [967, 89], [967, 174], [951, 193], [945, 337], [915, 333], [899, 243]],
    [[706, 182], [746, 182], [747, 248], [731, 266], [706, 266]],
  ],
})

const FILES = Object.freeze({
  base: 'public/generated/image-de30188b2385c89494a294557044a0b0.png',
  donor: 'qa/staged-scene-cut/wall-imagegen-v5-full-raw.png',
  manifest: 'qa/staged-scene-cut/v5-wall-imagegen-prompt.json',
})
const EXPECTED = Object.freeze({
  base: 'de30188b2385c89494a294557044a0b0f7d42aefb82d090c7ab31dd7cf28861c',
  donor: '245510205d5886d1884f64396e4fa97b6c5e40f5f53a1cbef1a2704d29048dc6',
  output: '46009d665c617828d2cd87542ee5032a337c4f7b0b14e1291766f8533fe24c95',
})
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = reason => { throw Error(`A8B6_LOCAL_V5_PIXELS_INVALID: ${reason}`) }
const readPinned = (root, key) => {
  const bytes = readFileSync(path.join(root, FILES[key]))
  if (EXPECTED[key] && sha(bytes) !== EXPECTED[key])
    fail(`${key} source bytes changed`)
  return bytes
}
const inside = (polygon, x, y) => {
  let hit = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j]
    if ((yi > y) !== (yj > y)
      && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit
  }
  return hit
}
const distance = (polygon, x, y) => {
  let nearest = Infinity
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = polygon[i], [bx, by] = polygon[(i + 1) % polygon.length]
    const vx = bx - ax, vy = by - ay
    const t = Math.max(0, Math.min(1,
      ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)))
    nearest = Math.min(nearest,
      Math.hypot(x - (ax + vx * t), y - (ay + vy * t)))
  }
  return nearest
}
const smooth = value => {
  const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t)
}

export async function renderA8B6LocalFirstFrameV5(root = process.cwd()) {
  const bytes = Object.fromEntries(Object.keys(FILES)
    .map(key => [key, readPinned(root, key)]))
  const manifest = JSON.parse(bytes.manifest.toString('utf8'))
  if (manifest.tool !== 'image_gen__imagegen'
    || manifest.transparentBackground !== false
    || JSON.stringify(manifest.references) !== JSON.stringify([FILES.base])
    || manifest.raw !== FILES.donor
    || typeof manifest.prompt !== 'string' || !manifest.prompt.trim())
    fail('imagegen prompt, reference or raw source changed')
  const [baseMeta, donorMeta] = await Promise.all([
    sharp(bytes.base).metadata(), sharp(bytes.donor).metadata()])
  if (baseMeta.format !== 'png' || baseMeta.width !== 1536
    || baseMeta.height !== 864 || baseMeta.hasAlpha
    || donorMeta.format !== 'png' || donorMeta.width !== 1672
    || donorMeta.height !== 941 || donorMeta.hasAlpha)
    fail('source image format, dimensions or opacity changed')
  const base = await sharp(bytes.base).removeAlpha().raw().toBuffer()
  const donor = await sharp(bytes.donor).resize(1536, 864,
    { kernel: A8B6_LOCAL_V5_PIXEL_PARAMETERS.donorResizeKernel,
      fit: 'fill' }).removeAlpha().raw().toBuffer()
  if (base.length !== 1536 * 864 * 3 || donor.length !== base.length)
    fail('decoded source shape changed')
  const output = Buffer.from(base)
  const { polygons, featherPixels } = A8B6_LOCAL_V5_PIXEL_PARAMETERS
  let changedPixels = 0, outsideAllowedChangedPixels = 0
  let minX = 1536, minY = 864, maxX = -1, maxY = -1
  for (let y = 0; y < 864; y++) for (let x = 0; x < 1536; x++) {
    const px = x + .5, py = y + .5, at = (y * 1536 + x) * 3
    const containing = polygons.filter(polygon => inside(polygon, px, py))
    if (!containing.length) continue
    const alpha = Math.max(...containing.map(polygon =>
      smooth(distance(polygon, px, py) / featherPixels)))
    for (let channel = 0; channel < 3; channel++)
      output[at + channel] = Math.round(base[at + channel] * (1 - alpha)
        + donor[at + channel] * alpha)
    if (output[at] !== base[at] || output[at + 1] !== base[at + 1]
      || output[at + 2] !== base[at + 2]) {
      changedPixels++
      minX = Math.min(minX, x); minY = Math.min(minY, y)
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
      if (!containing.length) outsideAllowedChangedPixels++
    }
  }
  if (changedPixels < 50_000 || outsideAllowedChangedPixels)
    fail('wall edit absent or escaped the signed polygons')
  const pngBytes = await sharp(output,
    { raw: { width: 1536, height: 864, channels: 3 } })
    .png({ compressionLevel: 9 }).toBuffer()
  if (sha(pngBytes) !== EXPECTED.output || changedPixels !== 81561)
    fail('selected wall candidate bytes changed')
  return {
    pngBytes, outputSha256: sha(pngBytes),
    algorithmId: A8B6_LOCAL_V5_PIXEL_ALGORITHM_ID,
    algorithmParameters: A8B6_LOCAL_V5_PIXEL_PARAMETERS,
    sourceSha256s: [EXPECTED.base, EXPECTED.donor],
    allowedRegions: [{ role: 'wall', polygons }],
    pixelProof: { changedPixels, outsideAllowedChangedPixels,
      changedBounds: { minX, minY, maxX, maxY } },
    provenance: { imageGen: { wall: {
      tool: manifest.tool,
      transparentBackground: manifest.transparentBackground,
      prompt: manifest.prompt, promptSha256: sha(manifest.prompt),
      references: [{ path: FILES.base, sha256: EXPECTED.base,
        identityAuthority: false }],
      rawOutput: { path: FILES.donor, sha256: EXPECTED.donor,
        width: donorMeta.width, height: donorMeta.height },
    } } },
  }
}
