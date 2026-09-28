import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { isPublicInternetUrl } from './web-sources.ts'

const run = promisify(execFile)
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const maxImageBytes = 20 * 1024 * 1024
/** Calibrated on a small, visually reviewed adult-stage sample: the accepted
 * Zhang Fei costume sheet measures 0.495 against its keeper snapshot, while
 * four visibly drifting historical sheets measure 0.708–0.837 with the same
 * method. This is a review triage boundary, not biometric proof. */
export const SAME_STAGE_FACE_DISTANCE_REVIEW_THRESHOLD = 0.55

type FaceDistance = { detector: string; distance: number; sourceFace?: unknown; targetFace?: unknown }
type Input = { sourceAssetId: string; sourceSnapshotUrl: string; sourceSnapshotFingerprint: string; candidateUrl: string }

async function imageBytes(url: string, root: string, fetchImpl: typeof fetch) {
  if (/^\/generated\/[\w.-]+\.(?:png|jpe?g|webp)$/i.test(url)) return readFile(path.join(root, 'public', url))
  if (/^data:image\/(?:png|jpeg|webp);base64,/i.test(url)) {
    const bytes = Buffer.from(url.split(',', 2)[1], 'base64')
    if (bytes.length > maxImageBytes) throw Error('图片超过 20MB')
    return bytes
  }
  if (!url.startsWith('https://') || !isPublicInternetUrl(url)) throw Error('图片来源不是已归档本地图或公开 HTTPS 图片')
  let current = url, response: Response | undefined
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    if (!current.startsWith('https://') || !isPublicInternetUrl(current)) throw Error('图片跳转后的地址不是公开 HTTPS 图片')
    response = await fetchImpl(current, { signal: AbortSignal.timeout(120_000), redirect: 'manual' })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location')
    if (!location || redirect === 3) throw Error('图片跳转次数或目标无效')
    current = new URL(location, current).toString()
  }
  if (!response) throw Error('图片读取失败')
  if (!response.ok) throw Error(`图片读取失败 HTTP ${response.status}`)
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > maxImageBytes) throw Error('图片超过 20MB')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > maxImageBytes) throw Error('图片超过 20MB')
  return bytes
}

async function stableImage(inputUrl: string, bytes: Buffer, root: string) {
  const metadata = await sharp(bytes, { failOn: 'error' }).metadata()
  await sharp(bytes, { failOn: 'error' }).stats()
  const extension = metadata.format === 'jpeg' ? 'jpg' : metadata.format
  if (!['png', 'jpg', 'webp'].includes(extension ?? '')) throw Error('人物候选不是受支持的位图格式')
  const contentSha256 = hash(bytes)
  const localUri = `/generated/character-portrait-${contentSha256.slice(0, 32)}.${extension}`
  const localFile = path.join(root, 'public', localUri)
  await mkdir(path.dirname(localFile), { recursive: true })
  try { await writeFile(localFile, bytes, { flag: 'wx' }) }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST'
      || hash(await readFile(localFile)) !== contentSha256) throw error
  }
  const sourceMediaProvenance = inputUrl.startsWith('https://')
    ? { version: 'generated-media-mirror-v1', localUri, originalUri: inputUrl,
      originalUriFingerprint: hash(inputUrl), contentSha256 }
    : undefined
  return { localUri, contentSha256, sourceMediaProvenance }
}

/** Preserve any paid candidate in content-addressed local storage before a
 * deferred batch is stopped for review. No model request is made here. */
export async function mirrorGeneratedCharacterImage(candidateUrl: string, options: {
  root?: string; fetchImpl?: typeof fetch
} = {}) {
  const root = options.root ?? process.cwd()
  return stableImage(candidateUrl, await imageBytes(candidateUrl, root, options.fetchImpl ?? fetch), root)
}

/** A same-stage reference is compared only to the front panel face. Vision
 * failures and distances above the threshold route the paid sheet to manual
 * review; this function never authorizes an automatic replacement request. */
export async function compareCharacterFaceSheets(input: Input, options: {
  root?: string
  fetchImpl?: typeof fetch
  calculate?: (sourcePath: string, candidatePath: string, scriptPath: string) => Promise<FaceDistance>
} = {}) {
  const root = options.root ?? process.cwd()
  const candidateUriFingerprint = hash(input.candidateUrl)
  const evidence = { version: 'same-stage-face-consistency-v1', sourceAssetId: input.sourceAssetId,
    sourceSnapshotUrl: input.sourceSnapshotUrl, sourceSnapshotFingerprint: input.sourceSnapshotFingerprint,
    candidateUriFingerprint, threshold: SAME_STAGE_FACE_DISTANCE_REVIEW_THRESHOLD,
    reviewedAt: new Date().toISOString() }
  let candidateContentSha256 = ''
  let candidateLocalUri = ''
  let sourceMediaProvenance: Awaited<ReturnType<typeof stableImage>>['sourceMediaProvenance']
  try {
    const candidate = await imageBytes(input.candidateUrl, root, options.fetchImpl ?? fetch)
    const mirrored = await stableImage(input.candidateUrl, candidate, root)
    candidateContentSha256 = mirrored.contentSha256
    candidateLocalUri = mirrored.localUri
    sourceMediaProvenance = mirrored.sourceMediaProvenance
    if (!/^\/generated\/appearance-[a-f0-9]{24}\.jpg$/.test(input.sourceSnapshotUrl)) throw Error('已核验身份快照路径无效')
    const source = await readFile(path.join(root, 'public', input.sourceSnapshotUrl))
    if (hash(source) !== input.sourceSnapshotFingerprint) throw Error('已核验身份快照字节指纹不符')
    const scriptPath = path.join(root, 'scripts/character-face-feature-distance.swift')
    const result = await (options.calculate ?? (async (sourcePath, targetPath, script) => {
      if (process.platform !== 'darwin') throw Error('当前系统没有 macOS Vision')
      const { stdout } = await run('/usr/bin/swift', [script, sourcePath, targetPath], { timeout: 45_000, maxBuffer: 1024 * 1024 })
      return JSON.parse(stdout) as FaceDistance
    }))(path.join(root, 'public', input.sourceSnapshotUrl), path.join(root, 'public', candidateLocalUri), scriptPath)
    if (result.detector !== 'macos-vision-image-feature-v1' || !Number.isFinite(result.distance) || result.distance < 0) {
      throw Error('离线脸部特征距离结果无效')
    }
    const status = result.distance <= SAME_STAGE_FACE_DISTANCE_REVIEW_THRESHOLD ? 'passed' : 'needs_manual_review'
    return { ...evidence, candidateContentSha256, candidateLocalUri, sourceMediaProvenance, status, reason: status === 'passed' ? 'distance-within-threshold' : 'distance-above-threshold',
      detector: result.detector, distance: result.distance,
      sourceFace: result.sourceFace, targetFace: result.targetFace }
  } catch (error) {
    return { ...evidence, ...(candidateContentSha256 ? { candidateContentSha256, candidateLocalUri, sourceMediaProvenance } : {}), status: 'needs_manual_review', reason: 'comparison-unavailable',
      diagnostic: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) }
  }
}
