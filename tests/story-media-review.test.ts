import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { bindStoryShotObservations, buildStoryShotAssessmentPrompt, buildStoryShotObservationPrompt, reviewStoryShotVideo,
  storyReviewImageDetail, storyReviewSampleTimes,
  validateStoryShotAssessment, validateStoryShotObservations } from '../server/story-media-review.ts'
import { loadReviewImages, REVIEW_IMAGE_LIMITS, reviewImageContentBlocks } from '../server/review-images.ts'

const exec = promisify(execFile)
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string

const shot = {
  title: '早餐到爪', content: '蓝猫推硬币，柴犬送来包子并停稳。', camera: '固定竖屏', mood: '早晨',
  firstFramePrompt: '蓝猫与柴犬在早餐店柜台两侧。', duration: 7,
  visualBeats: [
    { id: 'coin', action: '蓝猫把硬币推到柴犬面前', completion: '硬币停在柴犬一侧', startSecond: 0, endSecond: 3 },
    { id: 'bag', action: '柴犬把纸袋推到蓝猫面前', completion: '纸袋停在蓝猫一侧', startSecond: 3, endSecond: 6 },
  ],
}

function evidence() {
  const frameTimes = [0, 1.5, 3, 4.5, 6, 6.5, 6.92]
  const frames = frameTimes.map((_, index) => `/generated/verified-test-frame-${index}.jpg`)
  return { decoded: true, sha256: 'a'.repeat(64), evidenceUrl: '/generated/verified-test-evidence.json',
    duration: 7.04, url: '/generated/verified-test.mp4', originalUrl: 'https://example.com/video.mp4',
    frames, frameTimes } as unknown as Parameters<typeof validateStoryShotObservations>[1]
}

function observationDraft(e = evidence()) {
  const descriptions = [
    '蓝猫前爪旁有硬币，柴犬爪边有纸袋。',
    '蓝猫前爪正在推动硬币，纸袋仍在柴犬爪边。',
    '硬币停在柴犬一侧，纸袋仍在柴犬爪边。',
    '硬币停在柴犬一侧，柴犬爪子接触纸袋。',
    '硬币停在柴犬一侧，纸袋停在蓝猫一侧。',
    '硬币停在柴犬一侧，纸袋停在蓝猫一侧。',
    '硬币停在柴犬一侧，纸袋停在蓝猫一侧。',
  ]
  return { version: 'story-shot-observations-v1', sourceVideoSha256: e.sha256, evidenceUrl: e.evidenceUrl,
    frames: e.frames.map((_, frameIndex) => ({ frameIndex, second: e.frameTimes[frameIndex],
      description: descriptions[frameIndex] })) }
}

function observations(e = evidence()) {
  return bindStoryShotObservations(observationDraft(e), e) as ReturnType<typeof observationDraft> & {
    frames: Array<ReturnType<typeof observationDraft>['frames'][number] & { frameUrl: string }>
  }
}

function assessment(e = evidence()) {
  return { version: 'story-shot-media-review-v1', sourceVideoSha256: e.sha256, evidenceUrl: e.evidenceUrl,
    passed: true, beatChecks: [
      { id: 'coin', status: 'complete', startFrameIndex: 0, completionFrameIndex: 2,
        startObservation: '蓝猫前爪旁有硬币', completionObservation: '硬币停在柴犬一侧', reason: '硬币改变所在位置' },
      { id: 'bag', status: 'complete', startFrameIndex: 3, completionFrameIndex: 4,
        startObservation: '柴犬爪子接触纸袋', completionObservation: '纸袋停在蓝猫一侧', reason: '纸袋改变所在位置' },
    ], endingHold: { status: 'complete', firstFrameIndex: 4, lastFrameIndex: 6,
      firstObservation: '纸袋停在蓝猫一侧', lastObservation: '纸袋停在蓝猫一侧', reason: '两帧状态持续' }, issues: [] as string[] }
}

test('story review sampling covers every action and an actual final hold', () => {
  const planned = storyReviewSampleTimes(shot)
  for (const second of Array.from({ length: 14 }, (_, tick) => tick / 2)) assert.ok(planned.includes(second))
  assert.ok([1.2, 1.8, 4.2, 4.8].every(second => planned.includes(second)), 'inspect two intermediate positions in each beat')
  assert.ok(planned.length <= 23, 'reserve one real tail frame')
  const blind = buildStoryShotObservationPrompt(evidence())
  assert.doesNotMatch(blind, /蓝猫把硬币推到柴犬面前|早餐到爪/)
  assert.match(blind, /逐帧独立描述实际可见状态/)
  assert.match(blind, /相关物体到相关角色的实际可见间隙、接触和遮挡/)
  assert.match(blind, /不要把“在某角色一侧\/前方”当成距离描述/)
  assert.doesNotMatch(blind, /verified-test-frame-|"frameUrl"/)
  assert.match(blind, /"frameIndex":0,"second":0/)
})

test('blind observation separates frame facts from comparisons and binds detail images to source indices', () => {
  const blind = buildStoryShotObservationPrompt(evidence())
  assert.match(blind, /表面的标记、数量、内容与开合状态/)
  assert.match(blind, /服饰、配件、构图/)
  assert.match(blind, /握持、悬停、接触或看不清/)
  assert.match(blind, /不穷举所有背景道具与所有角色的距离/)
  assert.doesNotMatch(blind, /对每个可辨认的道具.*每个可见人物/)
  assert.match(blind, /每帧先写本帧事实/)
  assert.match(blind, /两帧都清楚可辨.*不推断中间过程或变化原因/)
  assert.match(blind, /不要用前后帧补全单张画面/)
  assert.match(blind, /附件标签中的 frameIndex 标识其对应原帧/)
  assert.match(blind, /不按附件序号新增帧索引/)
  assert.match(blind, /覆盖全部 7 个采证帧，局部图不增加条目/)
  const prompt = buildStoryShotAssessmentPrompt(shot, evidence(), observations())
  assert.match(prompt, /仅当动作涉及道具交接、到达可触及处或接触时/)
  assert.match(prompt, /接触类动作须引用相应接触双方的可见关系/)
  assert.match(prompt, /其他动作引用证明所要求的姿态、可见表面状态、服饰或构图变化等的原句，不要求道具到手\/爪的距离/)
})

test('detail anchors span the source sequence without duplicates or attachment budget overflow', () => {
  for (let count = 4; count <= 24; count++) {
    const detail = storyReviewImageDetail(count)
    assert.equal(detail.indices.length, Math.min(5, count))
    assert.equal(new Set(detail.indices).size, detail.indices.length)
    assert.equal(detail.indices[0], 0)
    assert.equal(detail.indices.at(-1), count - 1)
    const gaps = detail.indices.slice(1).map((index, offset) => index - detail.indices[offset])
    assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, 'indices remain evenly spread')
    assert.ok(detail.indices.every(index => Number.isInteger(index) && index >= 0 && index < count))
    assert.equal(detail.columns, 2)
    assert.equal(detail.rows, 2)
    assert.equal(detail.overlap, .2)
    assert.ok(count + detail.indices.length * detail.columns * detail.rows <= REVIEW_IMAGE_LIMITS.count)
  }
  assert.deepEqual(storyReviewImageDetail(24).indices, [0, 6, 12, 17, 23])
})

test('eight-second story review samples brief paw contact every half second', () => {
  const eightSecondShot = { ...shot, duration: 8,
    visualBeats: [
      { ...shot.visualBeats[0], endSecond: 4 },
      { ...shot.visualBeats[1], startSecond: 4, endSecond: 7 },
    ] }
  const planned = storyReviewSampleTimes(eightSecondShot)
  for (const second of Array.from({ length: 16 }, (_, tick) => tick / 2)) assert.ok(planned.includes(second))
  assert.ok([1.6, 2.4, 5.2, 5.8].every(second => planned.includes(second)))
  assert.equal(planned.length + 1, 21, 'include the actual decodable tail')
})

test('story review samples near each beat completion without exceeding 24 video frames', () => {
  const denseShot = { ...shot, duration: 15,
    visualBeats: Array.from({ length: 7 }, (_, index) => ({
      id: `beat-${index}`, action: `动作 ${index}`, completion: `动作 ${index} 完成`,
      startSecond: index * 2, endSecond: (index + 1) * 2,
    })) }
  const planned = storyReviewSampleTimes(denseShot)
  assert.ok(planned.length <= 23, 'reserve one frame for the actual decodable tail')
  for (const beat of denseShot.visualBeats) {
    assert.ok(planned.includes(beat.startSecond))
    assert.ok(planned.includes(beat.endSecond - .5))
    assert.ok(planned.includes(beat.endSecond))
  }
  assert.ok(planned.includes(14.5), 'sample the final hold')
})

test('story review accepts only complete beat evidence bound to the sampled video', () => {
  const e = evidence(), observed = observations(e), reviewed = assessment(e)
  assert.deepEqual(validateStoryShotObservations(observationDraft(e), e), [])
  assert.deepEqual(observed.frames.map(frame => frame.frameUrl), e.frames)
  assert.equal(validateStoryShotAssessment(shot, e, observed, reviewed).reviewStatus, 'passed')
  const malformed = structuredClone(reviewed)
  malformed.beatChecks[1].completionObservation = '纸袋已经交给蓝猫但盲观察里没有这一句'
  assert.equal(validateStoryShotAssessment(shot, e, observed, malformed).reviewStatus, 'invalid')
  const wrongVideo = structuredClone(reviewed)
  wrongVideo.sourceVideoSha256 = 'b'.repeat(64)
  assert.equal(validateStoryShotAssessment(shot, e, observed, wrongVideo).reviewStatus, 'invalid')
  const missingBeat = structuredClone(reviewed)
  missingBeat.beatChecks.pop()
  assert.equal(validateStoryShotAssessment(shot, e, observed, missingBeat).reviewStatus, 'invalid')
  const noHold = structuredClone(reviewed)
  noHold.endingHold.lastFrameIndex = 5
  assert.equal(validateStoryShotAssessment(shot, e, observed, noHold).reviewStatus, 'invalid')
  const veryShortHold = structuredClone(e)
  veryShortHold.frameTimes[6] = 6.7
  assert.equal(validateStoryShotAssessment(shot, veryShortHold, observations(veryShortHold), assessment(veryShortHold)).reviewStatus, 'invalid')
  const changedHold = structuredClone(reviewed)
  changedHold.endingHold.firstObservation = '硬币停在柴犬一侧'
  assert.equal(validateStoryShotAssessment(shot, e, observed, changedHold).reviewStatus, 'invalid')
  const contradicted = structuredClone(reviewed)
  contradicted.beatChecks[1].status = 'incomplete'
  assert.equal(validateStoryShotAssessment(shot, e, observed, contradicted).reviewStatus, 'invalid')
  assert.equal(validateStoryShotAssessment(shot, e, observed, contradicted).retryable, false)
})

test('blind observations reject model-supplied URLs and missing, repeated or mistimed frames', () => {
  const e = evidence(), draft = observationDraft(e)
  const injectedUrl = structuredClone(draft) as typeof draft & { frames: Array<typeof draft.frames[number] & { frameUrl?: string }> }
  injectedUrl.frames[0].frameUrl = e.frames[0]
  assert.notDeepEqual(validateStoryShotObservations(injectedUrl, e), [])
  assert.throws(() => bindStoryShotObservations(injectedUrl, e))
  const missing = structuredClone(draft)
  missing.frames.pop()
  assert.notDeepEqual(validateStoryShotObservations(missing, e), [])
  const repeated = structuredClone(draft)
  repeated.frames[1].frameIndex = 0
  assert.match(validateStoryShotObservations(repeated, e).join('；'), /索引重复/)
  const mistimed = structuredClone(draft)
  mistimed.frames[2].second = 2.9
  assert.notDeepEqual(validateStoryShotObservations(mistimed, e), [])
  const wrongSource = structuredClone(draft)
  wrongSource.sourceVideoSha256 = 'b'.repeat(64)
  assert.notDeepEqual(validateStoryShotObservations(wrongSource, e), [])
})

test('a move toward the recipient does not prove a reachable delivery', () => {
  const e = evidence(), reachableShot = structuredClone(shot)
  reachableShot.visualBeats[0].completion = '硬币停在柴犬前爪可触及处'
  const observed = observations(e), reviewed = assessment(e)
  observed.frames[2].description = '银色圆片平放在桌面前部、画面中央偏右，与动物前爪有间隔。'
  reviewed.beatChecks[0].completionObservation = observed.frames[2].description
  const unsupported = validateStoryShotAssessment(reachableShot, e, observed, reviewed)
  assert.equal(unsupported.reviewStatus, 'uncertain')
  assert.equal(unsupported.passed, false)
  assert.equal(unsupported.retryable, false)
  assert.match(unsupported.issues.join('；'), /未证明道具到达指定对象可触及处/)

  observed.frames[2].description = '银色圆片紧挨柴犬前爪，柴犬不挪位就能碰到。'
  reviewed.beatChecks[0].completionObservation = '银色圆片紧挨柴犬前爪'
  assert.equal(validateStoryShotAssessment(reachableShot, e, observed, reviewed).reviewStatus, 'passed')

  observed.frames[2].description = '银色圆片紧挨柴犬前爪的方向摆放，但与柴犬前爪仍有间隔。'
  assert.equal(validateStoryShotAssessment(reachableShot, e, observed, reviewed).reviewStatus, 'uncertain')

  observed.frames[2].description = '银色圆片可见于柴犬前爪右前方，但间隙不清楚。'
  reviewed.beatChecks[0].completionObservation = '银色圆片可见于柴犬前爪右前方'
  assert.equal(validateStoryShotAssessment(reachableShot, e, observed, reviewed).reviewStatus, 'uncertain',
    'direction without visible proximity is insufficient')

  observed.frames[2].description = '两只动物的爪之间有间隔。银色圆片紧邻柴犬前爪，和爪边缘相隔约半个爪宽。'
  reviewed.beatChecks[0].completionObservation = '银色圆片紧邻柴犬前爪'
  assert.equal(validateStoryShotAssessment(reachableShot, e, observed, reviewed).reviewStatus, 'passed',
    'an unrelated actor-to-actor gap must not negate the prop-to-recipient gap')

  observed.frames[2].description = '银色圆片紧挨柴犬前爪方向，但与柴犬前爪仍有明显间隔。'
  reviewed.beatChecks[0].completionObservation = '银色圆片紧挨柴犬前爪方向'
  assert.equal(validateStoryShotAssessment(reachableShot, e, observed, reviewed).reviewStatus, 'uncertain',
    'a contradictory gap in the cited prop sentence must still block completion')

  observed.frames[2].description = '银色圆片紧挨柴犬前爪方向，但离狗爪很远。'
  assert.equal(validateStoryShotAssessment(reachableShot, e, observed, reviewed).reviewStatus, 'uncertain',
    'a directional proximity word cannot override an explicit far distance')

  observed.frames[2].description = '银色圆片紧挨柴犬前爪方向，但到狗爪还有明显间隔。'
  assert.equal(validateStoryShotAssessment(reachableShot, e, observed, reviewed).reviewStatus, 'uncertain',
    'another explicit separation wording must also remain uncertain')
})

test('observed incomplete is retryable; uncertain evidence never purchases a new take', () => {
  const e = evidence(), observed = observations(e)
  for (const frame of observed.frames.slice(4)) frame.description = '硬币停在柴犬一侧，纸袋仍在柴犬一侧。'
  const incomplete = assessment(e)
  incomplete.passed = false
  incomplete.beatChecks[1].status = 'incomplete'
  incomplete.beatChecks[1].reason = '最后一帧纸袋仍在柴犬一侧'
  Object.assign(incomplete.beatChecks[1], { evidenceFrameIndices: [4, 6],
    evidenceObservations: ['纸袋仍在柴犬一侧', '纸袋仍在柴犬一侧'] })
  incomplete.endingHold.status = 'uncertain'
  incomplete.endingHold.reason = '规定的纸袋终态未出现'
  incomplete.issues.push('纸袋未推到蓝猫一侧')
  const rejected = validateStoryShotAssessment(shot, e, observed, incomplete)
  assert.equal(rejected.reviewStatus, 'incomplete')
  assert.equal(rejected.retryable, true)
  const uncertain = structuredClone(incomplete)
  uncertain.beatChecks[1].status = 'uncertain'
  uncertain.beatChecks[1].reason = '纸袋被遮挡，抽帧不足以确认'
  const pending = validateStoryShotAssessment(shot, e, observed, uncertain)
  assert.equal(pending.reviewStatus, 'uncertain')
  assert.equal(pending.retryable, false)

  const short = structuredClone(e)
  short.duration = 6.78
  short.frameTimes[6] = 6.7
  const shortHold = assessment(short)
  shortHold.passed = false
  shortHold.endingHold.status = 'incomplete'
  shortHold.endingHold.reason = '动作完成后仅有 0.7 秒实际可见保持'
  shortHold.issues.push('片尾保持时长不足')
  const shortResult = validateStoryShotAssessment(shot, short, observations(short), shortHold)
  assert.equal(shortResult.reviewStatus, 'incomplete')
  assert.equal(shortResult.retryable, true)
  shortHold.endingHold.firstObservation = '不存在的原帧文字'
  assert.equal(validateStoryShotAssessment(shot, short, observations(short), shortHold).retryable, false)
})

test('reviewer outage retains the paid local clip and actual frame evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'story-media-review-'))
  const dir = path.join(root, 'public/generated')
  await mkdir(dir, { recursive: true })
  try {
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=180x320:r=8:d=7',
      '-f', 'lavfi', '-i', 'sine=frequency=180:duration=7', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', path.join(dir, 'paid-take.mp4')], { timeout: 30_000 })
    const result = await reviewStoryShotVideo({ shot, videoUrl: '/generated/paid-take.mp4',
      model: { id: 'vision', provider: 'Codex', capability: 'text' }, root,
      execute: async () => { throw new Error('reviewer unavailable') } })
    assert.equal(result.passed, false)
    assert.equal(result.reviewStatus, 'unavailable')
    assert.equal(result.retryable, false)
    assert.equal(result.videoUrl, '/generated/paid-take.mp4')
    assert.ok(result.videoEvidence?.url.startsWith('/generated/verified-'))
    assert.ok(result.videoEvidence?.frames.length >= 7)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a 24-frame shot gives both real review requests enough bounded JSON output room', async () => {
  const denseShot = { ...shot, duration: 15,
    visualBeats: Array.from({ length: 7 }, (_, index) => ({ id: `beat-${index}`,
      action: `动作 ${index}`, completion: `动作 ${index} 完成`,
      startSecond: index * 2, endSecond: (index + 1) * 2 })) }
  const root = await mkdtemp(path.join(os.tmpdir(), 'story-dense-review-'))
  const dir = path.join(root, 'public/generated')
  await mkdir(dir, { recursive: true })
  try {
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=180x320:r=24:d=15',
      '-f', 'lavfi', '-i', 'sine=frequency=180:duration=15', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', path.join(dir, 'dense.mp4')], { timeout: 30_000 })
    let sourceVideoSha256 = '', evidenceUrl = ''
    const operations: string[] = []
    const result = await reviewStoryShotVideo({ shot: denseShot, videoUrl: '/generated/dense.mp4',
      model: { id: 'vision', provider: 'Anthropic', capability: 'text' }, root,
      execute: async request => {
        operations.push(request.operation ?? '')
        assert.equal(request.params.maxTokens, 8192)
        if (request.operation === 'story.frame-observe') {
          const urls = request.params.reviewImages as string[]
          assert.equal(urls.length, 24)
          assert.deepEqual(request.params.reviewImageDetail, { indices: [0, 6, 12, 17, 23], columns: 2, rows: 2, overlap: .2 })
          const images = await loadReviewImages(urls, root, request.params.reviewImageDetail)
          assert.equal(images.length, 44, '24 full frames plus 20 local crops, without dropping source frames')
          assert.deepEqual(images.slice(0, 24).map(image => image.frameIndex), Array.from({ length: 24 }, (_, index) => index))
          assert.deepEqual(images.slice(0, 24).map(image => image.url), urls)
          for (const image of images.slice(0, 24)) {
            assert.equal(image.kind, 'original')
            assert.deepEqual(image.bytes, await readFile(path.join(root, 'public', image.url)), 'full JPEG byte stream stays unchanged')
          }
          assert.deepEqual(images.slice(24).map(image => image.frameIndex), [0, 6, 12, 17, 23].flatMap(index => Array(4).fill(index)))
          for (const image of images.slice(24)) {
            assert.equal(image.kind, 'detail')
            assert.match(image.label!, new RegExp(`frameIndex=${image.frameIndex}；`))
            assert.match(image.label!, /源像素矩形/)
          }
          const blocks = reviewImageContentBlocks(images)
          assert.equal(blocks.filter(block => block.type === 'image').length, 44)
          assert.equal(blocks.filter(block => block.type === 'text').length, 44, 'each attachment carries its original index label')
          assert.ok(images.reduce((bytes, image) => bytes + image.bytes.length, 0) < REVIEW_IMAGE_LIMITS.totalBytes)
          const binding = JSON.parse(request.prompt.match(/证据绑定：([^\n]+)/)?.[1] ?? '{}') as {
            sourceVideoSha256: string; evidenceUrl: string; frameTimes: Array<{ frameIndex: number; second: number }>
          }
          sourceVideoSha256 = binding.sourceVideoSha256
          evidenceUrl = binding.evidenceUrl
          return { status: 200, body: { version: 'story-shot-observations-v1', sourceVideoSha256, evidenceUrl,
            frames: binding.frameTimes.map(frame => ({ ...frame, description: '灰色画面，没有人物或道具。' })) } }
        }
        assert.equal(request.operation, 'story.beat-review')
        assert.equal(request.params.reviewImages, undefined)
        assert.equal(request.params.reviewImageDetail, undefined, 'assessment only sees the new blind observations')
        return { status: 200, body: { version: 'story-shot-media-review-v1', sourceVideoSha256, evidenceUrl,
          passed: false, beatChecks: denseShot.visualBeats.map(beat => ({ id: beat.id, status: 'uncertain', reason: '画面无人物' })),
          endingHold: { status: 'uncertain', reason: '画面无剧情终态' }, issues: ['画面无动作'] } }
      } })
    assert.deepEqual(operations, ['story.frame-observe', 'story.beat-review'], result.issues.join('；'))
    assert.equal(result.reviewStatus, 'uncertain')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('quiet real audio is raised on the same decoded video before visual review', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'story-quiet-review-'))
  const dir = path.join(root, 'public/generated')
  await mkdir(dir, { recursive: true })
  const expression = '0.006*sin(2*PI*440*t)*between(t\\,1.5\\,2.6)'
    + '+0.006*sin(2*PI*550*t)*between(t\\,4.3\\,5.4)'
    + '+0.025*sin(2*PI*1200*t)*between(t\\,2.0\\,2.008)'
  try {
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=180x320:r=8:d=7',
      '-f', 'lavfi', '-i', `aevalsrc=${expression}:s=44100:d=7`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'quiet.mp4')], { timeout: 30_000 })
    let reviewCalls = 0
    const result = await reviewStoryShotVideo({ shot, videoUrl: '/generated/quiet.mp4',
      model: { id: 'vision', provider: 'Codex', capability: 'text' }, root,
      execute: async () => { reviewCalls++; throw Error('reviewer unavailable') } })
    assert.equal(result.reviewStatus, 'unavailable')
    assert.equal(reviewCalls, 1, 'visual review was reached after remediating the actual audio track')
    assert.ok(result.audioLevelRemediation)
    assert.equal(result.videoEvidence?.sha256, result.audioLevelRemediation.outputSha256)
    assert.match(result.audioLevelRemediation.sourceUrl, /^\/generated\/verified-[\w.-]+\.mp4$/)
    assert.equal(result.audioLevelRemediation.everyDecodedVideoFrameMatched, true)
    assert.equal(result.audioLevelRemediation.videoFrameCount, 56)
    assert.ok(result.audioLevelRemediation.outputAudio.meanDbfs > -50)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('truly silent audio remains a technical failure and never reaches visual review', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'story-silent-review-'))
  const dir = path.join(root, 'public/generated')
  await mkdir(dir, { recursive: true })
  try {
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=180x320:r=8:d=7',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=7',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'silent.mp4')], { timeout: 30_000 })
    let reviewCalls = 0
    const result = await reviewStoryShotVideo({ shot, videoUrl: '/generated/silent.mp4',
      model: { id: 'vision', provider: 'Codex', capability: 'text' }, root,
      execute: async () => { reviewCalls++; throw Error('must not run') } })
    assert.equal(result.reviewStatus, 'technical-failure')
    assert.equal(reviewCalls, 0)
    assert.equal(result.audioLevelRemediation, undefined)
    assert.match(result.issues.join('；'), /原音轨增益补救未通过/)
    const visualOnly = await reviewStoryShotVideo({ shot, videoUrl: '/generated/silent.mp4',
      model: { id: 'vision', provider: 'Codex', capability: 'text' }, root, requireAudio: false,
      execute: async () => { reviewCalls++; throw Error('reviewer unavailable') } })
    assert.equal(visualOnly.reviewStatus, 'unavailable')
    assert.equal(reviewCalls, 1, 'a shot without an audio contract reaches visual review')
    assert.equal(visualOnly.audioLevelRemediation, undefined)
    assert.ok(visualOnly.videoEvidence?.decoded)
  } finally { await rm(root, { recursive: true, force: true }) }
})
