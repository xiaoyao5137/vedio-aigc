import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { archiveCoverageImage } from './coverage-cut-frame-storage.ts'
import { extractThreeViewPanel } from './image-references.ts'
import { deriveSceneCutEllipsisProof } from './scene-cut-ellipsis-proof.ts'

type Value = Record<string, unknown>
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const fail = (message: string): never => { throw Error(`SCENE_CUT_SOURCE_INVALID: ${message}`) }

/** One reference per actor: two partial crops preserve both identity and the
 * lower garment, without showing the full neutral standing pose. */
export async function buildSceneCutIdentityPlate(sourceBytes: Buffer,
  layout?: 'horizontal-three-view' | 'vertical-three-view' | 'single-portrait') {
  const metadata = await sharp(sourceBytes, { failOn: 'error' }).metadata()
  const inferredLayout = layout ?? (metadata.width && metadata.height
    && metadata.width / metadata.height >= 1.5 ? 'horizontal-three-view' : 'single-portrait')
  if (inferredLayout === 'horizontal-three-view' && (!metadata.width || !metadata.height
      || metadata.width / metadata.height < 1.5)
    || inferredLayout === 'vertical-three-view' && (!metadata.width || !metadata.height
      || metadata.height / metadata.width < 1.5)) fail('三视图布局与归档资产尺寸不一致')
  const front = inferredLayout !== 'single-portrait'
    ? await extractThreeViewPanel(`data:image/${metadata.format};base64,${sourceBytes.toString('base64')}`, 'front')
    : `data:image/${metadata.format};base64,${sourceBytes.toString('base64')}`
  const frontBytes = Buffer.from(front.slice(front.indexOf(',') + 1), 'base64')
  const frontMetadata = await sharp(frontBytes, { failOn: 'error' }).metadata()
  const width = frontMetadata.width ?? 0, height = frontMetadata.height ?? 0
  if (width < 64 || height < 64) fail('正面人设尺寸过小，无法冻结衣摆与上装')
  const topHeight = Math.min(height, Math.max(64, Math.round(height * 0.58)))
  const lowerStart = Math.min(height - 64, Math.round(height * 0.48))
  const upper = await sharp(frontBytes).extract({ left: 0, top: 0, width, height: topHeight })
    .resize(320, 512, { fit: 'contain', background: '#f5f4ef', withoutEnlargement: true })
    .jpeg({ quality: 88 }).toBuffer()
  const lower = await sharp(frontBytes).extract({ left: 0, top: lowerStart,
    width, height: height - lowerStart })
    .resize(320, 512, { fit: 'contain', background: '#f5f4ef', withoutEnlargement: true })
    .jpeg({ quality: 88 }).toBuffer()
  const plate = await sharp({ create: { width: 640, height: 512, channels: 3,
    background: '#f5f4ef' } }).composite([
    { input: upper, left: 0, top: 0 }, { input: lower, left: 320, top: 0 },
  ]).jpeg({ quality: 88 }).toBuffer()
  return { plate, layout: inferredLayout, upperSha256: sha256(upper), lowerSha256: sha256(lower) }
}

/** Four local details from one frozen actor. No tile contains a complete
 * upright torso or full standing silhouette, while the robe/boot ratio stays
 * available to the image model. The original sheet remains the review source. */
export async function buildSceneCutIdentityPlateV3(sourceBytes: Buffer,
  layout?: 'horizontal-three-view' | 'vertical-three-view' | 'single-portrait') {
  const metadata = await sharp(sourceBytes, { failOn: 'error' }).metadata()
  const inferredLayout = layout ?? (metadata.width && metadata.height
    && metadata.width / metadata.height >= 1.5 ? 'horizontal-three-view' : 'single-portrait')
  if (inferredLayout === 'horizontal-three-view' && (!metadata.width || !metadata.height
      || metadata.width / metadata.height < 1.5)
    || inferredLayout === 'vertical-three-view' && (!metadata.width || !metadata.height
      || metadata.height / metadata.width < 1.5)) fail('三视图布局与归档资产尺寸不一致')
  const front = inferredLayout !== 'single-portrait'
    ? await extractThreeViewPanel(`data:image/${metadata.format};base64,${sourceBytes.toString('base64')}`, 'front')
    : `data:image/${metadata.format};base64,${sourceBytes.toString('base64')}`
  const frontBytes = Buffer.from(front.slice(front.indexOf(',') + 1), 'base64')
  const frontMetadata = await sharp(frontBytes, { failOn: 'error' }).metadata()
  const width = frontMetadata.width ?? 0, height = frontMetadata.height ?? 0
  if (width < 64 || height < 64) fail('正面人设尺寸过小，无法冻结局部服装')
  const regions = [
    { name: 'faceAndHeadwear', x: 0.20, y: 0.015, w: 0.60, h: 0.27 },
    { name: 'collarAndArmor', x: 0.16, y: 0.24, w: 0.68, h: 0.26 },
    { name: 'beltAndOuterHem', x: 0.15, y: 0.50, w: 0.70, h: 0.31 },
    { name: 'innerHemAndBoots', x: 0.18, y: 0.75, w: 0.64, h: 0.245 },
  ] as const
  const tiles: Buffer[] = []
  const partSha256s: Record<string, string> = {}
  for (const region of regions) {
    const left = Math.floor(width * region.x), top = Math.floor(height * region.y)
    const crop = await sharp(frontBytes).extract({ left, top,
      width: Math.max(1, Math.min(width - left, Math.ceil(width * region.w))),
      height: Math.max(1, Math.min(height - top, Math.ceil(height * region.h))) })
      .resize(320, 320, { fit: 'contain', background: '#f5f4ef', withoutEnlargement: true })
      .jpeg({ quality: 88 }).toBuffer()
    tiles.push(crop)
    partSha256s[region.name] = sha256(crop)
  }
  const plate = await sharp({ create: { width: 640, height: 640, channels: 3,
    background: '#f5f4ef' } }).composite([
    { input: tiles[0], left: 0, top: 0 }, { input: tiles[1], left: 320, top: 0 },
    { input: tiles[2], left: 0, top: 320 }, { input: tiles[3], left: 320, top: 320 },
  ]).jpeg({ quality: 88 }).toBuffer()
  return { plate, layout: inferredLayout, partSha256s }
}

/** Keep the garment silhouette on one scale. The upper tiles identify the
 * actor; the uninterrupted lower crop preserves belt, both hems and boots in
 * their original vertical proportions without showing a full standing pose. */
export async function buildSceneCutIdentityPlateV4(sourceBytes: Buffer,
  layout?: 'horizontal-three-view' | 'vertical-three-view' | 'single-portrait') {
  const metadata = await sharp(sourceBytes, { failOn: 'error' }).metadata()
  const inferredLayout = layout ?? (metadata.width && metadata.height
    && metadata.width / metadata.height >= 1.5 ? 'horizontal-three-view' : 'single-portrait')
  if (inferredLayout === 'horizontal-three-view' && (!metadata.width || !metadata.height
      || metadata.width / metadata.height < 1.5)
    || inferredLayout === 'vertical-three-view' && (!metadata.width || !metadata.height
      || metadata.height / metadata.width < 1.5)) fail('三视图布局与归档资产尺寸不一致')
  const front = inferredLayout !== 'single-portrait'
    ? await extractThreeViewPanel(`data:image/${metadata.format};base64,${sourceBytes.toString('base64')}`, 'front')
    : `data:image/${metadata.format};base64,${sourceBytes.toString('base64')}`
  const frontBytes = Buffer.from(front.slice(front.indexOf(',') + 1), 'base64')
  const frontMetadata = await sharp(frontBytes, { failOn: 'error' }).metadata()
  const width = frontMetadata.width ?? 0, height = frontMetadata.height ?? 0
  if (width < 64 || height < 64) fail('正面人设尺寸过小，无法冻结连续衣摆')
  const regions = [
    { name: 'faceAndHeadwear', x: 0.20, y: 0.015, w: 0.60, h: 0.27, size: 320 },
    { name: 'collarAndArmor', x: 0.16, y: 0.24, w: 0.68, h: 0.26, size: 320 },
    { name: 'waistThroughBoots', x: 0.12, y: 0.36, w: 0.76, h: 0.635, size: 640 },
  ] as const
  const tiles: Buffer[] = []
  const partSha256s: Record<string, string> = {}
  for (const region of regions) {
    const left = Math.floor(width * region.x), top = Math.floor(height * region.y)
    const crop = await sharp(frontBytes).extract({ left, top,
      width: Math.max(1, Math.min(width - left, Math.ceil(width * region.w))),
      height: Math.max(1, Math.min(height - top, Math.ceil(height * region.h))) })
      .resize(region.size, region.size, { fit: 'contain', background: '#f5f4ef' })
      .jpeg({ quality: 88 }).toBuffer()
    tiles.push(crop)
    partSha256s[region.name] = sha256(crop)
  }
  const plate = await sharp({ create: { width: 640, height: 960, channels: 3,
    background: '#f5f4ef' } }).composite([
    { input: tiles[0], left: 0, top: 0 }, { input: tiles[1], left: 320, top: 0 },
    { input: tiles[2], left: 0, top: 320 },
  ]).jpeg({ quality: 88 }).toBuffer()
  return { plate, layout: inferredLayout, partSha256s }
}

/** Freeze selected identity sheets before image generation. Codex receives one
 * partial identity/costume plate per actor; video keeps the original sheets. */
export async function archiveSceneCutSources(input: { shot: unknown; referenceBindings: unknown;
  referenceImages: unknown; identityPlateVersion?: unknown;
  approvedOutline?: unknown; previous?: unknown; sceneCutBoundaryVersion?: unknown;
  acceptedRecordBinding?: unknown }, root = process.cwd()) {
  const shot = object(input?.shot)
  const continuity = object(shot.continuity)
  const characters = Array.isArray(shot.characters) ? shot.characters : []
  const bindings = Array.isArray(input?.referenceBindings) ? input.referenceBindings.map(object) : []
  const referenceImages = Array.isArray(input?.referenceImages) ? input.referenceImages : []
  const identityPlateVersion = input.identityPlateVersion ?? 'scene-cut-identity-plate-v2'
  if (shot.visualTreatment !== 'live_action' || continuity.mode !== 'scene_cut'
    || shot.firstFrameMode !== 'reference' || characters.some(name => typeof name !== 'string' || !name.trim())
    || bindings.length !== characters.length || bindings.length !== referenceImages.length
    || bindings.length > 5
    || new Set(bindings.map(binding => binding.characterName)).size !== bindings.length
    || characters.some(name => bindings.filter(binding => binding.characterName === name).length !== 1)
    || bindings.some((binding, index) => typeof binding.assetId !== 'string' || !binding.assetId
      || binding.url !== undefined && binding.url !== referenceImages[index])
    || referenceImages.some(url => typeof url !== 'string' || !url)
    || !['scene-cut-identity-plate-v2', 'scene-cut-identity-plate-v3',
      'scene-cut-identity-plate-v4'].includes(String(identityPlateVersion))) {
    fail('真人换场镜与所选人物资产不匹配，或超过 Codex 五图容量')
  }
  const boundary = input.sceneCutBoundaryVersion === 'scene-cut-approved-boundary-v1'
    ? deriveSceneCutEllipsisProof({ shot, approvedOutline: input.approvedOutline,
      previous: input.previous }, root) : undefined
  if (input.sceneCutBoundaryVersion !== undefined && !boundary)
    fail('换场大纲与前镜真实尾帧契约版本无效')
  if (boundary && object(input.acceptedRecordBinding).version !== 'scene-cut-source-ledger-v1')
    fail('缺少持久化大纲与分镜接受节点身份')
  const directory = path.join(root, 'public/generated')
  await mkdir(directory, { recursive: true })
  const archived = []
  const imageReferenceImages: string[] = []
  for (const [index, binding] of bindings.entries()) {
    const source = await archiveCoverageImage(String(referenceImages[index]), root)
    const bytes = await readFile(path.join(root, 'public', source.url))
    const requestedLayout = binding.referenceLayout
      ?? object(binding.metadata).referenceLayout
    if (requestedLayout !== undefined && !['horizontal-three-view', 'vertical-three-view',
      'single-portrait'].includes(String(requestedLayout))) fail('人物参考布局声明无效')
    const layoutArg = requestedLayout as 'horizontal-three-view' | 'vertical-three-view' | 'single-portrait' | undefined
    const plateResult = identityPlateVersion === 'scene-cut-identity-plate-v4'
      ? await buildSceneCutIdentityPlateV4(bytes, layoutArg)
      : identityPlateVersion === 'scene-cut-identity-plate-v3'
        ? await buildSceneCutIdentityPlateV3(bytes, layoutArg)
        : await buildSceneCutIdentityPlate(bytes, layoutArg)
    const { plate: jpeg, layout } = plateResult
    if (jpeg.length > 5 * 1024 * 1024) fail('身份参考 JPEG 超过 5MiB')
    const frontSha256 = sha256(jpeg)
    const frontUrl = `/generated/scene-cut-front-${frontSha256}.jpg`
    const filename = path.join(root, 'public', frontUrl)
    try { await writeFile(filename, jpeg, { flag: 'wx' }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
        || sha256(await readFile(filename)) !== frontSha256) throw error
    }
    archived.push({ ...binding, ...source, frontUrl, frontSha256,
      identityPlateVersion, referenceLayout: layout,
      ...('partSha256s' in plateResult ? { partSha256s: plateResult.partSha256s }
        : { upperSha256: plateResult.upperSha256, lowerSha256: plateResult.lowerSha256 }) })
    imageReferenceImages.push(`data:image/jpeg;base64,${jpeg.toString('base64')}`)
  }
  return { version: 'scene-cut-sources-v1', identityPlateVersion,
    shotId: shot.id, referenceBindings: archived,
    referenceImages: archived.map(binding => binding.url), imageReferenceImages,
    ...(boundary ? { ...boundary, sourceContext: {
      approvedOutline: input.approvedOutline, previous: input.previous,
      acceptedRecordBinding: input.acceptedRecordBinding } } : {}) }
}
