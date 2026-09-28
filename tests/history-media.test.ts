import test from 'node:test'
import assert from 'node:assert/strict'
import { historicalVideoPrompt, validateHistoricalMediaReview, generateAcceptedHistoricalVideo, characterAppearanceContext, reviewHistoricalMedia, reviewStoryboardOpening, reviewStoryboardMotion } from '../src/history-media.ts'

test('physical continuity review requires per-person transition evidence and blocks a repeated completed movement', async () => {
  const previousTail = { url: '/generated/tail.jpg', endingState: '甲乙双臂垂下', endCharacters: ['甲', '乙'] }
  const checks = ['甲', '乙'].map(character => ({ character, startingState: '双臂下垂', nextAction: '保持站立', canExecuteAsWritten: true }))
  const base = { candidate: { videoPrompt: '甲再次收回伸出的右手' }, previousTail }
  await assert.rejects(() => reviewStoryboardOpening({ ...base, generate: async () => ({ passed: true, issues: [], checks: [] }) }), /HISTORY_REVIEW_INVALID/)
  await assert.rejects(() => reviewStoryboardOpening({ ...base, generate: async () => ({ passed: false, issues: [{ problem: '手已垂下，无法再次收回', repair: '保持垂手，仍以面色转沉回应' }], checks }) }), /HISTORY_CONTENT_REJECTED/)
  const result = await reviewStoryboardOpening({ ...base, generate: async (_prompt, frames) => {
    assert.deepEqual(frames, [previousTail.url])
    return { passed: true, issues: [], checks }
  } })
  assert.equal(result.scope, 'actual-tail-to-script-actions')
})

test('internal motion review rejects contradictory per-person evidence and requires every segment', async () => {
  const candidate = { __storyboardSegments: [{ id: 'a', characters: ['甲'] }, { id: 'b', characters: ['甲', '乙'] }] }
  const checks = [{ itemId: 'a', character: '甲' }, { itemId: 'b', character: '甲' }, { itemId: 'b', character: '乙' }].map(check => ({ ...check, finalActionState: '手垂下', requestedEndState: '手垂下', canExecuteAsWritten: true }))
  const generate = async () => ({ passed: true, issues: [], checks })
  assert.equal((await reviewStoryboardMotion({ candidate, generate })).passed, true)
  await assert.rejects(() => reviewStoryboardMotion({ candidate, generate: async () => ({ passed: true, issues: [], checks: checks.slice(0, 2) }) }), /HISTORY_REVIEW_INVALID/)
  checks[1].requestedEndState = '手仍指向对手'
  checks[1].canExecuteAsWritten = false
  await assert.rejects(() => reviewStoryboardMotion({ candidate, generate }), /HISTORY_CONTENT_REJECTED/)
})

const shot = { visualPrompt: '甲在右，乙在左。', videoPrompt: '0-5秒：甲递帖。5-13.5秒：乙不接。13.5-15秒：两人保持。', camera: '固定双人中景', lastFramePrompt: '甲右手持拜帖；乙抱臂站在左侧。\n【静态尾帧】附加约束', endCharacters: ['甲', '乙'], characters: ['甲', '乙'], audioType: '对白', audioText: '甲：为何不接？' }
test('the actual provider prompt contains the complete ending and camera contract', () => {
  const prompt = historicalVideoPrompt(shot)
  assert.match(prompt, /固定双人中景/)
  assert.match(prompt, /本镜结束时的自然动作结果】甲右手持拜帖；乙抱臂站在左侧/)
  assert.match(prompt, /0-5秒：甲递帖/)
  assert.match(prompt, /为何不接/)
})
test('a passing review cannot hide a lost character in the actual tail', () => {
  const review = { passed: true, issues: [], endingState: '甲的单人特写', endCharacters: ['甲'] }
  assert.throws(() => validateHistoricalMediaReview(review, shot), /tailCastMismatch/)
  assert.throws(() => validateHistoricalMediaReview({ passed: true, issues: [] }, shot), /缺少实际尾帧/)
  assert.throws(() => validateHistoricalMediaReview({ ...review, passed: false, issues: ['道具消失'], endCharacters: ['甲', '乙'] }, shot), /道具消失/)
  const accepted = validateHistoricalMediaReview({ ...review, endingState: '甲持帖，乙抱臂', endCharacters: ['乙', '甲'] }, shot)
  assert.equal(accepted.lipSyncVerified, false)
})

test('existing identities supply appearance without forcing an old screen position', () => {
  const designs = characterAppearanceContext([{ characterName: '甲', metadata: { description: '甲身着暗褐色襕袍在画面右前方', continuityKey: 'a' } }])
  assert.equal(designs[0].appearance, '甲身着暗褐色襕袍')
})

test('actual quality rejection gets one targeted retake, infrastructure failure gets none', async () => {
  const prompts: string[] = []
  const reports: unknown[] = []
  const common = {
    shot,
    generate: async (prompt: string) => { prompts.push(prompt); return { url: 'https://example.com/clip.mp4' } },
    review: async () => ({ passed: true, issues: [], endingState: '甲持帖，乙抱臂', endCharacters: ['甲', '乙'] }),
    onRejected: async (report: unknown) => { reports.push(report) },
  }
  const result = await generateAcceptedHistoricalVideo({ ...common, inspect: async (_video, attempt) => {
    if (attempt === 0) throw new Error('VIDEO_QUALITY_REJECTED: 台词延续到片尾')
    return { url: '/generated/clip.mp4', hasAudio: true, lastFrameUrl: '/generated/tail.jpg' }
  } })
  assert.equal(prompts.length, 2)
  assert.match(prompts[1], /台词延续到片尾/)
  assert.equal(reports.length, 1)
  assert.equal(result.extractedLastFrameUrl, '/generated/tail.jpg')
  prompts.length = 0
  await assert.rejects(() => generateAcceptedHistoricalVideo({ ...common, inspect: async () => { throw new Error('Whisper runtime missing') } }), /Whisper/)
  assert.equal(prompts.length, 1)
})

test('quality retakes are bounded and never silently pass an unusable second take', async () => {
  let calls = 0
  await assert.rejects(() => generateAcceptedHistoricalVideo({ shot,
    generate: async () => { calls++; return {} },
    inspect: async () => { throw new Error('VIDEO_QUALITY_REJECTED: 道具消失') },
    review: async () => { throw new Error('unreachable') },
  }), /两次未通过实际验收/)
  assert.equal(calls, 2)
})

test('frame observation is blind to the desired story and a contradictory rejection is reviewed again', async () => {
  const calls: Array<{ prompt: string; frames: string[] }> = []
  let comparisons = 0
  const report = await reviewHistoricalMedia({ shot, frames: ['one.jpg', 'two.jpg'], generate: async (prompt, frames) => {
    calls.push({ prompt, frames })
    if (prompt.includes('【实际尾帧状态提取】')) return { endingState: '甲已垂手，乙在左侧站立', endCharacters: ['甲', '乙'] }
    if (frames.length) return { people: [{ position: '左', clothing: '褐色', heldObject: '纸张', pose: '站立' }], setting: '门前' }
    comparisons++
    return { passed: comparisons > 1, issues: comparisons === 1 ? ['实际观察与剧本站位描述完全一致'] : [], endingState: '甲持帖，乙未接', endCharacters: ['甲', '乙'] }
  } })
  assert.equal(report.passed, true)
  assert.equal(comparisons, 2)
  assert.equal(calls.filter(c => c.frames.length === 1).length, 3)
  assert.ok(calls.filter(c => c.frames.length).every(c => !c.prompt.includes('甲递帖')))
  assert.equal(report.method, 'independent-frame-observation-then-script-comparison')
  assert.equal(report.endingState, '甲已垂手，乙在左侧站立')
  assert.deepEqual(report.endingStateEvidence, { method: 'actual-tail-image', frame: 'two.jpg' })
  assert.doesNotMatch(calls.at(-1)!.prompt, /甲右手持拜帖|乙抱臂/)
})

test('two-stage review still rejects a confirmed missing prop', async () => {
  await assert.rejects(() => reviewHistoricalMedia({ shot, frames: ['tail.jpg'], observations: [{ index: 0, people: [], setting: '空门前' }],
    generate: async () => ({ passed: false, issues: ['尾帧空无一人，拜帖消失'], endingState: '空门前', endCharacters: [] }),
  }), /VIDEO_QUALITY_REJECTED/)
})


test('actual reference observation takes precedence over stale action metadata', () => {
  const result = characterAppearanceContext([{ characterName: '周福', metadata: { description: '周福站在桌边手持官印', visualProfile: { appearance: '灰色宽领袍，短黑须，高冠' } } }])
  assert.equal(result[0].appearance, '灰色宽领袍，短黑须，高冠')
})

test('cached speech guards are refreshed without suppressing the listeners scripted laughter', () => {
  const shot = { characters: ['甲', '乙'], visualPrompt: '甲乙隔案相对', audioType: '对白', audioText: '甲：此言有理', camera: '双人中景',
    videoPrompt: '0-3秒：甲抬手。3-8秒：甲说出“此言有理”。8-13.5秒：乙仰头欢笑，甲相视而笑。13.5-15秒：二人闭口静止。\n【同期对白硬约束】乙全程闭口；其他时段均无口型动作。',
    lastFramePrompt: '甲乙举杯相对，闭口静止' }
  const prompt = historicalVideoPrompt(shot)
  assert.match(prompt, /乙仰头欢笑/)
  assert.match(prompt, /保留时间轴已明确编排的微笑、笑声及表情反应/)
  assert.doesNotMatch(prompt, /全程闭口|其他时段均无口型动作/)
  assert.match(prompt, /不得抢说或做语言口型/)
  assert.match(prompt, /最后 1.5 秒所有人物双唇完全贴合、无人声/)
  assert.equal((prompt.match(/【同期对白硬约束】/g) ?? []).length, 1)
})

test('cached narration labels are not sent as words to be spoken', () => {
  const prompt = historicalVideoPrompt({ ...shot, audioType: '旁白', audioText: '旁白：两家宾客错身而过。', videoPrompt: '0-13.5秒：两人错身而过。13.5-15秒：静止。\n【旁白时间硬约束】说完“旁白：两家宾客错身而过。”' })
  assert.doesNotMatch(prompt, /旁白：/)
  assert.match(prompt, /必须生成的同期人声原文】两家宾客错身而过。/)
})


test('frame observation limits concurrency and stops new batches after an infrastructure failure', async () => {
  let active = 0
  let peak = 0
  const started: string[] = []
  await assert.rejects(() => reviewHistoricalMedia({ shot, frames: ['a', 'b', 'c', 'd', 'e', 'f'], generate: async (_prompt, frames) => {
    started.push(frames[0]); active += 1; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, frames[0] === 'a' ? 2 : 8))
    active -= 1
    if (frames[0] === 'a') throw new Error('HTTP 429: invalid upstream token; retryExhausted=true')
    return { people: [], setting: '院门' }
  } }), /429/)
  assert.equal(peak, 2)
  assert.equal(active, 0)
  assert.deepEqual(started, ['a', 'b'])
})
