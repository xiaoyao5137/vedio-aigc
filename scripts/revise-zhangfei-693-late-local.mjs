#!/usr/bin/env node
// Editorial-only repair of the latter five scenes of the preserved schema153
// Zhang Fei episode candidate. No provider, workflow, or execution writes.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { normalizeDramaOutline } from '../src/history-drama.ts'
import { validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { validateHistoricalProductionPlan, validateHistoricalAgency } from '../src/history-content-guards.ts'
import { validateEpisodeNarrativeBoundary } from '../src/episode-boundary.ts'

const root = path.resolve('logs/episode693-schema153-opening-reconstruction-20260928-v1')
const validatedInput = path.resolve('logs/episode693-schema153-open-revision-preflight-20260928')
const out = path.resolve('logs/episode693-schema153-late-editorial-local-20260928-v1')
const read = async (folder, name) => JSON.parse(await fs.readFile(path.join(folder, name), 'utf8'))
const save = async (name, value) => {
  await fs.mkdir(out, { recursive: true })
  await fs.writeFile(path.join(out, name), JSON.stringify(value, null, 2) + '\n')
}
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const copy = value => structuredClone(value)
const [base, sourceContext, params, sourceManifest] = await Promise.all([
  read(root, 'candidate.json'),
  read(validatedInput, 'context.json'),
  read(validatedInput, 'params.json'),
  read(root, 'manifest.json'),
])
const source = sourceContext.historical_sources?.citations?.[0]
const boundary = sourceContext.input?.episode_boundary
if (base.episodeTitle !== '《张飞治兵》' || base.scenes?.length !== 11
  || base.scenes[6]?.id !== 'scene-07' || base.scenes[10]?.id !== 'scene-11'
  || !source?.content?.includes('先主常戒之曰')
  || boundary?.next?.[0]?.title !== '帐下行刺'
  || !boundary?.next?.some(item => item.title === '范疆张达')) {
  throw new Error('Saved episode, direct source, or adjacent-episode boundary drifted')
}
if (sha(sourceContext.historical_sources) !== sourceManifest.fingerprint?.sourceHash
  || sha(params) !== sourceManifest.fingerprint?.paramsHash) {
  throw new Error('Validation source or parameters differ from the saved schema153 opening request')
}
const result = copy(base)
// These are the source writer's serialized original response, not editorial
// fields. Keeping them would present stale scene-07–11 prose beside the new
// authoritative scenes if this local candidate were sent to a reviewer.
delete result.raw
delete result.text
const scene = id => result.scenes.find(item => item.id === id)
const drama = id => result.dramaticScenes.find(item => item.id === id)
const beat = (id, description, functionText, stateChange, visual, audio, setting, mustShow) => ({
  id, description, function: functionText, stateChange,
  observable: { visual, audio }, setting, mustShow,
})
const zhangVisual = copy(base.scenes[7].characterVisuals)

Object.assign(scene('scene-07'), {
  title: '一只手，从告诫回到军令', targetDuration: 7,
  purpose: '承接张飞在刘备面前垂下的手 → 切回阆中备兵，张飞的手压住军册，听见帐外鞭声便转头 → 观众辨清时间跳转，同时看见军令与旧治兵法仍在同一处 → 引出当场停止处罚和近身当值的安排。',
  requiredBeats: [beat('beat-07',
    '以张飞垂下的手作切点，来到阆中军帐内：同一只手压住未写可读字的军册；帐外传来一声短促鞭响，他抬眼转向帐口，举手示意停下。旁白只交代此时他将率一万人自阆中赴江州会师。',
    '有人物行动的时间桥，军令与治兵冲突直接相接',
    '故事从此前劝诫回到出发前的阆中；张飞听见处罚并作出下一步安排，危险的旧惯例即将接受检验。',
    ['回溯中的手垂下后，切到阆中军帐内张飞的手压住军册', '帐外响一声鞭，张飞抬眼转向帐口并举手'],
    ['画外旁白：阆中。张飞将率一万人，去江州与刘备会师。', '帐外一声短促鞭响。'],
    '刘备伐吴前、张飞出发前；阆中军营张飞帐内',
    ['张飞压住军册，听到鞭声后举手'])],
  completionCriteria: ['旁白明确阆中、将率一万人与江州会师，未说成已经出发', '张飞本人在转场中完成抬眼举手的行动，军册不承担可读史实', '帐外鞭声与下一段执鞭者放手有明确声画因果'],
  contextPayload: { timePlace: '刘备伐吴、张飞出发前；阆中军营', geographicFocus: ['阆中', '江州'], historicalBackground: '张飞应率一万人自阆中到江州会师，此时尚未出发。', narration: '阆中。张飞将率一万人，去江州与刘备会师。' },
  cast: ['张飞'], characterVisuals: zhangVisual, visualTreatment: 'live_action',
  adaptationBoundary: '手部切点、军册、帐外鞭声和张飞举手为合理拟制的剪辑与场面调度；不声称史料记载了具体军令文书、劝诫日期或这次处罚。',
  historicalBasis: '[史料1] 记载张飞应率一万人自阆中会师江州，并记载他常鞭打军士。',
  editorialRole: 'context_bridge', dramaticSceneId: 'drama-04', continuityMode: 'scene_cut',
})
Object.assign(scene('scene-08'), {
  title: '停鞭，仍留下', targetDuration: 7,
  purpose: '承接帐内举手与帐外鞭声 → 执鞭者停手，另一名匿名军士带伤起身；张飞令其仍在身边当值 → 观众看见刘备指出的处罚与近侍依旧连在一起 → 军士要决定是否求换值。',
  requiredBeats: [beat('beat-08',
    '张飞在帐口举着手，执鞭军士把鞭垂下。另一名匿名军士从地上撑起，衣背左肩附近的鞭痕只透在布面上，左臂贴住身体。张飞说：“够了。你留在我身边当值。”这名军士抬头看他，尚未答应。',
    '用一次停鞭后的命令直接呈现治兵惯例',
    '处罚停止了，但受罚者没有被换下，近身任事的矛盾立即落在这名军士身上。',
    ['张飞举手，执鞭军士垂下鞭', '受罚军士以右手撑地起身，左臂贴身，左肩布面可见鞭痕', '受罚军士抬头看向张飞，尚未答应'],
    ['张飞：够了。你留在我身边当值。', '受罚军士起身时忍住一声吸气。'],
    '阆中军营张飞帐内',
    ['执鞭者在张飞举手后停止', '受罚者带伤起身却被留下当值'])],
  completionCriteria: ['张飞、受罚者和执鞭者站位清楚，帐内外连成同一事件', '受罚者左肩与左臂受限从此段建立，区别于开场先前会面的右臂伤者', '没有具名刺客、罪名、血腥创口或行刺预兆'],
  contextPayload: null, cast: ['张飞'], visualTreatment: 'live_action',
  adaptationBoundary: '这是根据史载惯例合理拟制的另一名匿名军士；具体处罚场合、执鞭人、伤势、命令和反应均非史载，不将军士指认为后续具名人物。',
  historicalBasis: '[史料1] 支持张飞鞭打军士并仍令受罚者在左右任事的惯例。',
  editorialRole: 'story', dramaticSceneId: 'drama-05', continuityMode: 'scene_cut',
})
Object.assign(scene('scene-09'), {
  title: '能不能换人', targetDuration: 9,
  purpose: '承接受罚者被留下的命令 → 军士因伤请求换值，张飞看见其左肩后递出净布，却拒绝换人 → 关照与控制在同一选择里冲撞 → 同袍上前帮他包扎。',
  requiredBeats: [beat('beat-09',
    '受罚军士以右手托住左肩，说：“将军，肩膀使不上劲。能换个人吗？”张飞看一眼他受伤的肩，拿起案边净布交给一旁同袍，说：“先包好。值还是你当。”军士把要再说的话咽回去。',
    '让下属提出真正会改变安排的选择，让张飞只作有限让步',
    '张飞承认伤处需要照料，却仍决定让同一名受罚者留在左右。',
    ['受罚军士以右手托着左肩向张飞请求换值', '张飞看到左肩，把案边净布递给同袍', '受罚军士欲言又止'],
    ['受罚军士：将军，肩膀使不上劲。能换个人吗？', '张飞：先包好。值还是你当。'],
    '阆中军营张飞帐内',
    ['受罚者明确请求换人', '张飞交出净布却明确拒绝换人'])],
  completionCriteria: ['问答完整，净布从张飞手中交到同袍手中', '张飞有限照料不等于同意受罚者退下', '伤肩仍为左侧，未给军士新增动机或身份'],
  contextPayload: null, cast: ['张飞'], visualTreatment: 'live_action',
  adaptationBoundary: '请求、递布、对白和心理停顿为合理拟制；不把张飞的片刻照料写成史载答复或治兵方式已经改变。',
  historicalBasis: '[史料1] 支持张飞让受罚军士在左右任事；来源不记载具体换值请求或答复。',
  editorialRole: 'story', dramaticSceneId: 'drama-05', continuityMode: 'coverage_cut',
})
Object.assign(scene('scene-10'), {
  title: '同袍帮他收紧布结', targetDuration: 6,
  purpose: '承接净布交出 → 同袍替受罚者包住左肩，军士轻声道谢；张飞看着，没有催促 → 人的疼痛得到一点照料，却没有解除近身当值 → 迫使军士回到张飞身边。',
  requiredBeats: [beat('beat-10',
    '帐内原位，同袍扶住受罚军士的左臂，把净布绕过左肩收成一结。受罚者用右手压住布尾，低声说：“谢了。”同袍退开。张飞在案旁等他，没催。',
    '以同袍间的短暂照料显出伤痛的具体代价与温情',
    '伤处得到包扎，同袍退出；受罚者仍须独自回到张飞身边。',
    ['同袍扶住受罚军士左臂，将上一段的净布绕过左肩并打结', '受罚者用右手压住布尾，同袍放手退开', '张飞在案旁等待，没有打断包扎'],
    ['受罚军士低声：谢了。', '布料拉紧、呼吸稍停。'],
    '阆中军营张飞帐内',
    ['净布从上一段接续到左肩布结', '同袍帮完后退开，受罚者仍留下'])],
  completionCriteria: ['同一条净布和左肩伤势与上一段连续', '帮助来自匿名同袍，双方不交换后续行刺信息或动机', '张飞只等待包扎，没有让受罚者退出当值'],
  contextPayload: null, cast: ['张飞'], visualTreatment: 'live_action',
  adaptationBoundary: '同袍帮包扎、道谢、张飞等待皆为合理拟制的人际细节；温情不改变史载的过罚和近侍惯例，匿名同袍不对应后续具名人物。',
  historicalBasis: '[史料1] 仅支持受罚后仍在左右的治兵处境；包扎与同袍互助不见记载，明确作为表演拟制。',
  editorialRole: 'story', dramaticSceneId: 'drama-05', continuityMode: 'coverage_cut',
})
Object.assign(scene('scene-11'), {
  title: '卷牍拿回，位置不换', targetDuration: 8,
  purpose: '承接包扎完成、军士归位 → 张飞欲把卷牍交给他，见左臂抬到一半便收回卷牍，亲自放回案上，却仍命令他站在身边 → 观众看到一瞬顾惜未改变危险的人员安排 → 本集落在未解的治兵选择，不提前演后集结果。',
  requiredBeats: [beat('beat-11',
    '受罚军士回到张飞伸手可及处，左肩布结清楚可见。张飞拿起卷牍递过去；军士抬起左臂却停在半空。张飞看见，收回卷牍放回案上，说：“这个我拿。你还是站这儿。”军士用右手扶住左臂，留在原处。',
    '用张飞的一次小让步与不变的近身命令回答开场问题',
    '张飞没有强迫伤臂接卷牍，但仍让受罚军士近身当值；刘备指出的危险结构未被解除。',
    ['受罚军士左肩有上一段布结，站回张飞伸手可及处', '卷牍递出时受罚军士左臂只抬到半空，张飞收回卷牍放回案上', '受罚军士用右手扶住左臂，仍在张飞身边'],
    ['张飞：这个我拿。你还是站这儿。', '军士未再开口，帐外备兵声延续。'],
    '阆中军营张飞帐内',
    ['张飞收回卷牍而没有让伤臂接物', '受罚者仍在伸手可及处当值，画面止于此'])],
  completionCriteria: ['卷牍递出又收回的因果与左臂伤势一镜内可辨', '小幅照料没有被台词或镜头说成张飞已经改掉处罚与近侍惯例', '终镜不出现行刺、密谋、凶器、死亡或具名刺客'],
  contextPayload: null, cast: ['张飞'], visualTreatment: 'live_action',
  adaptationBoundary: '卷牍交接、收手、对白及军士反应均为合理拟制；只展示一次减轻负担的微动作，不能据此推断张飞的史实内心或已经接受刘备劝诫。匿名军士不是范疆、张达；不预演后集行刺。',
  historicalBasis: '[史料1] 支持张飞常鞭打军士且让他们在左右，刘备曾警告此举招祸；不记载这次具体交接。',
  editorialRole: 'payoff', dramaticSceneId: 'drama-05', continuityMode: 'tail_continuation',
})

const fourthDrama = drama('drama-04')
Object.assign(fourthDrama, {
  setting: '刘备伐吴前、张飞出发前；阆中军营张飞帐内',
  characters: ['张飞'],
  goal: '借张飞检查军册、听到鞭声并举手的行动，从此前告诫转回阆中备兵与当下治兵选择。',
  obstacle: '必须让观众在短时间内辨清时空跳转和会师任务，又不把行装静物当作独立剧情。',
  tactics: '以手部动作作时间切点，旁白仅说明阆中、一万人和江州；鞭声驱使张飞抬眼举手，下一场紧接停止处罚。',
  turn: '出兵任务与未改的鞭打惯例在张飞的同一次举手中相遇。',
  result: '故事回到阆中出发前，张飞即将当场决定受罚者仍否近身任事。',
  characterStates: [{ name: '张飞', before: copy(drama('drama-03').characterStates.find(item => item.name === '张飞').after),
    after: copy(drama('drama-03').characterStates.find(item => item.name === '张飞').after) }],
})
const fifthDrama = drama('drama-05')
Object.assign(fifthDrama, {
  setting: '阆中军营张飞帐内',
  goal: '张飞停止处罚后仍要受罚者留在左右；军士要请求因伤换值。',
  obstacle: '军士左肩疼痛使当值困难；换人的请求与张飞坚持的近身安排冲突。',
  tactics: '张飞停鞭后命令留任；面对请求递出净布让同袍包扎，却拒绝换人；最后收回卷牍免军士伤臂承重，仍令其在身边当值。',
  turn: '张飞肯减轻一次伤臂负担，却没有撤回让受罚者近身的决定。',
  result: '同袍的照料和张飞的一瞬顾惜能被看见，处罚代价与近身风险仍共同存在；结尾止于当前治兵安排。',
})
const zhangState = fifthDrama.characterStates.find(item => item.name === '张飞')
zhangState.after.knowledge = [...zhangState.before.knowledge, '眼前另一名军士因左肩伤请求换下当值']
zhangState.after.relationships = [...zhangState.before.relationships, '请求换下的受罚军士仍在自己身边任事']
zhangState.after.choices = [...zhangState.before.choices, '允许同袍替受罚者包扎，并拿回卷牍，却不更换其近身当值安排']
result.episodeDrama.payoff = { description: '张飞收回卷牍、让军士先照顾伤肩，却仍令他站在自己身边；刘备指出的危险安排没有改变。', beatIds: ['beat-11'] }
result.characterDramas.find(item => item.name === '张飞').tactic = '面对刘备以军令反问而未作承诺；回到阆中，他停止一次鞭打、允许同袍包扎、收回要交给伤臂的卷牍，但仍令受罚者近身当值。上述动作属于表演拟制。'
result.count = result.scenes.length
result.totalDuration = result.scenes.reduce((sum, item) => sum + item.targetDuration, 0)

const expected = { ...params, requireBeatCoverage: true, requireNarrativeClosure: true,
  requireDramaContract: true, requireEditorialGrammar: true, requireCharacterVisuals: true,
  deriveInheritedStates: true, input: sourceContext.input,
  historicalSources: sourceContext.historical_sources }
const checks = []
const check = (name, fn) => { try { fn() } catch (error) { checks.push({ name, error: String(error) }) } }
let normalized
check('normalizeDramaOutline', () => { normalized = normalizeDramaOutline(result, expected) })
if (normalized) {
  check('productionCapacity', () => validateHistoricalProductionPlan(normalized))
  check('historicalAgency', () => validateHistoricalAgency(normalized, sourceContext.historical_sources.citations))
  check('episodeBoundary', () => validateEpisodeNarrativeBoundary(normalized, sourceContext.input, true))
}
check('structuredOutput', () => validateHistoricalStructuredOutput('history.scene-outline', result, expected))
const changedScenes = result.scenes.filter((item, index) => sha(item) !== sha(base.scenes[index])).map(item => item.id)
const priorScenesPreserved = result.scenes.slice(0, 6).every((item, index) => sha(item) === sha(base.scenes[index]))
const sourceAndBoundaryPreserved = sha(result.historicalLocks) === sha(base.historicalLocks)
  && sha(result.adaptationSpace) === sha(base.adaptationSpace)
  && sha(result.episodeDrama.openingPromise) === sha(base.episodeDrama.openingPromise)
  && sha(sourceContext.input.episode_boundary) === sha(boundary)
const validation = { passed: checks.length === 0, checks, changedScenes, expectedChangedScenes: ['scene-07', 'scene-08', 'scene-09', 'scene-10', 'scene-11'],
  priorScenesPreserved, sourceAndBoundaryPreserved, originalDuration: base.totalDuration,
  newDuration: result.totalDuration, mediaGenerated: false, providerCalls: 0,
  humanDramaticAcceptance: false, audiovisualAcceptance: false }
await save('candidate.json', result)
await save('validation.json', validation)
await save('provenance.json', { base: path.relative(process.cwd(), path.join(root, 'candidate.json')),
  baseSha256: sha(base), candidateSha256: sha(result), sourceCitationId: source.id,
  sourceSha256: sha(sourceContext.historical_sources), paramsSha256: sha(params),
  scopedEdit: 'scene-07–11, drama-04–05, episodeDrama.payoff, Zhang Fei tactic, totalDuration; omit stale raw/text copies of source writer response',
  unchanged: 'scene-01–06, direct historical locks, adaptation policy and forbidden items, neighboring-episode boundary',
  requestKey: null, providerCalls: 0, workflowWrites: 0, executionWrites: 0 })
console.log(JSON.stringify({ output: out, ...validation }))
if (!validation.passed || !priorScenesPreserved || !sourceAndBoundaryPreserved
  || JSON.stringify(changedScenes) !== JSON.stringify(validation.expectedChangedScenes)) process.exitCode = 1
