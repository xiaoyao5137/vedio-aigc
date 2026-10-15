import test from 'node:test'
import assert from 'node:assert/strict'
import { storyRoommatePersonaIssues } from '../src/story-roommate-persona.ts'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'
import { createStoryScriptSource } from '../src/story-shot-timing.ts'
import { STORY_SCRIPT_PROMPT } from '../src/story-script-prompt.ts'

const noDatabase = { query: async () => { throw Error('review must not query database') } } as never

test('managed writer prompt binds animal voices to story segments without vocal timestamps', () => {
  assert.match(STORY_SCRIPT_PROMPT, /与芙伊同居的舍友，没有工作，不上班/)
  assert.match(STORY_SCRIPT_PROMPT, /每天辛苦上班赚钱/)
  assert.match(STORY_SCRIPT_PROMPT, /卷毛可以是顾客或在家等早餐/)
  assert.match(STORY_SCRIPT_PROMPT, /audioContractVersion为固定值“animal-interaction-v1”/)
  assert.match(STORY_SCRIPT_PROMPT, /speaker、utterance、visualBeatId、responseTo，不写叫声的起止秒数/)
  assert.doesNotMatch(STORY_SCRIPT_PROMPT, /黄白柴犬外形、清醒务实的同事/)
  assert.doesNotMatch(STORY_SCRIPT_PROMPT, /当前采用无台词模式|仅环境声与动作音效，无人话/)
})

function scriptShot(firstFramePrompt: string, content: string, mood = '两位舍友的生活节奏产生反差') {
  return { title: '早餐与午睡', firstFramePrompt, content, mood, camera: '固定中景', duration: 5,
    visualBeats: [
      { id: 'a', action: '芙伊举起早餐袋，朝卷毛叫喵儿', completion: '卷毛看向早餐袋', startSecond: 0, endSecond: 2 },
      { id: 'b', action: '卷毛叫旺回应并接过早餐袋', completion: '早餐袋到了卷毛手里', startSecond: 2, endSecond: 4 },
    ] }
}

test('record-50ob7g breakfast counter and office nap premises fail the roommate contract', () => {
  const breakfast = scriptShot(
    '芙伊在早餐店取餐台拿着蓝橙页面样稿；卷毛站在右侧收银位，以员工姿态直立，穿同款工牌。',
    '0—2秒：芙伊给卷毛的平板做远程工作评审；2—4秒：卷毛从收银位绕隔板走到芙伊身旁。',
    '芙伊与卷毛共同工作、线上对齐方案')
  const nap = scriptShot(
    '芙伊在办公室参加视频会议；卷毛穿同款工牌躺在办公椅后。',
    '0—2秒：芙伊展示方案；2—4秒：卷毛被拉开展示板后投到会议画面。',
    '两个同事在办公室午睡与参会之间制造笑点')
  const issues = storyRoommatePersonaIssues([breakfast, nap])
  assert.ok(issues.some(issue => issue.includes('shots[0].firstFramePrompt') && issue.includes('收银位')))
  assert.ok(issues.some(issue => issue.includes('shots[0].firstFramePrompt') && issue.includes('工牌')))
  assert.ok(issues.some(issue => issue.includes('shots[1].firstFramePrompt') && issue.includes('工牌')))
  assert.ok(issues.some(issue => issue.includes('shots[1].firstFramePrompt') && issue.includes('办公椅后')))
})

test('dog can be a breakfast customer or visit the cat without acquiring a job', () => {
  const customer = scriptShot(
    '早餐店里，芙伊带着上班电脑在取餐区等餐；卷毛穿休闲衫，以顾客身份站在收银台前付款。',
    '0—2秒：芙伊看到两份早餐的价钱，朝卷毛叫喵儿；2—4秒：卷毛作为顾客付钱，叫旺回应。')
  const visitor = scriptShot(
    '芙伊在公司楼下刚结束加班；卷毛穿休闲衣，作为舍友来接她回家。',
    '0—2秒：芙伊收起电脑叫喵儿；2—4秒：卷毛叫旺回应并把家门钥匙递给她。')
  assert.deepEqual(storyRoommatePersonaIssues([customer, visitor]), [])
})

test('coffee counter apron and customer service actions cannot disguise dog employment', () => {
  const apronCounter = scriptShot(
    '卷毛系围裙站在咖啡店吧台，接过客人的订单并递出拿铁。',
    '芙伊赶着上班，卷毛给顾客端咖啡并收钱。')
  const serviceWithoutUniform = scriptShot(
    '芙伊拿着通勤包走向早餐店，卷毛在柜台旁。',
    '卷毛给顾客端咖啡并收钱，芙伊赶着去上班。')
  const negatedRoleButRealService = scriptShot(
    '卷毛不是店员，穿休闲衣站在吧台旁。',
    '卷毛不是店员，却给顾客端咖啡并收钱。')
  const issues = storyRoommatePersonaIssues([apronCounter, serviceWithoutUniform, negatedRoleButRealService])
  assert.ok(issues.some(issue => issue.includes('shots[0].firstFramePrompt') && issue.includes('围裙')))
  assert.ok(issues.some(issue => issue.includes('shots[0].firstFramePrompt') && issue.includes('订单')))
  assert.ok(issues.some(issue => issue.includes('shots[1].content') && issue.includes('给顾客端咖啡')))
  assert.ok(issues.some(issue => issue.includes('shots[2].content') && issue.includes('给顾客端咖啡')))
})

test('coffee shop customer and at-home apron remain roommate-compatible', () => {
  const customer = scriptShot(
    '咖啡店里，卷毛穿休闲衣作为顾客站在吧台前；芙伊拿着通勤包等自己的拿铁。',
    '卷毛接过店员递来的拿铁，自己付钱后和芙伊一起出门。')
  const home = scriptShot(
    '合租家中，卷毛系围裙在厨房做早餐；芙伊穿通勤外套整理工作电脑。',
    '卷毛把早餐端给忙着上班的芙伊，随后摘下围裙躺回沙发。')
  const explicitCustomer = scriptShot(
    '卷毛不是咖啡店店员，而是顾客，站在吧台前等自己点的饮品。',
    '芙伊下班后与舍友卷毛在咖啡店会合，卷毛向店员付款。')
  assert.deepEqual(storyRoommatePersonaIssues([customer, home, explicitCustomer]), [])
})

test('new household story keeps working cat and unemployed roommate without role inversion', () => {
  const shot = scriptShot(
    '合租客厅里，芙伊穿着下班外套，工资入账提醒旁放着待缴的房租单；卷毛穿休闲衣躺在沙发上，旅行背包靠墙。',
    '0—2秒：芙伊放下工作电脑、看着待缴房租单叫喵儿；2—4秒：不上班的卷毛从沙发起身叫旺回应，把玩乐背包移开给芙伊腾出位置。',
    '工作赚钱养家的芙伊与无业在家躺平、四处游玩的卷毛是同居舍友')
  assert.deepEqual(storyRoommatePersonaIssues([shot]), [])
})

test('wf-story script review rejects persona conflict before timing repair or paid media', async () => {
  const shot = scriptShot('卷毛穿同款工牌站在咖啡店收银位，芙伊站在取餐区。',
    '0—2秒：芙伊取餐叫喵儿；2—4秒：卷毛在收银位叫旺回应。')
  let modelCalls = 0
  const result = await executeBuiltinNode(noDatabase, {
    operation: 'story.script-review',
    model: { id: 'writer', provider: 'Kling', capability: 'text', settings: {} },
    executionContext: { workflowId: 'wf-story', nodeId: 'node-script-review' },
    params: { script: [shot], expectedCount: 1 },
  }, async () => { modelCalls += 1; throw Error('should not call model') }) as Record<string, unknown>
  assert.equal(result.passed, false)
  assert.equal(result.code, 'STORY_PERSONA_INVALID')
  assert.equal(modelCalls, 0)
  assert.equal((result.repairAttempt as { attempted: boolean }).attempted, false)
})

test('a saved coworker source cannot be silently retimed into a roommate story', async () => {
  const old = scriptShot('卷毛是芙伊的同事，在办公室工位旁戴工牌。',
    '0—2秒：芙伊展示工作方案；2—4秒：卷毛参加会议并回应。')
  const source = createStoryScriptSource([old], { sourceExecutionId: 'record-50ob7g', sourceRunId: 'node-script' })
  const replacement = scriptShot('芙伊和无业舍友卷毛在家中。',
    '0—2秒：芙伊放下工作电脑；2—4秒：卷毛收起出游背包。')
  const result = await executeBuiltinNode(noDatabase, {
    operation: 'story.script-review',
    executionContext: { workflowId: 'wf-story', nodeId: 'node-script-review' },
    params: { script: [replacement], source, expectedCount: 1 },
  }) as Record<string, unknown>
  assert.equal(result.passed, false)
  assert.equal(result.code, 'STORY_PERSONA_INVALID')
  assert.ok((result.issues as string[]).some(issue => issue.includes('原') || issue.includes('同事')))
})

test('wf-story accepts the consistent roommate scene with a timed cat and dog exchange', async () => {
  const shot = scriptShot('家中，芙伊穿下班外套放着工作电脑，卷毛穿休闲衫躺在沙发上。',
    '0—2秒：芙伊举起早餐袋，朝卷毛叫喵儿；2—4秒：卷毛叫旺回应并接过早餐袋。',
    '芙伊工作赚钱养家，卷毛无业在家躺平，两位同居舍友互相回应')
  const planned = Object.assign(shot, {
    audioContractVersion: 'animal-interaction-v1',
    vocalBeats: [
      { id: 'cat', speaker: '芙伊', utterance: '喵儿', startSecond: 0.7, endSecond: 1.2,
        visualBeatId: 'a', responseTo: null },
      { id: 'dog', speaker: '卷毛', utterance: '旺', startSecond: 2.3, endSecond: 2.8,
        visualBeatId: 'b', responseTo: 'cat' },
    ],
  })
  const result = await executeBuiltinNode(noDatabase, {
    operation: 'story.script-review',
    executionContext: { workflowId: 'wf-story', nodeId: 'node-script-review' },
    params: { script: [planned], expectedCount: 1 },
  }) as Record<string, unknown>
  assert.equal(result.passed, true)
})

test('wf-story silent draft needs a new script instead of a timing-only model repair', async () => {
  const shot = scriptShot('家中，芙伊带着工作电脑，卷毛穿休闲衫在沙发上。',
    '0—2秒：芙伊举起早餐袋，朝卷毛叫喵儿；2—4秒：卷毛叫旺回应并接过早餐袋。')
  let modelCalls = 0
  const result = await executeBuiltinNode(noDatabase, {
    operation: 'story.script-review',
    model: { id: 'writer', provider: 'Kling', capability: 'text', settings: {} },
    executionContext: { workflowId: 'wf-story', nodeId: 'node-script-review' },
    params: { script: [shot], expectedCount: 1 },
  }, async () => { modelCalls += 1; throw Error('should not call model') }) as Record<string, unknown>
  assert.equal(result.passed, false)
  assert.ok((result.issues as string[]).some(issue => issue.includes('ANIMAL_INTERACTION_INVALID:')))
  assert.equal((result.repairAttempt as { attempted: boolean }).attempted, false)
  assert.equal(modelCalls, 0)
})
