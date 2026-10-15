import { SCENE_CUT_TRANSFER_RULE } from './dramatic-expression.ts'

type PromptNode = { id: string; kind?: string; prompt?: string }
type Workflow<N extends PromptNode> = { id: string; schemaVersion?: number; nodes: N[] }
const ANCHOR = '不必把没有新戏的路程逐段重演。'

/** The persisted schema-160 outline prompt still encourages eliding an escort
 * without stating the sound/picture obligation at a physical scene cut. Insert
 * the one missing exception beside that exact clause; keep every other prompt
 * byte, node, and user edit unchanged. Divergent prompts remain for review. */
export function upgradeSceneCutBridgeWorkflow<N extends PromptNode, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || workflow.schemaVersion !== 160) return workflow
  const target = workflow.nodes.find(node => node.id === 'sanguo-scene-outline')
  const prompt = target?.prompt
  if (target?.kind !== 'text' || typeof prompt !== 'string'
    || prompt.split(ANCHOR).length !== 2 || !prompt.includes('【影视表达与现代汉语·大纲】')
    || prompt.split(SCENE_CUT_TRANSFER_RULE).length > 2) return workflow
  const next = prompt.includes(SCENE_CUT_TRANSFER_RULE) ? prompt
    : prompt.replace(ANCHOR, `${ANCHOR}\n${SCENE_CUT_TRANSFER_RULE}`)
  return { ...workflow, schemaVersion: 161, nodes: workflow.nodes.map(node => node === target
    ? { ...node, prompt: next } : node) } as W
}
