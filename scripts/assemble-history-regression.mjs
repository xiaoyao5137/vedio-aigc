import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import ffmpeg from 'ffmpeg-static'
const dir = process.env.QUALITY_OUTPUT_DIR ?? 'logs/quality-regression/real-sequence-v4'
const clips = await Promise.all([0, 1].map(async i => JSON.parse(await fs.readFile(`${dir}/accepted-${i}.json`, 'utf8'))))
if (clips.some(clip => clip.technicalValidation?.passed !== true || clip.visualReview?.passed !== true || clip.speechValidation?.passed !== true)) throw new Error('Only accepted clips may be assembled')
const paced = process.argv.includes('--paced')
let parts = [{ input: 0, start: 0, end: 15, speed: 1 }, { input: 1, start: 0, end: 15, speed: 1 }]
if (paced) {
  // Demonstration edit: speed up only ASR-confirmed silence. Retain the whole
  // source action and the actual matching boundary; spoken passages stay 1x.
  const finish = Number(clips[0].speechValidation.lastSpeechEnd)
  const begin = Number(clips[1].speechValidation.alignment?.[0]?.actualStart)
  if (!Number.isFinite(finish) || !Number.isFinite(begin)) throw new Error('Pacing edit needs actual speech timestamps')
  const tailStart = Math.min(15, finish + 0.33)
  const leadEnd = Math.max(0, Math.min(3, begin - 0.5))
  parts = [{ input: 0, start: 0, end: tailStart, speed: 1 }, { input: 0, start: tailStart, end: 15, speed: 3 },
    { input: 1, start: 0, end: leadEnd, speed: 3 }, { input: 1, start: leadEnd, end: 15, speed: 1 }].filter(p => p.end - p.start > 0.04)
}
const output = path.resolve(`public/generated/history-quality-${paced ? 'edited-' : ''}20260905.mp4`)
const inputs = clips.flatMap(clip => ['-i', path.resolve('public', clip.url.slice(1))])
const filters = parts.flatMap((part, i) => [
  `[${part.input}:v]trim=start=${part.start}:end=${part.end},setpts=(PTS-STARTPTS)/${part.speed}[v${i}]`,
  `[${part.input}:a]atrim=start=${part.start}:end=${part.end},asetpts=PTS-STARTPTS${part.speed === 3 ? ',atempo=1.5,atempo=2' : ''}[a${i}]`,
])
filters.push(parts.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${parts.length}:v=1:a=1[v][a]`)
execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', '-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', '-r', '25', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output], { timeout: 120000 })
const result = { output, duration: parts.reduce((sum, p) => sum + (p.end - p.start) / p.speed, 0), sourceClips: clips.map(c => c.url), parts }
await fs.writeFile(`${dir}/${paced ? 'edit-plan' : 'assembly'}.json`, JSON.stringify(result, null, 2))
console.log(JSON.stringify(result))
