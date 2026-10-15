import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { validateSceneCutFrameReview } from '../src/scene-cut-first-frame-gate.ts'
import { validateSceneCutT0ImageContract } from '../src/scene-cut-t0-image-contract.ts'
import { validateSceneCutStanceStartReview } from '../src/scene-cut-opening-plan-workflow.ts'
import { validateSceneCutTravelStartReview } from '../src/scene-cut-travel-start-workflow.ts'
import { sceneCutActionPerformerFeetRequired } from '../src/scene-cut-action-visibility-workflow.ts'
import { deriveSceneCutOpeningPlan } from './scene-cut-opening-plan.ts'
import { verifySceneCutEllipsisProof } from './scene-cut-ellipsis-proof.ts'
import { buildSceneCutIdentityPlateV4 } from './scene-cut-frame-storage.ts'

type Value = Record<string, unknown>
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const invalid = (message: string): never => { throw Error(`SCENE_CUT_FRAME_APPROVAL_INVALID: ${message}`) }
const keyPath = (root: string) => path.join(root, '.runtime/scene-cut-frame-approval.key')
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value ?? null)
}
export const sceneCutShotSha256 = (shot: unknown) => sha256(canonical(shot))
function generatedFile(url: unknown, root: string, extension: RegExp) {
  if (typeof url !== 'string' || !/^\/generated\/[\w.-]+$/.test(url) || !extension.test(url)) invalid('图片源须为本地固定文件')
  return path.join(root, 'public', String(url))
}
async function approvalKey(root: string) {
  const filename = keyPath(root)
  try { return await readFile(filename) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await mkdir(path.dirname(filename), { recursive: true })
  try { await writeFile(filename, randomBytes(32), { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  return readFile(filename)
}
function signature(certificate: Value, secret: Buffer) {
  const { signature: _ignored, ...content } = certificate
  void _ignored
  return createHmac('sha256', secret).update(canonical(content)).digest('hex')
}
type Approval = ReturnType<typeof validateSceneCutFrameReview> & { reviewExecutionId: string;
  reviewSha256: string; evidenceSha256: string; shotSha256: string;
  sourceSha256s: string[]; referenceSha256s: string[]; signature: string;
  identityPlateVersion?: 'scene-cut-identity-plate-v4'; sourceArchiveSha256?: string;
  identityPlateBindings?: Array<{ characterName: string; assetId: string;
    sourceUrl: string; sourceSha256: string; frontUrl: string; frontSha256: string;
    partSha256s: Record<string, string> }>;
  repairBinding?: SceneCutImageRepairBinding }

export type SceneCutImageRepairBinding = {
  version: 'scene-cut-image-repair-binding-v1' | 'scene-cut-image-repair-binding-v2';
  executionId: string;
  reviewSourceExecutionId?: string;
  imageExecutionId: string; repairRequestFingerprint: string;
  repairReceiptSha256: string; candidateImageSha256: string;
  receipt: Record<string, unknown>
}

function verifyRepairBinding(bindingInput: unknown, certificate: Value, root: string) {
  const binding = object(bindingInput), receipt = object(binding.receipt)
  const refs = Array.isArray(receipt.referenceOrder) ? receipt.referenceOrder.map(object) : []
  const isGeometryRepair = binding.version === 'scene-cut-image-repair-binding-v2'
  const assets = Array.isArray(certificate.assets) ? certificate.assets : []
  const plateBindings = Array.isArray(certificate.identityPlateBindings)
    ? certificate.identityPlateBindings.map(object) : []
  if (!['scene-cut-image-repair-binding-v1', 'scene-cut-image-repair-binding-v2']
    .includes(String(binding.version))
    || !/^record-[\w-]+$/.test(String(binding.executionId ?? ''))
    || binding.reviewSourceExecutionId !== undefined
      && !/^record-[\w-]+$/.test(String(binding.reviewSourceExecutionId))
    || !/^model-run-[\w-]+$/.test(String(binding.imageExecutionId ?? ''))
    || !['repairRequestFingerprint', 'repairReceiptSha256', 'candidateImageSha256']
      .every(key => typeof binding[key] === 'string' && /^[a-f0-9]{64}$/.test(String(binding[key])))
    || receipt.version !== (isGeometryRepair
      ? 'scene-cut-rejected-image-edit-reference-v2'
      : 'scene-cut-rejected-image-edit-reference-v1')
    || receipt.role !== 'reference-only' || receipt.sourceVerdict !== 'rejected'
    || receipt.approvedFirstFrame !== false || receipt.requiresFreshIndependentReview !== true
    || receipt.requiresPaidGateRevalidation !== true || receipt.sourceExecutionId === binding.executionId
    || !Array.isArray(receipt.referenceOrder) || refs.length !== (isGeometryRepair ? 4 : 3)
    || assets.length !== 2 || plateBindings.length !== 2
    || typeof receipt.preparationSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(receipt.preparationSha256)
    || typeof receipt.sourceImageUrl !== 'string'
    || !/^\/generated\/image-[a-f0-9]{32}\.png$/.test(receipt.sourceImageUrl)
    || receipt.sourceImageSha256 !== refs[2].sourceSha256
    || receipt.sourceImageUrl !== refs[2].sourceUrl
    || refs[2].role !== 'rejected-edit-source' || refs[2].position !== 3
    || refs[0].position !== 1 || refs[1].position !== 2
    || sha256(canonical(receipt)) !== binding.repairReceiptSha256
    || object(certificate.frame).sourceUrl === receipt.sourceImageUrl
    || binding.candidateImageSha256 !== (certificate.sourceSha256s as string[])?.[0])
    invalid('修复图签章字段、参考图顺序或候选哈希无效')
  for (const [index, plate] of plateBindings.entries()) {
    const ref = refs[index]
    if (ref.frontUrl !== plate.frontUrl || ref.sha256 !== plate.frontSha256
      || ref.characterName !== plate.characterName || ref.position !== index + 1)
      invalid('修复图身份板顺序与签章不一致')
    let board: Buffer
    try { board = readFileSync(generatedFile(ref.frontUrl, root, /\.jpg$/i)) }
    catch { return invalid('修复图身份板文件丢失') }
    if (sha256(board) !== ref.sha256 || board.length !== ref.bytes)
      invalid('修复图身份板字节改变')
  }
  let failedImage: Buffer
  try { failedImage = readFileSync(generatedFile(receipt.sourceImageUrl, root, /\.png$/i)) }
  catch { return invalid('失败参考原 PNG 丢失') }
  if (sha256(failedImage) !== receipt.sourceImageSha256
    || !/^[a-f0-9]{64}$/.test(String(refs[2].jpegSha256 ?? ''))
    || !Number.isSafeInteger(refs[2].bytes) || Number(refs[2].bytes) <= 0)
    invalid('失败参考原 PNG 字节或第三图收据无效')
  if (isGeometryRepair) {
    const guide = refs[3]
    const guideDeclaration = object(receipt.geometryGuide)
    if (guide.position !== 4 || guide.role !== 'geometry-guide'
      || guide.purpose !== 'geometry-only' || guide.referenceOnly !== true
      || guideDeclaration.role !== 'geometry-only'
      || guideDeclaration.identityAuthority !== false
      || guideDeclaration.sourcePath !== guide.sourcePath
      || guideDeclaration.sourceSha256 !== guide.sourceSha256
      || typeof receipt.guideProvenanceSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(receipt.guideProvenanceSha256)
      || typeof guide.sourcePath !== 'string'
      || !/^qa\/record-[A-Za-z0-9_-]+\/geometry-guide-v\d+-[a-f0-9]{8}\.png$/.test(guide.sourcePath)
      || typeof guide.sourceSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(guide.sourceSha256)
      || typeof guide.jpegSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(guide.jpegSha256)
      || !Number.isSafeInteger(guide.bytes) || Number(guide.bytes) <= 0)
      invalid('第四参考未声明只读几何用途或完整字节哈希')
    let guideBytes: Buffer
    try { guideBytes = readFileSync(path.join(root, String(guide.sourcePath))) }
    catch { return invalid('已签几何引导图丢失') }
    if (sha256(guideBytes) !== guide.sourceSha256)
      invalid('已签几何引导图原 PNG 字节改变')
  }
  return binding as unknown as SceneCutImageRepairBinding
}

/** An approval for v4 is allowed only after rebuilding every plate from its
 * archived character sheet. The signed fields then bind the exact reviewed
 * source archive and the plate bytes used to generate the candidate. */
async function validatedV4PlateBindings(sources: unknown, assets: Value[], root: string) {
  const archive = object(sources)
  if (archive.identityPlateVersion !== 'scene-cut-identity-plate-v4') return undefined
  const bindings = Array.isArray(archive.referenceBindings)
    ? archive.referenceBindings.map(object) : []
  const refs = Array.isArray(archive.imageReferenceImages) ? archive.imageReferenceImages : []
  if (archive.version !== 'scene-cut-sources-v1' || bindings.length !== assets.length
    || refs.length !== bindings.length) invalid('v4 身份板来源数量与审核资产不一致')
  const result: NonNullable<Approval['identityPlateBindings']> = []
  for (const [index, binding] of bindings.entries()) {
    const asset = assets[index], sourceUrl = binding.url, frontUrl = binding.frontUrl
    let sourceBytes: Buffer, frontBytes: Buffer
    try {
      sourceBytes = await readFile(generatedFile(sourceUrl, root, /\.(?:png|jpe?g|webp)$/i))
      frontBytes = await readFile(generatedFile(frontUrl, root, /\.jpg$/i))
    } catch { return invalid('v4 身份板原图或板图丢失') }
    const layout = binding.referenceLayout as
      'horizontal-three-view' | 'vertical-three-view' | 'single-portrait' | undefined
    const expected = await buildSceneCutIdentityPlateV4(sourceBytes, layout)
    if (binding.identityPlateVersion !== 'scene-cut-identity-plate-v4'
      || asset.characterName !== binding.characterName || asset.assetId !== binding.assetId
      || asset.sourceUrl !== sourceUrl || binding.sha256 !== sha256(sourceBytes)
      || binding.frontSha256 !== sha256(frontBytes) || !frontBytes.equals(expected.plate)
      || binding.referenceLayout !== expected.layout
      || canonical(binding.partSha256s) !== canonical(expected.partSha256s)
      || refs[index] !== `data:image/jpeg;base64,${frontBytes.toString('base64')}`)
      invalid('v4 身份板与已归档正面人设或审核资产不一致')
    result.push({ characterName: String(binding.characterName), assetId: String(binding.assetId),
      sourceUrl: String(sourceUrl), sourceSha256: sha256(sourceBytes),
      frontUrl: String(frontUrl), frontSha256: sha256(frontBytes),
      partSha256s: expected.partSha256s })
  }
  return result
}

/** Bind signed approval to the raw still, identity sheets and model-viewed JPEG bytes. */
export async function issueSceneCutFrameApproval(input: { review: unknown; evidence: unknown; shot: unknown;
  sources: unknown; reviewExecutionId: string; openingStatePlan?: unknown;
  imageRepairBinding?: SceneCutImageRepairBinding; visualDetailsAdvisory?: boolean;
  uncertainManipulationAdvisory?: boolean; allowReviewRisks?: boolean }, root = process.cwd()): Promise<Approval> {
  if (!/^model-run-[\w-]+$/.test(input.reviewExecutionId)) invalid('缺少独立实图审核执行 ID')
  const evidence = object(input.evidence), reportUrl = evidence.evidenceUrl
  if (typeof reportUrl !== 'string' || !/^\/generated\/image-evidence-[a-f0-9]{24}\.json$/.test(reportUrl)) invalid('采证报告 URL 无效')
  const reportBytes = await readFile(generatedFile(reportUrl, root, /\.json$/))
  let saved: Value
  try { saved = JSON.parse(reportBytes.toString('utf8')) as Value } catch { return invalid('采证报告无法解析') }
  if (canonical(saved) !== canonical(evidence) || !Array.isArray(saved.items)
    || sha256(JSON.stringify(saved.items)).slice(0, 24) !== String(reportUrl).match(/([a-f0-9]{24})\.json$/)?.[1]) {
    invalid('提交采证与本机固定报告不一致')
  }
  const base = validateSceneCutFrameReview(input.review, saved, input.shot, input.sources,
    { allowReviewRisks: input.allowReviewRisks })
  if (object(input.sources).sourceContext) verifySceneCutEllipsisProof(input.sources, input.shot, root)
  if (!input.allowReviewRisks && ['scene-cut-identity-plate-v2', 'scene-cut-identity-plate-v3',
    'scene-cut-identity-plate-v4']
    .includes(String(object(input.sources).identityPlateVersion)))
    validateSceneCutT0ImageContract(input.review, input.shot,
      { visualDetailsAdvisory: input.visualDetailsAdvisory,
        uncertainManipulationAdvisory: input.uncertainManipulationAdvisory })
  if (input.openingStatePlan !== undefined) {
    const planVersion = object(input.openingStatePlan).version
    if (!['scene-cut-opening-plan-v1', 'scene-cut-opening-plan-v2',
      'scene-cut-opening-plan-v3', 'scene-cut-opening-plan-v4'].includes(String(planVersion)))
      invalid('零秒起点计划版本无效')
    if (canonical(input.openingStatePlan) !== canonical(deriveSceneCutOpeningPlan(input.shot,
      planVersion === 'scene-cut-opening-plan-v4' ? 4
        : planVersion === 'scene-cut-opening-plan-v3' ? 3
        : planVersion === 'scene-cut-opening-plan-v2' ? 2 : 1)))
      invalid('零秒起点计划与批准分镜不一致')
    if (!input.allowReviewRisks) validateSceneCutStanceStartReview(input.review, input.shot)
    if (!input.allowReviewRisks && (planVersion === 'scene-cut-opening-plan-v2' || planVersion === 'scene-cut-opening-plan-v3'
      || planVersion === 'scene-cut-opening-plan-v4'))
      validateSceneCutTravelStartReview(input.review, input.shot,
        planVersion === 'scene-cut-opening-plan-v3' || planVersion === 'scene-cut-opening-plan-v4' ? 3 : 2,
        object(input.sources).identityPlateVersion === 'scene-cut-identity-plate-v4'
          ? sceneCutActionPerformerFeetRequired(input.shot) : undefined)
  }
  const plateBindings = await validatedV4PlateBindings(input.sources,
    base.assets.map(object), root)
  const sourceSha256s: string[] = [], referenceSha256s: string[] = []
  for (const [index, raw] of (saved.items as unknown[]).entries()) {
    const item = object(raw), frame = [base.frame, ...base.assets,
      ...(base.priorTail ? [base.priorTail] : [])][index]
    const sourceBytes = await readFile(generatedFile(item.url, root, /\.(?:png|jpe?g|webp)$/i))
    const attachment = await readFile(generatedFile(item.referenceImage, root, /\.jpg$/))
    const sourceHash = sha256(sourceBytes), measurement = object(item.measurement)
    const metadata = await sharp(sourceBytes, { failOn: 'error' }).metadata()
    const expected = await sharp(sourceBytes).resize({ width: 1600, height: 1200,
      fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer()
    if (frame.sourceUrl !== item.url || frame.evidenceReferenceImage !== item.referenceImage
      || sourceHash.slice(0, 24) !== String(item.referenceImage).match(/image-evidence-([a-f0-9]{24})\.jpg$/)?.[1]
      || !attachment.equals(expected) || measurement.width !== metadata.width
      || measurement.height !== metadata.height || measurement.format !== metadata.format
      || measurement.bytes !== sourceBytes.length || item.decoded !== true) invalid('实图附件与原图不符')
    sourceSha256s.push(sourceHash); referenceSha256s.push(sha256(attachment))
  }
  const certificate: Approval = { ...base, reviewExecutionId: input.reviewExecutionId,
    reviewSha256: sha256(canonical(input.review)), evidenceSha256: sha256(reportBytes),
    shotSha256: sceneCutShotSha256(input.shot), sourceSha256s, referenceSha256s,
    ...(plateBindings ? { identityPlateVersion: 'scene-cut-identity-plate-v4' as const,
      sourceArchiveSha256: sha256(canonical(input.sources)),
      identityPlateBindings: plateBindings } : {}),
    ...(input.imageRepairBinding ? { repairBinding: input.imageRepairBinding } : {}),
    signature: '' }
  if (certificate.repairBinding) verifyRepairBinding(certificate.repairBinding, certificate as Value, root)
  certificate.signature = signature(certificate, await approvalKey(root))
  return certificate
}

/** Re-read all signed files before a new paid video request. */
export function verifySceneCutFrameApproval(certificate: unknown, root = process.cwd()): Approval {
  const value = object(certificate)
  const sourceSha256s = Array.isArray(value.sourceSha256s) ? value.sourceSha256s : []
  const referenceSha256s = Array.isArray(value.referenceSha256s) ? value.referenceSha256s : []
  const assets = Array.isArray(value.assets) ? value.assets : []
  if (value.version !== 'scene-cut-frame-gate-v1' || value.passed !== true
    || !Array.isArray(value.assets) || !Array.isArray(value.sourceSha256s)
    || sourceSha256s.length !== assets.length + 1 + (value.priorTail ? 1 : 0)
    || !Array.isArray(value.referenceSha256s)
    || referenceSha256s.length !== assets.length + 1 + (value.priorTail ? 1 : 0)
    || Boolean(value.priorTail) !== Boolean(value.approvedEllipsis)
    || typeof value.reviewExecutionId !== 'string' || !/^model-run-[\w-]+$/.test(value.reviewExecutionId)
    || !['reviewSha256', 'evidenceSha256', 'shotSha256', 'signature'].every(key =>
      typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key] as string))) invalid('凭证格式不完整')
  let secret: Buffer
  try { secret = readFileSync(keyPath(root)) } catch { return invalid('签发密钥缺失') }
  if (secret.length !== 32 || !timingSafeEqual(Buffer.from(String(value.signature), 'hex'),
    Buffer.from(signature(value, secret), 'hex'))) invalid('凭证签名不匹配')
  const hasPlateBinding = value.identityPlateVersion !== undefined
    || value.sourceArchiveSha256 !== undefined || value.identityPlateBindings !== undefined
  if (hasPlateBinding) {
    const bindings = Array.isArray(value.identityPlateBindings)
      ? value.identityPlateBindings.map(object) : []
    if (value.identityPlateVersion !== 'scene-cut-identity-plate-v4'
      || typeof value.sourceArchiveSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.sourceArchiveSha256)
      || !Array.isArray(value.identityPlateBindings) || bindings.length !== assets.length)
      invalid('v4 身份板签名绑定不完整')
    for (const [index, binding] of bindings.entries()) {
      const parts = object(binding.partSha256s), asset = object(assets[index])
      if (binding.characterName !== asset.characterName || binding.assetId !== asset.assetId
        || binding.sourceUrl !== asset.sourceUrl
        || binding.sourceSha256 !== sourceSha256s[index + 1]
        || !['sourceSha256', 'frontSha256', ...Object.keys(parts)].every(key =>
          typeof (key === 'sourceSha256' || key === 'frontSha256' ? binding[key] : parts[key]) === 'string'
          && /^[a-f0-9]{64}$/.test(String(key === 'sourceSha256' || key === 'frontSha256'
            ? binding[key] : parts[key])))
        || Object.keys(parts).sort().join(',')
          !== ['faceAndHeadwear', 'collarAndArmor', 'waistThroughBoots'].sort().join(','))
        invalid('v4 身份板签名字段与审核资产不一致')
      let front: Buffer
      try { front = readFileSync(generatedFile(binding.frontUrl, root, /\.jpg$/i)) }
      catch { return invalid('已签 v4 身份板文件丢失') }
      if (sha256(front) !== binding.frontSha256) invalid('已签 v4 身份板字节改变')
    }
  }
  if (value.repairBinding) verifyRepairBinding(value.repairBinding, value, root)
  let report: Buffer
  try { report = readFileSync(generatedFile(value.evidenceUrl, root, /\.json$/)) }
  catch { return invalid('图片采证报告丢失') }
  if (sha256(report) !== value.evidenceSha256) invalid('图片采证报告已改变')
  for (const [index, raw] of [value.frame, ...assets,
    ...(value.priorTail ? [value.priorTail] : [])].entries()) {
    const frame = object(raw)
    let source: Buffer, attachment: Buffer
    try {
      source = readFileSync(generatedFile(frame.sourceUrl, root, /\.(?:png|jpe?g|webp)$/i))
      attachment = readFileSync(generatedFile(frame.evidenceReferenceImage, root, /\.jpg$/))
    } catch { return invalid('已签图片原图或审核附件丢失') }
    if (sha256(source) !== sourceSha256s[index]
      || sha256(attachment) !== referenceSha256s[index]) invalid('已签图片字节改变')
  }
  if (value.approvedEllipsis) {
    const proof = object(value.approvedEllipsis)
    let video: Buffer
    try { video = readFileSync(generatedFile(proof.priorVideoUrl, root, /\.mp4$/i)) }
    catch { return invalid('已批准省略的前镜成片丢失') }
    if (proof.priorVideoSha256 !== sha256(video)
      || proof.priorTailUrl !== object(value.priorTail).sourceUrl
      || proof.priorTailSha256 !== sourceSha256s.at(-1))
      invalid('前镜成片或实际尾帧与已签批准省略证明不同')
  }
  return value as Approval
}

export function validateSceneCutVideoPayment(params: Value, root = process.cwd()) {
  const certificate = verifySceneCutFrameApproval(params.sceneCutFrameGate, root)
  const shot = object(params.sceneCutShot), bindings = Array.isArray(params.referenceBindings)
    ? params.referenceBindings.map(object) : []
  const refs = Array.isArray(params.referenceImages) ? params.referenceImages : []
  const sources = object(params.sceneCutSources)
  if (certificate.repairBinding) {
    if (certificate.repairBinding.candidateImageSha256 !== certificate.sourceSha256s[0]
      || certificate.frame.sourceUrl !== params.referenceImage)
      invalid('修复图的新候选与签名收据不一致')
  }
  if (sources.identityPlateVersion === 'scene-cut-identity-plate-v4') {
    const plates = Array.isArray(certificate.identityPlateBindings)
      ? certificate.identityPlateBindings : []
    const archived = Array.isArray(sources.referenceBindings)
      ? sources.referenceBindings.map(object) : []
    if (certificate.identityPlateVersion !== 'scene-cut-identity-plate-v4'
      || certificate.sourceArchiveSha256 !== sha256(canonical(sources))
      || plates.length !== archived.length || plates.length !== bindings.length
      || plates.some((plate, index) => plate.characterName !== archived[index].characterName
        || plate.assetId !== archived[index].assetId || plate.sourceUrl !== archived[index].url
        || plate.sourceSha256 !== archived[index].sha256
        || plate.frontUrl !== archived[index].frontUrl
        || plate.frontSha256 !== archived[index].frontSha256
        || canonical(plate.partSha256s) !== canonical(archived[index].partSha256s)))
      invalid('v4 身份板与已签首帧审核及归档字节不一致')
  } else if (certificate.identityPlateVersion === 'scene-cut-identity-plate-v4') {
    invalid('已签 v4 身份板缺少付款请求的原始归档')
  }
  if (params.continuityMode !== 'scene_cut' || object(shot.continuity).mode !== 'scene_cut'
    || shot.visualTreatment !== 'live_action' || shot.firstFrameMode !== 'reference'
    || certificate.shotSha256 !== sceneCutShotSha256(shot)
    || certificate.frame.sourceUrl !== params.referenceImage
    || refs.length !== certificate.assets.length || bindings.length !== refs.length
    || certificate.assets.some((asset, index) => asset.sourceUrl !== refs[index]
      || asset.sourceUrl !== bindings[index].url || asset.assetId !== bindings[index].assetId
      || asset.characterName !== bindings[index].characterName
      || certificate.sourceSha256s[index + 1] !== bindings[index].sha256)) {
    invalid('视频分镜、首帧或人物资产与签发凭证不一致')
  }
  if (certificate.outlineBinding) {
    const sources = object(params.sceneCutSources)
    const proof = verifySceneCutEllipsisProof(sources, shot, root)
    if (canonical(certificate.outlineBinding) !== canonical(proof.outlineBinding)
      || canonical(certificate.approvedEllipsis ?? null)
        !== canonical(proof.approvedEllipsis ?? null)
      || canonical(certificate.acceptedRecordBinding)
        !== canonical(object(sources.sourceContext).acceptedRecordBinding))
      invalid('付款分镜的批准大纲或前镜真实尾帧与首帧凭证不一致')
  }
  return certificate
}
