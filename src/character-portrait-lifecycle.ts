import type { CharacterAsset } from './character-asset.ts'

/** Historical portraits remain inspectable, but are not the person's current
 * face or an automatic workflow reference. */
export function isSupersededPortrait(asset: Pick<CharacterAsset, 'metadata'>): boolean {
  const lifecycle = asset.metadata?.portraitLifecycle
  return Boolean(lifecycle && typeof lifecycle === 'object' && !Array.isArray(lifecycle)
    && (lifecycle as Record<string, unknown>).status === 'superseded')
}

/** A newly archived sheet awaiting a face decision stays inspectable but must
 * not seed automatic authoring or appearance reuse. */
export function isPendingIdentityReview(asset: Pick<CharacterAsset, 'metadata'>): boolean {
  const consistency = asset.metadata?.identityConsistency
  const lifecycle = asset.metadata?.portraitLifecycle
  const decision = asset.metadata?.portraitReviewDecision
  if (isRejectedPortraitReview(asset)) return false
  if (decision && typeof decision === 'object' && !Array.isArray(decision)
    && (decision as Record<string, unknown>).version === 'manual-portrait-review-v1'
    && (decision as Record<string, unknown>).decision === 'accept'
    && lifecycle && typeof lifecycle === 'object' && !Array.isArray(lifecycle)
    && (lifecycle as Record<string, unknown>).status === 'active') return false
  return Boolean((consistency && typeof consistency === 'object' && !Array.isArray(consistency)
    && (consistency as Record<string, unknown>).status === 'needs_manual_review')
    || (lifecycle && typeof lifecycle === 'object' && !Array.isArray(lifecycle)
      && ['pending-review', 'pending-unrecoverable'].includes(String((lifecycle as Record<string, unknown>).status))))
}

export function isRejectedPortraitReview(asset: Pick<CharacterAsset, 'metadata'>): boolean {
  const decision = asset.metadata?.portraitReviewDecision
  return Boolean(decision && typeof decision === 'object' && !Array.isArray(decision)
    && (((decision as Record<string, unknown>).version === 'manual-portrait-review-v1'
      && (decision as Record<string, unknown>).decision === 'reject')
      || ((decision as Record<string, unknown>).version === 'manual-portrait-abandon-v1'
        && (decision as Record<string, unknown>).decision === 'abandon')))
}

/** The manual decision is bound to archived local image bytes, never a URL. */
export function portraitReviewCandidateSha256(asset: Pick<CharacterAsset, 'metadata'>): string | undefined {
  const consistency = asset.metadata?.identityConsistency
  const lifecycle = asset.metadata?.portraitLifecycle
  const candidates = [consistency && typeof consistency === 'object' && !Array.isArray(consistency)
    ? (consistency as Record<string, unknown>).candidateContentSha256 : undefined,
  lifecycle && typeof lifecycle === 'object' && !Array.isArray(lifecycle)
    ? (lifecycle as Record<string, unknown>).candidateContentSha256 : undefined]
  return candidates.find((value): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
}

export function currentPortraits<T extends Pick<CharacterAsset, 'metadata'>>(versions: T[]): T[] {
  return versions.filter(version => !isSupersededPortrait(version) && !isPendingIdentityReview(version))
}

export function preferredPortrait<T extends Pick<CharacterAsset, 'metadata'>>(versions: T[]): T | undefined {
  return currentPortraits(versions)[0]
}
