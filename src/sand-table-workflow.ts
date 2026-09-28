import { refreshSceneOutlineSandTablePrompt } from './scene-outline-prompt.ts'
import { refreshStoryboardSandTablePrompt } from './storyboard-prompt.ts'
import { refreshAnimatedFrameSandTablePrompt } from './animated-map-frames.ts'
import { refreshDramaticExpressionMapPrompt } from './dramatic-expression.ts'
import { refreshHistoricalMapBarePlateCode, refreshMapPortraitBackgroundCode } from './code-node-presets.ts'
import { upgradeHistoricalMapFrameGate } from './historical-map-frame-gate.ts'

type Node = { id: string; kind: string; prompt: string; code?: string }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[] }

/** Refresh only shipped presentation clauses. Model choices, parameters,
 * routing, custom prompts and frozen execution snapshots remain intact. */
export function upgradeSandTableWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || (workflow.schemaVersion ?? 0) < 147) return workflow
  let changed = false
  const nodes = workflow.nodes.map(node => {
    const managedPrompt = node.id === 'sanguo-scene-outline' && node.kind === 'text'
      ? refreshSceneOutlineSandTablePrompt(node.prompt)
      : node.id === 'sanguo-shot-script' && node.kind === 'text'
        ? refreshStoryboardSandTablePrompt(node.prompt)
        : ['sanguo-animated-map-first-frame', 'sanguo-end-frame'].includes(node.id) && node.kind === 'image'
          ? refreshAnimatedFrameSandTablePrompt(node.prompt) : node.prompt
    const prompt = refreshDramaticExpressionMapPrompt(managedPrompt)
    const code = node.id === 'sanguo-first-frame-branch' && node.kind === 'code' && typeof node.code === 'string'
      ? refreshHistoricalMapBarePlateCode(refreshMapPortraitBackgroundCode(node.code)) : node.code
    if (prompt === node.prompt && code === node.code) return node
    changed = true
    return { ...node, prompt, ...(code !== node.code ? { code } : {}) }
  })
  const presentation = changed ? { ...workflow, schemaVersion: Math.max(151, workflow.schemaVersion ?? 0), nodes } as W : workflow
  return upgradeHistoricalMapFrameGate(presentation)
}
