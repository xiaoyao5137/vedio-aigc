#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'

const directory = path.resolve('logs/zhangfei-jiangzhou-identity-20260928')
const proof = JSON.parse(await fs.readFile(path.join(directory, 'identity-consistency-live.json'), 'utf8'))
const expectedId = 'character-2adc61b636f93ba0'
const expectedKeeperId = 'character-mukn7n7k-xzu2tb'
if (proof.status !== 'passed' || proof.distance > proof.threshold || proof.sourceAssetId !== expectedKeeperId
  || !proof.candidateLocalUri?.startsWith('/generated/character-portrait-') || !/^[a-f0-9]{64}$/.test(proof.candidateContentSha256)) {
  throw Error('当前离线同脸证据未通过或未绑定已确认身份图')
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
try {
  const { rows } = await pool.query(`select id,uri,metadata from character_assets where id=$1`, [expectedId])
  const asset = rows[0]
  if (!asset || asset.uri !== proof.candidateLocalUri
    || asset.metadata?.identityReferenceAssetId !== expectedKeeperId
    || asset.metadata?.identityReferenceAnchor?.sourceSnapshotUrl !== proof.sourceSnapshotUrl
    || asset.metadata?.identityReferenceAnchor?.sourceSnapshotFingerprint !== proof.sourceSnapshotFingerprint
    || asset.metadata?.sourceMediaProvenance?.contentSha256 !== proof.candidateContentSha256
    || asset.metadata?.portraitLifecycle?.status === 'superseded') throw Error('人物资产已变化或同脸证据与图像字节未绑定')
  if (asset.metadata.identityConsistency && JSON.stringify(asset.metadata.identityConsistency) !== JSON.stringify(proof)) {
    throw Error('人物资产已有不同的身份核验记录，停止覆盖')
  }
  if (process.argv.includes('--apply') && !asset.metadata.identityConsistency) {
    const updated = await pool.query(`update character_assets
      set metadata=jsonb_set(metadata,'{identityConsistency}',$2::jsonb,true), updated_at=now()
      where id=$1 and uri=$3
        and metadata->>'identityReferenceAssetId'=$4
        and metadata->'sourceMediaProvenance'->>'contentSha256'=$5
        and metadata->'identityReferenceAnchor'->>'sourceSnapshotFingerprint'=$6
        and metadata->'identityConsistency' is null
      returning id,uri,metadata->'identityConsistency' as identity_consistency`,
    [expectedId, JSON.stringify(proof), proof.candidateLocalUri, expectedKeeperId,
      proof.candidateContentSha256, proof.sourceSnapshotFingerprint])
    if (updated.rowCount !== 1) throw Error('身份核验记录 CAS 回填失败，人物资产已变化')
  }
  const after = (await pool.query(`select id,uri,metadata->'identityConsistency' as identity_consistency,
      metadata->'quality' as quality from character_assets where id=$1`, [expectedId])).rows[0]
  const result = { at: new Date().toISOString(), applied: process.argv.includes('--apply'), id: after.id, uri: after.uri,
    status: after.identity_consistency?.status ?? null, distance: after.identity_consistency?.distance ?? null,
    qualityStatus: after.quality?.status ?? null, manualReviewRequired: after.quality?.manualReviewRequired ?? null }
  await fs.writeFile(path.join(directory, 'identity-consistency-backfill.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(result))
} finally { await pool.end() }
