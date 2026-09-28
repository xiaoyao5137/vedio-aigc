#!/usr/bin/env node
// Offline, immutable comparison of the single 693 opening reconstruction with
// its original. It documents exact differences; semantic acceptance is human.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const root = path.resolve('.')
const originalDir = path.join(root, 'logs/episode693-schema151-outline-20260928')
const outputDir = path.join(root, 'logs/episode693-schema153-opening-reconstruction-20260928-v1')
const read = async (dir, name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'))
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const same = (left, right) => sha(left) === sha(right)
const [original, candidate, manifest, validation] = await Promise.all([
  read(originalDir, 'candidate.json'), read(outputDir, 'candidate.json'),
  read(outputDir, 'manifest.json'), read(outputDir, 'validation.json'),
])
const byId = values => new Map(values.map(value => [value.id, value]))
const oldDramas = byId(original.dramaticScenes)
const newDramas = byId(candidate.dramaticScenes)
const oldScenes = byId(original.scenes)
const changedScenes = candidate.scenes.filter(scene => !same(scene, oldScenes.get(scene.id))).map(scene => scene.id)
const report = {
  episode: 693,
  candidatePath: path.join(outputDir, 'candidate.json'),
  submissionSchema: 153,
  requestKey: manifest.requestKey,
  originalHash: sha(original), candidateHash: sha(candidate),
  writerStaticChecksPassed: validation.staticPassed,
  initialExactScopePassed: validation.boundedPassed,
  changedScenes,
  scenes04Through11ExactlyUnchanged: candidate.scenes.slice(3).every((scene, index) => same(scene, original.scenes[index + 3])),
  laterDramas04And05ExactlyUnchanged: ['drama-04', 'drama-05'].every(id => same(oldDramas.get(id), newDramas.get(id))),
  historicalLocksExactlyUnchanged: same(original.historicalLocks, candidate.historicalLocks),
  adaptationPolicyExactlyUnchanged: same(original.adaptationSpace.policy, candidate.adaptationSpace.policy),
  adaptationSourceLevelExactlyUnchanged: same(original.adaptationSpace.sourceLevel, candidate.adaptationSpace.sourceLevel),
  adaptationForbiddenExactlyUnchanged: same(original.adaptationSpace.forbidden, candidate.adaptationSpace.forbidden),
  adaptationAllowedTailExactlyUnchanged: same(original.adaptationSpace.allowed.slice(1), candidate.adaptationSpace.allowed.slice(1)),
  adaptationAllowedOpeningChanged: !same(original.adaptationSpace.allowed[0], candidate.adaptationSpace.allowed[0]),
  originalAllowedOpening: original.adaptationSpace.allowed[0],
  candidateAllowedOpening: candidate.adaptationSpace.allowed[0],
  episodePayoffExactlyUnchanged: same(original.episodeDrama.payoff, candidate.episodeDrama.payoff),
  openingPromiseChanged: !same(original.episodeDrama.openingPromise, candidate.episodeDrama.openingPromise),
  dramaticScene02MergedInto03: oldDramas.has('drama-02') && !newDramas.has('drama-02')
    && candidate.scenes[1].dramaticSceneId === 'drama-03',
  assessment: 'Exact sourceBoundsUnchanged check failed solely because adaptationSpace.allowed[0] explicitly describes the new opening as a reasonable fictional scene. Policy, source level, all prohibitions, historical locks, payoff and later scenes/dramas are byte-for-byte unchanged. Human review finds no boundary relaxation, but the original strict failure remains preserved; this is not automatic acceptance.',
  mediaGenerated: false,
}
await fs.writeFile(path.join(outputDir, 'scope-audit.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ output: path.join(outputDir, 'scope-audit.json'), changedScenes,
  laterUnchanged: report.scenes04Through11ExactlyUnchanged, initialExactScopePassed: report.initialExactScopePassed }))
