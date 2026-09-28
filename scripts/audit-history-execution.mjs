import { historicalCrossingIssue } from '../src/history-motion.ts'
import { HISTORY_PACING_VERSION, narrativeTransitionIssue } from '../src/history-pacing.ts'
import { validateHistoricalMediaReview } from '../src/history-media.ts'
// Audit an actual application execution, not a hand-written scene fixture.
import fs from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { validateHistoricalAgency, validateHistoricalProductionPlan } from '../src/history-content-guards.ts'
import { historicalContinuityIssue } from '../src/storyboard-runtime.ts'
const requestedId = process.argv[2] ?? 'latest'
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
try {
  const latest = (await pool.query("select id from execution_records where workflow_id='wf-sanguo-history-drama' order by created_at desc limit 1")).rows[0]?.id
  const id = requestedId === 'latest' ? latest : requestedId
  if (!id) throw new Error('No actual historical workflow execution exists')
  const row = (await pool.query('select * from execution_records where id=$1', [id])).rows[0]
  if (!row) throw new Error('Execution record not found')
  const state = row.result
  const runs = state.nodeRuns
  const output = resultVar => runs.filter(r => r.node.resultVar === resultVar && r.status === 'success').map(r => r.output)
  const sources = output('historical_sources')[0]
  const outline = output('scene_outline')[0]
  const shotRuns = runs.filter(r => r.node.resultVar === 'shot_script' && r.status === 'success')
  const videoRuns = runs.filter(r => r.node.resultVar === 'video_shot' && r.status === 'success')
  const shots = shotRuns.map(r => r.output)
  const videos = videoRuns.map(r => r.output)
  const matching = (candidates, run, offset = 0) => candidates.find(other => other.loopGroupId === run.loopGroupId && other.loopIndex === run.loopIndex + offset)?.output
  const verification = output('historical_verification')[0]
  const timeline = output('episode_timeline')[0]
  const issues = []
  if (id !== latest) issues.push('This is an older execution; it cannot certify the latest workflow run')
  if (state.mode !== 'run') issues.push('This is not a full-mode execution')
  for (const run of runs) if (!['success', 'skipped'].includes(run.status)) issues.push(`${run.node.id}: ${run.status}`)
  if (!sources?.citations?.length || sources.sourceMode !== 'internet') issues.push('No actual internet sources')
  if (!outline?.contentReview?.passed) issues.push('Outline review incomplete')
  if (outline) {
    try { validateHistoricalProductionPlan(outline); validateHistoricalAgency(outline, sources?.citations ?? []) } catch (e) { issues.push(e.message) }
  }
  if (videos.length < 2) issues.push('At least two actual completed loop rounds are required')
  if (videos.length !== shots.length) issues.push(`Completed video count ${videos.length} differs from script count ${shots.length}`)
  if (!verification?.passed) issues.push('Final historical/media verification incomplete')
  if (!timeline || timeline.clipCount !== videos.length) issues.push('Timeline not completed or count differs')
  for (const [index, video] of videos.entries()) {
    const run = videoRuns[index]
    const shot = matching(shotRuns, run) ?? {}
    const clipNumber = run.loopIndex + 1
    if (shot.pacing?.version !== HISTORY_PACING_VERSION) issues.push(`Clip ${clipNumber} predates dynamic pacing and narrative closure checks`)
    try { validateHistoricalMediaReview(video.visualReview ?? {}, shot) } catch (error) { issues.push(`Clip ${clipNumber}: ${error.message}`) }
    const narrativeIssue = narrativeTransitionIssue({dramaticUnitId:shot.storyProgress?.unitId,continuityFromPrevious:shot.firstFrameMode==='reuse_previous_tail'}, matching(shotRuns,run,-1),matching(videoRuns,run,-1))
    if (narrativeIssue) issues.push(`Clip ${clipNumber}: ${narrativeIssue}`)
    if (!video.technicalValidation?.passed || !video.speechValidation?.passed || !video.visualReview?.passed) issues.push(`Clip ${clipNumber} lacks technical/speech/visual evidence`)
    if (video.url?.startsWith('/generated/')) await fs.access(path.join(process.cwd(), 'public', video.url))
    else issues.push(`Clip ${clipNumber} not locally decoded`)
    if (shot.firstFrameMode === 'reuse_previous_tail' && !(typeof video.firstFrameDifference === 'number' && video.firstFrameDifference <= 0.10)) issues.push(`Clip ${clipNumber} lacks actual previous-tail comparison`)
    const crossingIssue = historicalCrossingIssue(shot, video)
    if (crossingIssue) issues.push(`Clip ${clipNumber}: ${crossingIssue}`)
    const continuityIssue = historicalContinuityIssue(shot, video, matching(shotRuns, run, -1), matching(videoRuns, run, -1))
    if (continuityIssue) issues.push(`Clip ${clipNumber}: ${continuityIssue}`)
  }
  const ledger = (await pool.query(`select id,node_id,provider,model_id,status,http_status,task_id,duration_ms,created_at,
    request_data->>'operation' as operation, response_data->'transport' as transport
    from model_execution_records where request_data->>'requestKey' like $1 order by created_at`, [`${state.requestScopeId ?? id}:%`])).rows
  for (const [index, video] of videos.entries()) {
    const taskId = String(video.raw?.data?.task_id ?? video.raw?.task_id ?? '')
    if (!taskId || !ledger.some(entry => entry.task_id === taskId && entry.provider === 'Kling' && entry.status === 'succeeded')) issues.push(`Clip ${index + 1} lacks a matching real provider completion record`)
  }
  const report = { executionId: id, createdAt: row.created_at, auditedAt: new Date().toISOString(), scope: 'actual-full-application-execution',
    passed: issues.length === 0, issues, sources: sources?.citations?.map(c => ({ index: c.index, title: c.title, url: c.url })),
    shots: shots.map((s, i) => {
      const video = matching(videoRuns, shotRuns[i])
      return { id: s.id, title: s.title, characters: s.characters, deriveFromPrevious: s.firstFrameMode === 'reuse_previous_tail', video: video?.url,
        firstFrameDifference: video?.firstFrameDifference, qualityAttempts: video?.qualityAttempts }
    }),
    preciseLipSyncCertified: false, ledger }
  const directory = path.join('logs/quality-regression/full-execution', id)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'audit.json'), JSON.stringify(report, null, 2))
  await fs.writeFile(path.join(directory, 'execution.json'), JSON.stringify(state, null, 2))
  console.log(JSON.stringify({ executionId: id, passed: report.passed, issues, clips: videos.length, directory }))
  if (issues.length) process.exitCode = 1
} finally { await pool.end() }
