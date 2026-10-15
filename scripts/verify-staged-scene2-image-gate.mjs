#!/usr/bin/env node
/** Read-only stop before the second shot's paid video node. The first shot,
 * original creative decision, fresh courtyard still and signed review must
 * all refer to the exact same actual first-shot media. */
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { prepareScene2RegenerationPreflight,
  verifyScene2RegenerationImageGate } from '../server/staged-scene2-regeneration-preflight.mjs'

const fail = reason => { throw Error(`SCENE2_IMAGE_PAYMENT_PREFLIGHT_INVALID: ${reason}`) }

function parseArgs(args) {
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (!['--first', '--expected-first-md5', '--second', '--expected-second-md5'].includes(flag)
      || options[flag] !== undefined || !args[i + 1] || args[i + 1].startsWith('--'))
      fail(`invalid or incomplete ${flag}`)
    options[flag] = args[++i]
  }
  if (!/^record-[\w-]+$/.test(options['--first'] ?? '')
    || !/^record-[\w-]+$/.test(options['--second'] ?? '')
    || options['--first'] === options['--second']
    || ![options['--expected-first-md5'], options['--expected-second-md5']]
      .every(value => /^[a-f0-9]{32}$/.test(value ?? '')))
    fail('two distinct record IDs and both reviewed MD5 locks are required')
  return options
}

/** Pure record-state check. The cryptographic asset/approval checks run in
 * verifyScene2RegenerationImageGate after this source route is established. */
export function verifyScene2BeforePaidVideo(prepared, firstRow, secondRow,
  root = process.cwd()) {
  if (prepared?.status !== 'ready-for-new-image-review-only'
    || !prepared.plan || prepared.scene2Accepted !== false)
    fail('accepted first shot and fresh-image plan are not ready')
  const second = decodeExecutionState(secondRow.result)
  const marker = second.secondShotReplayRecovery
  const runs = second.nodeRuns
  const voiceAssets = runs?.[80]?.output?.voiceAssets
  const zhangVoice = Array.isArray(voiceAssets) ? voiceAssets.find(
    asset => asset?.characterName === '张飞')?.videoBinding : undefined
  if (firstRow.workflow_id !== 'wf-sanguo-history-drama'
    || secondRow.workflow_id !== firstRow.workflow_id
    || second.parentExecutionId !== firstRow.id
    || marker?.sourceExecutionId !== firstRow.id
    || marker?.sourceResultMd5 !== firstRow.result_md5
    || marker?.originalExecutionId !== 'record-4x5m31'
    || marker?.originalResultMd5 !== '74e5e2f8afcf8f829694aef350629950'
    || !Array.isArray(runs) || runs.length !== 464
    || runs[67]?.node?.id !== 'sanguo-shot-script-accept'
    || runs[106]?.node?.id !== 'sanguo-scene-cut-approval'
    || runs[108]?.node?.id !== 'sanguo-video'
    || runs.slice(65, 108).some(run => !['success', 'skipped'].includes(run.status))
    || runs[108].status !== 'idle' || runs[108].output !== undefined
    || runs[106].status !== 'success')
    fail('second-shot replay lineage or stop-before-payment boundary changed')
  if (zhangVoice?.modelId !== 'keling3'
    || zhangVoice.voiceId !== prepared.plan.audio.fixedVoiceId)
    fail('second-shot Zhang Fei voice is not the original approved Kling voice')
  const signed = verifyScene2RegenerationImageGate(prepared,
    runs[106].output, runs[67].output, root)
  return { status: 'fresh-second-first-image-signed; paid-video-still-pending',
    firstExecutionId: firstRow.id, firstResultMd5: firstRow.result_md5,
    secondExecutionId: secondRow.id, secondResultMd5: secondRow.result_md5,
    approvedScene2ShotSha256: prepared.plan.source.approvedScene2ShotSha256,
    firstAcceptedVideoSha256: prepared.plan.source.firstAcceptedVideoSha256,
    actualFirstTailSha256: prepared.plan.source.actualFirstTailSha256,
    newSecondFirstFrameUrl: signed.candidateUrl,
    newSecondFirstFrameSha256: signed.candidateSha256,
    newSecondFrameApprovalSignature: signed.approvalSignature,
    providerCalls: 0, databaseWrites: 0, scene2Accepted: false }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const row = async id => (await db.query(
      'SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [id])).rows[0]
    const original = await row('record-4x5m31')
    const first = await row(options['--first'])
    const second = await row(options['--second'])
    if (!first || !second || first.result_md5 !== options['--expected-first-md5']
      || second.result_md5 !== options['--expected-second-md5'])
      fail('reviewed first or second record missing or changed')
    const marker = decodeExecutionState(first.result).sceneCutCompositeRecovery
    const parent = marker?.sourceExecutionId ? await row(marker.sourceExecutionId) : undefined
    const imageApproval = marker?.version
      === 'source-bound-composite-a8b6-fresh-first-shot-v1'
      && marker.imageApprovalExecutionId
      ? await row(marker.imageApprovalExecutionId) : undefined
    const prepared = prepareScene2RegenerationPreflight(original, first,
      parent, process.cwd(), imageApproval)
    const result = verifyScene2BeforePaidVideo(prepared, first, second)
    await db.query('ROLLBACK')
    console.log(JSON.stringify({ mode: 'read-only', ...result }, null, 2))
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
