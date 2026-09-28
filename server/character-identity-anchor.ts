import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

type Point = { x: number; y: number }
type Face = { confidence: number; yaw: number; bounds: { x: number; y: number; width: number; height: number }; leftEye: Point[]; rightEye: Point[]; leftEyebrow: Point[]; rightEyebrow: Point[]; nose: Point[] }
type Detection = { detector: string; faces: Face[] }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const run = promisify(execFile)

async function detectFrontFace(file: string, root: string): Promise<Detection> {
  if (process.platform !== 'darwin') throw Error('FACIAL_IDENTITY_ANCHOR_UNAVAILABLE: 本机缺少macOS Vision人脸关键点检测能力；不能回退整图强参考，请配置可靠的离线人脸检测')
  try {
    const { stdout } = await run('/usr/bin/swift', [path.join(root, 'scripts/character-face-landmarks.swift'), file], { timeout: 45_000, maxBuffer: 1024 * 1024 })
    return JSON.parse(stdout) as Detection
  } catch (error) { throw Error('FACIAL_IDENTITY_ANCHOR_UNAVAILABLE: 离线人脸关键点检测失败；不能继续付费生成或回退整图', { cause: error }) }
}

/** Derive only eyebrows, eyes, nose and upper cheek structure. Hair, mouth,
 * beard, full body and costume are excluded from the generation reference. */
export async function prepareCharacterIdentityAnchor(input: { assetId: string; sourceUrl: string; snapshotUrl: string; sourceFingerprint: string }, options: { root?: string; detect?: (file: string, root: string) => Promise<Detection>; mode?: 'upper-face' | 'full-face' } = {}) {
  const mode = options.mode ?? 'upper-face'
  const root = options.root ?? process.cwd(), sourceFingerprint = hash(input.sourceUrl)
  const expectedSnapshot = `/generated/appearance-${sourceFingerprint.slice(0, 24)}.jpg`
  if (input.sourceFingerprint !== sourceFingerprint || input.snapshotUrl !== expectedSnapshot) throw Error('FACIAL_IDENTITY_ANCHOR_SOURCE_MISMATCH: 身份参考快照未与已核验原图指纹绑定')
  let bytes: Buffer
  try { bytes = await readFile(path.join(root, 'public', expectedSnapshot)) }
  catch (error) { throw Error('FACIAL_IDENTITY_ANCHOR_UNAVAILABLE: 已核验快照缺失，请先重新外观核验/读图', { cause: error }) }
  const snapshotFingerprint = hash(bytes), base = `/generated/identity-anchor-${snapshotFingerprint.slice(0, 24)}-${mode === 'full-face' ? 'full-face-v4' : 'v2'}`
  const anchorUrl = base + '.jpg', manifestPath = path.join(root, 'public', base + '.json')
  const version = mode === 'full-face' ? 'facial-identity-anchor-v4' : 'facial-identity-anchor-v2'
  const colorPolicy = mode === 'full-face' ? 'source-color-face' : 'geometry-only-grayscale'
  const scope = mode === 'full-face' ? 'full-face-identity-only' : 'upper-face-identity-only'
  const image = sharp(bytes, { failOn: 'error' }), dimensions = await image.metadata()
  const width = dimensions.width ?? 0, height = dimensions.height ?? 0
  if (width / height < 1.5 || width < 192 || height < 64) throw Error('FACIAL_IDENTITY_ANCHOR_UNAVAILABLE: 身份快照必须为可读的水平一行三视图，不能推测正面板')
  const panel = { left: 0, top: 0, width: Math.floor(width / 3), height }
  try {
    const cached = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    if (cached.version === version && cached.colorPolicy === colorPolicy && cached.scope === scope && cached.sourceSnapshotFingerprint === snapshotFingerprint && cached.sourceUriFingerprint === sourceFingerprint && cached.sourceSnapshotUrl === expectedSnapshot && cached.anchorUrl === anchorUrl && cached.detector === 'macos-vision-landmarks-v1') {
      const anchor = await readFile(path.join(root, 'public', anchorUrl))
      if (hash(anchor) === cached.anchorFingerprint) { await sharp(anchor).stats(); return { ...cached, sourceAssetId: input.assetId, anchorUrl } }
    }
  } catch { /* A missing/stale derived cache must be detected again, never guessed. */ }
  const temporary = await mkdtemp(path.join(tmpdir(), 'character-face-anchor-'))
  try {
    const front = path.join(temporary, 'front.png')
    await image.extract(panel).png().toFile(front)
    const result = await (options.detect ?? detectFrontFace)(front, root)
    if (result.detector !== 'macos-vision-landmarks-v1' || result.faces.length !== 1) throw Error('FACIAL_IDENTITY_ANCHOR_UNAVAILABLE: 正面板未检测到唯一可靠人脸，不能按人物名或固定位置猜裁切')
    const face = result.faces[0], regions = [face.leftEye, face.rightEye, face.leftEyebrow, face.rightEyebrow, face.nose]
    if (face.confidence < 0.7 || Math.abs(face.yaw) > 0.3 || regions.some(points => !Array.isArray(points) || points.length < 2)) throw Error('FACIAL_IDENTITY_ANCHOR_UNAVAILABLE: 人脸朝向/关键点置信不足，不能继续付费生成')
    const points = regions.flat()
    if (points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) throw Error('FACIAL_IDENTITY_ANCHOR_UNAVAILABLE: 人脸关键点超出图像')
    const center = (points: Point[]) => ({ x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length })
    const eyes = [center(face.leftEye), center(face.rightEye)], nose = center(face.nose)
    const eyeGap = Math.abs(eyes[1].x - eyes[0].x), eyeLevel = (eyes[0].y + eyes[1].y) / 2
    if (eyeGap * panel.width < 12 || Math.abs(eyes[0].y - eyes[1].y) > eyeGap * 0.35 || nose.y <= eyeLevel || nose.x < Math.min(...eyes.map(eye => eye.x)) || nose.x > Math.max(...eyes.map(eye => eye.x))) throw Error('FACIAL_IDENTITY_ANCHOR_UNAVAILABLE: 双眼与鼻部几何不可靠，不能猜测脸部骨相')
    const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x))
    const browTop = Math.min(...[...face.leftEyebrow, ...face.rightEyebrow].map(point => point.y)), noseBottom = Math.max(...face.nose.map(point => point.y))
    const fullFace = face.bounds
    const left = mode === 'full-face' ? Math.max(0, Math.floor((fullFace.x - fullFace.width * 0.38) * panel.width)) : Math.max(0, Math.floor((minX - eyeGap * 0.3) * panel.width))
    const right = mode === 'full-face' ? Math.min(panel.width, Math.ceil((fullFace.x + fullFace.width * 1.38) * panel.width)) : Math.min(panel.width, Math.ceil((maxX + eyeGap * 0.3) * panel.width))
    const top = mode === 'full-face' ? Math.max(0, Math.floor((fullFace.y - fullFace.height * 0.55) * panel.height)) : Math.max(0, Math.floor((browTop - eyeGap * 0.1) * panel.height))
    const bottom = mode === 'full-face' ? Math.min(panel.height, Math.ceil((fullFace.y + fullFace.height * 1.12) * panel.height)) : Math.min(panel.height, Math.ceil(noseBottom * panel.height))
    const crop = { left, top, width: right - left, height: bottom - top }
    if (crop.width < 24 || crop.height < 16 || crop.width > panel.width * 0.7 || crop.height > panel.height * 0.5) throw Error('FACIAL_IDENTITY_ANCHOR_UNAVAILABLE: 脸部局部范围不可靠，不能回退整张三视图')
    const cropped = sharp(bytes).extract(crop)
    const anchor = await (mode === 'full-face' ? cropped : cropped.grayscale()).resize({ width: 512, withoutEnlargement: false }).jpeg({ quality: 95 }).toBuffer()
    const manifest = { version, colorPolicy, detector: result.detector, sourceAssetId: input.assetId, sourceUriFingerprint: sourceFingerprint, sourceSnapshotUrl: expectedSnapshot, sourceSnapshotFingerprint: snapshotFingerprint,
      anchorUrl, anchorFingerprint: hash(anchor), frontPanel: panel, faceBounds: face.bounds, cropBounds: crop, landmarkEvidence: { confidence: face.confidence, yaw: face.yaw, regions: ['leftEye', 'rightEye', 'leftEyebrow', 'rightEyebrow', 'nose'] }, scope, createdAt: new Date().toISOString() }
    await mkdir(path.join(root, 'public/generated'), { recursive: true })
    await writeFile(path.join(root, 'public', anchorUrl), anchor)
    await writeFile(manifestPath, JSON.stringify(manifest))
    return manifest
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
