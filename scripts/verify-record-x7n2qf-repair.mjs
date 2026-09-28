import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import pg from 'pg'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { SANGUO_CHARACTER_LOOKUP_CODE, SANGUO_FIRST_FRAME_BRANCH_CODE } from '../src/code-node-presets.ts'
import { validateDramaStoryboard } from '../src/history-drama.ts'

const recordId = 'record-x7n2qf'
const outputDirectory = 'logs/neutral-portrait-background'
const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

await fs.mkdir(outputDirectory, { recursive: true })
await client.connect()
try {
  await client.query('BEGIN READ ONLY')
  const row = (await client.query('SELECT result FROM execution_records WHERE id=$1', [recordId])).rows[0]
  assert.ok(row, `Execution ${recordId} must exist`)
  const beforeHash = hash(row.result)
  const runs = Array.isArray(row.result?.nodeRuns) ? row.result.nodeRuns : []
  const acceptedRun = runs.find(run => run.status === 'success' && String(run.nodeId ?? run.id).startsWith('sanguo-shot-script-accept-sanguo-scene-loop-'))
  assert.ok(acceptedRun?.output, 'A real accepted shot is required for replay')
  const shot = acceptedRun.output
  assert.equal(shot.animationStyle, 'character_illustration')
  assert.ok(Array.isArray(shot.characters) && shot.characters.includes('张角'))

  const lookup = await executeBuiltinNode(client, {
    operation: 'character.lookup',
    params: { workflowId: 'wf-sanguo-history-drama', characters: shot.characters },
  })
  assert.equal(lookup.foundCount, 0)
  assert.equal(lookup.missingCount, 1)
  assert.equal(lookup.missingCharacters[0].continuityKey, '张角-eastern-han-v2')
  assert.ok(lookup.rejectedAssets.some(asset => asset.id === 'character-bb5d55a0b269e29a' && /POSE_INVALID/.test(asset.reason)))

  const characterLookup = await executeCodeNode({ code: SANGUO_CHARACTER_LOOKUP_CODE, context: {
    shot_script: shot, character_lookup_result: lookup,
  } })
  assert.match(characterLookup.missingCharacters[0].description, /黑发|短须/)
  assert.doesNotMatch(characterLookup.missingCharacters[0].designPrompt, /口唇微合|动作刚完成/)

  const branch = await executeCodeNode({ code: SANGUO_FIRST_FRAME_BRANCH_CODE, context: {
    shot_script: shot, loop: { previous: undefined }, character_lookup: characterLookup, character_assets: { items: [] },
  } })
  assert.deepEqual(branch.frameReferenceImages, [])
  assert.equal(branch.shouldGenerateAnimatedEndFrame, false)
  assert.doesNotMatch(branch.framePrompt, /张角|人物插画|淡入|移至画面中心/)
  assert.match(branch.framePrompt, /历史环境背景底板/)

  let storyboardRejection = ''
  try {
    validateDramaStoryboard(shot, {
      dramaticSceneId: shot.dramaticSceneId, contentContractVersion: shot.contentContractVersion,
      editorialRole: shot.editorialRole, visualTreatment: shot.visualTreatment,
      animationStyle: shot.animationStyle, animationAesthetic: shot.animationAesthetic,
    })
  } catch (error) {
    storyboardRejection = error instanceof Error ? error.message : String(error)
  }
  assert.match(storyboardRejection, /visualPrompt 只能描述不含具名人物的历史背景底板/)

  const after = (await client.query('SELECT result FROM execution_records WHERE id=$1', [recordId])).rows[0]
  assert.equal(hash(after.result), beforeHash, 'Read-only replay must not mutate the original execution')
  await client.query('COMMIT')

  const proof = {
    at: new Date().toISOString(), recordId, replayedShotId: shot.id,
    oldPoseAssetRejected: lookup.rejectedAssets,
    nextContinuityKey: lookup.missingCharacters[0].continuityKey,
    sanitizedIdentityDescription: characterLookup.missingCharacters[0].description,
    framePrompt: branch.framePrompt, frameReferenceImages: branch.frameReferenceImages,
    staticIllustrationEndFrameDisabled: branch.shouldGenerateAnimatedEndFrame === false,
    staleShotRejectedBeforeMediaGeneration: storyboardRejection,
    originalRecordPreserved: true, sourceRecordHash: beforeHash,
  }
  await fs.writeFile(`${outputDirectory}/record-x7n2qf-replay.json`, JSON.stringify(proof, null, 2))
  console.log(JSON.stringify(proof, null, 2))
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  await client.end()
}
