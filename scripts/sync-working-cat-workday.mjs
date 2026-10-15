#!/usr/bin/env node
import { createHash } from 'node:crypto'
import pg from 'pg'
import { WORKING_CAT_FIRST_FRAME_SUFFIX, WORKING_CAT_VIDEO_SUFFIX,
  WORKING_CAT_WORKDAY_PROMPT } from '../src/working-cat-workday-prompt.ts'

const workflowId = 'wf-workplace-second-trial-v1'
const sourceId = 'record-ae3g6x'
const expected = process.argv[2] === '--apply' ? process.argv[3] : undefined
if (process.argv.length !== (expected ? 4 : 2)
  || (expected && !/^[a-f0-9]{32}$/i.test(expected)))
  throw Error('Usage: node scripts/sync-working-cat-workday.mjs [--apply EXPECTED_NODES_MD5]')
const sha = value => createHash('sha256').update(value).digest('hex')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(expected ? 'BEGIN' : 'BEGIN READ ONLY')
  const workflow = (await db.query(`SELECT schema_version,nodes,md5(nodes::text) nodes_md5,
    md5(edges::text) edges_md5 FROM workflow_configs WHERE id=$1${expected ? ' FOR UPDATE' : ''}`,
  [workflowId])).rows[0]
  const source = (await db.query('SELECT md5(result::text) result_md5 FROM execution_records WHERE id=$1',
    [sourceId])).rows[0]
  if (!workflow || workflow.schema_version !== 12 || !source
    || expected && workflow.nodes_md5 !== expected)
    throw Error('workflow schema, source record, or nodes MD5 changed')
  const writers = workflow.nodes.filter(node => node.id === 'node-script')
  if (writers.length !== 1 || writers[0].kind !== 'text'
    || writers[0].modelId !== 'codex-local-vision') throw Error('writer contract changed')
  const images = workflow.nodes.filter(node => node.id === 'node-image')
  if (images.length !== 1 || images[0].kind !== 'image'
    || !images[0].prompt?.includes('${shot.firstFramePrompt}'))
    throw Error('first frame contract changed')
  const imagePrompt = images[0].prompt.includes(WORKING_CAT_FIRST_FRAME_SUFFIX)
    ? images[0].prompt : `${images[0].prompt} ${WORKING_CAT_FIRST_FRAME_SUFFIX}`
  const videos = workflow.nodes.filter(node => node.id === 'node-video')
  if (videos.length !== 1 || videos[0].kind !== 'video'
    || !videos[0].prompt?.includes('${shot.timedActions}'))
    throw Error('video prompt contract changed')
  const videoPrompt = videos[0].prompt.includes(WORKING_CAT_VIDEO_SUFFIX)
    ? videos[0].prompt : `${videos[0].prompt} ${WORKING_CAT_VIDEO_SUFFIX}`
  const nodes = workflow.nodes.map(node => node.id === 'node-script'
    ? { ...node, prompt: WORKING_CAT_WORKDAY_PROMPT }
    : node.id === 'node-image' ? { ...node, prompt: imagePrompt }
      : node.id === 'node-video' ? { ...node, prompt: videoPrompt } : node)
  const receipt = {
    workflowId, sourceId, applied: Boolean(expected), schemaVersion: workflow.schema_version,
    sourceResultMd5: source.result_md5, beforeNodesMd5: workflow.nodes_md5,
    edgesMd5: workflow.edges_md5, beforePromptSha256: sha(writers[0].prompt ?? ''),
    afterPromptSha256: sha(WORKING_CAT_WORKDAY_PROMPT),
    beforeImagePromptSha256: sha(images[0].prompt), afterImagePromptSha256: sha(imagePrompt),
    beforeVideoPromptSha256: sha(videos[0].prompt), afterVideoPromptSha256: sha(videoPrompt),
    changed: writers[0].prompt !== WORKING_CAT_WORKDAY_PROMPT
      || images[0].prompt !== imagePrompt || videos[0].prompt !== videoPrompt,
  }
  if (expected) {
    const updated = (await db.query(`UPDATE workflow_configs SET nodes=$2::jsonb,updated_at=now()
      WHERE id=$1 AND md5(nodes::text)=$3 RETURNING md5(nodes::text) nodes_md5,
      md5(edges::text) edges_md5`, [workflowId, JSON.stringify(nodes), expected])).rows[0]
    const after = (await db.query('SELECT md5(result::text) result_md5 FROM execution_records WHERE id=$1',
      [sourceId])).rows[0]
    if (!updated || updated.edges_md5 !== workflow.edges_md5
      || after?.result_md5 !== source.result_md5) throw Error('CAS or preservation check failed')
    receipt.afterNodesMd5 = updated.nodes_md5
  }
  await db.query('COMMIT')
  console.log(JSON.stringify(receipt, null, 2))
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
