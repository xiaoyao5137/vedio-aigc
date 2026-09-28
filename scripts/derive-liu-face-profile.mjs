#!/usr/bin/env node
// Derive a face-only reference from the one saved actual-image observation that
// rejected Liu Bei's old costume description. This is not a costume approval.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'
import sharp from 'sharp'
import { isDeepStrictEqual } from 'node:util'

const workflowId = 'wf-sanguo-history-drama'
const assetId = 'character-mukn7n96-esdd71'
const ledgerId = 'model-run-mukr82po-41nj6nv'
const uri = '/generated/liu-bei-changban-portrait-20260928-v2.png'
const directory = path.resolve('logs/dramatic-expression/live-20260928/artistic-identity-migration')
const backupFile = path.join(directory, 'liu-before-identity-visual-profile.json')
const apply = process.argv.includes('--apply')
const verify = process.argv.includes('--verify')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const sha = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')

try {
  await fs.mkdir(directory, { recursive: true })
  const asset = (await pool.query('select *,xmin::text as row_version from character_assets where id=$1', [assetId])).rows[0]
  const ledger = (await pool.query('select id,model_id,capability,status,workflow_id,node_id,request_data,response_data,created_at,updated_at from model_execution_records where id=$1', [ledgerId])).rows[0]
  if (!asset || asset.workflow_id !== workflowId || asset.character_name !== '刘备' || asset.asset_type !== 'three-view'
    || asset.uri !== uri || asset.metadata?.artisticIdentity?.active !== true || asset.metadata?.visualProfile
    || (asset.metadata?.identityVisualProfile && !verify)) throw Error('刘备当前资产已变化或存在完整核验，拒绝派生')
  if (!ledger || ledger.status !== 'succeeded' || ledger.capability !== 'text' || ledger.model_id !== 'codex-local-vision'
    || ledger.workflow_id !== workflowId || ledger.node_id !== 'artistic-identity-existing-sheet-review'
    || typeof ledger.request_data?.requestKey !== 'string' || !ledger.request_data.requestKey.includes(assetId)) {
    throw Error('原始视觉文本核验 ledger 身份不符')
  }
  const rawText = ledger.response_data?.content?.find(item => item.type === 'text')?.text
  const observed = JSON.parse(rawText)
  if (observed.valid !== true || observed.matchesDesign !== false || typeof observed.appearance !== 'string'
    || !Array.isArray(observed.issues) || observed.issues.length !== 2
    || !observed.issues.some(issue => /头巾/.test(issue)) || !observed.issues.some(issue => /皮甲/.test(issue))
    || observed.visualContextEvidence?.hair !== 'dark' || observed.visualContextEvidence?.facialHair !== 'dark') {
    throw Error('原始观察不是有效同人图、明确服装不符的预期结构，拒绝派生')
  }
  const faceOnlyAppearance = observed.appearance.split('；')[0].trim()
  if (!observed.appearance.startsWith(faceOnlyAppearance) || faceOnlyAppearance.length < 16
    || /衣|袍|甲|冠|发|髭|须|靴/.test(faceOnlyAppearance)) throw Error('无法从原始观察安全提取脸部/骨架事实')
  const fingerprint = sha(uri), snapshot = `/generated/appearance-${fingerprint.slice(0, 24)}.jpg`
  const snapshotBytes = await fs.readFile(path.join(process.cwd(), 'public', snapshot))
  const snapshotInfo = await sharp(snapshotBytes).metadata()
  if (snapshotInfo.format !== 'jpeg' || !snapshotInfo.width || !snapshotInfo.height) throw Error('原核验快照不可解码')
  const profile = { version: 'actual-facial-identity-v1', scope: 'facial-identity-only', valid: true,
    fullDesignMatched: false, sourceFingerprint: fingerprint, referenceImage: snapshot,
    snapshotSha256: sha(snapshotBytes), appearance: faceOnlyAppearance,
    issues: observed.issues, visualContextEvidence: observed.visualContextEvidence,
    observationLedgerId: ledger.id, observationRequestKey: ledger.request_data.requestKey,
    observationResponseHash: sha(rawText), observedAt: new Date(ledger.updated_at).toISOString() }
  const summary = { assetId, ledgerId, profile, beforeRowVersion: asset.row_version,
    beforeMetadataHash: sha(asset.metadata), fullVisualProfileRemains: null,
    currentAssetUri: uri, pendingUserAcceptance: asset.metadata.artisticIdentityReviewStatus }
  if (verify) {
    const proof = { assetId, uriPreserved: asset.uri === uri, fullVisualProfile: asset.metadata.visualProfile ?? null,
      identityVisualProfileMatchesLedger: isDeepStrictEqual(asset.metadata.identityVisualProfile, profile),
      artisticIdentityStatus: asset.metadata.artisticIdentityReviewStatus,
      sourceLedgerId: ledger.id, unresolvedIssues: observed.issues, rowVersion: asset.row_version }
    await fs.writeFile(path.join(directory, 'liu-identity-visual-profile-verification.json'), JSON.stringify(proof, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({ mode: 'verify-only', ...proof }))
    if (!proof.uriPreserved || proof.fullVisualProfile || !proof.identityVisualProfileMatchesLedger) process.exitCode = 1
  } else if (!apply) {
    await fs.writeFile(backupFile, JSON.stringify({ row: asset, sha: sha(asset) }, null, 2), { flag: 'wx', mode: 0o600 })
    await fs.writeFile(path.join(directory, 'liu-identity-visual-profile-dry-run.json'), JSON.stringify(summary, null, 2), { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ mode: 'backup-and-dry-run', assetId, ledgerId, backupFile,
      profileVersion: profile.version, fullDesignMatched: false, issues: profile.issues }))
  } else {
    const backup = JSON.parse(await fs.readFile(backupFile, 'utf8'))
    if (backup.sha !== sha(backup.row) || backup.row.id !== asset.id || backup.row.row_version !== asset.row_version
      || sha(backup.row.metadata) !== sha(asset.metadata)) throw Error('资产行与备份不一致，拒绝覆盖')
    const metadata = { ...asset.metadata, identityVisualProfile: profile }
    const updated = await pool.query('update character_assets set metadata=$2::jsonb,updated_at=now() where id=$1 and xmin::text=$3 and uri=$4 returning id',
      [assetId, JSON.stringify(metadata), asset.row_version, uri])
    if (updated.rowCount !== 1) throw Error('资产并发变化，拒绝覆盖')
    const after = (await pool.query('select id,uri,metadata from character_assets where id=$1', [assetId])).rows[0]
    if (after?.uri !== uri || after.metadata?.visualProfile || !isDeepStrictEqual(after.metadata?.identityVisualProfile, profile)
      || !isDeepStrictEqual(after.metadata?.artisticIdentity, asset.metadata.artisticIdentity)) throw Error('写后核验不符')
    console.log(JSON.stringify({ mode: 'applied', assetId, profileVersion: profile.version,
      fullVisualProfile: null, fullDesignMatched: false, humanAcceptance: 'pending', backupFile }))
  }
} finally { await pool.end() }
