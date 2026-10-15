import { COVERAGE_CUT_FIRST_FRAME_PROMPT, COVERAGE_CUT_FRAME_REVIEW_PROMPT } from './coverage-cut-frame-gate.ts'

type Param = { id: string; name: string; englishName?: string; type: string; required: boolean; value: string }
type Node = { id: string; prompt?: string; params?: Param[];
  acceptance?: { passedPath: string; retryFrom: string; maxAttempts: number; feedbackPath?: string } }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[] }

/** Persist the named identity sheets on the pending image node. Prior paid runs keep their snapshots. */
export function upgradeCoverageCutIdentityWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || ![188, 189].includes(workflow.schemaVersion ?? 0)) return workflow
  const matches = workflow.nodes.filter(node => node.id === 'sanguo-coverage-first-frame')
  const reviews = workflow.nodes.filter(node => node.id === 'sanguo-coverage-review')
  if (matches.length !== 1 || !Array.isArray(matches[0].params) || reviews.length !== 1)
    throw Error('COVERAGE_IDENTITY_MIGRATION_CONFLICT: unique coverage first frame and review required')
  const node = matches[0]
  const params = node.params!.map(param => ({ ...param }))
  for (const [name, type, value] of [
    ['referenceImages', 'images', '${coverage_sources.referenceImages}'],
    ['referenceBindings', 'json', '${coverage_sources.referenceBindings}'],
    ['singleFrame', 'boolean', 'true'],
  ]) {
    const existing = params.find(param => param.englishName === name)
    if (existing) { existing.value = value; existing.type = type }
    else params.push({ id: `cc-frame-${name}`, name, englishName: name, type, required: false, value })
  }
  return { ...workflow, schemaVersion: 190, nodes: workflow.nodes.map(item => item.id === node.id
    ? { ...item, prompt: COVERAGE_CUT_FIRST_FRAME_PROMPT, params }
    : item.id === reviews[0].id ? { ...item, acceptance: {
      passedPath: 'passed', retryFrom: node.id, maxAttempts: 3, feedbackPath: 'issues',
    } } : item) } as W
}

/** Apply the spatial-continuity instructions to saved managed nodes. Completed
 * run snapshots remain unchanged; only future requests use these prompts. */
export function upgradeCoverageCutSpatialWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || (workflow.schemaVersion ?? 0) < 193) return workflow
  const image = workflow.nodes.find(node => node.id === 'sanguo-coverage-first-frame')
  const review = workflow.nodes.find(node => node.id === 'sanguo-coverage-review')
  if (!image?.prompt?.startsWith('【真人同场切镜的新机位首帧】')
    || !review?.prompt?.startsWith('【同场切镜新机位首帧独立实图审核】')) return workflow
  if (image.prompt === COVERAGE_CUT_FIRST_FRAME_PROMPT
    && review.prompt === COVERAGE_CUT_FRAME_REVIEW_PROMPT
    && (workflow.schemaVersion ?? 0) >= 194) return workflow
  return { ...workflow, schemaVersion: Math.max(194, workflow.schemaVersion ?? 0),
    nodes: workflow.nodes.map(node => node.id === image.id ? { ...node, prompt: COVERAGE_CUT_FIRST_FRAME_PROMPT }
      : node.id === review.id ? { ...node, prompt: COVERAGE_CUT_FRAME_REVIEW_PROMPT } : node) } as W
}
