import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SANGUO_DRAMATIC_EXPRESSION_OUTLINE_PROMPT,
  SANGUO_DRAMATIC_EXPRESSION_STORYBOARD_PROMPT,
  DRAMATIC_EXPRESSION_TEXT_REVIEW_PROMPT,
  DRAMATIC_EXPRESSION_MEDIA_REVIEW_PROMPT,
  DRAMATIC_EXPRESSION_EPISODE_REVIEW_PROMPT,
  refreshDramaticExpressionPrompt,
  upgradeDramaticExpression,
} from '../src/dramatic-expression.ts'
import { upgradeQualityWorkflow } from '../src/quality-node-presets.ts'
import { upgradePrincipleQuality } from '../src/principle-workflow.ts'
import { SANGUO_SCENE_OUTLINE_PROMPT } from '../src/scene-outline-prompt.ts'
import { generateHistoricalStoryboard, promptForStoryboardScene } from '../src/storyboard-runtime.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { chantScene, chantShot, songText } from './fixtures/duration-v2-chant.ts'

const sections = {
  outline: { start: '【影视表达与现代汉语·大纲】', end: '【影视表达与现代汉语·大纲结束】', body: SANGUO_DRAMATIC_EXPRESSION_OUTLINE_PROMPT },
  storyboard: { start: '【影视表达与现代汉语·分镜】', end: '【影视表达与现代汉语·分镜结束】', body: SANGUO_DRAMATIC_EXPRESSION_STORYBOARD_PROMPT },
}
const count = (text: string, needle: string) => text.split(needle).length - 1
const stale = (stage: keyof typeof sections) => sections[stage].start + '\n旧版本：全部用古文，人物只需点头。\n' + sections[stage].end
const sourceQuote = '二家賓客，互相譏揣，遂各樹朋徒。'
const customPrefix = '用户自定义创作范围：${input.adaptation_policy}\n史料原文：' + sourceQuote + '\n'
const customSuffix = '\n用户补充：当前场景=${scene}；上一镜=${loop.previous.shot_script}；史料=${historical_sources.citations}'

const node = (id: string, prompt: string, kind = 'text') => ({
  id, title: id, kind, resultVar: id.replaceAll('-', '_'), prompt, modelId: 'user-selected-writer',
  params: [{ id: 'user-timeout', name: 'timeoutMs', englishName: 'timeoutMs', type: 'number', required: true, value: '900000' }],
  uploads: [], loop: { enabled: false, sourcePath: '', fallbackCount: 1, itemVar: '' }, position: { x: 42, y: 53 },
  code: 'return context;', operation: id === 'sanguo-scene-outline' ? 'history.scene-outline' : 'history.storyboard',
})
const workflow = (schemaVersion = 144) => ({
  id: 'wf-sanguo-history-drama', schemaVersion, name: '用户配置三国短剧', voicePolicy: 'frozen-voices',
  nodes: [
    node('sanguo-scene-outline', customPrefix + stale('outline') + customSuffix),
    node('sanguo-shot-script', customPrefix + stale('storyboard') + customSuffix),
    node('sanguo-video', '已完成付费视频参数：${shot_script.audioText}', 'video'),
    node('custom-writer', '用户其他写作节点'),
    node('sanguo-scene-outline-review', '现有史实审核内容'),
    node('sanguo-shot-script-review', '现有分镜审核内容'),
    node('sanguo-media-review', '现有成片审核内容'),
    node('sanguo-episode-review', '现有整集审核内容'),
  ],
  edges: [{ id: 'existing-production-route', from: 'sanguo-shot-script', to: 'sanguo-video' }],
})
type WorkflowFixture = ReturnType<typeof workflow>
const writer = (value: WorkflowFixture, id: string) => value.nodes.find(item => item.id === id)!

for (const stage of ['outline', 'storyboard'] as const) {
  test(`${stage} managed refresh replaces stale style instructions without changing source text or template references`, () => {
    const existing = customPrefix + stale(stage) + customSuffix
    const updated = refreshDramaticExpressionPrompt(existing, stage)
    assert.equal(updated, customPrefix + sections[stage].body + customSuffix)
    assert.equal(refreshDramaticExpressionPrompt(updated, stage), updated)
    assert.equal(count(updated, sections[stage].start), 1)
    assert.doesNotMatch(updated, /旧版本：全部用古文/)
  })

  test(`${stage} duplicated managed sections converge to one while retaining interleaved user instructions`, () => {
    const between = '\n用户特别要求：本集只拍已确认的史料事件。\n'
    const existing = customPrefix + stale(stage) + between + sections[stage].body + customSuffix
    const updated = refreshDramaticExpressionPrompt(existing, stage)
    assert.equal(updated, customPrefix + sections[stage].body + between + customSuffix)
    assert.equal(count(updated, sections[stage].start), 1)
    assert.equal(count(updated, sections[stage].end), 1)
    assert.equal(refreshDramaticExpressionPrompt(updated, stage), updated)
  })

  test(`${stage} unmarked custom prompt acquires the creative contract and renders actual sources verbatim`, () => {
    const existing = customPrefix + customSuffix
    const updated = refreshDramaticExpressionPrompt(existing, stage)
    assert.ok(updated.startsWith(existing), 'unmanaged user instructions retain their complete original text')
    assert.equal(count(updated, sections[stage].start), 1)
    const rendered = renderWorkflowTemplate(updated, {
      input: { adaptation_policy: '只能拟制场面表演' }, scene: { id: 'approved-scene' },
      loop: { previous: { shot_script: { audioText: '喏。' } } },
      historical_sources: { citations: [{ index: 1, quote: sourceQuote, content: sourceQuote }] },
    })
    assert.ok(rendered.includes(sourceQuote))
    assert.ok(rendered.includes(JSON.stringify({ audioText: '喏。' })))
    assert.doesNotMatch(rendered, /\[object Object\]/)
    assert.equal(refreshDramaticExpressionPrompt(updated, stage), updated)
  })
}

test('schema145 configuration migration changes writer and advisory review prompts while preserving configuration and production routes', () => {
  const original = workflow(), snapshot = structuredClone(original), updated = upgradeDramaticExpression(original)
  assert.equal(updated.schemaVersion, 145)
  assert.deepEqual(original, snapshot, 'saved configuration is not mutated')
  assert.equal(updated.edges, original.edges)
  assert.equal(updated.voicePolicy, original.voicePolicy)
  for (const [index, stage] of [[0, 'outline'], [1, 'storyboard']] as const) {
    const before = original.nodes[index], after = updated.nodes[index]
    assert.deepEqual(after, { ...before, prompt: customPrefix + sections[stage].body + customSuffix })
    assert.equal(after.params, before.params)
    assert.equal(after.uploads, before.uploads)
    assert.equal(after.loop, before.loop)
    assert.equal(after.position, before.position)
  }
  for (const index of [2, 3]) assert.equal(updated.nodes[index], original.nodes[index])
  for (const [index, body] of [[4, DRAMATIC_EXPRESSION_TEXT_REVIEW_PROMPT], [5, DRAMATIC_EXPRESSION_TEXT_REVIEW_PROMPT],
    [6, DRAMATIC_EXPRESSION_MEDIA_REVIEW_PROMPT], [7, DRAMATIC_EXPRESSION_EPISODE_REVIEW_PROMPT]] as const) {
    assert.deepEqual(updated.nodes[index], { ...original.nodes[index], prompt: original.nodes[index].prompt + '\n' + body })
    assert.equal(updated.nodes[index].params, original.nodes[index].params)
    assert.equal(updated.nodes[index].code, original.nodes[index].code)
  }
  assert.equal(upgradeDramaticExpression(updated), updated)
})

test('same-schema stale prompt refreshes, production and future schemas remain intact, and other workflows are untouched', () => {
  for (const schemaVersion of [145, 148, 152]) {
    const original = workflow(schemaVersion), snapshot = structuredClone(original), updated = upgradeDramaticExpression(original)
    assert.equal(updated.schemaVersion, schemaVersion)
    assert.equal(writer(updated, 'sanguo-scene-outline').prompt, customPrefix + sections.outline.body + customSuffix)
    assert.equal(writer(updated, 'sanguo-shot-script').prompt, customPrefix + sections.storyboard.body + customSuffix)
    assert.equal(upgradeDramaticExpression(updated), updated)
    assert.deepEqual(original, snapshot)
  }
  const other = { ...workflow(), id: 'wf-custom-historical-series' }
  assert.equal(upgradeDramaticExpression(other), other)
  for (const schemaVersion of [0, 115, 143]) {
    const pending = workflow(schemaVersion)
    assert.equal(upgradeDramaticExpression(pending), pending, 'style migration cannot skip the version-sensitive prerequisite migrations')
  }
})

test('saved cinematic guidance offers motivated same-scene coverage without changing a locked tail continuation', () => {
  const saved = workflow(150)
  saved.nodes[0].prompt = customPrefix + stale('outline') + customSuffix
  saved.nodes[1].prompt = customPrefix + stale('storyboard') + customSuffix
  const updated = upgradeDramaticExpression(saved)
  assert.equal(updated.schemaVersion, 150)
  assert.deepEqual(updated.edges, saved.edges)
  assert.match(updated.nodes[0].prompt, /说话权或受压者的反应成为新信息.*coverage_cut/)
  assert.match(updated.nodes[1].prompt, /coverage_cut 只有在本段已有应对变化/)
  assert.match(updated.nodes[1].prompt, /tail_continuation 首帧严格复用尾帧，不偷换机位/)
  assert.match(updated.nodes[1].prompt, /下一段允许的 coverage_cut 中局部调整，不改本段承接模式、对白或节拍/)
  assert.match(updated.nodes[5].prompt, /没有其他可见的新动作或压力/)
  assert.match(updated.nodes[6].prompt, /实际连续采样足以显示相邻真人镜头/)
  assert.equal(count(updated.nodes[0].prompt, sections.outline.start), 1)
  assert.equal(count(updated.nodes[1].prompt, sections.storyboard.start), 1)
  assert.equal(upgradeDramaticExpression(updated), updated)
  assert.equal(saved.nodes[1].prompt, customPrefix + stale('storyboard') + customSuffix,
    'the saved input and any running execution remain untouched')
})

test('real quality and principle upgrades converge across serialized schema144 and schema145 reloads', () => {
  const upgrade = (value: WorkflowFixture) => upgradeDramaticExpression(upgradePrincipleQuality(upgradeQualityWorkflow(value)))
  for (const schemaVersion of [144, 145]) {
    const original = workflow(schemaVersion), snapshot = JSON.stringify(original), updated = upgrade(original)
    assert.equal(updated.schemaVersion, 145)
    assert.equal(JSON.stringify(original), snapshot)
    assert.equal(updated.edges, original.edges)
    for (const [id, stage] of [['sanguo-scene-outline', 'outline'], ['sanguo-shot-script', 'storyboard']] as const) {
      const prompt = writer(updated, id).prompt
      assert.equal(count(prompt, sections[stage].start), 1)
      assert.ok(prompt.includes(customPrefix))
      assert.ok(prompt.includes(customSuffix))
    }
    const reloaded = JSON.parse(JSON.stringify(updated)) as WorkflowFixture
    const repeated = upgrade(reloaded)
    assert.equal(repeated, reloaded, 'loading a migrated saved config needs no further write')
    assert.equal(JSON.stringify(repeated), JSON.stringify(updated))
  }
})

test('new outline template includes the creative contract exactly once', () => {
  assert.equal(count(SANGUO_SCENE_OUTLINE_PROMPT, sections.outline.start), 1)
  assert.ok(SANGUO_SCENE_OUTLINE_PROMPT.includes(sections.outline.body))
})

test('managed outline and reviewer require causal map use, real beat progression, and source-count precision', () => {
  const outline = SANGUO_DRAMATIC_EXPRESSION_OUTLINE_PROMPT
  const review = DRAMATIC_EXPRESSION_TEXT_REVIEW_PROMPT
  assert.match(outline, /单一城址高亮.*不构成地图的叙事必要性/)
  assert.match(outline, /连续同场问答、同一个人忍痛或服从.*新增可见压力/)
  assert.match(outline, /“十余”.*不把它们改成“十二”/)
  assert.match(review, /只标一个地名、城址变色.*不能因“地图可建立时地”就认为影视表达已合格/)
  assert.match(review, /没有独立地理因果或时代空间信息增量.*code="unnecessary_map"、itemId=地图场 id、relatedItemId=相邻承接场 id/)
  assert.match(review, /单个短地图紧接有压力或选择的真人冲突.*不能据地图短促或无人而给此 code/)
  assert.match(review, /code="repeated_action_without_delta"、itemId=后一场 id、relatedItemId=前一场 id/)
  assert.match(review, /两个 path 都从当前候选根开始.*分别落到对应场景真实可见可听正文/)
  assert.match(review, /找不到相邻两场可绑定的逐字原句时只给普通建议/)
  assert.match(review, /若新段确有拒绝、让步、距离改变.*不按相似动作词定错/)
  assert.match(review, /仅因镜头调度出现可数的群演，不把合理拍摄人数当成史实错误/)
  assert.match(review, /principle-v1 的 pass 只表示未发现其列出的史实原则错误/)
  const refreshed = upgradeDramaticExpression(workflow(152))
  assert.equal(refreshed.schemaVersion, 152)
  assert.match(writer(refreshed, 'sanguo-scene-outline').prompt, /单一城址高亮/)
  assert.match(writer(refreshed, 'sanguo-scene-outline-review').prompt, /十余人.*拟制调度/)
  assert.equal(upgradeDramaticExpression(refreshed), refreshed)
})

test('persisted advisory review sections refresh stale duplicates without changing actual evidence or review gates', () => {
  const original = workflow()
  const reviewBodies = [DRAMATIC_EXPRESSION_TEXT_REVIEW_PROMPT, DRAMATIC_EXPRESSION_TEXT_REVIEW_PROMPT,
    DRAMATIC_EXPRESSION_MEDIA_REVIEW_PROMPT, DRAMATIC_EXPRESSION_EPISODE_REVIEW_PROMPT]
  for (let index = 4; index < original.nodes.length; index++) {
    const body = reviewBodies[index - 4], markers = body.match(/【[^】]+】/g)!
    const start = markers[0], end = markers.at(-1)!
    const prior = start + '\n旧规则：不搞笑就必须重拍。\n' + end
    const evidence = '\n本次证据：${params.candidate}；${video_evidence}；${episode_review_evidence}\n逐字引文：' + sourceQuote
    original.nodes[index].prompt = '用户审查说明\n' + prior + '\n保留这里的用户说明\n' + prior + evidence
    const updated = upgradeDramaticExpression(original), after = updated.nodes[index]
    assert.equal(after.prompt, '用户审查说明\n' + body + '\n保留这里的用户说明\n' + evidence)
    assert.equal(count(after.prompt, start), 1)
    assert.equal(count(after.prompt, end), 1)
    assert.deepEqual(after, { ...original.nodes[index], prompt: after.prompt })
    assert.equal(after.code, original.nodes[index].code)
    assert.equal(after.modelId, original.nodes[index].modelId)
    assert.equal(after.params, original.nodes[index].params)
    assert.ok(after.prompt.includes(sourceQuote))
    assert.equal(upgradeDramaticExpression(updated), updated)
  }
})

function approvedCinematicChant() {
  const original = chantShot(), sourceBeat = chantScene.requiredBeats[0]
  const visual = [original.pacing.beats[0].textOrVocalization, '围观乡人点头']
  const audio = ['传唱歌谣的乡人：' + songText]
  const scene = {
    ...chantScene, contentContractVersion: 'cinematic-v1', dramaticSceneId: 'drama-song',
    settingId: 'ganling-street', cast: ['传唱歌谣的乡人'], continuityFromPrevious: false, continuityMode: 'scene_cut',
    requiredBeats: [{ ...sourceBeat, function: 'setup', stateChange: '歌谣被唱出并得到乡人的回应', observable: { visual, audio } }],
  }
  const shot = {
    ...original, contentContractVersion: 'cinematic-v1', dramaticSceneId: scene.dramaticSceneId,
    continuity: { ...original.continuity, mode: 'scene_cut' },
    worldState: { settingId: scene.settingId, characters: [{ name: '传唱歌谣的乡人',
      position: { status: 'unknown' }, heldProps: { status: 'unknown' }, pendingAction: { status: 'unknown' } }] },
    shotIntent: { viewpointCharacter: '传唱歌谣的乡人', purpose: '让观众听见歌谣与当场应和', cameraReason: '跟随主唱后保留乡人回应' },
    beatDramaturgy: [{ beatId: sourceBeat.id, function: 'setup', stateChange: scene.requiredBeats[0].stateChange, visual, audio }],
  }
  return { scene, shot }
}

test('runtime style refresh reaches fresh and repair requests while preserving approved ancient chant and source quotes', async () => {
  const { scene, shot } = approvedCinematicChant(), expected = { scene, pacingVersion: 'duration-v2', requireDramaContract: true,
    requireDynamicPacing: true, requireContinuityContract: true, maxGenerationAttempts: 2 }
  const sourceSnapshot = structuredClone(expected), candidateSnapshot = structuredClone(shot)
  const simplified = '房伯武是天下人的榜样，周仲进靠老师拿到了官印。'
  const changed = structuredClone(shot)
  changed.audioText = '传唱歌谣的乡人：' + simplified
  changed.pacing.beats[1].textOrVocalization = simplified
  const base = customPrefix + stale('storyboard') + customSuffix + '\n当前场景：${scene}\n\n史料原文：' + sourceQuote
  const prompt = promptForStoryboardScene(renderWorkflowTemplate(base, {
    input: { adaptation_policy: '不改变批准内容' }, scene,
    historical_sources: { citations: [{ index: 1, content: sourceQuote }] },
  }), scene, {})
  const prompts: string[] = []
  const result = await generateHistoricalStoryboard({ prompt, expected,
    generate: async requestPrompt => {
      prompts.push(requestPrompt)
      assert.equal(count(requestPrompt, sections.storyboard.start), 1)
      assert.ok(requestPrompt.includes(sections.storyboard.body))
      assert.ok(requestPrompt.includes(sourceQuote), 'creative modernization cannot alter source evidence')
      assert.ok(requestPrompt.includes(songText), 'the approved source audio remains in every task and repair prompt')
      assert.doesNotMatch(requestPrompt, /旧版本：全部用古文/)
      return prompts.length === 1 ? changed : shot
    } })
  assert.equal(prompts.length, 2, 'a rewritten approved chant must be repaired instead of silently accepted')
  assert.equal(result.audioText, shot.audioText)
  const pacing = result.pacing as { beats: Array<{ id: string; textOrVocalization: string }> }
  assert.equal(pacing.beats.find(beat => beat.id === 'lead-song')?.textOrVocalization, songText)
  assert.deepEqual(expected, sourceSnapshot)
  assert.deepEqual(shot, candidateSnapshot)
})
