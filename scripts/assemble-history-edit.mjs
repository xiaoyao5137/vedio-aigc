// An explicit, reviewed edit of a complete audited execution. Never changes the
// production checkpoint or speeds up an actor to hide a generation problem.
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import ffmpeg from 'ffmpeg-static'
import { parseFfmpegMetadata } from '../server/video-inspection.ts'

const [id, planFile] = process.argv.slice(2)
if (!/^record-[\w-]+$/.test(id ?? '') || !planFile) throw new Error('Usage: node scripts/assemble-history-edit.mjs <execution-id> <reviewed-edit-plan.json>')
const directory = path.resolve('logs/quality-regression/full-execution', id)
const audit = JSON.parse(await fs.readFile(path.join(directory, 'audit.json'), 'utf8'))
const state = JSON.parse(await fs.readFile(path.join(directory, 'execution.json'), 'utf8'))
const plan = JSON.parse(await fs.readFile(planFile, 'utf8'))
if (!audit.passed || plan.executionId !== id || plan.reviewed !== true) throw new Error('A passed full audit and an explicit reviewed plan for this execution are required')
const runs = state.nodeRuns.filter(run => run.status === 'success' && run.node.resultVar === 'video_shot')
if (!Array.isArray(plan.clips) || plan.clips.length !== runs.length) throw new Error('The edit must retain every scene in order')
const inputs = []
const filters = []
let totalDuration = 0
const spokenWindows = []
for (const [i, run] of runs.entries()) {
  const video = run.output
  const edit = plan.clips[i]
  const shot = state.nodeRuns.find(other => other.loopGroupId === run.loopGroupId && other.loopIndex === run.loopIndex && other.node.resultVar === 'shot_script')?.output
  if (!shot || edit.source !== video.url || edit.sceneId !== shot.id || !/^\/generated\/[\w.-]+\.mp4$/.test(video.url)) throw new Error(`Scene ${i + 1} does not match its audited source`)
  if (![edit.start, edit.end].every(Number.isFinite) || edit.start < 0 || edit.end > 15 || edit.end - edit.start < 1) throw new Error(`Scene ${i + 1} has an invalid source range`)
  const audioStart = edit.audioStart ?? edit.start
  const audioEnd = audioStart + edit.end - edit.start
  if (!Number.isFinite(audioStart) || audioStart < 0 || audioEnd > 15) throw new Error(`Scene ${i + 1} has an invalid audio range`)
  if (audioStart !== edit.start && shot.audioType !== '旁白') throw new Error(`Scene ${i + 1}: dialogue audio must stay synchronized with its original picture`)
  if (!edit.reason?.trim() || !edit.actionEvidence?.trim() || !edit.transitionReview?.trim()) throw new Error(`Scene ${i + 1} lacks action and transition review notes`)
  const alignment = video.speechValidation?.alignment
  if (!Array.isArray(alignment) || !alignment.length) throw new Error(`Scene ${i + 1} lacks actual speech timing`)
  if (!Number.isFinite(video.speechValidation.lastSpeechEnd) || audioEnd < video.speechValidation.lastSpeechEnd + 0.3) throw new Error(`Scene ${i + 1} would truncate the actual end of speech`)
  for (const cue of alignment) {
    if (!Number.isFinite(cue.actualStart) || !Number.isFinite(cue.actualEnd) || audioStart > Math.max(0, cue.actualStart - 0.15) || audioEnd < cue.actualEnd + 0.3) throw new Error(`Scene ${i + 1} would truncate speech or its safety margin`)
    spokenWindows.push({ sceneId: shot.id, start: totalDuration + cue.actualStart - audioStart, end: totalDuration + cue.actualEnd - audioStart, text: cue.planned.text })
  }
  inputs.push('-i', path.resolve('public', video.url.slice(1)))
  filters.push(`[${i}:v]trim=start=${edit.start}:end=${edit.end},setpts=PTS-STARTPTS,scale=1280:720,setsar=1,fps=25[v${i}]`)
  filters.push(`[${i}:a]atrim=start=${audioStart}:end=${audioEnd},asetpts=PTS-STARTPTS,aresample=48000[a${i}]`)
  totalDuration += edit.end - edit.start
}
filters.push(runs.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${runs.length}:v=1:a=1[v][a]`)
const output = path.resolve('public/generated', `${id}-edited.mp4`)
execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', '-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output], { timeout: 300_000 })
const decoded = spawnSync(ffmpeg, ['-hide_banner', '-xerror', '-i', output, '-f', 'null', '-'], { timeout: 120_000, encoding: 'utf8' })
if (decoded.status !== 0) throw new Error(decoded.stderr)
const metadata = parseFfmpegMetadata(decoded.stderr)
if (Math.abs(metadata.duration - totalDuration) > 0.25 || !metadata.hasAudio) throw new Error('Edited output duration/audio validation failed')
const timestamp = seconds => {
  const milliseconds = Math.round(seconds * 1000)
  return `${String(Math.floor(milliseconds / 3600000)).padStart(2, '0')}:${String(Math.floor(milliseconds / 60000) % 60).padStart(2, '0')}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')},${String(milliseconds % 1000).padStart(3, '0')}`
}
const subtitles = output.replace(/\.mp4$/, '.srt')
await fs.writeFile(subtitles, spokenWindows.map((cue, i) => `${i + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.text}\n`).join('\n'))
const report = { executionId: id, output, subtitles, metadata, plan, spokenWindows, speed: 1, renderedAt: new Date().toISOString(), scope: 'reviewed-editorial-cut-of-audited-raw-clips', preciseLipSyncCertified: false }
await fs.writeFile(path.join(directory, 'edited-assembly.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ output, duration: metadata.duration, scenes: runs.length, dialogueCues: spokenWindows.length }))
