#!/usr/bin/env node
// Source-bound, read-only A v3 request preview. This script cannot save or POST.
import { previewPhaseAV3 } from '../server/staged-scene-cut-v3-preflight.mjs'

if (process.argv.length !== 2) throw Error('A_V3_PREFLIGHT_INVALID: this command takes no arguments')
const { plan, phaseA } = await previewPhaseAV3(process.cwd())
console.log(JSON.stringify({ mode: 'read-only-source-audit', sourceAuditFingerprint: plan.planId,
  sourceRecordId: plan.source.recordId, sourceResultMd5: plan.source.resultMd5,
  approvedShotSha256: plan.source.approvedShotSha256,
  approvedFirstSha256: plan.source.firstSha256,
  identitySha256s: plan.source.identitySha256s,
  previousPaidAttempt: plan.oldPaidAttempt,
  targetGuide: plan.endGuide,
  timeline: plan.timeline, review: plan.review,
  phaseA, phaseB: 'blocked until new A has native-frame acceptance and real seam review',
  providerCalls: 0, databaseReads: 0, databaseWrites: 0 }, null, 2))
