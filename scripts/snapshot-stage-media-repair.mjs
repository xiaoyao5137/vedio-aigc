// Freeze an execution and its local preview sources. SELECT only, autocommit.
// The PG connection closes before decoding, hashing, or writing evidence.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import pg from 'pg'
import ffmpeg from 'ffmpeg-static'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { parseFfmpegMetadata } from '../server/video-inspection.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'
import { selectPreview, localVideo } from './audit-ten-shot-preview.mjs'

const fail = message => { throw Error(`MEDIA_REPAIR_SNAPSHOT_INVALID: ${message}`) }
async function hashFile(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
async function save(file, value) {
  const handle = await open(file, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n') } finally { await handle.close() }
}

export async function snapshotStageMediaRepair({ sourceId, out, count = 10 }) {
  if (!/^record-[\w-]+$/.test(sourceId ?? '') || !Number.isSafeInteger(count) || count < 1) fail('invalid source/count')
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  let source
  await db.connect()
  try {
    source = (await db.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [sourceId])).rows[0]
    if (!source) fail('source not found')
  } finally { await db.end() }
  const state = decodeExecutionState(source.result)
  if (state.id !== source.id || state.workflowId !== source.workflow_id) fail('record/state identity differs')
  const preview = selectPreview(state, count), hash = createJsonHasher()
  const group = preview.concatRun.loopGroupId
  const runs = state.nodeRuns.filter(run => run.status === 'success' && run.loopGroupId === group && run.loopIndex === 0)
  const role = name => {
    const found = runs.filter(run => run.node?.resultVar === name)
    if (found.length !== 1) fail(`opening ${name} is not unique`)
    return found[0]
  }
  const accepted = preview.shots.map((shot, index) => ({ order: index + 1, runId: shot.accepted.id, output: shot.accepted.output }))
  const sourceFiles = []
  for (const [i, clip] of preview.stage.clips.entries()) {
    const sha256 = await hashFile(localVideo(clip.url))
    if (sha256 !== clip.sha256 || sha256 !== preview.stage.sourceSha256[i]) fail(`source ${i + 1} byte hash differs from saved concat`)
    sourceFiles.push({ order: i + 1, url: clip.url, duration: preview.shots[i].evidence.duration, sha256 })
  }
  const concats = state.nodeRuns.filter(run => run.status === 'success' && run.loopGroupId === group && run.node?.resultVar === 'stage_video'
    && run.output?.clips?.some(clip => (typeof clip === 'string' ? clip : clip.url) === sourceFiles[0].url))
  if (concats.length !== count || concats.some((run, i) => run.loopIndex !== i || run.output.count !== i + 1)) fail('affected prefix concat sequence differs')
  const entry = name => { const run = role(name); return { runId: run.id, old: run.output, new: null } }
  const firstEvidence = role('video_evidence').output
  const oldTail = firstEvidence.extractedLastFrameUrl ?? firstEvidence.lastFrameUrl ?? firstEvidence.frames?.at(-1)
  const referencesTail = value => typeof oldTail === 'string' && (value === oldTail
    || Array.isArray(value) && value.some(referencesTail)
    || value && typeof value === 'object' && Object.values(value).some(referencesTail))
  const next = preview.shots[1]
  const outgoingDependency = next && (next.script.firstFrameMode === 'reuse_previous_tail' || next.script.continuity?.mode === 'continuous'
    || referencesTail(next.take.params))
  const manifestDraft = {
    format: 'stage-media-repair-v1', sourceRecordId: source.id, sourceResultHash: hash(source.result),
    repairs: [{ loopIndex: 0, loopGroupId: group, reason: '替换经实际媒体验收的沙盘开场；保留原第2至10镜文件、声音与历史。',
      shot: entry('shot_script'), take: entry('video_take'), evidence: entry('video_evidence'), accepted: entry('video_shot'),
      outputs: ['shot_candidate', 'first_frame', 'end_frame', 'media_request', 'media_metrics'].map(name => ({ ...entry(name), resultVar: name })),
      continuity: {
        incoming: { status: 'not-applicable', reason: '开场为第一镜，没有前一镜尾帧依赖。' },
        outgoing: outgoingDependency
          ? { status: 'verified', reason: '待补实际新首镜与下一镜衔接证据；此草稿不构成验证。', evidenceRefs: [],
            dependentRunIds: next.scope.filter(run => run.node.resultVar === 'video_take').map(run => run.id), videoUrl: null }
          : { status: 'not-applicable', reason: next ? '下一镜非continuous/reuse_previous_tail；其保存付费请求未引用旧首镜实际尾帧。' : '此预览没有已付费下一镜。' },
      },
    }],
    concats: concats.map(run => ({ runId: run.id, loopIndex: run.loopIndex, loopGroupId: group, old: run.output, new: null })),
  }
  const { stderr } = await promisify(execFile)(ffmpeg, ['-hide_banner', '-nostdin', '-i', localVideo(preview.stage.url), '-t', '0', '-f', 'null', '-'],
    { timeout: 30000, maxBuffer: 2 * 1024 * 1024 })
  const finalMetadata = parseFfmpegMetadata(stderr)
  if (!Number.isFinite(finalMetadata.format.duration) || finalMetadata.format.duration <= 0) fail('invalid actual final duration')
  const bindings = { format: 'stage-media-repair-source-snapshot-v1', sourceRecordId: source.id,
    workflowId: source.workflow_id, sourceResultMd5: source.result_md5, sourceResultHash: hash(source.result),
    requestScopeId: state.requestScopeId, generationScopeId: state.generationScopeId, parentExecutionId: state.parentExecutionId,
    createdAt: new Date().toISOString(), loopGroupId: group, sourceFiles, accepted,
    final: { url: preview.stage.url, sha256: await hashFile(localVideo(preview.stage.url)), duration: finalMetadata.format.duration,
      width: preview.stage.width, height: preview.stage.height, fps: preview.stage.fps },
    openingRuns: runs.map(run => ({ runId: run.id, nodeId: run.node.id, resultVar: run.node.resultVar,
      loopGroupId: run.loopGroupId, loopIndex: run.loopIndex, inputs: run.inputs, output: run.output })),
    concatRuns: concats.map(run => ({ runId: run.id, loopIndex: run.loopIndex, loopGroupId: group, output: run.output })),
    openingScene: role('shot_script').loopItem, modelsCalled: 0, databaseWrites: 0,
    manifestDraftPending: 'Every new:null must be filled from actual producer/API output; this is not an importable manifest yet.',
  }
  await mkdir(out, { recursive: true })
  await save(path.join(out, 'source-record.json'), source)
  await save(path.join(out, 'source-bindings.json'), bindings)
  await save(path.join(out, 'repair-manifest.draft.json'), manifestDraft)
  return { sourceRecordId: source.id, sourceResultMd5: source.result_md5, sourceResultHash: hash(source.result),
    sourceClipCount: sourceFiles.length, affectedConcatCount: concats.length, originalDuration: bindings.final.duration,
    originalOpeningDuration: sourceFiles[0].duration, out: path.resolve(out), modelsCalled: 0, databaseWrites: 0 }
}

async function main() {
  const args = process.argv.slice(2), options = { count: 10 }
  for (let i = 0; i < args.length; i++) {
    const key = { '--source': 'sourceId', '--out': 'out', '--count': 'count' }[args[i]]
    if (!key || !args[i + 1]) fail(`unknown/incomplete argument ${args[i]}`)
    options[key] = args[++i]
  }
  options.count = Number(options.count)
  if (!options.out) fail('--out fresh evidence directory required')
  console.log(JSON.stringify(await snapshotStageMediaRepair(options), null, 2))
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
