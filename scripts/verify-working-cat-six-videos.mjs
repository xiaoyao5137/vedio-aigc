import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'

const recordId = process.argv[2]
if (!/^record-[\w-]+$/.test(recordId ?? '')) throw Error('请提供明确的执行记录 ID')
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
const exec = promisify(execFile)
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
try {
  const record = (await pool.query('select * from execution_records where id=$1', [recordId])).rows[0]
  if (!record || record.workflow_id !== 'wf-workplace-second-trial-v1') throw Error('执行记录不属于打工猫工作流')
  const state = decodeExecutionState(record.result)
  const shots = state.nodeRuns.find(run => run.node.id === 'node-script' && run.status === 'success')?.output?.shots
  if (!Array.isArray(shots) || shots.length !== 6) throw Error('剧本不是六镜')
  const videos = []
  for (let index = 0; index < 6; index++) {
    const video = state.nodeRuns.find(run => run.node.id === 'node-video' && run.loopIndex === index)
    const review = state.nodeRuns.find(run => run.node.id === 'node-video-review' && run.loopIndex === index)
    const evidence = review?.output?.videoEvidence
    if (video?.status !== 'success' || review?.status !== 'success' || !/^\/generated\/[\w.-]+\.mp4$/.test(evidence?.url ?? '')
      || !/^[a-f0-9]{64}$/.test(evidence?.sha256 ?? '') || evidence?.decoded !== true
      || evidence.width * 16 !== evidence.height * 9 || !Number.isFinite(evidence.duration) || evidence.duration <= 0
      || review.output.originalUrl !== video.output?.url || evidence.originalUrl !== video.output?.url
      || !Array.isArray(evidence.frames) || evidence.frames.length < 4) throw Error(`第 ${index + 1} 镜视频或同源证据无效`)
    const file = path.resolve('public', `.${evidence.url}`)
    const bytes = await readFile(file)
    if (createHash('sha256').update(bytes).digest('hex') !== evidence.sha256) throw Error(`第 ${index + 1} 镜本地文件散列不一致`)
    await exec(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], { timeout: 45_000, maxBuffer: 1024 * 1024 })
    videos.push({ round:index + 1, topic:shots[index].topic, file, sha256:evidence.sha256, bytes:bytes.length,
      width:evidence.width, height:evidence.height, durationSeconds:evidence.duration,
      reviewStatus:review.output.storyMediaReview?.reviewStatus,
      reviewPassed:review.output.passed === true, reviewIssues:review.output.storyMediaReview?.issues ?? [],
      hasAudio:evidence.hasAudio, meanVolumeDb:evidence.meanVolumeDb ?? null })
  }
  if (state.nodeRuns.some(run => !['success', 'skipped'].includes(run.status))) throw Error('循环尚未执行完成')
  const manifest = { workflowId:record.workflow_id, executionRecordId:recordId, verifiedAt:new Date().toISOString(),
    claim:'六个不同循环轮次的视频生成节点成功；本地文件散列、9:16 画幅和完整视频解码已核验。内容质检状态逐镜列出，非人工验收。',
    videos }
  const manifestPath = path.resolve('public/generated', `working-cat-six-videos-${recordId}.json`)
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify({ manifestPath, recordId, videoCount:videos.length,
    reviews:videos.map(video => video.reviewStatus),files:videos.map(video => video.file) }, null, 2))
} finally { await pool.end() }
