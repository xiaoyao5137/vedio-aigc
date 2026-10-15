import assert from 'node:assert/strict'
import test from 'node:test'
import { sceneCutRebindSha256 } from '../server/scene-cut-approval-rebind.ts'
import { buildScene2RegenerationPreflight,
  verifyScene2RegenerationImageGate } from '../server/staged-scene2-regeneration-preflight.mjs'

const hex = (character: string) => character.repeat(64)
const fixture = () => {
  const certificate = { version: 'scene-cut-frame-gate-v1', passed: true,
    identityPlateVersion: 'scene-cut-identity-plate-v4',
    identityPlateBindings: [
      { characterName: '张飞', assetId: 'character-zhang', frontUrl: '/generated/zhang.jpg', frontSha256: hex('a') },
      { characterName: '严颜', assetId: 'character-yan', frontUrl: '/generated/yan.jpg', frontSha256: hex('b') }
    ] }
  const first = { firstShotReady: true, blockers: [], sourceExecutionId: 'record-first',
    sourceResultMd5: 'c'.repeat(32), newFirstVideoUrl: '/generated/first-accepted.mp4',
    newFirstVideoSha256: hex('d'),
    newFirstActualTailUrl: '/generated/first-tail.jpg', newFirstActualTailSha256: hex('e'),
    newFirstMediaAcceptSha256: hex('f'), newFirstCertificateSha256: sceneCutRebindSha256(certificate) }
  const historical = { version: 'original-scene2-historical-media-audit-v1',
    status: 'historical-paid-candidate-only', schema180DirectAdmission: false,
    originalExecutionId: 'record-4x5m31',
    originalResultMd5: '74e5e2f8afcf8f829694aef350629950',
    originalAcceptedScriptSha256: 'a0bd06afdcf6f8019f36c0a5d44b9209d27ec97673550090d72faea1ff31a8e3',
    oldProvider: { taskId: '933544686269653023',
      archivedUrl: '/generated/verified-bb6bc95cbd10cff9b815.mp4',
      archivedSha256: '3546388b7925d4fcade3df94e34238a8e5cc185df4fbabf4f35bc139af1fabd8' },
    native: { nativeFirstJpegSha256: hex('1'), nativeFrameCount: 241, fps: 24, lastPts: 10 },
    originalSpeech: { planned: '张飞：我们的大军已经到了，你为什么不投降，还要抵抗？',
      voiceId: '933124714380816393' } }
  const shot = { id: 'scene-02', duration: 10, audioType: '对白',
    audioText: '张飞：我们的大军已经到了，你为什么不投降，还要抵抗？',
    firstFrameMode: 'reference', continuity: { mode: 'scene_cut', bridgeType: 'cut', previousShotId: 'scene-01' },
    pacing: { version: 'duration-v2' }, visualPrompt: '院落',
    lastFramePrompt: '严颜仍被绑', videoPrompt: '9.261-10秒张飞停口' }
  return { historical, first, shot, certificate }
}

test('read-only scene-02 plan binds actual first tail, frozen identity, native-dialogue policy, and a new courtyard frame', () => {
  const { historical, first, shot, certificate } = fixture()
  const prepared = buildScene2RegenerationPreflight(historical, first, shot, certificate)
  assert.equal(prepared.providerCalls, 0)
  assert.equal(prepared.scene2Accepted, false)
  assert.equal(prepared.plan.sceneCut.priorTailUrl, first.newFirstActualTailUrl)
  assert.equal(prepared.plan.source.firstAcceptedVideoUrl, first.newFirstVideoUrl)
  assert.equal(prepared.plan.sceneCut.firstFrameMode, 'fresh-approved-courtyard-image')
  assert.equal(prepared.plan.audio.oldNativeAacRole,
    'audit-reference-only; never remux to a new picture')
  assert.equal(prepared.plan.source.identityPlates[1].frontSha256,
    certificate.identityPlateBindings[1].frontSha256)
  assert.equal(prepared.plan.providerPreviewOnly.actualRequestNotYetCreated, true)
  assert.equal(prepared.plan.providerPreviewOnly.endImage, null)
  assert.equal(prepared.plan.endState.separateLiveActionEndImageAllowed, false)
})

test('scene-02 plan blocks incomplete first-shot acceptance, identity drift, and altered approved dialogue', () => {
  const { historical, first, shot, certificate } = fixture()
  assert.throws(() => buildScene2RegenerationPreflight(historical,
    { ...first, firstShotReady: false }, shot, certificate), /first-shot actual tail/)
  assert.throws(() => buildScene2RegenerationPreflight(historical, first, shot,
    { ...certificate, identityPlateBindings: [...certificate.identityPlateBindings].reverse() }),
  /identity plates/)
  assert.throws(() => buildScene2RegenerationPreflight(historical, first,
    { ...shot, audioText: '改写台词' }, certificate), /creative/)
  assert.throws(() => buildScene2RegenerationPreflight({ ...historical,
    originalResultMd5: 'a'.repeat(32) }, first, shot, certificate), /historical source/)
  assert.throws(() => buildScene2RegenerationPreflight({ ...historical,
    oldProvider: { ...historical.oldProvider, taskId: 'other' } }, first, shot, certificate),
  /historical source/)
  assert.throws(() => buildScene2RegenerationPreflight(historical,
    { ...first, newFirstVideoUrl: '/generated/other.jpg' }, shot, certificate),
  /first-shot actual tail/)
})

test('scene-02 first-image gate cannot treat a preflight as a signed frame approval', () => {
  const { historical, first, shot, certificate } = fixture()
  const prepared = buildScene2RegenerationPreflight(historical, first, shot, certificate)
  assert.throws(() => verifyScene2RegenerationImageGate(prepared, {}, shot),
    /SCENE_CUT_FRAME_APPROVAL_INVALID/)
  assert.throws(() => verifyScene2RegenerationImageGate({ ...prepared,
    plan: { ...prepared.plan, status: 'accepted' } }, {}, shot),
  /PREFLIGHT_INVALID/)
})

test('A8+B6 scene-02 preflight pins the signed 14-second first-shot lineage', () => {
  const { historical, first, shot, certificate } = fixture()
  const lineage = { version: 'source-bound-composite-a8b6-first-shot-v1',
    planId: hex('1'), manifestSha256: hex('2'), receiptSha256: hex('3'),
    workflowApprovalSha256: hex('4'), amendedShotSha256: hex('5'),
    nativeFrameCount: 337, approvedDurationSeconds: 14 }
  const prepared = buildScene2RegenerationPreflight(historical,
    { ...first, firstShotLineage: lineage }, shot, certificate)
  assert.equal(prepared.plan.version, 'scene2-regeneration-preflight-a8b6-v1')
  assert.deepEqual(prepared.plan.source.firstShotLineage, lineage)
  assert.throws(() => buildScene2RegenerationPreflight(historical,
    { ...first, firstShotLineage: { ...lineage, approvedDurationSeconds: 13 } },
    shot, certificate), /14 second first-shot lineage/)
  assert.throws(() => verifyScene2RegenerationImageGate({ ...prepared,
    plan: { ...prepared.plan, source: { ...prepared.plan.source,
      firstShotLineage: { ...lineage, receiptSha256: hex('6') } } } }, {}, shot),
  /PREFLIGHT_INVALID/)
})
