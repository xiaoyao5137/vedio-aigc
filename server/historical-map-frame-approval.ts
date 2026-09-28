import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { validateHistoricalMapFrameReview } from '../src/historical-map-frame-gate.ts'

type Value = Record<string, unknown>
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
export function historicalMapFrameShotSha256(shot: unknown) { return sha256(canonical(shot)) }
function invalid(message: string): never { throw new Error(`HISTORICAL_MAP_FRAME_APPROVAL_INVALID: ${message}`) }
function keyPath(root: string) { return path.join(root, '.runtime/historical-map-approval.key') }
async function approvalKey(root: string) {
  const file = keyPath(root)
  try { return await readFile(file) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await mkdir(path.dirname(file), { recursive: true })
  try { await writeFile(file, randomBytes(32), { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  return readFile(file)
}
function signature(value: Value, secret: Buffer) {
  const { signature: _signature, ...content } = value
  void _signature
  return createHmac('sha256', secret).update(canonical(content)).digest('hex')
}
function generatedFile(url: unknown, root: string, extension: RegExp) {
  if (typeof url !== 'string' || !/^\/generated\/[\w.-]+$/.test(url) || !extension.test(url)) invalid('采证图片必须为已持久化的本地 /generated 文件')
  return path.join(root, 'public', url)
}
function sourceHash(frame: Value, root: string) {
  const source = generatedFile(frame.sourceUrl, root, /\.(?:png|jpe?g|webp)$/i)
  let bytes: Buffer
  try { bytes = readFileSync(source) } catch { return invalid('原图不存在') }
  const fullHash = sha256(bytes)
  if (frame.fingerprint !== fullHash.slice(0, 24)
    || frame.evidenceReferenceImage !== `/generated/image-evidence-${frame.fingerprint}.jpg`) invalid('原图字节哈希与采证指纹不同')
  return { bytes, fullHash }
}

export type HistoricalMapFrameApproval = ReturnType<typeof validateHistoricalMapFrameReview> & {
  reviewExecutionId: string; reviewSha256: string; evidenceSha256: string; shotSha256: string;
  sourceSha256s: string[]; referenceSha256s: string[]; priorSignature?: string; signature: string }

/** Verify both the local secret and current immutable source bytes. */
export function verifyHistoricalMapFrameApproval(certificate: unknown, root = process.cwd()): HistoricalMapFrameApproval {
  const value = object(certificate)
  if (!['historical-map-first-frame-gate-v1', 'historical-map-frame-gate-v1'].includes(String(value.version))
    || value.passed !== true || !Array.isArray(value.frames)
    || value.frames.length !== (value.version === 'historical-map-first-frame-gate-v1' ? 1 : 2)
    || !Array.isArray(value.sourceSha256s) || value.sourceSha256s.length !== value.frames.length
    || !Array.isArray(value.referenceSha256s) || value.referenceSha256s.length !== value.frames.length
    || typeof value.reviewExecutionId !== 'string' || !/^model-run-[\w-]+$/.test(value.reviewExecutionId)
    || !['reviewSha256', 'evidenceSha256', 'shotSha256', 'signature'].every(key => typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key] as string))) {
    invalid('缺少实际图片审核凭证或独立模型执行证据')
  }
  let secret: Buffer
  try { secret = readFileSync(keyPath(root)) } catch { return invalid('缺少本机审核签发密钥') }
  if (secret.length !== 32) invalid('签发密钥无效')
  const actual = Buffer.from(value.signature as string, 'hex')
  const expected = Buffer.from(signature(value, secret), 'hex')
  if (!timingSafeEqual(actual, expected)) invalid('签名不匹配')
  const report = generatedFile(value.evidenceUrl, root, /\.json$/)
  let reportBytes: Buffer
  try { reportBytes = readFileSync(report) } catch { return invalid('审核采证报告已丢失') }
  if (sha256(reportBytes) !== value.evidenceSha256) invalid('审核采证报告已改变')
  for (const [index, raw] of value.frames.entries()) {
    const frame = object(raw)
    if (frame.role !== (index === 0 ? 'first' : 'end')) invalid('审核图片角色顺序错误')
    const { fullHash } = sourceHash(frame, root)
    if (value.sourceSha256s[index] !== fullHash) invalid('审核后原图已改变')
    let referenceBytes: Buffer
    try { referenceBytes = readFileSync(generatedFile(frame.evidenceReferenceImage, root, /\.jpg$/)) }
    catch { return invalid('审核附件已丢失') }
    if (value.referenceSha256s[index] !== sha256(referenceBytes)) invalid('审核后图像附件已改变')
  }
  return value as HistoricalMapFrameApproval
}

/** A stored model-review ledger match is required at the HTTP boundary before
 * invoking this signer. Re-read image evidence and source pixels regardless. */
export async function issueHistoricalMapFrameApproval(input: { review: unknown; evidence: unknown; shot: unknown;
  prior?: unknown; reviewExecutionId: string }, root = process.cwd()): Promise<HistoricalMapFrameApproval> {
  if (!/^model-run-[\w-]+$/.test(input.reviewExecutionId)) invalid('缺少已持久化的独立审核模型执行 ID')
  const evidence = object(input.evidence), reportUrl = evidence.evidenceUrl
  if (typeof reportUrl !== 'string' || !/^\/generated\/image-evidence-[a-f0-9]{24}\.json$/.test(reportUrl)) invalid('采证报告地址无效')
  const reportBytes = await readFile(generatedFile(reportUrl, root, /\.json$/))
  let saved: Value
  try { saved = JSON.parse(reportBytes.toString('utf8')) as Value } catch { return invalid('已保存采证报告无法解析') }
  if (canonical(saved) !== canonical(evidence) || saved.evidenceUrl !== reportUrl || !Array.isArray(saved.items)
    || sha256(JSON.stringify(saved.items)).slice(0, 24) !== reportUrl.match(/([a-f0-9]{24})\.json$/)?.[1]) {
    invalid('请求采证与服务端保存的原始报告不一致')
  }
  const firstOrEnd = (saved.items as unknown[]).length
  if (firstOrEnd === 2) {
    const firstApproval = verifyHistoricalMapFrameApproval(input.prior, root)
    if (firstApproval.shotSha256 !== historicalMapFrameShotSha256(input.shot)) invalid('首尾两阶段审核的分镜正文不一致')
  }
  else if (firstOrEnd !== 1 || input.prior !== undefined) invalid('首帧/尾帧审核阶段不匹配')
  const base = validateHistoricalMapFrameReview(input.review, saved, input.shot, input.prior)
  const sourceSha256s: string[] = [], referenceSha256s: string[] = []
  for (const [index, raw] of (saved.items as unknown[]).entries()) {
    const item = object(raw), frame = object(base.frames[index])
    const { bytes, fullHash } = sourceHash(frame, root)
    if (item.referenceImage !== frame.evidenceReferenceImage || item.decoded !== true) invalid('采证报告与源帧不一致')
    const reference = generatedFile(item.referenceImage, root, /\.jpg$/)
    const savedReference = await readFile(reference)
    const expectedReference = await sharp(bytes).resize({ width: 1600, height: 1200, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 }).toBuffer()
    if (!savedReference.equals(expectedReference)) invalid('审核附件像素与原图采证不一致')
    const metadata = await sharp(bytes, { failOn: 'error' }).metadata()
    const measurement = object(item.measurement)
    if (measurement.width !== metadata.width || measurement.height !== metadata.height
      || measurement.format !== metadata.format || measurement.bytes !== bytes.length) invalid('采证图像尺寸或字节数与原图不一致')
    sourceSha256s.push(fullHash)
    referenceSha256s.push(sha256(savedReference))
  }
  const certificate: HistoricalMapFrameApproval = { ...base, reviewExecutionId: input.reviewExecutionId,
    reviewSha256: sha256(canonical(input.review)), evidenceSha256: sha256(reportBytes),
    shotSha256: historicalMapFrameShotSha256(input.shot), sourceSha256s, referenceSha256s,
    ...(firstOrEnd === 2 ? { priorSignature: object(input.prior).signature as string } : {}), signature: '' }
  certificate.signature = signature(certificate, await approvalKey(root))
  return certificate
}
