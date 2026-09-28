#!/usr/bin/env node
// One non-model editorial correction after the independent v2 reviewer found
// that the approved voiceover did not explain the first route overlay.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { normalizeDramaOutline } from '../src/history-drama.ts'
import { validateHistoricalProductionPlan, validateHistoricalAgency } from '../src/history-content-guards.ts'
import { validateEpisodeNarrativeBoundary } from '../src/episode-boundary.ts'
import { validateHistoricalStructuredOutput } from '../src/workflow-core.ts'

const dir = path.resolve('logs/episode637-schema152-bounded-revision-20260928-v1')
const sourceDir = path.resolve('logs/episode637-schema151-outline-20260928')
const read = async (directory, name) => JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'))
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const [previous, review, context, params] = await Promise.all([
  read(dir, 'candidate-map-annotations-aligned-v2.json'),
  read(path.resolve('logs/episode637-schema153-map-v2-review-20260928-v1'), 'report.json'),
  read(sourceDir, 'context.json'), read(sourceDir, 'params.json'),
])
const warning = review.warnings?.find(item => item.itemId === 'scene-01' && item.path === 'scenes.0.requiredBeats.0.observable.audio.0')
if (!warning || review.decision !== 'pass' || review.issues?.length) throw Error('Reviewed v2 map voiceover warning missing')
const candidate = structuredClone(previous)
const scene = candidate.scenes[0], beat = scene.requiredBeats?.[0]
const prior = '汉末巴西，曹将张郃要迁民汉中。山道狭窄，刘备部将张飞如何挡敌？'
if (scene.id !== 'scene-01' || beat.id !== 'beat-01' || scene.contextPayload.narration !== prior
  || beat.observable.audio[0] !== `画外旁白：${prior}`) throw Error('v2 voiceover changed after reviewer')
const next = '汉末，曹将张郃从汉中进巴西，打算把当地百姓迁回汉中。山道狭窄，张飞如何挡敌？'
const forces = '巴西山地裸地图底板呈现概括性通道在密集山纹间收窄；不绘制势力标记或人物角标，本段旁白提出张飞如何抵拒曹军的问题。'
scene.contextPayload.narration = next
scene.targetDuration = 10
scene.purpose = '承接首次观看者没有前情的状态 → 地图区分曹军由汉中入巴西的进军与拟迁民返汉中的意图，并显示山地通道收窄 → 观众知道张飞既要阻止进军，也面对地形约束 → 引入长期相持后选择正面进攻还是另寻道路的军中问答。'
scene.adaptationBoundary = '地图布局、概括性通道与旁白措辞为依据史事的合理拟制。史料支持张郃从汉中进入巴西并欲迁民至汉中，但两条路线图层不确定精确道路、营址、距离、迁民数量或行动已完成；山道收窄仅示意史载地形。首尾帧与供应商地图视频只生成无字、无箭头、无势力标记的二维历史地理底板；先显示进军、后显示拟迁民的两支箭头必须由分镜中经独立审核的 mapAnnotations 后期叠加，不要求当前图层协议没有的虚线或静态势力标记。不提前显示张飞改道、曹军被切断或败退，不叠加人物肖像，不使用实体沙盘或三维棋子。'
scene.completionCriteria[0] = '旁白完整说出汉末、曹将张郃由汉中进入巴西、拟将当地百姓迁回汉中，以及张飞将如何挡敌。'
scene.completionCriteria[1] = '经独立审核的 mapAnnotations 路线图层先后呈现曹军已发生的进军方向与尚未完成的拟迁民方向；旁白分别说明两者，地理底板不烘焙箭头。'
scene.completionCriteria[2] = '地理底板呈现巴西山地狭道，旁白提出张飞抵拒的问题，使后续改道选择具有空间前提；不要求无法审核的静态势力标记。'
beat.description = beat.description.replace('旁白区分既有进军与迁民意图，并交代张飞抵拒及地形约束',
  '旁白区分既有进军与迁民意图，并提出张飞抵拒及地形约束的问题')
beat.observable.visual[2] = forces
beat.observable.audio[0] = `画外旁白：${next}`
beat.mustShow[1] = forces
const expected = { ...params, requireBeatCoverage: true, requireNarrativeClosure: true,
  requireDramaContract: true, requireEditorialGrammar: true, requireCharacterVisuals: true,
  deriveInheritedStates: true, input: context.input, historicalSources: context.historical_sources }
const productionCandidate = { ...candidate }
delete productionCandidate.repairProvenance
const normalized = normalizeDramaOutline(productionCandidate, expected)
validateHistoricalProductionPlan(normalized)
validateHistoricalAgency(normalized, context.historical_sources.citations)
validateEpisodeNarrativeBoundary(normalized, context.input, true)
validateHistoricalStructuredOutput('history.scene-outline', productionCandidate, expected)
if (candidate.scenes.slice(1).some((item, index) => sha(item) !== sha(previous.scenes[index + 1]))
  || sha(candidate.historicalLocks) !== sha(previous.historicalLocks)
  || sha(candidate.adaptationSpace) !== sha(previous.adaptationSpace)
  || sha(candidate.episodeDrama) !== sha(previous.episodeDrama)) {
  throw Error('Voiceover correction changed another scene or an episode boundary')
}
await fs.writeFile(path.join(dir, 'candidate-map-annotations-aligned-v3.json'), JSON.stringify(candidate, null, 2), { mode: 0o600 })
await fs.writeFile(path.join(dir, 'map-voiceover-alignment-proof-v3.json'), JSON.stringify({
  inputCandidateHash: sha(previous), outputCandidateHash: sha(candidate),
  reviewedWarning: { itemId: warning.itemId, path: warning.path, quote: warning.quote },
  changedSceneIds: ['scene-01'], otherScenesUnchanged: true, historicalAndEpisodeBoundsUnchanged: true,
  sourceFacts: '张郃自汉中进入巴西，欲迁民至汉中；只改旁白与图层说明的对应，不增加精确路线或已完成迁民。',
  oldTargetDuration: previous.scenes[0].targetDuration, newTargetDuration: scene.targetDuration,
  staticPassed: true, independentlyReviewedVersion: 'v2', currentVersionIndependentlyReviewed: false,
  modelCalls: 0, mediaGenerated: false,
}, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ event: 'aligned', output: path.join(dir, 'candidate-map-annotations-aligned-v3.json'),
  staticPassed: true, modelCalls: 0 }))
