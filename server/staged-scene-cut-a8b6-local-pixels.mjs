/** Deterministic, read-only reproduction of the approved QA face ROI candidate.
 * The image remains unapproved until a separate model review and frame gate. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

export const A8B6_LOCAL_PIXEL_ALGORITHM_ID = 'v7-v4-face-feather-tone-v1'
export const A8B6_LOCAL_PIXEL_PARAMETERS = Object.freeze({
  face: { centerX: 1082, centerY: 165, radiusX: 69, radiusY: 73,
    opaqueWithinNormalizedRadius: .78, sourceOffsetX: 1, sourceOffsetY: 1 },
  beard: { centerX: 1064, centerY: 207, radiusX: 46, radiusY: 36,
    yMax: 233, opaqueWithinNormalizedRadius: .7 },
  forehead: { centerX: 1071, centerY: 135, radiusX: 45, radiusY: 18 },
  eye: { centerX: 1060, centerY: 159, radiusX: 35, radiusY: 10 },
  blurSigma: .7, skinMixMax: .14, beardMixMax: .8,
  beardLumaReduction: .17, beardChromaOffset: [2, -1, -3],
  stage1Sha256: 'a6fe284d9e1a047fc341f927dbca299f640d4b92fcec98fcd6bb47d2c10b6165',
  outputSha256: 'f0c8fcc82fae74e8d736bb5e099471a799280db5e7b9d64b4e149efc26314ba1',
})
const fail = reason => { throw Error(`A8B6_LOCAL_PIXELS_INVALID: ${reason}`) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const clamp = value => Math.max(0, Math.min(1, value))
const smoothstep = value => { const t = clamp(value); return t * t * (3 - 2 * t) }
const rawRgb = async bytes => sharp(bytes, { failOn: 'error',
  limitInputPixels: 2_000_000 }).removeAlpha().raw()
  .toBuffer({ resolveWithObject: true })

export async function renderA8B6LocalFirstFrameBytes(baseBytes, donorBytes) {
  const base = await rawRgb(baseBytes), donor = await rawRgb(donorBytes)
  if (base.info.width !== 1536 || base.info.height !== 864
    || base.info.channels !== 3 || donor.info.width !== base.info.width
    || donor.info.height !== base.info.height || donor.info.channels !== 3)
    fail('source dimensions changed')
  const { width, height } = base.info
  const face = A8B6_LOCAL_PIXEL_PARAMETERS.face
  const lumaAt = (data, x, y) => {
    const offset = (y * width + x) * 3
    return .2126 * data[offset] + .7152 * data[offset + 1]
      + .0722 * data[offset + 2]
  }
  const registration = []
  for (let oy = -12; oy <= 12; oy++) for (let ox = -5; ox <= 30; ox++) {
    let sum = 0, n = 0
    for (let y = 105; y < 205; y += 2) for (let x = 1035; x < 1145; x += 2) {
      sum += Math.abs(lumaAt(base.data, x, y)
        - lumaAt(donor.data, x + ox, y + oy))
      n++
    }
    registration.push({ sourceOffsetX: ox, sourceOffsetY: oy,
      meanAbsoluteLumaDifference: sum / n })
  }
  registration.sort((a, b) => a.meanAbsoluteLumaDifference
    - b.meanAbsoluteLumaDifference)
  if (registration[0].sourceOffsetX !== face.sourceOffsetX
    || registration[0].sourceOffsetY !== face.sourceOffsetY)
    fail('donor face alignment no longer matches the signed source')
  const stage1Raw = Buffer.from(base.data)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const r = Math.hypot((x - face.centerX) / face.radiusX,
      (y - face.centerY) / face.radiusY)
    if (r >= 1) continue
    const alpha = r <= face.opaqueWithinNormalizedRadius ? 1
      : smoothstep((1 - r) / (1 - face.opaqueWithinNormalizedRadius))
    const sourceX = x + face.sourceOffsetX
    const sourceY = y + face.sourceOffsetY
    const dst = (y * width + x) * 3
    const src = (sourceY * width + sourceX) * 3
    for (let channel = 0; channel < 3; channel++)
      stage1Raw[dst + channel] = Math.round(base.data[dst + channel]
        * (1 - alpha) + donor.data[src + channel] * alpha)
  }
  const stage1Bytes = await sharp(stage1Raw,
    { raw: { width, height, channels: 3 } }).png({ compressionLevel: 9 })
    .toBuffer()
  if (hash(stage1Bytes) !== A8B6_LOCAL_PIXEL_PARAMETERS.stage1Sha256)
    fail('registered V4 face no longer reproduces the QA stage')
  const stage1 = await rawRgb(stage1Bytes)
  const blurred = await sharp(stage1Bytes).blur(.7).removeAlpha().raw()
    .toBuffer()
  const finalRaw = Buffer.from(stage1.data)
  const beard = A8B6_LOCAL_PIXEL_PARAMETERS.beard
  const forehead = A8B6_LOCAL_PIXEL_PARAMETERS.forehead
  const eye = A8B6_LOCAL_PIXEL_PARAMETERS.eye
  let changedPixels = 0, outsideAllowedChangedPixels = 0
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 3
    const beardRadius = Math.hypot((x - beard.centerX) / beard.radiusX,
      (y - beard.centerY) / beard.radiusY)
    const faceRadius = Math.hypot((x - face.centerX) / face.radiusX,
      (y - face.centerY) / face.radiusY)
    if (faceRadius < 1 && beardRadius < 1 && y <= beard.yMax) {
      const red = stage1.data[index], green = stage1.data[index + 1]
      const blue = stage1.data[index + 2]
      const luma = .2126 * red + .7152 * green + .0722 * blue
      const feather = beardRadius <= beard.opaqueWithinNormalizedRadius ? 1
        : smoothstep((1 - beardRadius)
          / (1 - beard.opaqueWithinNormalizedRadius))
      const hairLike = smoothstep((40 - (red - green)) / 20)
        * smoothstep((luma - 44) / 34)
        * (1 - smoothstep((luma - 160) / 20))
      const strength = feather * hairLike * .8
      for (let channel = 0; channel < 3; channel++) {
        const old = stage1.data[index + channel]
        finalRaw[index + channel] = Math.round(old * (1 - .17 * strength)
          + [2, -1, -3][channel] * strength)
      }
    }
    const foreheadRadius = Math.hypot((x - forehead.centerX)
      / forehead.radiusX, (y - forehead.centerY) / forehead.radiusY)
    const eyeRadius = Math.hypot((x - eye.centerX) / eye.radiusX,
      (y - eye.centerY) / eye.radiusY)
    const skinRegion = Math.max(foreheadRadius < 1 ? 1 - foreheadRadius : 0,
      eyeRadius < 1 ? 1 - eyeRadius : 0)
    if (faceRadius < 1 && skinRegion > 0) {
      const red = stage1.data[index], green = stage1.data[index + 1]
      const luma = .2126 * red + .7152 * green
        + .0722 * stage1.data[index + 2]
      const skin = smoothstep(((red - green) - 24) / 18)
        * smoothstep((luma - 80) / 30)
      const strength = .14 * smoothstep(skinRegion * 3) * skin
      if (strength > 0) for (let channel = 0; channel < 3; channel++) {
        const previous = finalRaw[index + channel]
        finalRaw[index + channel] = Math.round(previous * (1 - strength)
          + blurred[index + channel] * strength)
      }
    }
    if (finalRaw[index] !== base.data[index]
      || finalRaw[index + 1] !== base.data[index + 1]
      || finalRaw[index + 2] !== base.data[index + 2]) {
      changedPixels++
      minX = Math.min(minX, x); minY = Math.min(minY, y)
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
      if (faceRadius >= 1) outsideAllowedChangedPixels++
    }
  }
  const outputBytes = await sharp(finalRaw,
    { raw: { width, height, channels: 3 } }).png({ compressionLevel: 9 })
    .toBuffer()
  const outputSha256 = hash(outputBytes)
  if (outputSha256 !== A8B6_LOCAL_PIXEL_PARAMETERS.outputSha256
    || changedPixels !== 14947 || outsideAllowedChangedPixels !== 0)
    fail('local final pixels differ from the selected QA candidate')
  return { outputBytes, outputSha256,
    algorithm: { id: A8B6_LOCAL_PIXEL_ALGORITHM_ID,
      parameters: A8B6_LOCAL_PIXEL_PARAMETERS },
    allowedRegions: [{ type: 'ellipse', centerX: face.centerX,
      centerY: face.centerY, radiusX: face.radiusX,
      radiusY: face.radiusY }],
    pixelProof: { changedPixels, outsideAllowedChangedPixels,
      changedBounds: { minX, minY, maxX, maxY } },
    registration: registration.slice(0, 5) }
}

export async function renderA8B6LocalFirstFrame(root = process.cwd()) {
  const sources = [
    { filename: 'image-b96d9804eb28771cbe2cc2d5d6edc532.png',
      sha256: 'b96d9804eb28771cbe2cc2d5d6edc532ab3275abcbc71a4155e2da6d05b782be' },
    { filename: 'image-6732c53b6900c5de13f3b22ee070c5a7.png',
      sha256: '6732c53b6900c5de13f3b22ee070c5a701042c529e701cec3ce0dd3d578dd7aa' },
  ]
  const bytes = sources.map(source => readFileSync(path.join(root,
    'public/generated', source.filename)))
  if (bytes.some((value, index) => hash(value) !== sources[index].sha256))
    fail('V7 layout or V4 donor source bytes changed')
  const rendered = await renderA8B6LocalFirstFrameBytes(bytes[0], bytes[1])
  return { ...rendered, pngBytes: rendered.outputBytes,
    algorithmId: rendered.algorithm.id,
    algorithmParameters: rendered.algorithm.parameters,
    sourceSha256s: sources.map(source => source.sha256) }
}
