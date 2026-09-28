import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Pool } from 'pg'
import { mirrorGeneratedCharacterImage } from './character-face-consistency.ts'
import { validateThreeViewReference } from './image-references.ts'

export type CharacterPortraitReviewInput = {
  decision: 'accept' | 'reject'
  reviewedContentSha256: string
  note: string
}
export type CharacterPortraitRecoverInput = { action: 'retry' | 'abandon'; note?: string }

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** A local person-library decision is an explicit review of exact image bytes.
 * It never changes the original model comparison or deletes a paid candidate. */
export async function reviewPendingCharacterPortrait(pool: Pool, assetId: string, input: CharacterPortraitReviewInput) {
  if (!assetId.trim()) throw Error('CHARACTER_PORTRAIT_REVIEW_INVALID: 三视图 ID 不能为空')
  if (input.decision !== 'accept' && input.decision !== 'reject') throw Error('CHARACTER_PORTRAIT_REVIEW_INVALID: 审核结果只能是确认可用或拒绝此图')
  const contentSha256 = String(input.reviewedContentSha256 ?? '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(contentSha256)) throw Error('CHARACTER_PORTRAIT_REVIEW_INVALID: 图片内容指纹无效')
  const note = String(input.note ?? '').trim()
  if (note.length < 4 || note.length > 500) throw Error('CHARACTER_PORTRAIT_REVIEW_INVALID: 请填写 4–500 字的人工判断说明')
  const db = await pool.connect()
  try {
    await db.query('begin')
    const result = await db.query(`select id,uri,metadata from character_assets
      where id=$1 and asset_type='three-view' for update`, [assetId])
    const row = result.rows[0]
    if (!row) throw Error('CHARACTER_PORTRAIT_REVIEW_INVALID: 三视图不存在')
    const metadata = object(row.metadata)
    const consistency = object(metadata.identityConsistency)
    const lifecycle = object(metadata.portraitLifecycle)
    const quality = object(metadata.quality)
    const priorDecision = object(metadata.portraitReviewDecision)
    const uri = String(row.uri ?? '')
    const match = uri.match(/^\/generated\/character-portrait-([a-f0-9]{32})\.(?:png|jpg|webp)$/)
    if (!match || match[1] !== contentSha256.slice(0, 32)) {
      throw Error('CHARACTER_PORTRAIT_REVIEW_INVALID: 仅可审核已留存的内容寻址本地候选图')
    }
    const bytes = await readFile(path.join(process.cwd(), 'public', uri))
    const actualSha256 = createHash('sha256').update(bytes).digest('hex')
    const archivedHashes = [consistency.candidateContentSha256, lifecycle.candidateContentSha256]
      .filter(value => value !== undefined && value !== null).map(String)
    if (actualSha256 !== contentSha256 || archivedHashes.length === 0
      || archivedHashes.some(archivedSha256 => archivedSha256 !== contentSha256)) {
      throw Error('CHARACTER_PORTRAIT_REVIEW_STALE: 候选图像素、提交指纹或归档证据不一致，请刷新后重审')
    }
    if (priorDecision.decision === 'accept' || priorDecision.decision === 'reject') {
      if (priorDecision.decision !== input.decision || priorDecision.reviewedContentSha256 !== contentSha256) {
        throw Error('CHARACTER_PORTRAIT_REVIEW_CONFLICT: 此候选已有审核决定，不能覆盖；如需更改请另建版本')
      }
      await db.query('commit')
      return { assetId, decision: input.decision, portraitReviewDecision: priorDecision, alreadyReviewed: true }
    }
    if (consistency.status !== 'needs_manual_review' && lifecycle.status !== 'pending-review') {
      throw Error('CHARACTER_PORTRAIT_REVIEW_INVALID: 此三视图不是待核验候选')
    }
    // Identity approval also requires an actual, decodable three-view sheet.
    // A rejected candidate remains inspectable even if its layout is invalid.
    if (input.decision === 'accept') await validateThreeViewReference(uri)
    const reviewedAt = new Date().toISOString()
    const portraitReviewDecision = {
      version: 'manual-portrait-review-v1', decision: input.decision,
      reviewSource: 'person-library-local-review', reviewedAt, reviewedContentSha256: contentSha256,
      note, priorIdentityConsistency: Object.keys(consistency).length ? consistency : null,
      priorPortraitLifecycle: Object.keys(lifecycle).length ? lifecycle : null,
      priorQuality: Object.keys(quality).length ? quality : null,
    }
    const portraitLifecycle = { ...lifecycle, status: input.decision === 'accept' ? 'active' : 'superseded',
      reason: input.decision === 'accept' ? 'manual-identity-review-accepted' : 'manual-identity-review-rejected',
      reviewedAt }
    const reviewedQuality = { ...quality, canProceed: input.decision === 'accept',
      manualReviewRequired: input.decision !== 'accept',
      portraitReviewDecision: input.decision }
    await db.query(`update character_assets
      set metadata = metadata || jsonb_build_object('portraitReviewDecision',$2::jsonb,'portraitLifecycle',$3::jsonb,'quality',$5::jsonb),
          updated_at = now()
      where id=$1 and uri=$4`, [assetId, JSON.stringify(portraitReviewDecision), JSON.stringify(portraitLifecycle), uri,
      JSON.stringify(reviewedQuality)])
    await db.query('commit')
    return { assetId, decision: input.decision, portraitReviewDecision, alreadyReviewed: false }
  } catch (error) {
    await db.query('rollback')
    throw error
  } finally {
    db.release()
  }
}

/** Recover original paid bytes from the archived provider URL without making a
 * new model request. If the URL is gone, an explicit abandonment preserves the
 * task and URL evidence so a new purchase is never triggered by a plain retry. */
export async function recoverPendingCharacterPortrait(pool: Pool, assetId: string,
  input: CharacterPortraitRecoverInput, options: { fetchImpl?: typeof fetch } = {}) {
  if (!assetId.trim() || !['retry', 'abandon'].includes(input.action)) {
    throw Error('CHARACTER_PORTRAIT_RECOVERY_INVALID: 请选择恢复原图或放弃候选')
  }
  const note = String(input.note ?? '').trim()
  if (input.action === 'abandon' && (note.length < 4 || note.length > 500)) {
    throw Error('CHARACTER_PORTRAIT_RECOVERY_INVALID: 放弃已付费候选需填写 4–500 字的说明')
  }
  const preliminary = (await pool.query(`select uri,metadata from character_assets
    where id=$1 and asset_type='three-view'`, [assetId])).rows[0]
  if (!preliminary) throw Error('CHARACTER_PORTRAIT_RECOVERY_INVALID: 三视图不存在')
  const preliminaryLifecycle = object(object(preliminary.metadata).portraitLifecycle)
  const originalUri = String(preliminaryLifecycle.originalUri ?? '')
  const originalUriFingerprint = createHash('sha256').update(originalUri).digest('hex')
  if (preliminaryLifecycle.status !== 'pending-unrecoverable'
    || !originalUri
    || preliminary.uri !== originalUri
    || preliminaryLifecycle.originalUriFingerprint !== originalUriFingerprint) {
    throw Error('CHARACTER_PORTRAIT_RECOVERY_INVALID: 候选不是有完整来源记录的待恢复原图')
  }
  const mirror = input.action === 'retry'
    ? await mirrorGeneratedCharacterImage(originalUri, { fetchImpl: options.fetchImpl }) : undefined
  const db = await pool.connect()
  try {
    await db.query('begin')
    const row = (await db.query(`select uri,metadata from character_assets
      where id=$1 and asset_type='three-view' for update`, [assetId])).rows[0]
    if (!row) throw Error('CHARACTER_PORTRAIT_RECOVERY_INVALID: 三视图已被删除')
    const metadata = object(row.metadata)
    const lifecycle = object(metadata.portraitLifecycle)
    if (lifecycle.status !== 'pending-unrecoverable' || row.uri !== originalUri
      || lifecycle.originalUriFingerprint !== originalUriFingerprint
      || metadata.portraitReviewDecision !== undefined) {
      throw Error('CHARACTER_PORTRAIT_RECOVERY_STALE: 候选状态已变化，请刷新后重试')
    }
    const at = new Date().toISOString()
    if (mirror) {
      const consistency = object(metadata.identityConsistency)
      const nextMetadata = { ...metadata,
        ...(Object.keys(consistency).length ? { identityConsistency: { ...consistency,
          candidateContentSha256: mirror.contentSha256, candidateLocalUri: mirror.localUri } } : {}),
        ...(mirror.sourceMediaProvenance ? { sourceMediaProvenance: mirror.sourceMediaProvenance } : {}),
        ...(typeof metadata.visualContextImageFingerprint === 'string'
          ? { visualContextImageFingerprint: createHash('sha256').update(mirror.localUri).digest('hex') } : {}),
        portraitLifecycle: { ...lifecycle, status: 'pending-review', reason: 'paid-candidate-original-recovered',
          candidateContentSha256: mirror.contentSha256, recoveredAt: at },
      }
      await db.query(`update character_assets set uri=$2,metadata=$3::jsonb,updated_at=now() where id=$1`,
        [assetId, mirror.localUri, JSON.stringify(nextMetadata)])
      await db.query('commit')
      return { assetId, action: 'retry' as const, status: 'pending-review',
        recoveredContentSha256: mirror.contentSha256, recoveredUri: mirror.localUri }
    }
    const portraitReviewDecision = { version: 'manual-portrait-abandon-v1', decision: 'abandon',
      reviewSource: 'person-library-local-review', reviewedAt: at, note,
      originalUriFingerprint, candidateTaskId: lifecycle.candidateTaskId ?? null,
      priorPortraitLifecycle: lifecycle }
    const nextMetadata = { ...metadata, portraitReviewDecision,
      portraitLifecycle: { ...lifecycle, status: 'superseded', reason: 'unrecoverable-paid-candidate-abandoned',
        reviewedAt: at } }
    await db.query(`update character_assets set metadata=$2::jsonb,updated_at=now() where id=$1`,
      [assetId, JSON.stringify(nextMetadata)])
    await db.query('commit')
    return { assetId, action: 'abandon' as const, status: 'superseded', portraitReviewDecision }
  } catch (error) {
    await db.query('rollback')
    throw error
  } finally { db.release() }
}
