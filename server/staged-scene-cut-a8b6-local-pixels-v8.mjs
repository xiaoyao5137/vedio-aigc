/** Deterministic local wall continuation over the signed, rejected V7 frame.
 * Foreground and every pixel outside the three wall polygons remain V7 bytes. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

export const A8B6_LOCAL_V8_PIXEL_ALGORITHM_ID =
  'v7-rejected-frame-three-wall-polygons-v8'
export const A8B6_LOCAL_V8_PIXEL_PARAMETERS = Object.freeze({
  outputWidth: 1536, outputHeight: 864,
  donorResizeKernel: 'lanczos3', featherPixels: 11,
  polygons: [
    [[1218, 0], [1310, 0], [1321, 130], [1321, 270], [1315, 370], [1315, 605], [1233, 605], [1231, 370], [1218, 270]],
    [[899, 89], [967, 89], [967, 174], [951, 193], [945, 337], [915, 333], [899, 243]],
    [[706, 182], [746, 182], [747, 248], [731, 266], [706, 266]],
  ],
})

const FILES = Object.freeze({
  base: 'public/generated/image-6b7e52ceccf7493bbb1a473ab4e0f682.png',
  donor: 'qa/staged-scene-cut/wall-imagegen-v8-full-raw.png',
  manifest: 'qa/staged-scene-cut/v8-wall-imagegen-prompt.json',
})
const EXPECTED = Object.freeze({
  base: '6b7e52ceccf7493bbb1a473ab4e0f68216aa65ae02c03945de5bc69fb52a6c71',
  donor: '3e185620ce34d0d98af75b032a1b1db9c15cd51cf649cbdcbab1ab3f180e4cc6',
  output: '8149dea0eb98744508ac0615d37d70dcede1d8859c25c0edf301909748a4fb90',
})
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = reason => { throw Error(`A8B6_LOCAL_V8_PIXELS_INVALID: ${reason}`) }
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

export async function renderA8B6LocalFirstFrameV8(root = process.cwd()) {
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
    { kernel: A8B6_LOCAL_V8_PIXEL_PARAMETERS.donorResizeKernel,
      fit: 'fill' }).removeAlpha().raw().toBuffer()
  if (base.length !== 1536 * 864 * 3 || donor.length !== base.length)
    fail('decoded source shape changed')
  const output = Buffer.from(base)
  const { polygons, featherPixels } = A8B6_LOCAL_V8_PIXEL_PARAMETERS
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
  if (changedPixels < 10_000 || outsideAllowedChangedPixels)
    fail('wall edit absent or escaped the signed polygons')
  const pngBytes = await sharp(output,
    { raw: { width: 1536, height: 864, channels: 3 } })
    .png({ compressionLevel: 9 }).toBuffer()
  if (sha(pngBytes) !== EXPECTED.output || changedPixels !== 69358)
    fail('selected wall candidate bytes changed')
  return {
    pngBytes, outputSha256: sha(pngBytes),
    algorithmId: A8B6_LOCAL_V8_PIXEL_ALGORITHM_ID,
    algorithmParameters: A8B6_LOCAL_V8_PIXEL_PARAMETERS,
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
