import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { validateCoverageCutFrameReview } from '../src/coverage-cut-frame-gate.ts'

type Value = Record<string, unknown>
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
const invalid = (message: string): never => { throw new Error(`COVERAGE_FRAME_APPROVAL_INVALID: ${message}`) }
const keyPath = (root: string) => path.join(root, '.runtime/coverage-cut-frame-approval.key')
function generatedFile(url: unknown, root: string, extension: RegExp) {
  if (typeof url !== 'string' || !/^\/generated\/[\w.-]+$/.test(url) || !extension.test(url)) invalid('采证源须为本地固定图片')
  return path.join(root, 'public', String(url))
}
async function approvalKey(root: string) {
  const file = keyPath(root)
  try { return await readFile(file) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await mkdir(path.dirname(file), { recursive: true })
  try { await writeFile(file, randomBytes(32), { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  return readFile(file)
}
function signature(certificate: Value, secret: Buffer) {
  const { signature: _signature, ...content } = certificate
  void _signature
  return createHmac('sha256', secret).update(canonical(content)).digest('hex')
}
export const coverageCutShotSha256 = (shot: unknown) => sha256(canonical(shot))

type Approval = ReturnType<typeof validateCoverageCutFrameReview> & { reviewExecutionId: string;
  reviewSha256: string; evidenceSha256: string; shotSha256: string; sourceSha256s: string[];
  referenceSha256s: string[]; previousTailSourceUrl: string; signature: string;
  advisoryRetryCount?: number }

/** Re-read all original images and model-viewed JPEGs, not only their URLs. */
export function verifyCoverageCutFrameApproval(certificate: unknown, root = process.cwd()): Approval {
  const value = object(certificate)
  const review = object(value.qualityReview)
  const clean = value.reviewPassed === true && Array.isArray(value.qualityRisks)
    && value.qualityRisks.length === 0
  const advisory = value.reviewPassed === false && Array.isArray(value.qualityRisks)
    && value.qualityRisks.length > 0 && review.status === 'needs_attention'
    && review.canProceed === true && review.manualDecisionRequired === false
    && Number.isSafeInteger(value.advisoryRetryCount) && Number(value.advisoryRetryCount) >= 7
  if (value.version !== 'coverage-cut-frame-gate-v1' || value.passed !== true
    || !(clean || advisory)
    || !Array.isArray(value.frames) || value.frames.length !== 2
    || !Array.isArray(value.assets) || value.assets.length < 1 || value.assets.length > 2
    || !Array.isArray(value.sourceSha256s) || value.sourceSha256s.length !== 2 + value.assets.length
    || !Array.isArray(value.referenceSha256s) || value.referenceSha256s.length !== 2 + value.assets.length
    || typeof value.reviewExecutionId !== 'string' || !/^model-run-[\w-]+$/.test(value.reviewExecutionId)
    || !['reviewSha256', 'evidenceSha256', 'shotSha256', 'signature'].every(key =>
      typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key] as string))) invalid('凭证格式或独立审核执行不完整')
  let secret: Buffer
  try { secret = readFileSync(keyPath(root)) } catch { return invalid('签发密钥缺失') }
  if (secret.length !== 32 || !timingSafeEqual(Buffer.from(value.signature as string, 'hex'),
    Buffer.from(signature(value, secret), 'hex'))) invalid('凭证签名不匹配')
  let report: Buffer
  try { report = readFileSync(generatedFile(value.evidenceUrl, root, /\.json$/)) }
  catch { return invalid('图片采证报告丢失') }
  if (sha256(report) !== value.evidenceSha256) invalid('图片采证报告已改变')
  for (const [index, raw] of [...value.frames as unknown[], ...value.assets as unknown[]].entries()) {
    const frame = object(raw)
    let source: Buffer, attachment: Buffer
    try {
      source = readFileSync(generatedFile(frame.sourceUrl, root, /\.(?:png|jpe?g|webp)$/i))
      attachment = readFileSync(generatedFile(frame.evidenceReferenceImage, root, /\.jpg$/))
    } catch { return invalid('已签图片原图或审核附件丢失') }
    const sourceHash = sha256(source)
    if (sourceHash !== (value.sourceSha256s as string[])[index] || sourceHash.slice(0, 24) !== String(frame.fingerprint)
      || frame.evidenceReferenceImage !== `/generated/image-evidence-${frame.fingerprint}.jpg`
      || sha256(attachment) !== (value.referenceSha256s as string[])[index]) invalid('已签图片原图或审核附件字节改变')
  }
  return value as Approval
}

/** Only the HTTP endpoint may call this after matching the successful visual
 * model ledger row against the managed prompt and the exact reviewed bytes. */
export async function issueCoverageCutFrameApproval(input: { review: unknown; evidence: unknown;
  shot: unknown; previousTail: unknown; referenceBindings: unknown; reviewExecutionId: string;
  advisoryRetryCount?: number },
root = process.cwd()): Promise<Approval> {
  if (!/^model-run-[\w-]+$/.test(input.reviewExecutionId)) invalid('缺少独立视觉审核执行 ID')
  const evidence = object(input.evidence), reportUrl = evidence.evidenceUrl
  if (typeof reportUrl !== 'string' || !/^\/generated\/image-evidence-[a-f0-9]{24}\.json$/.test(reportUrl)) invalid('采证报告地址无效')
  const reportBytes = await readFile(generatedFile(reportUrl, root, /\.json$/))
  let saved: Value
  try { saved = JSON.parse(reportBytes.toString('utf8')) as Value } catch { return invalid('采证报告无法解析') }
  if (canonical(saved) !== canonical(evidence) || !Array.isArray(saved.items)
    || sha256(JSON.stringify(saved.items)).slice(0, 24) !== (reportUrl as string).match(/([a-f0-9]{24})\.json$/)?.[1]) {
    invalid('提交的采证与本机固定报告不一致')
  }
  const reviewed = validateCoverageCutFrameReview(input.review, saved, input.shot,
    input.previousTail, input.referenceBindings)
  const advisory = !reviewed.passed && Number.isSafeInteger(input.advisoryRetryCount)
    && Number(input.advisoryRetryCount) >= 7
  if (!reviewed.passed && !advisory) invalid('首帧身份或连续性实图审核未通过；请重画首帧再验收')
  const base = advisory ? { ...reviewed, passed: true,
    qualityReview: { status: 'needs_attention', canProceed: true, manualDecisionRequired: false },
    advisoryRetryCount: input.advisoryRetryCount } : reviewed
  const sourceSha256s: string[] = [], referenceSha256s: string[] = []
  for (const [index, raw] of (saved.items as unknown[]).entries()) {
    const item = object(raw), frame = [...base.frames, ...base.assets][index]
    const sourceBytes = await readFile(generatedFile(item.url, root, /\.(?:png|jpe?g|webp)$/i))
    const attachment = await readFile(generatedFile(item.referenceImage, root, /\.jpg$/))
    const sourceHash = sha256(sourceBytes)
    if (frame.sourceUrl !== item.url || frame.evidenceReferenceImage !== item.referenceImage
      || sourceHash.slice(0, 24) !== frame.fingerprint || item.decoded !== true) invalid('采证附件与原图指纹不一致')
    const expected = await sharp(sourceBytes).resize({ width: 1600, height: 1200, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 }).toBuffer()
    const metadata = await sharp(sourceBytes, { failOn: 'error' }).metadata(), measurement = object(item.measurement)
    if (!attachment.equals(expected) || measurement.width !== metadata.width || measurement.height !== metadata.height
      || measurement.format !== metadata.format || measurement.bytes !== sourceBytes.length) invalid('模型审核附件不是原图的真实采样')
    sourceSha256s.push(sourceHash); referenceSha256s.push(sha256(attachment))
  }
  const tail = object(input.previousTail)
  const certificate: Approval = { ...base, reviewExecutionId: input.reviewExecutionId,
    reviewSha256: sha256(canonical(input.review)), evidenceSha256: sha256(reportBytes),
    shotSha256: coverageCutShotSha256(input.shot), sourceSha256s, referenceSha256s,
    previousTailSourceUrl: String(tail.sourceUrl), signature: '' }
  certificate.signature = signature(certificate, await approvalKey(root))
  return certificate
}

/** Invoke before any new paid live-action coverage-cut video request. */
export function validateCoverageCutVideoPayment(params: Value, root = process.cwd()) {
  const certificate = verifyCoverageCutFrameApproval(params.coverageCutFrameGate, root)
  const tail = object(params.coveragePreviousTail), shot = object(params.coverageShot)
  const bindings = Array.isArray(params.referenceBindings) ? params.referenceBindings.map(object) : []
  const refs = Array.isArray(params.referenceImages) ? params.referenceImages : []
  if (params.continuityMode !== 'coverage_cut'
    || object(shot.continuity).mode !== 'coverage_cut' || shot.firstFrameMode !== 'reference'
    || certificate.shotSha256 !== coverageCutShotSha256(shot)
    || certificate.frames[0].sourceUrl !== tail.url || certificate.previousTailSourceUrl !== tail.sourceUrl
    || tail.source !== 'extracted-from-video' || tail.available !== true || tail.videoTailUrl !== tail.sourceUrl
    || certificate.frames[1].sourceUrl !== params.referenceImage || refs.length !== certificate.assets.length
    || bindings.length !== refs.length || certificate.assets.some((asset, index) => asset.sourceUrl !== refs[index]
      || asset.sourceUrl !== bindings[index].url || asset.assetId !== bindings[index].assetId
      || asset.characterName !== bindings[index].characterName)) {
    invalid('付费视频的分镜、前镜尾帧、新机位首帧或人物资产与实图凭证不一致')
  }
  return certificate
}
