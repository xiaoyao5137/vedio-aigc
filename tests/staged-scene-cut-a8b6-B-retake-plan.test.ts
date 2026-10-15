import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertFreshA8B6BRetakeAncestry } from
  '../server/staged-scene-cut-a8b6-B-retake-plan.mjs'
import { assertFreshA8B6BRetakeGuideReview } from
  '../server/staged-scene-cut-a8b6-B-retake-target.mjs'

const A_SHA = 'a'.repeat(64)
const FRAME_SHA = 'b'.repeat(64)
const B_SHA = 'c'.repeat(64)
const B_PLAN_SHA = 'd'.repeat(64)
const B_TASK_SHA = '2'.repeat(64)
const GUIDE_SHA = 'e'.repeat(64)
const SOURCE_SHA = 'f'.repeat(64)
const parentId = '1'.repeat(64)
function ancestry() {
  return { parent: { version: 'staged-a8b6-fresh-A-plan-v2',
    planId: parentId },
  A: { acceptanceSha256: A_SHA,
    acceptance: { version: 'staged-a8b6-fresh-native-acceptance-v3',
      acceptedFrameIndex: 192, acceptedFrameSha256: FRAME_SHA } },
  B: { mediaSha256: B_SHA,
    media: { taskId: 'new-B-task', videoSha256: B_SHA,
      nativeLastFrameIndex: 144, nativeLastPts: 6 } },
  BPlan: { planSha256: B_PLAN_SHA,
    plan: { sourceA: { acceptanceSha256: A_SHA,
      frameSha256: FRAME_SHA } } },
  BTask: { taskSha256: B_TASK_SHA,
    task: { taskId: 'new-B-task' } },
  rejection: { phase: 'B', planId: parentId,
    taskId: 'new-B-task', videoSha256: B_SHA,
    mediaSha256: B_SHA, taskSha256: B_TASK_SHA,
    phaseBPlanSha256: B_PLAN_SHA,
    sourceA: { acceptanceSha256: A_SHA },
    failedChecks: { frontWristKnotRemainsVisibleThroughout: false } },
  guide: { parentPlanId: parentId,
    acceptedA: { acceptanceSha256: A_SHA,
      nativeTailFrameSha256: FRAME_SHA },
    failedB: { mediaSha256: B_SHA, planSha256: B_PLAN_SHA },
    output: { sha256: GUIDE_SHA } },
  guideReview: { sourceReceiptSha256: SOURCE_SHA,
    targetSha256: GUIDE_SHA } }
}

test('B-only child needs the exact accepted A and rejected B', () => {
  const good = ancestry()
  assert.equal(assertFreshA8B6BRetakeAncestry(good), true)
  const changed = structuredClone(good)
  changed.rejection.failedChecks.frontWristKnotRemainsVisibleThroughout = true
  assert.throws(() => assertFreshA8B6BRetakeAncestry(changed),
    /exact accepted A, failed B/)
  changed.rejection.failedChecks.frontWristKnotRemainsVisibleThroughout = false
  changed.BPlan.plan.sourceA.frameSha256 = '0'.repeat(64)
  assert.throws(() => assertFreshA8B6BRetakeAncestry(changed),
    /exact accepted A, failed B/)
})

test('end guide review cannot be substituted for native B acceptance', () => {
  const source = { parentPlanId: parentId,
    output: { sha256: GUIDE_SHA } }
  const report = { version: 'staged-a8b6-B-retake-target-review-v1',
    parentPlanId: parentId, sourceReceiptSha256: SOURCE_SHA,
    targetSha256: GUIDE_SHA, reviewer: 'Codex', verdict: 'accept',
    reviewedAt: '2026-09-30T00:30:00Z', checks: {
      sameStreetAndFourIdentities: true,
      yanFrontWristKnotClearlyVisible: true,
      zhangAtStopPosition: true,
      guardsWithdrawnToSides: true,
      guideIsNotAcceptedNativeTail: true,
    }, observations: [
      'Same street and camera composition with four foreground people.',
      'The bound front wrists and completed knot are visible in the still.',
    ] }
  assert.equal(assertFreshA8B6BRetakeGuideReview(report, source,
    SOURCE_SHA), true)
  const falseAcceptance = structuredClone(report)
  falseAcceptance.checks.guideIsNotAcceptedNativeTail = false
  assert.throws(() => assertFreshA8B6BRetakeGuideReview(falseAcceptance,
    source, SOURCE_SHA), /guide direct review incomplete/)
})
