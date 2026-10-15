/** Signed plan and write-once task/media ledger for NEW first-frame A8+B6.
 * Every paid phase has a separate guarded runner. No old A/B task is admitted. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { buildKlingVideoRequest } from './model-adapters.ts'
import { sceneCutShotSha256, verifySceneCutFrameApproval } from './scene-cut-frame-approval.ts'
import { sceneCutRebindSha256 } from './scene-cut-approval-rebind.ts'
import { verifyA8B6FreshV7EditReceiptSync } from
  './staged-scene-cut-a8b6-fresh-edit-v7.mjs'
import { verifyA8B6FreshV8EditReceipt,
  verifyA8B6FreshV8EditReceiptSync } from
  './staged-scene-cut-a8b6-fresh-edit-v8.mjs'
import { verifyA8B6V7DualOutputRecoveryReceipt,
  verifyA8B6V7DualOutputRecoveryReceiptAsync,
  verifyA8B6V7DualOutputClarification } from
  './staged-scene-cut-a8b6-v7-dual-output.mjs'
import { assertA8B6LocalCompositeWorkflowResult,
  verifyA8B6LocalCompositeSourceReceipt } from
  './staged-scene-cut-a8b6-local-composite-admission.mjs'
import { assertA8B6LocalCompositeWorkflowResultV2,
  verifyA8B6LocalCompositeSourceReceiptV2 } from
  './staged-scene-cut-a8b6-local-composite-admission-v2.mjs'
import { assertA8B6LocalCompositeWorkflowResultV3,
  verifyA8B6LocalCompositeSourceReceiptV3 } from
  './staged-scene-cut-a8b6-local-composite-admission-v3.mjs'
import { assertA8B6LocalCompositeWorkflowResultV4,
  verifyA8B6LocalCompositeSourceReceiptV4 } from
  './staged-scene-cut-a8b6-local-composite-admission-v4.mjs'
import { assertA8B6LocalCompositeWorkflowResultV5,
  verifyA8B6LocalCompositeSourceReceiptV5 } from
  './staged-scene-cut-a8b6-local-composite-admission-v5.mjs'
import { assertA8B6LocalCompositeWorkflowResultV6,
  verifyA8B6LocalCompositeSourceReceiptV6 } from
  './staged-scene-cut-a8b6-local-composite-admission-v6.mjs'
import { assertA8B6LocalCompositeWorkflowResultV7,
  verifyA8B6LocalCompositeSourceReceiptV7 } from
  './staged-scene-cut-a8b6-local-composite-admission-v7.mjs'
import { assertA8B6LocalCompositeWorkflowResultV8,
  verifyA8B6LocalCompositeSourceReceiptV8 } from
  './staged-scene-cut-a8b6-local-composite-admission-v8.mjs'
import { assertA8B6LocalCompositeWorkflowResultV9 } from
  './staged-scene-cut-a8b6-local-composite-admission-v9.mjs'
import { getV9VerifiedSource, withV9VerifiedSource } from
  './staged-scene-cut-a8b6-v9-verification-scope.mjs'
import { deriveCompactInputs, saveCompactInputs,
  verifyCompactInputs, deriveCompactInputsWithEndFrame,
  saveCompactInputsWithEndFrame,
  verifyCompactInputsWithEndFrame } from './staged-scene-cut-compact-inputs.mjs'
import { A8B6_A_RETAKE_PARENT_PLAN_ID,
  A8B6_A_RETAKE_PARENT_TASK_ID, A8B6_A_RETAKE_PARENT_VIDEO_SHA256,
  verifyA8B6ARetakeTargetSourceSync } from
  './staged-scene-cut-a8b6-A-retake-target.mjs'
import { verifyA8B6ARetakeTargetReviewSync } from
  './staged-scene-cut-a8b6-A-retake-target-review.mjs'
import { verifyA8B6ARetakeTargetProvenanceAmendmentSync } from
  './staged-scene-cut-a8b6-A-retake-target-provenance-amendment.mjs'

const TIMING_ID = 'record-4x5m31-a8b6-timing-approval-v3'
const TIMING_MD5 = '7024e0652a9fd878ef00a5a2dcec99f8'
const SHOT_SHA = 'f5d04665f0f1be6db954de81c2748fcb41a423cac833e6b94383fad1b5d07fc0'
const SCHEDULE_HASH = 'duration-v2-sha256-ecccd70590dab91eccf4c52d6797f57ecb961a3bb02b7922e4a66bb203b71c18'
const GRAPH_NODES_MD5 = '3ed9cf16e56b311458f4c6fa7e7f1e2e'
const GRAPH_EDGES_MD5 = '1d0a75acb3d4778a122a4cfd96a23b49'
const SHA = /^[a-f0-9]{64}$/
const MD5 = /^[a-f0-9]{32}$/
const invalid = reason => { throw Error(`A8B6_FRESH_LEDGER_INVALID: ${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const dir = (root, planId) => {
  if (!SHA.test(String(planId))) invalid('plan ID invalid')
  return path.join(root, '.runtime/staged-scene-cut-a8b6-fresh', planId)
}
const generatedFile = (root, url, type) => {
  const extension = type === 'video' ? /\.mp4$/i
    : type === 'audio' ? /\.wav$/i : /\.(?:png|jpg|jpeg)$/i
  if (typeof url !== 'string' || !/^\/generated\/[\w.-]+$/.test(url)
    || !extension.test(url)) invalid('generated asset URL invalid')
  return path.join(root, 'public', url.slice(1))
}

/** Image-generation references carry provenance only. The Kling A request
 * below uses the approved image plus the two frozen boards, never the rejected
 * layout frame or this Yan face crop. */
export function assertFreshA8B6ImageReferenceProof(referenceProof, source,
  frozenIdentityPlates, root = process.cwd()) {
  const compact = Array.isArray(referenceProof) ? referenceProof.map(item => ({
    index: item.index, bytes: item.bytes, sha256: item.sha256 })) : []
  const v7 = verifyA8B6FreshV7EditReceiptSync(root)
  const v8 = source?.v8EditReceiptSha256
    ? verifyA8B6FreshV8EditReceiptSync(root) : undefined
  const edit = v8 ?? v7, refs = edit.receipt.referenceOrder
  const v8Expected = Boolean(v8)
  const expectedBytes = v8Expected
    ? [v7.receipt.referenceOrder[0].bytes,
      v7.receipt.referenceOrder[1].bytes,
      refs[2].jpegBytes, refs[3].jpegBytes,
      v7.receipt.referenceOrder[3].bytes]
    : refs.map(ref => ref.bytes)
  const expectedShas = v8Expected
    ? [refs[0].sha256, refs[1].sha256,
      refs[2].jpegSha256, refs[3].jpegSha256, refs[4].jpegSha256]
    : [refs[0].sha256, refs[1].sha256,
      refs[2].jpegSha256, refs[3].jpegSha256]
  if (edit.receiptSha256 !== source?.freshEditReceiptSha256
    || v8Expected && source.v8EditReceiptSha256 !== edit.receiptSha256
    || (v8Expected ? refs[2].sourceSha256
      : edit.receipt.sourceImageSha256) !== source.rejectedLayoutImageSha256
    || !Array.isArray(frozenIdentityPlates)
    || frozenIdentityPlates.length !== 2
    || !Array.isArray(referenceProof)
    || referenceProof.length !== (v8Expected ? 5 : 4)
    || compact.some((item, index) => item.index !== index + 1
      || !Number.isInteger(item.bytes) || item.bytes <= 0
      || !SHA.test(String(item.sha256))
      || item.bytes !== expectedBytes[index]
      || item.sha256 !== expectedShas[index])
    || !isDeepStrictEqual(compact.slice(0, 2).map(item => item.sha256),
      frozenIdentityPlates.map(plate => plate.frontSha256))
    || compact[2].sha256 !== source.rejectedLayoutTransportSha256
    || (v8Expected
      ? refs[2].role !== 'face-masked-layout-only'
        || refs[2].identityAuthority !== false
        || refs[3].role !== 'v4-face-appearance-helper'
        || refs[3].identityAuthority !== false
        || refs[4].role !== 'frozen-yan-original-face-crop'
        || refs[4].identityAuthority !== true
        || refs[4].sourceSha256 !== frozenIdentityPlates[1].frontSha256
        || source.maskedLayoutSourceSha256 !== refs[2].sourceSha256
        || source.maskedLayoutTransportSha256 !== refs[2].jpegSha256
        || source.v4FaceHelperSourceSha256 !== refs[3].sourceSha256
        || source.v4FaceHelperTransportSha256 !== refs[3].jpegSha256
        || source.frozenFaceCropSourceSha256 !== refs[4].sourceSha256
        || source.frozenFaceCropJpegSha256 !== refs[4].jpegSha256
        || canonical(source.frozenFaceCropBox) !== canonical(refs[4].crop)
        || source.v8SourceSelectionClarificationSha256
          !== edit.receipt.sourceSelectionClarificationSha256
      : refs[2].role !== 'rejected-layout-only'
        || refs[3].role !== 'frozen-face-crop'
        || refs[3].identityAuthority !== true
        || refs[3].sourceSha256 !== frozenIdentityPlates[1].frontSha256))
    invalid('signed image references or their authority changed')
  return { editReceiptSha256: edit.receiptSha256,
    referenceVariant: v8Expected ? 'v8-five-reference' : 'v7-four-reference',
    frozenFaceCropTransportSha256:
      compact[v8Expected ? 4 : 3].sha256 }
}

export function assertFreshA8B6DualOutputSource(source,
  root = process.cwd()) {
  const fields = [source?.dualOutputRecoveryReceiptSha256,
    source?.dualOutputClarificationSha256,
    source?.dualOutputSelectedSha256,
    source?.dualOutputUnselectedSha256,
    source?.dualOutputThreadId]
  if (!fields.some(Boolean)) return undefined
  if (!fields.every(Boolean)) invalid('partial failed-ledger selection in A plan')
  const signed = verifyA8B6V7DualOutputRecoveryReceipt(root)
  const clarification = verifyA8B6V7DualOutputClarification(root)
  const receipt = signed.receipt
  if (source.dualOutputRecoveryReceiptSha256 !== signed.receiptSha256
    || source.dualOutputClarificationSha256
      !== clarification.clarificationSha256
    || source.dualOutputSelectedSha256 !== receipt.selectedSourceSha256
    || source.dualOutputUnselectedSha256 !== receipt.unselectedSourceSha256
    || source.dualOutputThreadId !== receipt.threadId
    || source.freshFrameExecutionId !== receipt.targetExecutionId
    || source.imagePaymentExecutionId !== receipt.failedExecutionId
    || source.imageModelExecutionId !== receipt.failedImageModelExecutionId
    || source.approvedFirstFrameUrl !== receipt.imageUrl
    || source.approvedFirstFrameSha256 !== receipt.normalizedImageSha256
    || source.freshEditReceiptSha256 !== receipt.editReceiptSha256)
    invalid('failed-ledger selection or approved normalized image changed')
  return signed
}
async function key(root) {
  const value = await readFile(path.join(root, '.runtime/staged-scene-cut.key'))
  if (value.length !== 32) invalid('staging signing key invalid')
  return value
}
function signature(value, secret) {
  const { signature: _signature, ...body } = value
  void _signature
  return createHmac('sha256', secret).update(canonical(body)).digest('hex')
}
function verifySignature(value, secret) {
  const actual = String(value?.signature ?? ''), expected = signature(value, secret)
  if (!SHA.test(actual)
    || !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex')))
    invalid('signed ledger artifact changed')
}
async function writeOnce(filename, bytes) {
  await mkdir(path.dirname(filename), { recursive: true })
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  try { await writeFile(filename, value, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(filename)).equals(value))
      invalid(`existing source-bound artifact differs: ${filename}`)
  }
}
async function signOnce(root, planId, name, body) {
  const value = { ...body, signature: '' }
  value.signature = signature(value, await key(root))
  const filename = path.join(dir(root, planId), name)
  await writeOnce(filename, JSON.stringify(value, null, 2) + '\n')
  return { value, sha256: sha(await readFile(filename)) }
}
async function readSigned(root, planId, name) {
  const bytes = await readFile(path.join(dir(root, planId), name))
  const value = JSON.parse(bytes.toString('utf8'))
  verifySignature(value, await key(root))
  return { value, sha256: sha(bytes) }
}

export function freshA8B6PhaseAPrompt() {
  return [
    '16:9 真人实景，单机位连续八秒。首帧严格使用已审江州街口新图；张飞和严颜两名具名人物及首帧全部已批准军士保持各自脸、须发、冠、甲、袍摆和靴连续，具名人物以各自冻结身份参考为准。画内所有人物全程无语言声和语言口型。',
    '0–2.5秒：左侧张飞抬手示意，左右军士在原位合拢，封住严颜身前的缺口；严颜站立，双手仍清楚可见。',
    '2.5–7.5秒：两名军士在严颜身前并腕、绕绳、收紧、打结，过程持续可见。严颜深色头发和颏须保持原参考的深色成熟人设；外摆、黑色内摆与露出裤腿和靴的比例保持原参考。',
    '7.5–8秒：绳结完成并保持可见，两名军士双手从腕绳自然抽离；第八秒画面保留双手离腕、绳结完整的连续动作，供下一段原生尾帧接续。张飞仍在原左侧位置，尚未走近或说话。',
    '全段保持同一街景、机位、真实动作速度和全部原有人物位置连续；没有字幕、可读文字、跳切或额外人物。',
  ].join('\n')
}

export function freshA8B6PhaseARetakePrompt() {
  return [
    '16:9 真人实景，单机位连续八秒。首帧严格使用 V9 已独立审核的新图；尾帧使用单独审核的目标引导图。四人及街景、脸、须发、冠、甲、袍摆、靴和机位全程连续。画内人物没有语言声、语言口型、字幕或跳切。',
    '0–2.5秒：左侧张飞抬手示意但始终留在原左侧站位，两名军士从左右在严颜身前封住缺口。严颜站立，双腕与手指清楚可见。',
    '2.5–6.8秒：两名军士把严颜两只手腕在腹部正前方自然并拢，使用同一根麻绳同时绕过两只手腕，持续可见地收紧，并在两腕之间打出清楚的已完成绳结。绳只束双腕，不绕腰、上臂或躯干；不产生从腰部横跨的绳圈或垂绳。',
    '6.8–7.2秒：军士完成腕结并从严颜腕部撤手，双手回到自己身侧。严颜两只手仍在腹前，腕间绳结完整可见，手指外露。',
    '7.2–8秒：保持守卫已撤手、双腕已绑、张飞仍在左侧原站位的稳定同机位尾段，供下一段使用实际原生尾帧接续。不得用目标引导图替代真实生成动作，也不得在第八秒突然切换。',
    '只允许真实速度的连贯绑腕动作；没有腰绳、臂绳、字幕、可读文字、新人物或场景切换。',
  ].join('\n')
}

export function freshA8B6PhaseBPrompt() {
  return [
    '16:9 真人实景，同一街口同一机位连续六秒。首帧严格接上刚验收的 A 段真实原生尾帧，严颜身前腕绳结完整，全部原有人物的脸、须发、甲、袍摆与露靴比例连续；画内人物无语言声和语言口型。',
    '0–1.25秒：两名军士已从腕绳撤手，双手留在各自身侧，向侧后方退到看押位；严颜双腕和绳结持续清楚可见。',
    '1.25–5秒：张飞从左侧原站位沿街口自然走近严颜，不遮住身前绳结；约第5秒双脚落定、停止前进。',
    '5–6秒：张飞站稳与严颜相对，军士两侧看押，仅有呼吸与衣摆轻动，留下稳定的真实尾帧。严颜不回答。',
    '保持真实摄影速度与同一光线，不新增人物、腰绳、字幕、可读文字或场景切换。',
  ].join('\n')
}

/** A B-only retake keeps the accepted A native tail. The end guide is a
 * generation target, never proof that a generated B preserved the knot. */
export function freshA8B6PhaseBRetakePrompt() {
  return [
    '16:9 真人实景，江州街口同一机位连续六秒。首帧只能使用已验收 A 段的实际原生尾帧；尾帧图仅为第六秒构图和腕结目标，不得把静图当成中间动作。全段与首帧的两名具名人物、两名军士、脸、甲袍、街景和光线连续，所有人无语言声、语言口型、字幕或跳切。',
    '严颜两只手腕在腹部正前方由同一根麻绳并拢捆住，两腕之间已经完成的清楚绳结从第零秒到第六秒始终存在并可见。双手指保持外露。绝不松开、消失、换成腰带或绑腰；严颜不把双手藏在袖内。',
    '0–1.25秒：军士已从腕部撤手并退到两侧看押位，不再碰严颜的双腕。严颜维持前腕绳结，保持静止。',
    '1.25–5秒：张飞由左侧原站位自然走近严颜，不遮挡腕结；约第五秒双脚落定停止。严颜仅抬头看他，不解绳、不说话。',
    '5–6秒：张飞站稳，严颜双腕仍并拢、绳结清楚，军士分列两侧；保持真实速度的稳定尾秒，实际原生尾帧应与目标引导图的空间关系一致。',
    '没有新人物、道具、腰绳、臂绳、可读文字或场景切换。',
  ].join('\n')
}

/** A new immutable request after the first B-only take repeated tying. Keep
 * the prior prompt unchanged so its signed paid request still recomputes. */
export function freshA8B6PhaseBSecondRetakePrompt() {
  return [
    '16:9 真人实景，江州同一街口同一机位连续六秒。只从已验收 A 的真实原生尾帧接入；新末帧图仅规定第六秒目标，不代表中间动作。四名原有人物、身份、脸、甲袍、街景、光线保持连续，全段无语言声、语言口型、字幕、跳切。',
    '首帧严颜双腕在腹部正前方已由同一根麻绳绑好，两腕之间有清楚的前腕绳结；从 0 到 6 秒每一瞬间绳结都保持原位可见，双腕不可分开，不能改为腰绳、臂绳或新绑缚。',
    '关键动作不可倒退：首帧两名军士已经松开严颜双腕，绑绳工序已完成。0–1.25 秒他们只继续向侧后方撤离，双臂自然垂在身体两侧；绝不转身返回、靠近严颜、伸手到腕部、触碰或重新抓住绳结。',
    '1.25–3 秒两名军士持续退到严颜身后及画面右边缘，离严颜至少两个人体宽度，双臂始终下垂。张飞从左侧原站位开始自然走近；军士绝不回身、返步、回到双腕旁、调整已经打好的结。',
    '3–5 秒军士只在远侧看押位停住，不靠近严颜，不抬臂、不碰绳。张飞继续走近严颜并约在第五秒双脚落定；严颜仅抬头看张飞，双腕绳结全程清楚。',
    '5–6 秒张飞近身站稳，军士仍在远侧、双臂下垂，绝不重新抓腕或绳结；保持真实速度的稳定尾秒，原生尾帧与目标引导图的空间位置相符。',
    '全 0–6 秒禁止任何军士再次接触严颜、已完成的绳结或两只手腕；没有补绑、重新打结、折返、腰绳、新人物、可读文字或场景切换。',
  ].join('\n')
}

/** New immutable B request after a B2 upper-arm contact. Keep signed B1/B2
 * prompts unchanged; this take leaves both guards at their accepted A posts. */
export function freshA8B6PhaseBThirdRetakePrompt() {
  return [
    '16:9 真人实景，江州同一街口同一固定机位连续六秒。首帧只能接已验收 A 的真实原生尾帧；目标末帧图仅规定约第六秒构图，不证明中间动作。四名原有人物的身份、脸、服装、街景、光线全部连续；无语言声、语言口型、字幕或跳切。',
    '严颜双手腕在腹部正前方已由一根麻绳捆在一起，两腕之间的结清楚可见。从第 0 秒到第 6 秒每一瞬间，腕结和并拢双腕始终在原位清楚可见；不能松开、消失、改成腰绳或臂绳，也不能让袖子或张飞遮挡腕结。严颜只可轻微抬头看张飞，不说话。',
    '两名戴盔军士在 A 尾帧已经完成绑绳并松手。全程保持 A 尾帧各自的看押区域与自然站姿：一人仍在严颜左后方的中央背景，一人仍在画面最右侧。手保持在各自身体旁或原有靠腰姿态，始终远离严颜。两人全 0–6 秒不走近、不撤离、不折返、不抬手、不伸手、不碰严颜身体、手腕或绳结，不再参与任何绑绳动作。',
    '0–1.25 秒：同一真实首帧自然延续；严颜已被绑好，两名军士原地看押并保持手离人；张飞仍在左侧原站位。画面没有新动作或重绑。',
    '1.25–5 秒：只有张飞从左侧原站位以真实速度走近严颜；军士维持原看押位置和手势，不与严颜发生接触。约第五秒张飞双脚落定停止，站在严颜左侧近处，严颜双腕绳结仍完整露出。',
    '5–6 秒：张飞与严颜在近处对视并站稳，军士在原看押区域保持静止、手远离严颜；整整最后一秒是稳定自然尾段，原生尾帧与目标末帧图的空间关系相符。',
    '任何时刻都禁止军士再次接触严颜的上臂、身体、双腕或绳结；没有补绑、解绳、腰绳、新人物、可读文字或场景切换。',
  ].join('\n')
}

function buildRequest(prompt, firstBytes, identityBytes, duration,
  endBytes = undefined) {
  const request = buildKlingVideoRequest({ settings: { model: 'kling-v3-omni' } },
    prompt, { referenceImage: `data:image/jpeg;base64,${firstBytes.toString('base64')}`,
      referenceImages: identityBytes.map(bytes =>
        `data:image/jpeg;base64,${bytes.toString('base64')}`),
      ...(endBytes ? { endImage:
        `data:image/jpeg;base64,${endBytes.toString('base64')}` } : {}),
      duration, mode: 'std', model_name: 'kling-v3-omni', sound: 'off',
      pacingVersion: 'independent-narration-v1', audioType: '环境声', audioText: '',
      promptOverflowPolicy: 'reject' })
  const types = request.image_list?.map(item => item.type ?? 'reference')
  const imageShas = request.image_list?.map(item =>
    sha(Buffer.from(item.image_url, 'base64')))
  if (request.model_name !== 'kling-v3-omni' || request.duration !== String(duration)
    || request.mode !== 'std' || request.sound !== 'off'
    || request.multi_shot !== undefined
    || !isDeepStrictEqual(types, endBytes
      ? ['reference', 'reference', 'first_frame', 'end_frame']
      : ['reference', 'reference', 'first_frame'])
    || !isDeepStrictEqual(imageShas,
      [...identityBytes.map(sha), sha(firstBytes),
        ...(endBytes ? [sha(endBytes)] : [])])
    || Array.from(request.prompt).length > 2500
    || Buffer.byteLength(JSON.stringify(request)) > 2_000_000)
    invalid('new A/B provider request lost exact first-frame and identity bindings')
  return { request, requestSha256: sha(canonical(request)),
    requestByteLength: Buffer.byteLength(JSON.stringify(request)),
    promptSha256: sha(request.prompt), imageTypes: types,
    firstFrameTransportSha256: sha(firstBytes),
    identityTransportSha256s: identityBytes.map(sha),
    ...(endBytes ? { endFrameTransportSha256: sha(endBytes) } : {}),
    duration }
}

export function previewFreshA8B6PhaseARetake(firstFrameJpegBytes,
  identityJpegBytes, endFrameJpegBytes) {
  const images = [firstFrameJpegBytes, ...(identityJpegBytes ?? []),
    endFrameJpegBytes]
  if (!Array.isArray(identityJpegBytes) || identityJpegBytes.length !== 2
    || images.some(bytes => !Buffer.isBuffer(bytes) || bytes.length < 1000
      || bytes[0] !== 0xff || bytes[1] !== 0xd8))
    invalid('retake A lacks approved first, identities or target guide JPEG')
  return buildRequest(freshA8B6PhaseARetakePrompt(), firstFrameJpegBytes,
    identityJpegBytes, 8, endFrameJpegBytes)
}

/** Build the A plan only after node50 signed a new image under timing-v3. */
export async function planFreshA8B6PhaseA(preflight, candidate,
  providerLock, root = process.cwd()) {
  if (candidate?.localCompositeSourceReceiptSha256) {
    if (candidate.frameProvenanceVariant !== undefined
      && !['a8b6-local-composite-v1', 'a8b6-local-composite-v2',
        'a8b6-local-composite-v3', 'a8b6-local-composite-v4',
        'a8b6-local-composite-v5', 'a8b6-local-composite-v6',
        'a8b6-local-composite-v7', 'a8b6-local-composite-v8',
        'a8b6-local-composite-v9']
        .includes(candidate.frameProvenanceVariant))
      invalid('local first-frame provenance variant unknown')
    return planFreshA8B6PhaseALocal(preflight, candidate, providerLock, root)
  }
  const { sourceRow, timingRow, imageLedger,
    editReceiptSha256: candidateEditReceiptSha256,
    v8EditReceiptSha256, maskedLayoutSourceSha256,
    maskedLayoutTransportSha256, v4FaceHelperSourceSha256,
    v4FaceHelperTransportSha256, frozenFaceCropSourceSha256,
    frozenFaceCropJpegSha256, frozenFaceCropBox,
    referenceProof,
    rejectedLayoutImageSha256: candidateRejectedLayoutImageSha256,
    rejectedLayoutTransportSha256: candidateRejectedLayoutTransportSha256,
    approvedFirstFrameUrl,
    approvedFirstFrameSha256, frameCertificateSha256,
    dualOutputRecoveryReceiptSha256, dualOutputSelectedSha256,
    dualOutputUnselectedSha256, dualOutputThreadId,
    imagePaymentExecutionId } = candidate ?? {}
  const editReceiptSha256 = v8EditReceiptSha256
    ?? candidateEditReceiptSha256
  const v8 = Boolean(v8EditReceiptSha256)
  const rejectedLayoutImageSha256 = candidateRejectedLayoutImageSha256
    ?? maskedLayoutSourceSha256
  const rejectedLayoutTransportSha256 =
    candidateRejectedLayoutTransportSha256 ?? maskedLayoutTransportSha256
  const fresh = decodeExecutionState(sourceRow?.result)
  const timing = decodeExecutionState(timingRow?.result)
  const runs = fresh?.nodeRuns, parentRuns = timing?.nodeRuns
  const marker = fresh?.sceneCutA8B6FreshFrameRecovery
  if (preflight?.version !== 'a8b6-fresh-regeneration-preflight-v1'
    || preflight.status !== 'ready-for-fresh-first-frame-planning-only'
    || preflight.providerAuthorization !== false
    || !/^record-[\w-]+$/.test(String(sourceRow?.id))
    || !MD5.test(String(sourceRow?.result_md5))
    || fresh?.id !== sourceRow.id
    || sourceRow.workflow_id !== 'wf-sanguo-history-drama'
    || timingRow?.id !== TIMING_ID || timingRow.result_md5 !== TIMING_MD5
    || !Array.isArray(runs) || runs.length !== 464
    || !Array.isArray(parentRuns) || parentRuns.length !== 464
    || !isDeepStrictEqual(runs.slice(0, 45), parentRuns.slice(0, 45))
    || !/^scene-cut-a8b6-fresh-first-frame-v[1-9]\d*-edit$/.test(
      String(marker?.version))
    || marker.qaPlanId !== preflight.source.qaPlanId
    || marker.sourceExecutionId !== TIMING_ID
    || marker.sourceResultMd5 !== TIMING_MD5
    || marker.editReceiptSha256 !== editReceiptSha256
    || marker.workflowSchemaVersion !== 180
    || marker.workflowNodesMd5 !== GRAPH_NODES_MD5
    || marker.workflowEdgesMd5 !== GRAPH_EDGES_MD5
    || runs[45]?.status !== 'success'
    || runs[48]?.status !== 'success'
    || runs[49]?.status !== 'success'
    || runs[49].output?.passed !== true
    || !isDeepStrictEqual(runs[49].output?.issues, [])
    || runs[50]?.status !== 'success'
    || runs.slice(51).some(run => run.status !== 'idle')
    || sceneCutShotSha256(runs[11].output) !== SHOT_SHA
    || runs[11].output.scheduleHash !== SCHEDULE_HASH
    || providerLock?.modelId !== 'keling3'
    || !SHA.test(String(providerLock.endpointSha256))
    || !SHA.test(String(editReceiptSha256))
    || !SHA.test(String(rejectedLayoutImageSha256))
    || !SHA.test(String(rejectedLayoutTransportSha256))
    || v8 && candidateEditReceiptSha256 !== undefined
      && candidateEditReceiptSha256 !== v8EditReceiptSha256
    || v8 && candidateRejectedLayoutImageSha256 !== undefined
      && candidateRejectedLayoutImageSha256 !== maskedLayoutSourceSha256
    || v8 && candidateRejectedLayoutTransportSha256 !== undefined
      && candidateRejectedLayoutTransportSha256 !== maskedLayoutTransportSha256)
    invalid('approved new first-frame candidate is not source-bound')
  const cert = verifySceneCutFrameApproval(runs[50].output, root)
  const image = runs[45].output
  const imageSha = cert.sourceSha256s?.[0]
  const plates = cert.identityPlateBindings
  const compactProof = Array.isArray(referenceProof)
    ? referenceProof.map(item => ({ index: item.index,
      bytes: item.bytes, sha256: item.sha256 })) : []
  const signedV8 = v8 ? await verifyA8B6FreshV8EditReceipt(root) : undefined
  const referenceSource = { freshEditReceiptSha256: editReceiptSha256,
    rejectedLayoutImageSha256, rejectedLayoutTransportSha256,
    ...(v8 ? { v8EditReceiptSha256, maskedLayoutSourceSha256,
      maskedLayoutTransportSha256, v4FaceHelperSourceSha256,
      v4FaceHelperTransportSha256, frozenFaceCropSourceSha256,
      frozenFaceCropJpegSha256, frozenFaceCropBox,
      v8SourceSelectionClarificationSha256:
        signedV8.receipt.sourceSelectionClarificationSha256 } : {}) }
  const signedReferences = assertFreshA8B6ImageReferenceProof(referenceProof,
    referenceSource, preflight.frozenIdentityPlates, root)
  const imagePaymentId = String(imageLedger?.request_data?.requestKey ?? '')
    .split(':')[0]
  const dualFields = [dualOutputRecoveryReceiptSha256,
    dualOutputSelectedSha256, dualOutputUnselectedSha256,
    dualOutputThreadId]
  if (dualFields.some(Boolean) && !dualFields.every(Boolean))
    invalid('partial failed-ledger dual-output provenance')
  const recovered = dualFields.every(Boolean)
  if (v8 && recovered) invalid('V8 paid image cannot reuse V7 recovery image ledger')
  const signedRecovery = recovered
    ? await verifyA8B6V7DualOutputRecoveryReceiptAsync(root) : undefined
  const signedClarification = recovered
    ? verifyA8B6V7DualOutputClarification(root) : undefined
  const selection = signedRecovery?.receipt
  const expectedImagePrompt = recovered
    ? renderWorkflowTemplate(runs[45].node.prompt, {
      shot_script: runs[11].output,
      scene_cut_sources: runs[41].output,
      scene_cut_opening_state: runs[43].output,
    }) : image.prompt
  const recoveredLedger = recovered && (
    signedRecovery.receiptSha256 === dualOutputRecoveryReceiptSha256
    && selection.selectedSourceSha256 === dualOutputSelectedSha256
    && selection.unselectedSourceSha256 === dualOutputUnselectedSha256
    && selection.threadId === dualOutputThreadId
    && selection.failedImageModelExecutionId === imageLedger?.id
    && selection.failedExecutionId === imagePaymentId
    && imagePaymentExecutionId === imagePaymentId
    && fresh.parentExecutionId === imagePaymentId
    && fresh.sceneCutA8B6V7DualOutputRecovery?.version
      === 'scene-cut-a8b6-v7-dual-output-recovery-v1'
    && fresh.sceneCutA8B6V7DualOutputRecovery.parentResultMd5
      === selection.failedResultMd5
    && fresh.sceneCutA8B6V7DualOutputRecovery.receiptSha256
      === signedRecovery.receiptSha256
    && fresh.sceneCutA8B6V7DualOutputRecovery.normalizedImageSha256
      === selection.normalizedImageSha256
    && image.url === selection.imageUrl
    && imageSha === selection.normalizedImageSha256
    && image.sourceBoundDualOutput?.receiptSha256
      === signedRecovery.receiptSha256
    && image.prompt === runs[45].node.prompt
    && imageLedger.status === 'failed'
    && imageLedger.error
      === 'CODEX_IMAGE_COUNT_INVALID: 本次线程必须恰好保存1张 PNG 图片'
    && imageLedger.request_data?.params?.sceneCutFreshEditReceipt?.signature
      === verifyA8B6FreshV7EditReceiptSync(root).receipt.signature
    && isDeepStrictEqual(imageLedger.request_data?.params
      ?.sceneCutFreshImage, marker)
    && imageLedger.response_data?.raw?.imageCount === 2
    && imageLedger.response_data.raw.threadId === dualOutputThreadId
    && isDeepStrictEqual(imageLedger.response_data.raw.references,
      compactProof))
  const ordinaryLedger = !recovered && imageLedger?.status === 'succeeded'
    && imageLedger.request_data?.sceneCutFreshEditReceiptSha256
      === editReceiptSha256
    && (!v8 || imageLedger.request_data?.params
      ?.sceneCutFreshEditReceipt?.signature === signedV8.receipt.signature)
    && imageLedger.response_data?.raw?.image?.sha256 === imageSha
    && imageLedger.response_data?.data?.[0]?.url === image.url
  if (cert.passed !== true || cert.shotSha256 !== SHOT_SHA
    || cert.repairBinding !== undefined
    || cert.frame?.sourceUrl !== image?.url
    || image.url !== approvedFirstFrameUrl
    || imageSha !== approvedFirstFrameSha256
    || sceneCutRebindSha256(cert) !== frameCertificateSha256
    || !SHA.test(String(imageSha))
    || preflight.forbiddenSources.some(item => item.sha256 === imageSha)
    || !Array.isArray(plates) || plates.length !== 2
    || plates.map(plate => plate.characterName).join(',') !== '张飞,严颜'
    || !isDeepStrictEqual(plates.map(plate => [plate.characterName,
      plate.sourceSha256, plate.frontSha256]),
      preflight.frozenIdentityPlates.map(plate => [plate.characterName,
        plate.sourceSha256, plate.frontSha256]))
    || signedReferences.referenceVariant
      !== (v8 ? 'v8-five-reference' : 'v7-four-reference')
    || signedV8 && (signedV8.receiptSha256 !== v8EditReceiptSha256
      || signedV8.receipt.targetExecutionId !== sourceRow.id)
    || !Array.isArray(referenceProof)
    || referenceProof.length !== (v8 ? 5 : 4)
    || compactProof.some((item, index) => item.index !== index + 1
      || !Number.isInteger(item.bytes) || item.bytes <= 0
      || !SHA.test(String(item.sha256)))
    || !isDeepStrictEqual(compactProof.slice(0, 2).map(item => item.sha256),
      plates.map(plate => plate.frontSha256))
    || compactProof[2].sha256 !== rejectedLayoutTransportSha256
    || !/^model-run-[\w-]+$/.test(String(imageLedger?.id))
    || !(recovered ? recoveredLedger : ordinaryLedger)
    || imageLedger.model_id !== 'codex-gpt-image-2'
    || imageLedger.provider !== 'Codex'
    || imageLedger.capability !== 'image'
    || imageLedger.workflow_id !== 'wf-sanguo-history-drama'
    || imageLedger.node_id !== 'sanguo-scene-cut-first-frame'
    || ![sourceRow.id, fresh.parentExecutionId].includes(imagePaymentId)
    || !SHA.test(String(imageLedger.request_data?.fingerprint))
    || imageLedger.request_data?.prompt !== expectedImagePrompt
    || imageLedger.response_data?.raw?.promptSha256
      !== sha(expectedImagePrompt)
    || !isDeepStrictEqual(imageLedger.response_data?.raw?.references,
      compactProof)
    || sha(readFileSync(generatedFile(root, image.url, 'image')))
      !== imageSha)
    invalid('new approved image, native reference roles or image ledger differ')
  const compact = await deriveCompactInputs([
    { role: 'first_frame', url: image.url, sha256: imageSha },
    ...plates.map((plate, index) => ({ role: `identity_${index + 1}`,
      url: plate.sourceUrl, sha256: plate.sourceSha256 })),
  ], root)
  const preview = buildRequest(freshA8B6PhaseAPrompt(), compact.buffers[0],
    compact.buffers.slice(1), 8)
  const { buffers: _buffers, ...transport } = compact
  void _buffers
  const body = { version: 'staged-a8b6-fresh-A-plan-v1',
    source: { ...preflight.source,
      freshFrameExecutionId: sourceRow.id,
      freshFrameResultMd5: sourceRow.result_md5,
      freshFrameMarkerSha256: sha(canonical(marker)),
      freshEditReceiptSha256: editReceiptSha256,
      rejectedLayoutImageSha256,
      rejectedLayoutTransportSha256,
      ...(v8 ? { v8EditReceiptSha256,
        maskedLayoutSourceSha256, maskedLayoutTransportSha256,
        v4FaceHelperSourceSha256, v4FaceHelperTransportSha256,
        frozenFaceCropSourceSha256, frozenFaceCropJpegSha256,
        frozenFaceCropBox,
        v8SourceSelectionClarificationSha256:
          signedV8.receipt.sourceSelectionClarificationSha256 } : {}),
      approvedShotSha256: SHOT_SHA, scheduleHash: SCHEDULE_HASH,
      frameCertificateSha256: sceneCutRebindSha256(cert),
      approvedFirstFrameUrl: image.url,
      approvedFirstFrameSha256: imageSha,
      imagePaymentExecutionId: imagePaymentId,
      imageModelExecutionId: imageLedger.id,
      imageRequestFingerprint: imageLedger.request_data.fingerprint,
      ...(recovered ? { dualOutputRecoveryReceiptSha256,
        dualOutputClarificationSha256:
          signedClarification.clarificationSha256,
        dualOutputSelectedSha256, dualOutputUnselectedSha256,
        dualOutputThreadId } : {}),
      frameReviewModelExecutionId: cert.reviewExecutionId },
    imageReferenceProof: referenceProof,
    frozenIdentityPlates: preflight.frozenIdentityPlates,
    narrationTracks: preflight.approved14s.narrationTracks,
    forbiddenSources: preflight.forbiddenSources,
    providerLock, compactTransport: transport,
    phaseA: { providerSeconds: 8, nativeFps: 24,
      firstFrameRole: 'new-certificate-image-only',
      endFrame: null, sound: 'off', acceptance: 'pending-native-review' },
    phaseAPreview: { ...preview, request: undefined },
    acceptanceState: 'A-request-ready-only; no provider task or media accepted' }
  return { ...body, planId: sha(canonical(body)), compactBuffers: compact.buffers }
}

/** New variant: source-bound local pixels, then a genuinely new node49 model
 * review and node50 certificate. No new image-model ledger is permitted. */
export async function planFreshA8B6PhaseALocal(preflight, candidate,
  providerLock, root = process.cwd()) {
  if (candidate?.frameProvenanceVariant !== undefined
    && !['a8b6-local-composite-v1', 'a8b6-local-composite-v2',
      'a8b6-local-composite-v3', 'a8b6-local-composite-v4',
      'a8b6-local-composite-v5', 'a8b6-local-composite-v6',
        'a8b6-local-composite-v7', 'a8b6-local-composite-v8',
        'a8b6-local-composite-v9']
      .includes(candidate.frameProvenanceVariant))
    invalid('local first-frame provenance variant unknown')
  const localV9 = candidate?.frameProvenanceVariant
    === 'a8b6-local-composite-v9'
  const localV8 = candidate?.frameProvenanceVariant
    === 'a8b6-local-composite-v8'
  const localV7 = candidate?.frameProvenanceVariant
    === 'a8b6-local-composite-v7'
  const localV6 = candidate?.frameProvenanceVariant
    === 'a8b6-local-composite-v6'
  const localV5 = candidate?.frameProvenanceVariant
    === 'a8b6-local-composite-v5'
  const localV4 = candidate?.frameProvenanceVariant
    === 'a8b6-local-composite-v4'
  const localV3 = candidate?.frameProvenanceVariant
    === 'a8b6-local-composite-v3'
  const localV2 = candidate?.frameProvenanceVariant
    === 'a8b6-local-composite-v2'
  const signed = localV9
    ? await getV9VerifiedSource(root)
    : localV8 ? await verifyA8B6LocalCompositeSourceReceiptV8(root)
    : localV7 ? await verifyA8B6LocalCompositeSourceReceiptV7(root)
    : localV6 ? await verifyA8B6LocalCompositeSourceReceiptV6(root)
    : localV5 ? await verifyA8B6LocalCompositeSourceReceiptV5(root)
    : localV4 ? await verifyA8B6LocalCompositeSourceReceiptV4(root)
    : localV3 ? await verifyA8B6LocalCompositeSourceReceiptV3(root)
    : localV2 ? await verifyA8B6LocalCompositeSourceReceiptV2(root)
    : await verifyA8B6LocalCompositeSourceReceipt(root)
  const { sourceRow, timingRow, imageLedgers, reviewLedger,
    localCompositeSourceReceiptSha256, approvedFirstFrameUrl,
    approvedFirstFrameSha256, frameCertificateSha256 } = candidate ?? {}
  const fresh = decodeExecutionState(sourceRow?.result)
  const timing = decodeExecutionState(timingRow?.result)
  const runs = fresh?.nodeRuns, parentRuns = timing?.nodeRuns
  const marker = fresh?.sceneCutA8B6LocalFrameRecovery
  if (preflight?.version !== 'a8b6-fresh-regeneration-preflight-v1'
    || preflight.status !== 'ready-for-fresh-first-frame-planning-only'
    || preflight.providerAuthorization !== false
    || sourceRow?.id !== signed.receipt.target.executionId
    || !MD5.test(String(sourceRow?.result_md5))
    || fresh?.id !== sourceRow.id
    || fresh.parentExecutionId !== TIMING_ID
    || sourceRow.workflow_id !== 'wf-sanguo-history-drama'
    || timingRow?.id !== TIMING_ID || timingRow.result_md5 !== TIMING_MD5
    || !Array.isArray(runs) || runs.length !== 464
    || !Array.isArray(parentRuns) || parentRuns.length !== 464
    || !isDeepStrictEqual(runs.slice(0, 45), parentRuns.slice(0, 45))
    || marker?.version !== (localV9
      ? 'scene-cut-a8b6-local-first-frame-v9'
      : localV8 ? 'scene-cut-a8b6-local-first-frame-v8'
      : localV7 ? 'scene-cut-a8b6-local-first-frame-v7'
      : localV6 ? 'scene-cut-a8b6-local-first-frame-v6'
      : localV5 ? 'scene-cut-a8b6-local-first-frame-v5'
      : localV4 ? 'scene-cut-a8b6-local-first-frame-v4'
      : localV3 ? 'scene-cut-a8b6-local-first-frame-v3'
      : localV2 ? 'scene-cut-a8b6-local-first-frame-v2'
      : 'scene-cut-a8b6-local-first-frame-v1')
    || marker.sourceReceiptSha256 !== signed.receiptSha256
    || marker.workflowSchemaVersion !== 180
    || marker.workflowNodesMd5 !== GRAPH_NODES_MD5
    || marker.workflowEdgesMd5 !== GRAPH_EDGES_MD5
    || marker.preservedPrefixLength !== 45
    || marker.preservedPrefixSha256 !== sha(canonical(parentRuns.slice(0, 45)))
    || runs.slice(51).some(run => run.status !== 'idle')
    || sceneCutShotSha256(runs[11].output) !== SHOT_SHA
    || runs[11].output.scheduleHash !== SCHEDULE_HASH
    || providerLock?.modelId !== 'keling3'
    || !SHA.test(String(providerLock.endpointSha256))
    || localCompositeSourceReceiptSha256 !== signed.receiptSha256
    || (localV2 && (
      candidate.imageGenRawSha256 !== signed.receipt.sources[1].sha256
      || candidate.imageGenPromptSha256
        !== signed.receipt.imageGen.promptSha256
      || candidate.priorLocalV1RejectedReviewSha256
        !== signed.receipt.priorLocalV1.rejectedReviewSha256
      || candidate.localCompositeAlgorithmSha256
        !== signed.receipt.algorithm.implementationSha256))
    || (localV3 && (
      candidate.wallImageGenRawSha256 !== signed.receipt.sources[1].sha256
      || candidate.faceImageGenRawSha256 !== signed.receipt.sources[2].sha256
      || candidate.gateFrameImageGenRawSha256
        !== signed.receipt.sources[3].sha256
      || candidate.priorLocalV2RejectedReviewSha256
        !== signed.receipt.priorLocalV2.rejectedReviewSha256
      || candidate.localCompositeAlgorithmSha256
        !== signed.receipt.algorithm.implementationSha256))
    || (localV4 && (
      candidate.wallImageGenRawSha256 !== signed.receipt.sources[1].sha256
      || candidate.priorLocalV3RejectedReviewSha256
        !== signed.receipt.priorLocalV3.rejectedReviewSha256
      || candidate.localCompositeAlgorithmSha256
        !== signed.receipt.algorithm.implementationSha256))
    || (localV5 && (
      candidate.wallImageGenRawSha256 !== signed.receipt.sources[1].sha256
      || candidate.priorLocalV4RejectedReviewSha256
        !== signed.receipt.priorLocalV4.rejectedReviewSha256
      || candidate.localCompositeAlgorithmSha256
        !== signed.receipt.algorithm.implementationSha256))
    || (localV6 && (
      candidate.wallImageGenRawSha256 !== signed.receipt.sources[1].sha256
      || candidate.priorLocalV5RejectedReviewSha256
        !== signed.receipt.priorLocalV5.rejectedReviewSha256
      || candidate.localCompositeAlgorithmSha256
        !== signed.receipt.algorithm.implementationSha256))
    || (localV7 && (
      candidate.wallImageGenRawSha256 !== signed.receipt.sources[1].sha256
      || candidate.priorLocalV6RejectedReviewSha256
        !== signed.receipt.priorLocalV6.rejectedReviewSha256
      || candidate.localCompositeAlgorithmSha256
        !== signed.receipt.algorithm.implementationSha256))
    || (localV8 && (
      candidate.wallImageGenRawSha256 !== signed.receipt.sources[1].sha256
      || candidate.priorLocalV7RejectedReviewSha256
        !== signed.receipt.priorLocalV7.rejectedReviewSha256
      || candidate.localCompositeAlgorithmSha256
        !== signed.receipt.algorithm.implementationSha256))
    || (localV9 && (
      candidate.wallImageGenRawSha256 !== signed.receipt.sources[1].sha256
      || candidate.priorLocalV8SourceReceiptSha256
        !== signed.receipt.priorLocalV8.sourceReceiptSha256
      || candidate.priorLocalV8RejectedReviewSha256
        !== signed.receipt.priorLocalV8.rejectedReviewSha256
      || candidate.localCompositeAlgorithmSha256
        !== signed.receipt.algorithm.implementationSha256))
    || approvedFirstFrameUrl !== signed.receipt.output.url
    || approvedFirstFrameSha256 !== signed.receipt.output.sha256
    || !Array.isArray(imageLedgers) || imageLedgers.length !== 0
    || reviewLedger?.status !== 'succeeded'
    || !/^model-run-[\w-]+$/.test(String(reviewLedger.id)))
    invalid('local first-frame candidate lacks source-bound timing/review')
  const cert = verifySceneCutFrameApproval(runs[50].output, root)
  const approved = (localV9
    ? assertA8B6LocalCompositeWorkflowResultV9
    : localV8 ? assertA8B6LocalCompositeWorkflowResultV8
    : localV7 ? assertA8B6LocalCompositeWorkflowResultV7
    : localV6 ? assertA8B6LocalCompositeWorkflowResultV6
    : localV5 ? assertA8B6LocalCompositeWorkflowResultV5
    : localV4 ? assertA8B6LocalCompositeWorkflowResultV4
    : localV3 ? assertA8B6LocalCompositeWorkflowResultV3
    : localV2 ? assertA8B6LocalCompositeWorkflowResultV2
    : assertA8B6LocalCompositeWorkflowResult)({
    receipt: signed.receipt, receiptSha256: signed.receiptSha256,
    execution: fresh, imageLedgers, reviewLedgerCount: 1,
    frameCertificateSha256 })
  const plates = cert.identityPlateBindings
  if (cert.passed !== true || cert.shotSha256 !== SHOT_SHA
    || cert.repairBinding !== undefined
    || cert.reviewExecutionId !== reviewLedger.id
    || sceneCutRebindSha256(cert) !== frameCertificateSha256
    || cert.frame?.sourceUrl !== approved.approvedFirstFrameUrl
    || !Array.isArray(plates) || plates.length !== 2
    || !isDeepStrictEqual(plates.map(plate => [plate.characterName,
      plate.sourceSha256, plate.frontSha256]),
      preflight.frozenIdentityPlates.map(plate => [plate.characterName,
        plate.sourceSha256, plate.frontSha256]))
    || preflight.forbiddenSources.some(item => item.sha256
      === approvedFirstFrameSha256)
    || sha(readFileSync(generatedFile(root, approvedFirstFrameUrl, 'image')))
      !== approvedFirstFrameSha256)
    invalid('local first-frame certificate or approved PNG changed')
  const compact = await deriveCompactInputs([
    { role: 'first_frame', url: approvedFirstFrameUrl,
      sha256: approvedFirstFrameSha256 },
    ...plates.map((plate, index) => ({ role: `identity_${index + 1}`,
      url: plate.sourceUrl, sha256: plate.sourceSha256 })),
  ], root)
  const preview = buildRequest(freshA8B6PhaseAPrompt(), compact.buffers[0],
    compact.buffers.slice(1), 8)
  const { buffers: _buffers, ...transport } = compact
  void _buffers
  const body = { version: 'staged-a8b6-fresh-A-plan-v1',
    source: { ...preflight.source,
      frameProvenanceVariant: localV9
        ? 'a8b6-local-composite-v9'
        : localV8 ? 'a8b6-local-composite-v8'
        : localV7 ? 'a8b6-local-composite-v7'
        : localV6 ? 'a8b6-local-composite-v6'
        : localV5 ? 'a8b6-local-composite-v5'
        : localV4 ? 'a8b6-local-composite-v4'
        : localV3 ? 'a8b6-local-composite-v3'
        : localV2 ? 'a8b6-local-composite-v2'
          : 'a8b6-local-composite-v1',
      freshFrameExecutionId: sourceRow.id,
      freshFrameResultMd5: sourceRow.result_md5,
      freshFrameMarkerSha256: sha(canonical(marker)),
      localCompositeSourceReceiptSha256: signed.receiptSha256,
      localCompositeAlgorithmSha256:
        signed.receipt.algorithm.implementationSha256,
      ...(localV2 ? {
        imageGenRawSha256: signed.receipt.sources[1].sha256,
        imageGenPromptSha256: signed.receipt.imageGen.promptSha256,
        priorLocalV1RejectedReviewSha256:
          signed.receipt.priorLocalV1.rejectedReviewSha256,
      } : {}),
      ...(localV3 ? {
        wallImageGenRawSha256: signed.receipt.sources[1].sha256,
        faceImageGenRawSha256: signed.receipt.sources[2].sha256,
        gateFrameImageGenRawSha256: signed.receipt.sources[3].sha256,
        priorLocalV2RejectedReviewSha256:
          signed.receipt.priorLocalV2.rejectedReviewSha256,
      } : {}),
      ...(localV4 ? {
        wallImageGenRawSha256: signed.receipt.sources[1].sha256,
        priorLocalV3RejectedReviewSha256:
          signed.receipt.priorLocalV3.rejectedReviewSha256,
      } : {}),
      ...(localV5 ? {
        wallImageGenRawSha256: signed.receipt.sources[1].sha256,
        priorLocalV4RejectedReviewSha256:
          signed.receipt.priorLocalV4.rejectedReviewSha256,
      } : {}),
      ...(localV6 ? {
        wallImageGenRawSha256: signed.receipt.sources[1].sha256,
        priorLocalV5RejectedReviewSha256:
          signed.receipt.priorLocalV5.rejectedReviewSha256,
      } : {}),
      ...(localV7 ? {
        wallImageGenRawSha256: signed.receipt.sources[1].sha256,
        priorLocalV6RejectedReviewSha256:
          signed.receipt.priorLocalV6.rejectedReviewSha256,
      } : {}),
      ...(localV8 ? {
        wallImageGenRawSha256: signed.receipt.sources[1].sha256,
        priorLocalV7RejectedReviewSha256:
          signed.receipt.priorLocalV7.rejectedReviewSha256,
      } : {}),
      ...(localV9 ? {
        wallImageGenRawSha256: signed.receipt.sources[1].sha256,
        priorLocalV8SourceReceiptSha256:
          signed.receipt.priorLocalV8.sourceReceiptSha256,
        priorLocalV8RejectedReviewSha256:
          signed.receipt.priorLocalV8.rejectedReviewSha256,
      } : {}),
      approvedShotSha256: SHOT_SHA, scheduleHash: SCHEDULE_HASH,
      frameCertificateSha256,
      approvedFirstFrameUrl, approvedFirstFrameSha256,
      imagePaymentExecutionId: null, imageModelExecutionId: null,
      imageRequestFingerprint: null,
      frameReviewModelExecutionId: reviewLedger.id },
    imageReferenceProof: [],
    frozenIdentityPlates: preflight.frozenIdentityPlates,
    narrationTracks: preflight.approved14s.narrationTracks,
    forbiddenSources: preflight.forbiddenSources,
    providerLock, compactTransport: transport,
    phaseA: { providerSeconds: 8, nativeFps: 24,
      firstFrameRole: 'new-certificate-local-image-only',
      endFrame: null, sound: 'off', acceptance: 'pending-native-review' },
    phaseAPreview: { ...preview, request: undefined },
    acceptanceState: 'A-request-ready-only; no provider task or media accepted' }
  return { ...body, planId: sha(canonical(body)), compactBuffers: compact.buffers }
}

/** Retake A is a new paid plan. Its first frame and identities are inherited
 * from the accepted V9 source, while its target guide and old A rejection are
 * new, independent signed evidence. */
export async function planFreshA8B6PhaseARetake(root = process.cwd()) {
  return withV9VerifiedSource(root,
    () => planFreshA8B6PhaseARetakeVerified(root))
}

async function planFreshA8B6PhaseARetakeVerified(root) {
  const { readFreshA8B6MediaReceipt } = await import(
    './staged-scene-cut-a8b6-fresh-phases.mjs')
  const { verifyFreshA8B6PhaseARejectionSync } = await import(
    './staged-scene-cut-a8b6-fresh-A-rejection.mjs')
  const media = await readFreshA8B6MediaReceipt(
    A8B6_A_RETAKE_PARENT_PLAN_ID, 'A', root)
  const { manifest: parent, manifestSha256 } = media
  const { rejection, rejectionSha256 } =
    verifyFreshA8B6PhaseARejectionSync(A8B6_A_RETAKE_PARENT_PLAN_ID, root)
  const target = verifyA8B6ARetakeTargetSourceSync(root)
  const targetReview = verifyA8B6ARetakeTargetReviewSync(root)
  const provenance = verifyA8B6ARetakeTargetProvenanceAmendmentSync(root)
  if (parent.version !== 'staged-a8b6-fresh-A-plan-v1'
    || parent.source?.frameProvenanceVariant !== 'a8b6-local-composite-v9'
    || parent.phaseA?.endFrame !== null
    || media.media.taskId !== A8B6_A_RETAKE_PARENT_TASK_ID
    || media.media.videoSha256 !== A8B6_A_RETAKE_PARENT_VIDEO_SHA256
    || rejection.taskId !== media.media.taskId
    || rejection.videoSha256 !== media.media.videoSha256
    || rejection.mediaSha256 !== media.mediaSha256
    || rejection.planManifestSha256 !== manifestSha256
    || rejection.failedChecks?.frontWristKnotCompletedByNativeTail !== false
    || rejection.modelReview?.decision === 'accept'
    || target.receipt.parentPlanId !== parent.planId
    || target.receipt.rejectedVideo.sha256 !== media.media.videoSha256
    || targetReview.review.sourceReceiptSha256 !== target.receiptSha256
    || targetReview.review.targetSha256 !== target.receipt.output.sha256
    || provenance.amendment.sourceReceiptSha256 !== target.receiptSha256
    || provenance.amendment.targetReviewSha256
      !== targetReview.reviewSha256)
    invalid('retake lacks old native rejection or independently reviewed target')
  const sourceAssets = parent.compactTransport.entries.map(entry => ({
    role: entry.role, url: entry.source.url, sha256: entry.source.sha256 }))
  const compact = await deriveCompactInputsWithEndFrame([
    ...sourceAssets, { role: 'end_frame',
      url: target.receipt.output.url,
      sha256: target.receipt.output.sha256 }], root)
  if (compact.entries.slice(0, 3).some((entry, index) =>
    canonical(entry) !== canonical(parent.compactTransport.entries[index])))
    invalid('retake changed V9 approved first or identity transport')
  const preview = previewFreshA8B6PhaseARetake(compact.buffers[0],
    compact.buffers.slice(1, 3), compact.buffers[3])
  const { buffers: _buffers, ...transport } = compact
  void _buffers
  const retake = {
    parentPlanId: parent.planId,
    parentManifestSha256: manifestSha256,
    parentWorkflowApprovalSha256: parent.workflowApprovalSha256,
    parentTaskId: media.media.taskId,
    parentTaskSha256: media.media.taskSha256,
    parentRequestSha256: parent.phaseAPreview.requestSha256,
    parentVideoSha256: media.media.videoSha256,
    parentMediaReceiptSha256: media.mediaSha256,
    parentRejectionSha256: rejectionSha256,
    targetSourceReceiptSha256: target.receiptSha256,
    targetReviewSha256: targetReview.reviewSha256,
    targetPromptAmendmentSha256: provenance.amendmentSha256,
  }
  const body = {
    version: 'staged-a8b6-fresh-A-plan-v2',
    source: parent.source,
    imageReferenceProof: parent.imageReferenceProof,
    frozenIdentityPlates: parent.frozenIdentityPlates,
    narrationTracks: parent.narrationTracks,
    forbiddenSources: [...parent.forbiddenSources,
      { kind: 'rejected-V9-A-native-video',
        url: media.media.videoUrl,
        sha256: media.media.videoSha256,
        taskId: media.media.taskId }],
    providerLock: parent.providerLock,
    compactTransport: transport,
    phaseA: { ...parent.phaseA,
      endFrame: { role: 'target-guide-only',
        url: target.receipt.output.url,
        sha256: target.receipt.output.sha256,
        targetSourceReceiptSha256: target.receiptSha256,
        targetReviewSha256: targetReview.reviewSha256,
        targetPromptAmendmentSha256: provenance.amendmentSha256 } },
    phaseAPreview: { ...preview, request: undefined },
    retake,
    acceptanceState: 'A-retake-request-ready-only; old A rejected; new native A pending',
  }
  return { ...body, planId: sha(canonical(body)),
    compactBuffers: compact.buffers }
}

async function verifyFreshA8B6LocalPlanApproval(planId, body, root) {
  if (body.source.frameProvenanceVariant === 'a8b6-local-composite-v9')
    return withV9VerifiedSource(root,
      () => verifyFreshA8B6LocalPlanApprovalVerified(planId, body, root))
  return verifyFreshA8B6LocalPlanApprovalVerified(planId, body, root)
}

async function verifyFreshA8B6LocalPlanApprovalVerified(planId, body, root) {
  const localV9 = body.source.frameProvenanceVariant
    === 'a8b6-local-composite-v9'
  const localV8 = body.source.frameProvenanceVariant
    === 'a8b6-local-composite-v8'
  const localV7 = body.source.frameProvenanceVariant
    === 'a8b6-local-composite-v7'
  const localV6 = body.source.frameProvenanceVariant
    === 'a8b6-local-composite-v6'
  const localV5 = body.source.frameProvenanceVariant
    === 'a8b6-local-composite-v5'
  const localV4 = body.source.frameProvenanceVariant
    === 'a8b6-local-composite-v4'
  const localV3 = body.source.frameProvenanceVariant
    === 'a8b6-local-composite-v3'
  const localV2 = body.source.frameProvenanceVariant
    === 'a8b6-local-composite-v2'
  const signed = localV9
    ? await getV9VerifiedSource(root)
    : localV8 ? await verifyA8B6LocalCompositeSourceReceiptV8(root)
    : localV7 ? await verifyA8B6LocalCompositeSourceReceiptV7(root)
    : localV6 ? await verifyA8B6LocalCompositeSourceReceiptV6(root)
    : localV5 ? await verifyA8B6LocalCompositeSourceReceiptV5(root)
    : localV4 ? await verifyA8B6LocalCompositeSourceReceiptV4(root)
    : localV3 ? await verifyA8B6LocalCompositeSourceReceiptV3(root)
    : localV2 ? await verifyA8B6LocalCompositeSourceReceiptV2(root)
    : await verifyA8B6LocalCompositeSourceReceipt(root)
  const { approval, approvalSha256 } = localV9
    ? await (await import('./staged-scene-cut-a8b6-local-approval-v9.mjs'))
      .verifyA8B6LocalWorkflowApprovalV9(planId, root)
    : localV8 ? await (await import('./staged-scene-cut-a8b6-local-approval-v8.mjs'))
      .verifyA8B6LocalWorkflowApprovalV8(planId, root)
    : localV7 ? await (await import('./staged-scene-cut-a8b6-local-approval-v7.mjs'))
      .verifyA8B6LocalWorkflowApprovalV7(planId, root)
    : localV6 ? await (await import('./staged-scene-cut-a8b6-local-approval-v6.mjs'))
      .verifyA8B6LocalWorkflowApprovalV6(planId, root)
    : localV5 ? await (await import('./staged-scene-cut-a8b6-local-approval-v5.mjs'))
      .verifyA8B6LocalWorkflowApprovalV5(planId, root)
    : localV4 ? await (await import('./staged-scene-cut-a8b6-local-approval-v4.mjs'))
      .verifyA8B6LocalWorkflowApprovalV4(planId, root)
    : localV3 ? await (await import('./staged-scene-cut-a8b6-local-approval-v3.mjs'))
      .verifyA8B6LocalWorkflowApprovalV3(planId, root)
    : localV2
      ? await (await import('./staged-scene-cut-a8b6-local-approval-v2.mjs'))
      .verifyA8B6LocalWorkflowApprovalV2(planId, root)
    : await (await import('./staged-scene-cut-a8b6-local-approval.mjs'))
      .verifyA8B6LocalWorkflowApproval(planId, root)
  if (!['a8b6-local-composite-v1', 'a8b6-local-composite-v2',
    'a8b6-local-composite-v3', 'a8b6-local-composite-v4',
    'a8b6-local-composite-v5', 'a8b6-local-composite-v6',
        'a8b6-local-composite-v7', 'a8b6-local-composite-v8',
        'a8b6-local-composite-v9']
    .includes(body.source.frameProvenanceVariant)
    || body.source.localCompositeSourceReceiptSha256 !== signed.receiptSha256
    || body.source.localCompositeAlgorithmSha256
      !== signed.receipt.algorithm.implementationSha256
    || (localV2 && (
      body.source.imageGenRawSha256 !== signed.receipt.sources[1].sha256
      || body.source.imageGenPromptSha256
        !== signed.receipt.imageGen.promptSha256
      || body.source.priorLocalV1RejectedReviewSha256
        !== signed.receipt.priorLocalV1.rejectedReviewSha256
      || approval.imageGenRawSha256 !== body.source.imageGenRawSha256
      || approval.imageGenPromptSha256 !== body.source.imageGenPromptSha256
      || approval.priorLocalV1RejectedReviewSha256
        !== body.source.priorLocalV1RejectedReviewSha256))
    || (localV3 && (
      body.source.wallImageGenRawSha256
        !== signed.receipt.sources[1].sha256
      || body.source.faceImageGenRawSha256
        !== signed.receipt.sources[2].sha256
      || body.source.gateFrameImageGenRawSha256
        !== signed.receipt.sources[3].sha256
      || body.source.priorLocalV2RejectedReviewSha256
        !== signed.receipt.priorLocalV2.rejectedReviewSha256
      || approval.wallImageGenRawSha256
        !== body.source.wallImageGenRawSha256
      || approval.faceImageGenRawSha256
        !== body.source.faceImageGenRawSha256
      || approval.gateFrameImageGenRawSha256
        !== body.source.gateFrameImageGenRawSha256
      || approval.priorLocalV2RejectedReviewSha256
        !== body.source.priorLocalV2RejectedReviewSha256))
    || (localV4 && (
      body.source.wallImageGenRawSha256
        !== signed.receipt.sources[1].sha256
      || body.source.priorLocalV3RejectedReviewSha256
        !== signed.receipt.priorLocalV3.rejectedReviewSha256
      || approval.wallImageGenRawSha256
        !== body.source.wallImageGenRawSha256
      || approval.priorLocalV3RejectedReviewSha256
        !== body.source.priorLocalV3RejectedReviewSha256))
    || (localV5 && (
      body.source.wallImageGenRawSha256
        !== signed.receipt.sources[1].sha256
      || body.source.priorLocalV4RejectedReviewSha256
        !== signed.receipt.priorLocalV4.rejectedReviewSha256
      || approval.wallImageGenRawSha256
        !== body.source.wallImageGenRawSha256
      || approval.priorLocalV4RejectedReviewSha256
        !== body.source.priorLocalV4RejectedReviewSha256))
    || (localV6 && (
      body.source.wallImageGenRawSha256
        !== signed.receipt.sources[1].sha256
      || body.source.priorLocalV5RejectedReviewSha256
        !== signed.receipt.priorLocalV5.rejectedReviewSha256
      || approval.wallImageGenRawSha256
        !== body.source.wallImageGenRawSha256
      || approval.priorLocalV5RejectedReviewSha256
        !== body.source.priorLocalV5RejectedReviewSha256))
    || (localV7 && (
      body.source.wallImageGenRawSha256
        !== signed.receipt.sources[1].sha256
      || body.source.priorLocalV6RejectedReviewSha256
        !== signed.receipt.priorLocalV6.rejectedReviewSha256
      || approval.wallImageGenRawSha256
        !== body.source.wallImageGenRawSha256
      || approval.priorLocalV6RejectedReviewSha256
        !== body.source.priorLocalV6RejectedReviewSha256))
    || (localV8 && (
      body.source.wallImageGenRawSha256
        !== signed.receipt.sources[1].sha256
      || body.source.priorLocalV7RejectedReviewSha256
        !== signed.receipt.priorLocalV7.rejectedReviewSha256
      || approval.wallImageGenRawSha256
        !== body.source.wallImageGenRawSha256
      || approval.priorLocalV7RejectedReviewSha256
        !== body.source.priorLocalV7RejectedReviewSha256))
    || (localV9 && (
      body.source.wallImageGenRawSha256
        !== signed.receipt.sources[1].sha256
      || body.source.priorLocalV8SourceReceiptSha256
        !== signed.receipt.priorLocalV8.sourceReceiptSha256
      || body.source.priorLocalV8RejectedReviewSha256
        !== signed.receipt.priorLocalV8.rejectedReviewSha256
      || approval.wallImageGenRawSha256
        !== body.source.wallImageGenRawSha256
      || approval.priorLocalV8SourceReceiptSha256
        !== body.source.priorLocalV8SourceReceiptSha256
      || approval.priorLocalV8RejectedReviewSha256
        !== body.source.priorLocalV8RejectedReviewSha256))
    || body.source.approvedFirstFrameUrl !== signed.receipt.output.url
    || body.source.approvedFirstFrameSha256 !== signed.receipt.output.sha256
    || body.source.imagePaymentExecutionId !== null
    || body.source.imageModelExecutionId !== null
    || body.source.imageRequestFingerprint !== null
    || !Array.isArray(body.imageReferenceProof)
    || body.imageReferenceProof.length !== 0
    || approval.planId !== planId
    || approval.approvalExecutionId !== body.source.freshFrameExecutionId
    || approval.approvalResultMd5 !== body.source.freshFrameResultMd5
    || approval.localCompositeSourceReceiptSha256
      !== body.source.localCompositeSourceReceiptSha256
    || approval.approvedFirstFrameSha256
      !== body.source.approvedFirstFrameSha256
    || approval.sceneCutFrameCertificateSha256
      !== body.source.frameCertificateSha256
    || approval.phaseARequestSha256 !== body.phaseAPreview.requestSha256)
    invalid('local workflow approval does not bind new first frame or A request')
  return approvalSha256
}

function assertFreshA8B6RetakeApprovalBinding(approval, planId, body) {
  const retake = body.retake, target = body.phaseA.endFrame
  if (approval.planId !== planId
    || approval.parentPlanId !== retake.parentPlanId
    || approval.parentManifestSha256 !== retake.parentManifestSha256
    || approval.parentWorkflowApprovalSha256
      !== retake.parentWorkflowApprovalSha256
    || approval.parentTaskId !== retake.parentTaskId
    || approval.parentTaskSha256 !== retake.parentTaskSha256
    || approval.parentRequestSha256 !== retake.parentRequestSha256
    || approval.parentVideoSha256 !== retake.parentVideoSha256
    || approval.parentMediaReceiptSha256
      !== retake.parentMediaReceiptSha256
    || approval.parentRejectionSha256 !== retake.parentRejectionSha256
    || approval.targetSourceReceiptSha256
      !== retake.targetSourceReceiptSha256
    || approval.targetReviewSha256 !== retake.targetReviewSha256
    || approval.targetPromptAmendmentSha256
      !== retake.targetPromptAmendmentSha256
    || approval.targetEndFrameUrl !== target.url
    || approval.targetEndFrameSha256 !== target.sha256
    || approval.phaseARequestSha256 !== body.phaseAPreview.requestSha256
    || canonical(approval.phaseAProviderLock)
      !== canonical(body.providerLock)
    || approval.approvedFirstFrameSha256
      !== body.source.approvedFirstFrameSha256
    || approval.sceneCutFrameCertificateSha256
      !== body.source.frameCertificateSha256)
    invalid('retake approval differs from signed plan ancestry or provider request')
}

export async function saveFreshA8B6PhaseAPlan(plan, root = process.cwd()) {
  if (plan?.version === 'staged-a8b6-fresh-A-plan-v3') {
    if (!SHA.test(String(plan.planId))
      || !SHA.test(String(plan.bRetake?.parentPlanId)))
      invalid('B-only child plan or parent identity invalid')
    const { planId, workflowApprovalSha256, ...body } = plan
    if (sha(canonical(body)) !== planId)
      invalid('B-only child plan content changed')
    const { verifyFreshA8B6BRetakeApproval } = await import(
      './staged-scene-cut-a8b6-B-retake-approval.mjs')
    const approved = await verifyFreshA8B6BRetakeApproval(planId, root)
    if (canonical(approved.plan) !== canonical(plan))
      invalid('B-only child lost rejected B or accepted A ancestry')
    const signed = await signOnce(root, planId, 'manifest.json', {
      ...body, planId, workflowApprovalSha256 })
    return { planId, manifestSha256: signed.sha256,
      manifestPath: path.join(dir(root, planId), 'manifest.json') }
  }
  if (plan?.version === 'staged-a8b6-fresh-A-plan-v2') {
    if (!SHA.test(String(plan.planId))
      || !Array.isArray(plan.compactBuffers)
      || plan.compactBuffers.length !== 4)
      invalid('retake A plan or four-image transport missing')
    const { compactBuffers, planId, ...body } = plan
    if (sha(canonical(body)) !== planId)
      invalid('retake A plan body changed')
    const expected = await planFreshA8B6PhaseARetake(root)
    const { compactBuffers: _buffers, planId: _expectedId,
      ...expectedBody } = expected
    void _buffers; void _expectedId
    if (expected.planId !== planId
      || canonical(expectedBody) !== canonical(body))
      invalid('retake A plan differs from rejected A and target evidence')
    const { verifyA8B6FreshARetakeApprovalSync } = await import(
      './staged-scene-cut-a8b6-A-retake-approval.mjs')
    const approved = verifyA8B6FreshARetakeApprovalSync(planId, root)
    assertFreshA8B6RetakeApprovalBinding(approved.approval,
      planId, body)
    await saveCompactInputsWithEndFrame(plan.compactTransport,
      compactBuffers, root)
    const signed = await signOnce(root, planId, 'manifest.json', {
      ...body, planId, workflowApprovalSha256: approved.approvalSha256 })
    return { planId, manifestSha256: signed.sha256,
      manifestPath: path.join(dir(root, planId), 'manifest.json') }
  }
  if (plan?.version !== 'staged-a8b6-fresh-A-plan-v1'
    || !SHA.test(String(plan.planId))
    || !Array.isArray(plan.compactBuffers) || plan.compactBuffers.length !== 3)
    invalid('new A plan or transport missing')
  const { compactBuffers, planId, ...body } = plan
  if (sha(canonical(body)) !== planId) invalid('new A plan body changed')
  if (['a8b6-local-composite-v1', 'a8b6-local-composite-v2',
    'a8b6-local-composite-v3', 'a8b6-local-composite-v4',
    'a8b6-local-composite-v5', 'a8b6-local-composite-v6',
        'a8b6-local-composite-v7', 'a8b6-local-composite-v8',
        'a8b6-local-composite-v9']
    .includes(body.source?.frameProvenanceVariant)) {
    const approvalSha256 = await verifyFreshA8B6LocalPlanApproval(
      planId, body, root)
    await saveCompactInputs(plan.compactTransport, compactBuffers, root)
    const signed = await signOnce(root, planId, 'manifest.json', {
      ...body, planId, workflowApprovalSha256: approvalSha256 })
    return { planId, manifestSha256: signed.sha256,
      manifestPath: path.join(dir(root, planId), 'manifest.json') }
  }
  const { verifyA8B6FreshWorkflowApproval } = await import(
    './staged-scene-cut-a8b6-fresh-approval.mjs')
  const { approval, approvalSha256 } = await verifyA8B6FreshWorkflowApproval(
    planId, root)
  if (approval.planId !== planId
    || approval.approvalExecutionId !== body.source.freshFrameExecutionId
    || approval.approvalResultMd5 !== body.source.freshFrameResultMd5
    || approval.editReceiptSha256 !== body.source.freshEditReceiptSha256
    || approval.v8EditReceiptSha256 !== body.source.v8EditReceiptSha256
    || approval.maskedLayoutSourceSha256
      !== body.source.maskedLayoutSourceSha256
    || approval.maskedLayoutTransportSha256
      !== body.source.maskedLayoutTransportSha256
    || approval.v4FaceHelperSourceSha256
      !== body.source.v4FaceHelperSourceSha256
    || approval.v4FaceHelperTransportSha256
      !== body.source.v4FaceHelperTransportSha256
    || approval.frozenFaceCropSourceSha256
      !== body.source.frozenFaceCropSourceSha256
    || approval.frozenFaceCropJpegSha256
      !== body.source.frozenFaceCropJpegSha256
    || canonical(approval.frozenFaceCropBox)
      !== canonical(body.source.frozenFaceCropBox)
    || approval.v8SourceSelectionClarificationSha256
      !== body.source.v8SourceSelectionClarificationSha256
    || approval.rejectedLayoutImageSha256
      !== body.source.rejectedLayoutImageSha256
    || approval.rejectedLayoutTransportSha256
      !== body.source.rejectedLayoutTransportSha256
    || approval.imagePaymentExecutionId
      !== body.source.imagePaymentExecutionId
    || approval.dualOutputRecoveryReceiptSha256
      !== body.source.dualOutputRecoveryReceiptSha256
    || approval.dualOutputClarificationSha256
      !== body.source.dualOutputClarificationSha256
    || approval.dualOutputSelectedSha256
      !== body.source.dualOutputSelectedSha256
    || approval.dualOutputUnselectedSha256
      !== body.source.dualOutputUnselectedSha256
    || approval.dualOutputThreadId
      !== body.source.dualOutputThreadId
    || approval.sceneCutFrameCertificateSha256
      !== body.source.frameCertificateSha256
    || approval.approvedFirstFrameSha256
      !== body.source.approvedFirstFrameSha256
    || approval.phaseARequestSha256 !== body.phaseAPreview.requestSha256)
    invalid('new image/timing approval does not bind signed A request')
  await saveCompactInputs(plan.compactTransport, compactBuffers, root)
  const signed = await signOnce(root, planId, 'manifest.json', {
    ...body, planId, workflowApprovalSha256: approvalSha256 })
  return { planId, manifestSha256: signed.sha256,
    manifestPath: path.join(dir(root, planId), 'manifest.json') }
}

export async function readFreshA8B6PhaseAPlan(planId, root = process.cwd()) {
  const { value, sha256: manifestSha256 } = await readSigned(root, planId, 'manifest.json')
  const { signature: _signature, planId: _planId,
    workflowApprovalSha256: _approvalSha, ...body } = value
  void _signature; void _planId
  void _approvalSha
  if (value.version === 'staged-a8b6-fresh-A-plan-v3') {
    if (value.planId !== planId || sha(canonical(body)) !== planId
      || !SHA.test(String(value.bRetake?.parentPlanId))
      || value.bRetake.parentPlanId === planId
      || value.phaseBRetake?.sound !== 'off'
      || value.phaseBRetake.endFrame?.role !== 'target-guide-only'
      || value.phaseBRetake.endFrame.sha256
        !== value.bRetake.targetEndFrameSha256
      || value.phaseBRetakePreview?.requestSha256
        !== value.bRetake.newBRequestSha256)
      invalid('signed B-only child plan changed')
    const { verifyFreshA8B6BRetakeApproval } = await import(
      './staged-scene-cut-a8b6-B-retake-approval.mjs')
    const approved = await verifyFreshA8B6BRetakeApproval(planId, root)
    const expected = approved.plan
    if (canonical({ ...expected, signature: value.signature })
        !== canonical(value)
      || approved.approval.planId !== planId
      || value.workflowApprovalSha256
        !== expected.bRetake.parentWorkflowApprovalSha256)
      invalid('B-only child lost signed B approval or parent A approval')
    return { manifest: value, manifestSha256,
      preview: value.phaseAPreview }
  }
  if (value.version === 'staged-a8b6-fresh-A-plan-v2') {
    if (value.planId !== planId || sha(canonical(body)) !== planId
      || value.source?.frameProvenanceVariant !== 'a8b6-local-composite-v9'
      || value.phaseA?.providerSeconds !== 8
      || value.phaseA.sound !== 'off'
      || value.phaseA.endFrame?.role !== 'target-guide-only'
      || value.phaseA.endFrame.targetSourceReceiptSha256
        !== value.retake?.targetSourceReceiptSha256
      || value.phaseA.endFrame.targetReviewSha256
        !== value.retake?.targetReviewSha256
      || value.phaseA.endFrame.targetPromptAmendmentSha256
        !== value.retake?.targetPromptAmendmentSha256
      || value.providerLock?.modelId !== 'keling3'
      || !SHA.test(String(value.providerLock.endpointSha256))
      || !SHA.test(String(value.workflowApprovalSha256)))
      invalid('signed retake A plan changed')
    const expected = await planFreshA8B6PhaseARetake(root)
    const { compactBuffers: _buffers, planId: _expectedId,
      ...expectedBody } = expected
    void _buffers; void _expectedId
    if (expected.planId !== planId
      || canonical(expectedBody) !== canonical(body))
      invalid('retake A plan lost old rejection or target evidence')
    const { verifyA8B6FreshARetakeApprovalSync } = await import(
      './staged-scene-cut-a8b6-A-retake-approval.mjs')
    const approved = verifyA8B6FreshARetakeApprovalSync(planId, root)
    if (approved.approvalSha256 !== value.workflowApprovalSha256)
      invalid('retake plan lost separately signed approval')
    assertFreshA8B6RetakeApprovalBinding(approved.approval,
      planId, value)
    await verifyCompactInputsWithEndFrame(value.compactTransport, root)
    const entries = value.compactTransport.entries
    const bytes = await Promise.all(entries.map(entry =>
      readFile(generatedFile(root, entry.transport.url, 'image'))))
    const preview = previewFreshA8B6PhaseARetake(bytes[0],
      bytes.slice(1, 3), bytes[3])
    if (preview.requestSha256 !== value.phaseAPreview.requestSha256
      || preview.endFrameTransportSha256 !== entries[3].transport.sha256)
      invalid('signed retake provider request changed')
    return { manifest: value, manifestSha256, preview }
  }
  if (['a8b6-local-composite-v1', 'a8b6-local-composite-v2',
    'a8b6-local-composite-v3', 'a8b6-local-composite-v4',
    'a8b6-local-composite-v5', 'a8b6-local-composite-v6',
        'a8b6-local-composite-v7', 'a8b6-local-composite-v8',
        'a8b6-local-composite-v9']
    .includes(value.source?.frameProvenanceVariant)) {
    if (value.version !== 'staged-a8b6-fresh-A-plan-v1'
      || value.planId !== planId || sha(canonical(body)) !== planId
      || !/^record-[\w-]+$/.test(String(value.source.freshFrameExecutionId))
      || !MD5.test(String(value.source.freshFrameResultMd5))
      || value.source.approvedShotSha256 !== SHOT_SHA
      || value.source.scheduleHash !== SCHEDULE_HASH
      || value.phaseA?.providerSeconds !== 8
      || value.phaseA.endFrame !== null
      || value.phaseA.sound !== 'off'
      || value.providerLock?.modelId !== 'keling3'
      || !SHA.test(String(value.providerLock.endpointSha256))
      || !SHA.test(String(value.workflowApprovalSha256)))
      invalid('signed local A plan changed')
    const approvalSha256 = await verifyFreshA8B6LocalPlanApproval(
      planId, body, root)
    if (approvalSha256 !== value.workflowApprovalSha256)
      invalid('signed local A plan lost workflow approval')
    await verifyCompactInputs(value.compactTransport, root)
    const transport = value.compactTransport.entries
    if (!Array.isArray(transport) || transport.length !== 3
      || transport.map(entry => entry.role).join(',')
        !== 'first_frame,identity_1,identity_2')
      invalid('local A transport roles changed')
    const bytes = await Promise.all(transport.map(entry =>
      readFile(generatedFile(root, entry.transport.url, 'image'))))
    const preview = buildRequest(freshA8B6PhaseAPrompt(), bytes[0],
      bytes.slice(1), 8)
    if (preview.requestSha256 !== value.phaseAPreview?.requestSha256
      || preview.firstFrameTransportSha256
        !== transport[0].transport.sha256
      || !isDeepStrictEqual(preview.identityTransportSha256s,
        transport.slice(1).map(entry => entry.transport.sha256)))
      invalid('signed local A request changed')
    return { manifest: value, manifestSha256, preview }
  }
  if (value.version !== 'staged-a8b6-fresh-A-plan-v1'
    || value.planId !== planId || sha(canonical(body)) !== planId
    || !/^record-[\w-]+$/.test(String(value.source?.freshFrameExecutionId))
    || !MD5.test(String(value.source?.freshFrameResultMd5))
    || !SHA.test(String(value.source?.freshEditReceiptSha256))
    || !SHA.test(String(value.source?.rejectedLayoutImageSha256))
    || !SHA.test(String(value.source?.rejectedLayoutTransportSha256))
    || value.source?.approvedShotSha256 !== SHOT_SHA
    || value.source?.scheduleHash !== SCHEDULE_HASH
    || value.phaseA?.providerSeconds !== 8
    || value.phaseA?.endFrame !== null
    || value.providerLock?.modelId !== 'keling3'
    || !SHA.test(String(value.providerLock.endpointSha256))
    || !SHA.test(String(value.workflowApprovalSha256)))
    invalid('signed new A plan changed')
  assertFreshA8B6DualOutputSource(value.source, root)
  assertFreshA8B6ImageReferenceProof(value.imageReferenceProof,
    value.source, value.frozenIdentityPlates, root)
  const { verifyA8B6FreshWorkflowApproval } = await import(
    './staged-scene-cut-a8b6-fresh-approval.mjs')
  const { approval, approvalSha256 } = await verifyA8B6FreshWorkflowApproval(
    planId, root)
  if (approvalSha256 !== value.workflowApprovalSha256
    || approval.planId !== planId
    || approval.approvalExecutionId !== value.source.freshFrameExecutionId
    || approval.approvalResultMd5 !== value.source.freshFrameResultMd5
    || approval.editReceiptSha256 !== value.source.freshEditReceiptSha256
    || approval.v8EditReceiptSha256 !== value.source.v8EditReceiptSha256
    || approval.maskedLayoutSourceSha256
      !== value.source.maskedLayoutSourceSha256
    || approval.maskedLayoutTransportSha256
      !== value.source.maskedLayoutTransportSha256
    || approval.v4FaceHelperSourceSha256
      !== value.source.v4FaceHelperSourceSha256
    || approval.v4FaceHelperTransportSha256
      !== value.source.v4FaceHelperTransportSha256
    || approval.frozenFaceCropSourceSha256
      !== value.source.frozenFaceCropSourceSha256
    || approval.frozenFaceCropJpegSha256
      !== value.source.frozenFaceCropJpegSha256
    || canonical(approval.frozenFaceCropBox)
      !== canonical(value.source.frozenFaceCropBox)
    || approval.v8SourceSelectionClarificationSha256
      !== value.source.v8SourceSelectionClarificationSha256
    || approval.rejectedLayoutImageSha256
      !== value.source.rejectedLayoutImageSha256
    || approval.rejectedLayoutTransportSha256
      !== value.source.rejectedLayoutTransportSha256
    || approval.imagePaymentExecutionId
      !== value.source.imagePaymentExecutionId
    || approval.dualOutputRecoveryReceiptSha256
      !== value.source.dualOutputRecoveryReceiptSha256
    || approval.dualOutputClarificationSha256
      !== value.source.dualOutputClarificationSha256
    || approval.dualOutputSelectedSha256
      !== value.source.dualOutputSelectedSha256
    || approval.dualOutputUnselectedSha256
      !== value.source.dualOutputUnselectedSha256
    || approval.dualOutputThreadId
      !== value.source.dualOutputThreadId
    || approval.sceneCutFrameCertificateSha256
      !== value.source.frameCertificateSha256
    || approval.approvedFirstFrameSha256
      !== value.source.approvedFirstFrameSha256
    || approval.phaseARequestSha256 !== value.phaseAPreview.requestSha256)
    invalid('signed A plan lost its independent new workflow approval')
  await verifyCompactInputs(value.compactTransport, root)
  const transport = value.compactTransport.entries
  const bytes = await Promise.all(transport.map(entry =>
    readFile(generatedFile(root, entry.transport.url, 'image'))))
  const preview = buildRequest(freshA8B6PhaseAPrompt(), bytes[0], bytes.slice(1), 8)
  if (preview.requestSha256 !== value.phaseAPreview?.requestSha256
    || preview.firstFrameTransportSha256 !== transport[0].transport.sha256
    || !isDeepStrictEqual(preview.identityTransportSha256s,
      transport.slice(1).map(entry => entry.transport.sha256)))
    invalid('signed new A request changed')
  return { manifest: value, manifestSha256, preview }
}

/** B is built only from an accepted A actual native tail and new task/media. */
export function previewFreshA8B6PhaseB(firstFrameJpegBytes, identityJpegBytes) {
  if (!Buffer.isBuffer(firstFrameJpegBytes) || firstFrameJpegBytes.length < 1000
    || firstFrameJpegBytes[0] !== 0xff || firstFrameJpegBytes[1] !== 0xd8
    || !Array.isArray(identityJpegBytes) || identityJpegBytes.length !== 2)
    invalid('new B lacks accepted A native tail JPEG and frozen identities')
  return buildRequest(freshA8B6PhaseBPrompt(), firstFrameJpegBytes,
    identityJpegBytes, 6)
}

export function previewFreshA8B6PhaseBRetake(firstFrameJpegBytes,
  identityJpegBytes, endFrameJpegBytes) {
  if (!Buffer.isBuffer(firstFrameJpegBytes)
    || firstFrameJpegBytes.length < 1000
    || firstFrameJpegBytes[0] !== 0xff || firstFrameJpegBytes[1] !== 0xd8
    || !Array.isArray(identityJpegBytes) || identityJpegBytes.length !== 2
    || identityJpegBytes.some(bytes => !Buffer.isBuffer(bytes)
      || bytes.length < 1000 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    || !Buffer.isBuffer(endFrameJpegBytes)
    || endFrameJpegBytes.length < 1000
    || endFrameJpegBytes[0] !== 0xff || endFrameJpegBytes[1] !== 0xd8)
    invalid('B retake lacks accepted A tail, identities or guide JPEG')
  return buildRequest(freshA8B6PhaseBRetakePrompt(), firstFrameJpegBytes,
    identityJpegBytes, 6, endFrameJpegBytes)
}

export function previewFreshA8B6PhaseBSecondRetake(firstFrameJpegBytes,
  identityJpegBytes, endFrameJpegBytes) {
  if (!Buffer.isBuffer(firstFrameJpegBytes)
    || firstFrameJpegBytes.length < 1000
    || firstFrameJpegBytes[0] !== 0xff || firstFrameJpegBytes[1] !== 0xd8
    || !Array.isArray(identityJpegBytes) || identityJpegBytes.length !== 2
    || identityJpegBytes.some(bytes => !Buffer.isBuffer(bytes)
      || bytes.length < 1000 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    || !Buffer.isBuffer(endFrameJpegBytes)
    || endFrameJpegBytes.length < 1000
    || endFrameJpegBytes[0] !== 0xff || endFrameJpegBytes[1] !== 0xd8)
    invalid('second B retake lacks accepted A tail, identities or new guide')
  return buildRequest(freshA8B6PhaseBSecondRetakePrompt(),
    firstFrameJpegBytes, identityJpegBytes, 6, endFrameJpegBytes)
}

export function previewFreshA8B6PhaseBThirdRetake(firstFrameJpegBytes,
  identityJpegBytes, endFrameJpegBytes) {
  if (!Buffer.isBuffer(firstFrameJpegBytes)
    || firstFrameJpegBytes.length < 1000
    || firstFrameJpegBytes[0] !== 0xff || firstFrameJpegBytes[1] !== 0xd8
    || !Array.isArray(identityJpegBytes) || identityJpegBytes.length !== 2
    || identityJpegBytes.some(bytes => !Buffer.isBuffer(bytes)
      || bytes.length < 1000 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    || !Buffer.isBuffer(endFrameJpegBytes)
    || endFrameJpegBytes.length < 1000
    || endFrameJpegBytes[0] !== 0xff || endFrameJpegBytes[1] !== 0xd8)
    invalid('third B retake lacks accepted A tail, identities or new guide')
  return buildRequest(freshA8B6PhaseBThirdRetakePrompt(),
    firstFrameJpegBytes, identityJpegBytes, 6, endFrameJpegBytes)
}

/** Narrow artifact API shared by the independent paid-phase/QA modules. */
export async function saveFreshA8B6Artifact(planId, name, body, root = process.cwd()) {
  if (!/^(phase-[AB]-(?:plan|task|media|acceptance|review-evidence|manual-review)|composite|narration-transfer|whole-shot-review)\.json$/.test(name))
    invalid('fresh artifact name invalid')
  return signOnce(root, planId, name, body)
}

export async function readFreshA8B6Artifact(planId, name, root = process.cwd()) {
  if (!/^(phase-[AB]-(?:plan|task|media|acceptance|review-evidence|manual-review)|composite|narration-transfer|whole-shot-review)\.json$/.test(name))
    invalid('fresh artifact name invalid')
  return readSigned(root, planId, name)
}

export async function saveFreshA8B6Bytes(filename, bytes) {
  return writeOnce(filename, bytes)
}

export function freshA8B6Directory(planId, root = process.cwd()) {
  return dir(root, planId)
}

export function freshA8B6GeneratedFile(url, type, root = process.cwd()) {
  return generatedFile(root, url, type)
}
