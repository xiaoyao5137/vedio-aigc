import assert from 'node:assert/strict'
import test from 'node:test'
import { assertFreshA8B6EndGuidePlan } from
  '../server/staged-scene-cut-a8b6-fresh-composite.mjs'

const hash = (letter: string) => letter.repeat(64)
const parentPlanId = hash('a')
const guide = { role: 'target-guide-only',
  url: '/generated/a8b6-retake-A-end-guide.png', sha256: hash('b'),
  targetSourceReceiptSha256: hash('c'), targetReviewSha256: hash('d'),
  targetPromptAmendmentSha256: hash('9') }
const entry = (role: string) => ({ role,
  source: { url: role === 'end_frame' ? guide.url
    : `/generated/${role}.png`, sha256: role === 'end_frame'
    ? guide.sha256 : hash('e') },
  transport: { sha256: role === 'end_frame' ? hash('f') : hash('e') } })
const retake = { parentPlanId, parentManifestSha256: hash('1'),
  parentWorkflowApprovalSha256: hash('2'),
  parentTaskId: '934036356547235843', parentTaskSha256: hash('3'),
  parentRequestSha256: hash('4'), parentVideoSha256: hash('5'),
  parentMediaReceiptSha256: hash('6'), parentRejectionSha256: hash('7'),
  targetSourceReceiptSha256: guide.targetSourceReceiptSha256,
  targetReviewSha256: guide.targetReviewSha256,
  targetPromptAmendmentSha256: guide.targetPromptAmendmentSha256 }
const manifest = { version: 'staged-a8b6-fresh-A-plan-v2', planId: hash('8'),
  source: { frameProvenanceVariant: 'a8b6-local-composite-v9' }, retake,
  phaseA: { endFrame: guide },
  compactTransport: { entries: ['first_frame', 'identity_1',
    'identity_2', 'end_frame'].map(entry) },
  phaseAPreview: { imageTypes: ['reference', 'reference',
    'first_frame', 'end_frame'], endFrameTransportSha256: hash('f') },
  forbiddenSources: [{ taskId: retake.parentTaskId,
    sha256: retake.parentVideoSha256,
    url: `/generated/fresh-a8b6-${parentPlanId.slice(0, 16)}-A-${retake.parentTaskId}.mp4` }] }

test('v1 has no A guide; v2 binds a separate signed guide and rejected parent', () => {
  assert.equal(assertFreshA8B6EndGuidePlan({
    version: 'staged-a8b6-fresh-A-plan-v1', phaseA: { endFrame: null },
  }), null)
  assert.throws(() => assertFreshA8B6EndGuidePlan({
    version: 'staged-a8b6-fresh-A-plan-v1', phaseA: { endFrame: guide },
  }), /A plan version or end guide changed/)
  assert.deepEqual(assertFreshA8B6EndGuidePlan(manifest), guide)
  assert.deepEqual(assertFreshA8B6EndGuidePlan({ ...manifest,
    version: 'staged-a8b6-fresh-A-plan-v3', planId: hash('8'),
    bRetake: { parentPlanId: manifest.planId } }), guide)
  assert.throws(() => assertFreshA8B6EndGuidePlan({ ...manifest,
    phaseA: { endFrame: { ...guide, targetReviewSha256: hash('9') } },
  }), /retake target guide/)
  assert.throws(() => assertFreshA8B6EndGuidePlan({ ...manifest,
    phaseA: { endFrame: { ...guide, targetPromptAmendmentSha256: hash('8') } },
  }), /retake target guide/)
  assert.throws(() => assertFreshA8B6EndGuidePlan({ ...manifest,
    forbiddenSources: [],
  }), /retake target guide/)
  assert.throws(() => assertFreshA8B6EndGuidePlan({ ...manifest,
    forbiddenSources: [{ taskId: retake.parentTaskId },
      { sha256: retake.parentVideoSha256 }],
  }), /retake target guide/)
  assert.throws(() => assertFreshA8B6EndGuidePlan({ ...manifest,
    compactTransport: { entries: manifest.compactTransport.entries.slice(0, 3) },
  }), /retake target guide/)
})
