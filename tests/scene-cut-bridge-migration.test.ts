import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { upgradePrincipleDurationWorkflow } from '../src/principle-duration-migration.ts'
import { upgradeNativeSequenceQualityWorkflow } from '../src/native-sequence-quality-migration.ts'
import { upgradeSceneCutBridgeWorkflow } from '../src/scene-cut-bridge-migration.ts'
import { SCENE_CUT_TRANSFER_RULE } from '../src/dramatic-expression.ts'
import { validateHistoricalStructuredOutput } from '../src/workflow-core.ts'

type Node = { id: string; kind: string; prompt: string; [key: string]: unknown }
type Workflow = { id: string; schemaVersion: number; nodes: Node[]; [key: string]: unknown }
const saved160 = (): Workflow => upgradeNativeSequenceQualityWorkflow(upgradePrincipleDurationWorkflow(JSON.parse(
  readFileSync(new URL('../public/data/sanguo-default-workflow.json', import.meta.url), 'utf8')))) as Workflow

test('schema 161 inserts only the bridge exception beside the old elision clause', () => {
  const before = saved160(), copy = structuredClone(before)
  assert.equal(before.schemaVersion, 160)
  const after = upgradeSceneCutBridgeWorkflow(before)
  assert.deepEqual(before, copy)
  assert.equal(after.schemaVersion, 161)
  const changed = after.nodes.filter((node, index) => JSON.stringify(node) !== JSON.stringify(before.nodes[index]))
  assert.deepEqual(changed.map(node => node.id), ['sanguo-scene-outline'])
  const oldPrompt = before.nodes.find(node => node.id === 'sanguo-scene-outline')!.prompt
  const newPrompt = changed[0].prompt
  assert.equal(newPrompt.replace(`\n${SCENE_CUT_TRANSFER_RULE}`, ''), oldPrompt)
  assert.equal(newPrompt.split(SCENE_CUT_TRANSFER_RULE).length, 2)
  assert.match(newPrompt, /不必把没有新戏的路程逐段重演。\n相邻真人短段若换到另一物理地点/)
  assert.equal(upgradeSceneCutBridgeWorkflow(after), after)
})

test('divergent saved outline prompt is preserved at schema 160', () => {
  const before = saved160()
  before.nodes.find(node => node.id === 'sanguo-scene-outline')!.prompt = 'user-authored replacement'
  assert.equal(upgradeSceneCutBridgeWorkflow(before), before)
})

test('text-node structured validation names the adjacent scene and missing observable bridge', () => {
  const outline = JSON.parse(readFileSync(new URL('./fixtures/cinematic-drama-outline.json', import.meta.url), 'utf8'))
  const prior = outline.scenes[2], next = outline.scenes[3]
  outline.scenes.forEach((scene: Node) => { scene.visualTreatment = 'live_action'; scene.editorialRole = 'story' })
  prior.requiredBeats[0].description += '周家宾客手持令牌。'
  prior.requiredBeats[0].mustShow.push('周家宾客手持令牌')
  prior.requiredBeats[0].observable.visual.push('周家宾客手持令牌')
  next.requiredBeats[0].description += '周家宾客握着令牌已站在市集。'
  next.requiredBeats[0].mustShow.push('周家宾客握着令牌已站在市集')
  next.requiredBeats[0].observable.visual.push('周家宾客握着令牌已站在市集')
  assert.throws(() => validateHistoricalStructuredOutput('history.scene-outline', outline,
    { requireDramaContract: true }), /scenes\[3\].*迁移承接/)
})
