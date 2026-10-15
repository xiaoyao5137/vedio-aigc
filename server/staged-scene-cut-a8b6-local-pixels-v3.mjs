/** Deterministic three-region V3 first-frame candidate. This is not an
 * approval: the new workflow child must independently pass nodes 49 and 50. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

export const A8B6_LOCAL_V3_PIXEL_ALGORITHM_ID =
  'v2-wall-gate-face-three-rois-v3'
export const A8B6_LOCAL_V3_REGION_ROLES =
  Object.freeze(['wall', 'gate-frame', 'yan-face'])

const SHA = {
  base: '63a701c1c4b38ae9fa04c450d13b8089b3220977ea2df55d86061c7a75e1d0f5',
  wall: '3af90de3b8af4b87e484b7f576e4e84c22f9df4ff12de6b780ec3e35efc70f9a',
  face: 'ce9820011e1df7e5380c6d9270649a0c201e8edab80c8530c0e0fda45f2b1e9d',
  gateFrame: '89123113a9a0ff726542fd643c05c5b2992adcf570ba181ff58de63239338df2',
  wallReference: '2d8f0d15d87e84f7e29aeda9f0b2f4a9c6e564677b9c40e421eb3f8820273c0b',
  faceReference: '06bc5b4646bbea90a460fda0bc8a1a4ec4431a1930227a08db172d7e8d2fc0ef',
  yanBoard: '55c299bd043eb89664e44cc18e00caccd8c5ac9f61c2ea6e0eb9b463f191000c',
  yanReference: 'a2f4027597899d9a6bdd2468d2a730c26198b02dec94fc52a2541dff7d476640',
  prompts: '72e676c3fbf3a0a7e3b223eb8378cd0e08ccb77a75fe71573a94e04f64a28754',
  output: '7313b043adc16dc9fc7f6ee7512f2a377f8218e6e0fba11bea91ef943fc7fac7',
}
const FILES = {
  base: 'public/generated/image-63a701c1c4b38ae9fa04c450d13b8089.png',
  wall: 'qa/staged-scene-cut/wall-imagegen-v3-raw.png',
  face: 'qa/staged-scene-cut/yan-imagegen-v3b-raw.png',
  gateFrame: 'qa/staged-scene-cut/gate-imagegen-v3-raw.png',
  wallReference: 'qa/staged-scene-cut/wall-target-local-crop-v3.png',
  faceReference: 'qa/staged-scene-cut/yan-target-local-crop-v3.png',
  yanBoard: 'public/generated/scene-cut-front-55c299bd043eb89664e44cc18e00caccd8c5ac9f61c2ea6e0eb9b463f191000c.jpg',
  yanReference: 'qa/staged-scene-cut/yan-frozen-tight-face-v2b.png',
  prompts: 'qa/staged-scene-cut/v3-imagegen-prompts.json',
}
const sha = value => createHash('sha256').update(value).digest('hex')
const fail = reason => { throw Error(`A8B6_LOCAL_V3_PIXELS_INVALID: ${reason}`) }
const readPinned = (root, key) => {
  const bytes = readFileSync(path.join(root, FILES[key]))
  if (sha(bytes) !== SHA[key]) fail(`${key} bytes changed`)
  return bytes
}

export const A8B6_LOCAL_V3_PIXEL_PARAMETERS = Object.freeze({
  outputSha256: SHA.output,
  edits: [
    { role: 'wall', source: 'wall',
      crop: { left: 430, top: 0, width: 704, height: 704 },
      featherPixels: 10, polygons: [
        [[420, 93], [496, 91], [541, 94], [565, 106], [781, 111],
          [824, 98], [898, 98], [936, 125], [928, 160],
          [904, 181], [876, 204], [859, 189], [858, 150],
          [840, 145], [774, 145], [750, 175], [563, 178],
          [557, 265], [516, 317], [478, 317], [477, 169],
          [441, 167], [420, 160]],
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
    { role: 'gate-frame', source: 'gateFrame',
      crop: { left: 430, top: 0, width: 704, height: 704 },
      featherPixels: 6, polygons: [
        [[543, 158], [741, 158], [747, 168], [747, 198],
          [739, 201], [547, 201], [540, 194], [540, 168]],
        [[545, 188], [573, 188], [574, 314], [556, 327],
          [542, 321]],
        [[723, 188], [748, 188], [747, 251], [735, 268],
          [722, 253]],
      ] },
    { role: 'yan-face', source: 'face',
      crop: { left: 940, top: 35, width: 285, height: 285 },
      featherPixels: 8, polygons: [
        [[1060, 103], [1098, 103], [1125, 117], [1146, 146],
          [1144, 171], [1129, 193], [1105, 209], [1078, 219],
          [1048, 212], [1027, 194], [1017, 166], [1023, 138],
          [1039, 116]],
        [[1038, 178], [1096, 174], [1112, 194], [1105, 218],
          [1089, 240], [1063, 250], [1038, 239], [1017, 222],
          [1007, 205], [1018, 186]],
      ] },
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
    nearest = Math.min(nearest,
      Math.hypot(px - (ax + vx * t), py - (ay + vy * t)))
  }
  return nearest
}
const smooth = value => {
  const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t)
}

async function verifyReferences(bytes) {
  const wall = await sharp(bytes.base).extract({ left: 430, top: 0,
    width: 704, height: 704 }).resize(1024, 1024).png().toBuffer()
  const face = await sharp(bytes.base).extract({ left: 940, top: 35,
    width: 285, height: 285 }).resize(1024, 1024).png().toBuffer()
  const yan = await sharp(bytes.yanBoard).extract({ left: 125, top: 65,
    width: 180, height: 195 }).resize(945, 1024).png().toBuffer()
  if (sha(wall) !== SHA.wallReference || sha(face) !== SHA.faceReference
    || sha(yan) !== SHA.yanReference
    || !wall.equals(bytes.wallReference)
    || !face.equals(bytes.faceReference)
    || !yan.equals(bytes.yanReference))
    fail('image_gen references no longer derive from V2 and frozen Yan board')
}

function imageGenProvenance(manifest) {
  const expected = {
    wall: { references: [FILES.wallReference], raw: FILES.wall },
    face: { references: [FILES.faceReference, FILES.yanReference],
      raw: FILES.face },
    gate: { references: [FILES.wall], raw: FILES.gateFrame },
  }
  for (const [key, spec] of Object.entries(expected)) {
    const item = manifest[key]
    if (!item || !Array.isArray(item.references)
      || JSON.stringify(item.references) !== JSON.stringify(spec.references)
      || item.raw !== spec.raw || typeof item.prompt !== 'string'
      || !item.prompt.trim()) fail(`${key} prompt or references changed`)
  }
  const ref = (key, source, crop, resizedTo, identityAuthority) => ({
    path: FILES[key], sha256: SHA[key], sourceSha256: SHA[source],
    ...(crop ? { crop, resizedTo } : {}), identityAuthority,
  })
  const make = (key, references, rawKey) => ({
    tool: 'image_gen__imagegen', transparentBackground: false,
    prompt: manifest[key].prompt, promptSha256: sha(manifest[key].prompt),
    references,
    rawOutput: { path: FILES[rawKey], sha256: SHA[rawKey] },
  })
  return { imageGen: {
    wall: make('wall', [ref('wallReference', 'base',
      { left: 430, top: 0, width: 704, height: 704 },
      { width: 1024, height: 1024 }, false)], 'wall'),
    face: make('face', [
      ref('faceReference', 'base',
        { left: 940, top: 35, width: 285, height: 285 },
        { width: 1024, height: 1024 }, false),
      ref('yanReference', 'yanBoard',
        { left: 125, top: 65, width: 180, height: 195 },
        { width: 945, height: 1024 }, true),
    ], 'face'),
    gateFrame: make('gate', [ref('wall', 'wall', null, null, false)],
      'gateFrame'),
  } }
}

export async function renderA8B6LocalFirstFrameV3(root = process.cwd()) {
  const bytes = Object.fromEntries(Object.keys(FILES)
    .map(key => [key, readPinned(root, key)]))
  await verifyReferences(bytes)
  const manifest = JSON.parse(bytes.prompts.toString('utf8'))
  const base = await sharp(bytes.base).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true })
  if (base.info.width !== 1536 || base.info.height !== 864
    || base.info.channels !== 3) fail('V2 base dimensions changed')
  const output = Buffer.from(base.data)
  const edits = A8B6_LOCAL_V3_PIXEL_PARAMETERS.edits
  for (const edit of edits) {
    const { crop, source, polygons, featherPixels } = edit
    const donor = await sharp(bytes[source]).resize(crop.width, crop.height,
      { kernel: 'lanczos3' }).removeAlpha().raw()
      .toBuffer({ resolveWithObject: true })
    if (donor.info.width !== crop.width
      || donor.info.height !== crop.height || donor.info.channels !== 3)
      fail(`${source} dimensions changed`)
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
    if (!edits.some(edit => edit.polygons.some(polygon =>
      inside(polygon, x + .5, y + .5)))) outsideAllowedChangedPixels++
  }
  if (outputSha256 !== SHA.output || changedPixels !== 77888
    || outsideAllowedChangedPixels !== 0) fail('selected V3 QA pixels changed')
  return { pngBytes, outputSha256,
    algorithmId: A8B6_LOCAL_V3_PIXEL_ALGORITHM_ID,
    algorithmParameters: A8B6_LOCAL_V3_PIXEL_PARAMETERS,
    sourceSha256s: [SHA.base, SHA.wall, SHA.face, SHA.gateFrame],
    allowedRegions: edits.map(({ role, polygons }) => ({ role, polygons })),
    pixelProof: { changedPixels, outsideAllowedChangedPixels,
      changedBounds: { minX, minY, maxX, maxY } },
    provenance: imageGenProvenance(manifest) }
}
