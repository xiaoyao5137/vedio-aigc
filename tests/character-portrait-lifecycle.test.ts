import test from 'node:test'
import assert from 'node:assert/strict'
import { currentPortraits, isPendingIdentityReview, isRejectedPortraitReview, isSupersededPortrait,
  portraitReviewCandidateSha256, preferredPortrait } from '../src/character-portrait-lifecycle.ts'

test('superseded paid portraits remain visible but do not become the current face', () => {
  const old = { id: 'old', metadata: { portraitLifecycle: { status: 'superseded', replacedByAssetId: 'new' } } }
  const current = { id: 'new', metadata: {} }
  assert.equal(isSupersededPortrait(old), true)
  assert.deepEqual(currentPortraits([old, current]), [current])
  assert.equal(preferredPortrait([old, current])?.id, 'new')
  assert.equal(preferredPortrait([old]), undefined)
})

test('identity review candidates stay inspectable but are not current or representative', () => {
  const pending = { id: 'pending', metadata: { identityConsistency: { status: 'needs_manual_review' } } }
  const preservedPaid = { id: 'paid', metadata: { portraitLifecycle: { status: 'pending-review' } } }
  const unavailable = { id: 'unavailable', metadata: { portraitLifecycle: { status: 'pending-unrecoverable' } } }
  const accepted = { id: 'accepted', metadata: { identityConsistency: { status: 'passed' } } }
  assert.equal(isPendingIdentityReview(pending), true)
  assert.equal(isPendingIdentityReview(preservedPaid), true)
  assert.equal(isPendingIdentityReview(unavailable), true)
  assert.equal(portraitReviewCandidateSha256(unavailable), undefined)
  assert.equal(portraitReviewCandidateSha256({ metadata: { portraitLifecycle: { status: 'pending-review',
    candidateContentSha256: 'a'.repeat(64) } } }), 'a'.repeat(64))
  assert.deepEqual(currentPortraits([pending, preservedPaid, accepted]), [accepted])
  assert.equal(preferredPortrait([pending, preservedPaid]), undefined)
  const humanAccepted = { id: 'human-accepted', metadata: { identityConsistency: { status: 'needs_manual_review', distance: 0.7 },
    portraitLifecycle: { status: 'active' }, portraitReviewDecision: { version: 'manual-portrait-review-v1', decision: 'accept' } } }
  const humanRejected = { id: 'human-rejected', metadata: { identityConsistency: { status: 'needs_manual_review', distance: 0.7 },
    portraitLifecycle: { status: 'superseded' }, portraitReviewDecision: { version: 'manual-portrait-review-v1', decision: 'reject' } } }
  assert.equal(isPendingIdentityReview(humanAccepted), false)
  assert.equal(isRejectedPortraitReview(humanRejected), true)
  assert.deepEqual(currentPortraits([humanAccepted, humanRejected]), [humanAccepted])
})
