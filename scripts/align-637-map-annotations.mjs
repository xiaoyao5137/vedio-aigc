#!/usr/bin/env node
// Derive a new, local editorial candidate without changing the paid writer result.
// Only scene-01 wording separates the bare map base from approved local overlays.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { normalizeDramaOutline } from '../src/history-drama.ts'
import { validateHistoricalProductionPlan, validateHistoricalAgency } from '../src/history-content-guards.ts'
import { validateEpisodeNarrativeBoundary } from '../src/episode-boundary.ts'
import { validateHistoricalStructuredOutput } from '../src/workflow-core.ts'

const root = path.resolve('logs/episode637-schema152-bounded-revision-20260928-v1')
const source = path.resolve('logs/episode637-schema151-outline-20260928')
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const original = JSON.parse(await fs.readFile(path.join(root, 'scoped-candidate.json'), 'utf8'))
const context = JSON.parse(await fs.readFile(path.join(source, 'context.json'), 'utf8'))
const params = JSON.parse(await fs.readFile(path.join(source, 'params.json'), 'utf8'))
const candidate = structuredClone(original)
const scene = candidate.scenes.find(item => item.id === 'scene-01')
const beat = scene?.requiredBeats?.[0]
if (!scene || beat?.id !== 'beat-01'
  || beat.observable.visual[1] !== '由汉中进入巴西的实线箭头停在巴西，另有一条由巴西指向汉中的虚线箭头保持虚线。'
  || beat.observable.visual[2] !== '巴西山地中，曹军与刘备军的二维势力标记沿概括性通道相对，通道在密集山纹之间收窄。') {
  throw Error('Paid writer scene-01 no longer matches the reviewed map text')
}
const route = '无字无箭头的裸地图底板保持山川、城址与方位不变；经独立审核的 mapAnnotations 路线图层依次叠加由汉中进入巴西的曹军进军箭头，以及由巴西指向汉中的拟迁民方向箭头。旁白明确区分已发生的进军与尚未完成的迁民意图。'
const forces = '巴西山地裸地图底板呈现概括性通道在密集山纹间收窄；不绘制势力标记或人物角标，张飞在此抵拒的关系由本段已批准旁白交代。'
beat.description = '全画幅二维古代地理裸地图呈现汉中与巴西的相对位置及山地狭道。经独立审核的 mapAnnotations 后期路线图层依次显示曹军由汉中进入巴西的进军方向、计划把巴西百姓迁往汉中的方向；旁白区分既有进军与迁民意图，并交代张飞抵拒及地形约束，不展示张飞改道或战果。'
beat.observable.visual[1] = route
beat.observable.visual[2] = forces
beat.mustShow = [route, forces]
scene.adaptationBoundary += ' 首尾帧与供应商地图视频只生成无字、无箭头、无势力标记的古代地理底板；路线与箭头必须由分镜中经独立审核的 mapAnnotations 后期叠加，不要求当前图层协议没有的虚线或静态势力标记。图层不得伪造精确道路或位置，拟迁民箭头不表示迁民已完成。'
scene.completionCriteria = scene.completionCriteria.map(item => item === '曹军进军方向与计划迁民方向使用实线、虚线明确区分。'
  ? '经独立审核的 mapAnnotations 路线图层先后呈现曹军进军与拟迁民两个相反方向，旁白区分既有进军和未完成的意图，地理底板不烘焙箭头。'
  : item === '巴西山地内同时呈现两军相对和通道收窄，使后续改道选择具有空间前提。'
    ? '地理底板呈现巴西山地狭道，旁白交代张飞抵拒，使后续改道选择具有空间前提；不要求无法审核的静态势力标记。' : item)
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
if (candidate.scenes.slice(1).some((item, index) => sha(item) !== sha(original.scenes[index + 1]))
  || sha(candidate.historicalLocks) !== sha(original.historicalLocks)
  || sha(candidate.adaptationSpace) !== sha(original.adaptationSpace)) {
  throw Error('Editorial map wording changed an unrelated scene or historical boundary')
}
await fs.writeFile(path.join(root, 'candidate-map-annotations-aligned-v2.json'), JSON.stringify(candidate, null, 2), { mode: 0o600 })
await fs.writeFile(path.join(root, 'map-annotations-alignment-proof-v2.json'), JSON.stringify({
  inputCandidateHash: sha(original), outputCandidateHash: sha(candidate), changedSceneIds: ['scene-01'],
  description: 'Local wording edit only: two opposite route arrows use source-reviewed mapAnnotations; bare base keeps terrain, no unsupported dash or force-marker overlay',
  sourceFactsUnchanged: true, otherScenesUnchanged: true, staticPassed: true, schemaAtPaidGeneration: 152,
  schemaAtLocalValidation: 153, modelCalls: 0, mediaGenerated: false,
}, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ event: 'aligned', inputHash: sha(original), outputHash: sha(candidate), staticPassed: true }))
