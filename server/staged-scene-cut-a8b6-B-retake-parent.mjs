/** Fast signed parent snapshot for a B-only child. The parent B rejection was
 * independently deep-verified, and this reader rechecks every signed receipt
 * plus the archived A/B video hashes on each entry. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { verifyFreshA8B6PhaseBRejectionSync } from
  './staged-scene-cut-a8b6-fresh-B-rejection.mjs'
import { freshA8B6Directory, freshA8B6GeneratedFile } from
  './staged-scene-cut-a8b6-fresh-ledger.mjs'

const SHA = /^[a-f0-9]{64}$/
const fail = reason => { throw Error(`A8B6_B_RETAKE_PARENT_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)

export function readFreshA8B6BRetakeParentSigned(parentPlanId,
  root = process.cwd()) {
  if (!SHA.test(String(parentPlanId))) fail('parent plan ID invalid')
  const rejection = verifyFreshA8B6PhaseBRejectionSync(parentPlanId, root)
  const directory = freshA8B6Directory(parentPlanId, root)
  const secret = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  if (secret.length !== 32) fail('staging signing key invalid')
  const readSigned = name => {
    const bytes = readFileSync(path.join(directory, name))
    const value = JSON.parse(bytes.toString('utf8'))
    const { signature, ...body } = value
    const expected = createHmac('sha256', secret)
      .update(canonical(body)).digest('hex')
    if (!SHA.test(String(signature))
      || !timingSafeEqual(Buffer.from(signature, 'hex'),
        Buffer.from(expected, 'hex')))
      fail(`parent ${name} signature changed`)
    return { value, sha256: sha(bytes) }
  }
  const manifest = readSigned('manifest.json')
  const A = readSigned('phase-A-acceptance.json')
  const Amedia = readSigned('phase-A-media.json')
  const Atask = readSigned('phase-A-task.json')
  const AintentBytes = readFileSync(path.join(directory,
    'phase-A-submit-intent.json'))
  const Aintent = JSON.parse(AintentBytes.toString('utf8'))
  const Bplan = readSigned('phase-B-plan.json')
  const Btask = readSigned('phase-B-task.json')
  const Bmedia = readSigned('phase-B-media.json')
  if (manifest.value.version !== 'staged-a8b6-fresh-A-plan-v2'
    || manifest.value.planId !== parentPlanId
    || manifest.sha256 !== rejection.rejection.manifestSha256
    || A.value.version !== 'staged-a8b6-fresh-native-acceptance-v3'
    || A.value.planId !== parentPlanId
    || A.value.acceptedFrameIndex !== 192
    || A.value.acceptedFrameSha256
      !== Bplan.value.sourceA?.frameSha256
    || A.sha256 !== Bplan.value.sourceA.acceptanceSha256
    || A.value.mediaSha256 !== Amedia.sha256
    || Amedia.value.taskSha256 !== Atask.sha256
    || Atask.value.taskId !== Amedia.value.taskId
    || Atask.value.intentSha256 !== sha(AintentBytes)
    || Atask.value.requestSha256
      !== manifest.value.phaseAPreview.requestSha256
    || Aintent.planId !== parentPlanId || Aintent.phase !== 'A'
    || Aintent.requestSha256 !== Atask.value.requestSha256
    || Bplan.sha256 !== rejection.rejection.phaseBPlanSha256
    || Bplan.value.manifestSha256 !== manifest.sha256
    || Btask.sha256 !== rejection.rejection.taskSha256
    || Bmedia.sha256 !== rejection.rejection.mediaSha256
    || Bmedia.value.taskId !== Btask.value.taskId
    || Bmedia.value.taskSha256 !== Btask.sha256
    || Bmedia.value.nativeLastFrameIndex !== 144
    || Bmedia.value.nativeLastPts !== 6
    || Btask.value.requestSha256
      !== Bplan.value.phaseBPreview.requestSha256
    || sha(readFileSync(freshA8B6GeneratedFile(
      Amedia.value.videoUrl, 'video', root)))
      !== Amedia.value.videoSha256
    || sha(readFileSync(freshA8B6GeneratedFile(
      Bmedia.value.videoUrl, 'video', root)))
      !== Bmedia.value.videoSha256)
    fail('parent accepted A or rejected B signed snapshot changed')
  return { manifest: manifest.value,
    manifestSha256: manifest.sha256,
    A: { acceptance: A.value, acceptanceSha256: A.sha256,
      media: Amedia.value, mediaSha256: Amedia.sha256,
      task: Atask.value, taskSha256: Atask.sha256,
      intent: Aintent, intentSha256: sha(AintentBytes),
      native: { fps: 24, width: 1280, height: 720,
        frameCount: Amedia.value.nativeFrameCount,
        firstPts: 0,
        lastFrameIndex: Amedia.value.nativeLastFrameIndex,
        lastPts: Amedia.value.nativeLastPts,
        frameDigestSha256: Amedia.value.nativeFrameDigestSha256 } },
    B: { media: Bmedia.value, mediaSha256: Bmedia.sha256,
      native: { fps: 24, width: 1280, height: 720,
        frameCount: Bmedia.value.nativeFrameCount,
        firstPts: 0,
        lastFrameIndex: Bmedia.value.nativeLastFrameIndex,
        lastPts: Bmedia.value.nativeLastPts,
        frameDigestSha256: Bmedia.value.nativeFrameDigestSha256 } },
    BPlan: { plan: Bplan.value, planSha256: Bplan.sha256,
      preview: { requestSha256:
        Bplan.value.phaseBPreview.requestSha256 } },
    BTask: { task: Btask.value, taskSha256: Btask.sha256 },
    rejection }
}
