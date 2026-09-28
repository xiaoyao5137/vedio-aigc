import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { buildHistoricalMapVideoReviewPrompt, collectHistoricalMapVideoPlateEvidence,
  historicalMapVideoReviewFrames, validateHistoricalMapVideoReview } from '../server/historical-map-video-gate.ts'

const exec = promisify(execFile)
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string

test('supplier map video is sampled at seven real middle times before any local labels or portraits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'historical-map-video-'))
  const dir = path.join(root, 'public/generated')
  await mkdir(dir, { recursive: true })
  try {
    const original = path.join(dir, 'supplier-clean-map.mp4')
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xc2d2af:s=320x180:r=24:d=3',
      '-f', 'lavfi', '-i', 'sine=frequency=190:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', original])
    const evidence = await collectHistoricalMapVideoPlateEvidence('/generated/supplier-clean-map.mp4', root)
    const middle = historicalMapVideoReviewFrames(evidence)
    assert.equal(evidence.decoded, true)
    assert.equal(evidence.frames.length, 9)
    assert.equal(middle.length, 7)
    assert.ok(middle.every((frame, index) => frame.url === evidence.frames[index + 1]
      && frame.second === evidence.frameTimes[index + 1]))
    assert.ok(middle.every((frame, index) => index === 0 || frame.second > middle[index - 1].second))
    assert.ok(middle[0].second > 0 && middle.at(-1)!.second < evidence.duration)
    const shot = { visualPrompt: '无字无人物的当阳长坂古代山河。',
      lastFramePrompt: '同一地理范围和朝向。', videoPrompt: '山川位置稳定，缓慢推移。' }
    const prompt = buildHistoricalMapVideoReviewPrompt(evidence, shot)
    assert.match(prompt, /12\.5% 至 87\.5%|七张/)
    assert.match(prompt, /无字无人物的当阳长坂古代山河/)
    const review = { version: 'historical-map-video-review-v1', passed: true,
      sourceVideoSha256: evidence.sha256, evidenceUrl: evidence.evidenceUrl,
      frames: middle.map(frame => ({ ...frame, bakedPeople: false, unreadableText: false,
        observedLabels: [] as string[], routeMarksVisible: false, geographyConsistent: true, issues: [] as string[] })),
      issues: [] as string[] }
    const accepted = validateHistoricalMapVideoReview(review, evidence)
    assert.equal(accepted.reviewedFrames.length, 7)
    const cases: Array<[string, (candidate: typeof review) => void]> = [
      ['middle-frame portrait', candidate => { candidate.frames[3].bakedPeople = true }],
      ['invented place name', candidate => { candidate.frames[2].observedLabels.push('当阳方') }],
      ['unreadable pseudo text', candidate => { candidate.frames[1].unreadableText = true }],
      ['route or arrow', candidate => { candidate.frames[4].routeMarksVisible = true }],
      ['broken geography', candidate => { candidate.frames[5].geographyConsistent = false }],
      ['frame issue contradicts pass', candidate => { candidate.frames[0].issues.push('左上角人物头像') }],
      ['wrong attachment URL', candidate => { candidate.frames[6].url = '/generated/other-frame.jpg' }],
      ['wrong time', candidate => { candidate.frames[6].second += .1 }],
      ['missing one frame', candidate => { candidate.frames.pop() }],
      ['wrong source video hash', candidate => { candidate.sourceVideoSha256 = '0'.repeat(64) }],
      ['wrong evidence URL', candidate => { candidate.evidenceUrl = '/generated/other-evidence.json' }],
    ]
    for (const [name, change] of cases) {
      const candidate = structuredClone(review)
      change(candidate)
      assert.throws(() => validateHistoricalMapVideoReview(candidate, evidence), /HISTORICAL_MAP_VIDEO_REJECTED/, name)
    }
    const incomplete = { ...evidence, frames: evidence.frames.slice(0, -1) }
    assert.throws(() => historicalMapVideoReviewFrames(incomplete), /HISTORICAL_MAP_VIDEO_EVIDENCE_INVALID/)
    await access(original)
    await access(path.join(root, 'public', evidence.url))
  } finally { await rm(root, { recursive: true, force: true }) }
})
