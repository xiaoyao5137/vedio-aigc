// Render only an audited, complete production execution. No fixture fallback.
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import ffmpeg from 'ffmpeg-static'
import { parseFfmpegMetadata } from '../server/video-inspection.ts'
const id = process.argv[2]
if (!id || !/^record-[\w-]+$/.test(id)) throw new Error('Usage: node scripts/assemble-history-execution.mjs <execution-id>')
const directory = path.resolve('logs/quality-regression/full-execution', id)
const audit = JSON.parse(await fs.readFile(path.join(directory, 'audit.json'), 'utf8'))
if (!audit.passed) throw new Error('Full execution audit must pass before assembly')
const state = JSON.parse(await fs.readFile(path.join(directory, 'execution.json'), 'utf8'))
const videos = state.nodeRuns.filter(r => r.status === 'success' && r.node.resultVar === 'video_shot').map(r => r.output)
const timeline = state.nodeRuns.find(r => r.status === 'success' && r.node.resultVar === 'episode_timeline').output
if (videos.length !== timeline.clips.length || videos.length < 2) throw new Error('Incomplete timeline')
const inputs = videos.flatMap(video => {
  if (!/^\/generated\/[\w.-]+\.mp4$/.test(video.url)) throw new Error('Only locally verified media may be rendered')
  return ['-i', path.resolve('public', video.url.slice(1))]
})
const filters = videos.flatMap((_, i) => [
  `[${i}:v]trim=duration=${timeline.clips[i].duration},setpts=PTS-STARTPTS,scale=1280:720,setsar=1,fps=25[v${i}]`,
  `[${i}:a]atrim=duration=${timeline.clips[i].duration},asetpts=PTS-STARTPTS,aresample=48000[a${i}]`,
])
filters.push(videos.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${videos.length}:v=1:a=1[v][a]`)
const output = path.resolve('public/generated', `${id}-full.mp4`)
execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', '-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output], { timeout: 300_000 })
const { spawnSync } = await import('node:child_process')
const probe = spawnSync(ffmpeg, ['-hide_banner', '-xerror', '-i', output, '-f', 'null', '-'], { timeout: 120_000, encoding: 'utf8' })
if (probe.status !== 0) throw new Error(probe.stderr)
const metadata = parseFfmpegMetadata(probe.stderr)
if (Math.abs(metadata.duration - timeline.totalDuration) > 0.5 || !metadata.hasAudio) throw new Error('Rendered duration/audio validation failed')
const result = { executionId: id, output, metadata, clips: videos.map(v => v.url), edited: false, note: '完整保留全部片段剧情及生成尾帧；未作剧情删剪或语速调整。' }
await fs.writeFile(path.join(directory, 'assembly.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result))
