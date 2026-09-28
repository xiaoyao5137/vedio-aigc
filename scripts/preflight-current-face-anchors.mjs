#!/usr/bin/env node
// Offline macOS Vision landmark check for the two current revised portraits.
// It makes grayscale upper-face crops locally and never calls a provider.
import fs from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { prepareCharacterIdentityAnchor } from '../server/character-identity-anchor.ts'

const ids = ['character-mukn7n7k-xzu2tb', 'character-mukn7n96-esdd71']
const directory = path.resolve('logs/dramatic-expression/live-20260928/artistic-identity-migration')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc', options: '-c default_transaction_read_only=on' })
try {
  await fs.mkdir(directory, { recursive: true })
  const rows = (await pool.query('select id,workflow_id,character_name,uri,metadata from character_assets where id=any($1::text[])', [ids])).rows
  if (rows.length !== ids.length) throw Error('当前两张修订图缺失')
  const proof = []
  for (const id of ids) {
    const row = rows.find(item => item.id === id)
    if (!row || row.workflow_id !== 'wf-sanguo-history-drama' || row.metadata?.artisticIdentity?.active !== true) throw Error(`当前身份图不符：${id}`)
    const profile = row.metadata.visualProfile ?? row.metadata.identityVisualProfile
    if (!profile || !profile.referenceImage || !profile.sourceFingerprint) throw Error(`当前身份图缺少实际观察：${id}`)
    const anchor = await prepareCharacterIdentityAnchor({ assetId: id, sourceUrl: row.uri,
      snapshotUrl: profile.referenceImage, sourceFingerprint: profile.sourceFingerprint })
    if (anchor.sourceAssetId !== id || anchor.colorPolicy !== 'geometry-only-grayscale' || anchor.scope !== 'upper-face-identity-only'
      || anchor.landmarkEvidence?.confidence < 0.7) throw Error(`脸部锚点证据不可靠：${id}`)
    proof.push({ id, name: row.character_name, sourceProfileVersion: profile.version,
      fullVisualProfile: row.metadata.visualProfile?.version ?? null,
      unresolvedCostumeIssues: row.metadata.identityVisualProfile?.issues ?? [],
      anchorUrl: anchor.anchorUrl, anchorFingerprint: anchor.anchorFingerprint,
      colorPolicy: anchor.colorPolicy, scope: anchor.scope, faceBounds: anchor.faceBounds,
      cropBounds: anchor.cropBounds, landmarkEvidence: anchor.landmarkEvidence })
  }
  if (new Set(proof.map(item => item.anchorFingerprint)).size !== ids.length) throw Error('两人脸部锚点指纹相同，拒绝身份混淆')
  await fs.writeFile(path.join(directory, 'face-anchor-preflight.json'), JSON.stringify({
    at: new Date().toISOString(), providerCalls: 0, newGeneratedPortraits: 0, assets: proof }, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({status:'passed',providerCalls:0,assets:proof.map(item=>({id:item.id,anchorUrl:item.anchorUrl,confidence:item.landmarkEvidence.confidence}))}))
} finally { await pool.end() }
