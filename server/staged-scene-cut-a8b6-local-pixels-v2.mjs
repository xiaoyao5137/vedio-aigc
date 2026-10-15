/** Deterministic replay of the selected V7 + image_gen face-region QA image.
 * The output is a candidate only; workflow node49/50 must still review it. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

export const A8B6_LOCAL_V2_PIXEL_ALGORITHM_ID =
  'v7-imagegen-face-two-roi-v2'
export const A8B6_LOCAL_V2_PIXEL_PARAMETERS = Object.freeze({
  crop: { left: 940, top: 35, width: 285, height: 285 },
  polygons: [
    [[1060, 103], [1098, 103], [1125, 117], [1146, 146],
      [1144, 171], [1129, 193], [1105, 209], [1078, 219],
      [1048, 212], [1027, 194], [1017, 166], [1023, 138],
      [1039, 116]],
    [[1038, 178], [1096, 174], [1112, 194], [1105, 218],
      [1089, 240], [1063, 250], [1038, 239], [1017, 222],
      [1007, 205], [1018, 186]],
  ],
  featherPixels: 8,
  outputSha256: '63a701c1c4b38ae9fa04c450d13b8089b3220977ea2df55d86061c7a75e1d0f5',
})

export const A8B6_LOCAL_V2_IMAGEGEN_PROMPT =
  'Edit IMAGE 1 as a photorealistic film still crop. IMAGE 1 defines the exact camera view, head position, three-quarter leftward pose, gaze, lighting, crown/headwear, hair silhouette, robe collar, shoulders, depth of field, and ancient Jiangzhou street background. IMAGE 2 is the authoritative identity reference for Yan Yan, the same historical character. Redraw only the central man\'s facial anatomy and beard in IMAGE 1 to match IMAGE 2: narrower cheeks and jaw, mature but not heavily aged forehead and under-eye skin, same brow, eye, nose and mouth identity, a narrower pointed dark-brown chin beard with only the sparse natural gray strands visible in IMAGE 2. Adapt the authoritative front view naturally to IMAGE 1\'s three-quarter angle. Keep the face in precisely the same position and scale. Preserve all pixels outside the face as closely as possible: crown, hair, ears, neck, clothing, street, light and framing. No new person, no text, no watermark, no explanatory marks, no collage.'

export const A8B6_LOCAL_V2_SOURCE_FILES = Object.freeze({
  base: { path: 'public/generated/image-b96d9804eb28771cbe2cc2d5d6edc532.png',
    sha256: 'b96d9804eb28771cbe2cc2d5d6edc532ab3275abcbc71a4155e2da6d05b782be' },
  imageGenRaw: { path: 'qa/staged-scene-cut/yan-imagegen-v2-raw-1494cbd3.png',
    sha256: '1494cbd3acc592bdf181723115fdb653215c95071b35e8424f9d360c9769b4df' },
  targetReference: { path: 'qa/staged-scene-cut/yan-target-local-crop-v2.png',
    sha256: 'a83ec5cf62e48a2ad233dc6cd8fd3abcb4fefb721e100fab4e17799707b17781' },
  identityReference: { path: 'qa/staged-scene-cut/yan-frozen-tight-face-v2b.png',
    sha256: 'a2f4027597899d9a6bdd2468d2a730c26198b02dec94fc52a2541dff7d476640' },
  identityBoard: { path: 'public/generated/scene-cut-front-55c299bd043eb89664e44cc18e00caccd8c5ac9f61c2ea6e0eb9b463f191000c.jpg',
    sha256: '55c299bd043eb89664e44cc18e00caccd8c5ac9f61c2ea6e0eb9b463f191000c' },
})

const fail = reason => { throw Error(`A8B6_LOCAL_V2_PIXELS_INVALID: ${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const smooth = value => {
  const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t)
}
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
const readPinned = (root, spec) => {
  const bytes = readFileSync(path.join(root, spec.path))
  if (sha(bytes) !== spec.sha256) fail(`${spec.path} bytes changed`)
  return bytes
}

export async function renderA8B6LocalFirstFrameV2(root = process.cwd()) {
  const files = A8B6_LOCAL_V2_SOURCE_FILES
  const baseBytes = readPinned(root, files.base)
  const donorBytes = readPinned(root, files.imageGenRaw)
  readPinned(root, files.targetReference)
  readPinned(root, files.identityReference)
  const identityBoardBytes = readPinned(root, files.identityBoard)
  const targetCrop = { left: 940, top: 35, width: 285, height: 285 }
  const identityCrop = { left: 125, top: 65, width: 180, height: 195 }
  const targetReference = await sharp(baseBytes).extract(targetCrop)
    .resize(1024, 1024).png().toBuffer()
  const identityReference = await sharp(identityBoardBytes).extract(identityCrop)
    .resize(945, 1024).png().toBuffer()
  if (sha(targetReference) !== files.targetReference.sha256
    || sha(identityReference) !== files.identityReference.sha256)
    fail('image_gen reference images no longer derive from pinned sources')
  const { crop, polygons, featherPixels } = A8B6_LOCAL_V2_PIXEL_PARAMETERS
  const base = await sharp(baseBytes).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true })
  const donor = await sharp(donorBytes).resize(crop.width, crop.height,
    { kernel: 'lanczos3' }).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true })
  if (base.info.width !== 1536 || base.info.height !== 864
    || base.info.channels !== 3 || donor.info.width !== crop.width
    || donor.info.height !== crop.height || donor.info.channels !== 3)
    fail('source dimensions changed')
  const output = Buffer.from(base.data)
  let changedPixels = 0, outsideAllowedChangedPixels = 0
  let minX = 1536, minY = 864, maxX = -1, maxY = -1
  for (let y = crop.top; y < crop.top + crop.height; y++) {
    for (let x = crop.left; x < crop.left + crop.width; x++) {
      const px = x + .5, py = y + .5
      const alpha = Math.max(...polygons.map(polygon =>
        inside(polygon, px, py)
          ? smooth(boundaryDistance(polygon, px, py) / featherPixels) : 0))
      const donorIndex = ((y - crop.top) * crop.width + x - crop.left) * 3
      const baseIndex = (y * 1536 + x) * 3
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
          outsideAllowedChangedPixels++
      }
    }
  }
  const pngBytes = await sharp(output,
    { raw: { width: 1536, height: 864, channels: 3 } })
    .png({ compressionLevel: 9 }).toBuffer()
  const outputSha256 = sha(pngBytes)
  if (outputSha256 !== A8B6_LOCAL_V2_PIXEL_PARAMETERS.outputSha256
    || changedPixels !== 13206 || outsideAllowedChangedPixels !== 0)
    fail('selected QA pixels changed')
  return { pngBytes, outputSha256,
    algorithmId: A8B6_LOCAL_V2_PIXEL_ALGORITHM_ID,
    algorithmParameters: A8B6_LOCAL_V2_PIXEL_PARAMETERS,
    sourceSha256s: [files.base.sha256, files.imageGenRaw.sha256],
    allowedRegions: polygons.map(points => ({ type: 'polygon', points })),
    pixelProof: { changedPixels, outsideAllowedChangedPixels,
      changedBounds: { minX, minY, maxX, maxY } },
    provenance: { tool: 'image_gen__imagegen',
      transparentBackground: false,
      prompt: A8B6_LOCAL_V2_IMAGEGEN_PROMPT,
      promptSha256: sha(A8B6_LOCAL_V2_IMAGEGEN_PROMPT),
      references: [
        { ...files.targetReference, role: 'target-camera-layout',
          identityAuthority: false, sourceSha256: files.base.sha256,
          crop: targetCrop, resizedTo: { width: 1024, height: 1024 } },
        { ...files.identityReference, role: 'frozen-Yan-identity',
          identityAuthority: true,
          sourceSha256: files.identityBoard.sha256,
          crop: identityCrop, resizedTo: { width: 945, height: 1024 } },
      ],
      identityBoard: files.identityBoard,
      rawOutput: { ...files.imageGenRaw,
        originalToolOutputPath:
          '/Users/xianjiaqi/.codex/generated_images/01a0e853-2253-7251-ad19-e24ce23b0a79/exec-bbfea402-a079-430d-867d-cc1fbf9cdcae.png' } } }
}
