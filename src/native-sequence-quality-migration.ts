type Param = { id?: string; englishName?: string; type?: string; value?: string }
type Node = { id: string; code?: string; params?: Param[] }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[];
  edges?: Array<{ from: string; to: string; branch?: string }> }

const END = '// PRINCIPLE_POLICY_END'
const QUALITY_95 = /(reviewImageDetail\s*:\s*\{\s*transport\s*:\s*\{\s*mode\s*:\s*['"]sequence-grid['"]\s*,\s*columns\s*:\s*2\s*,\s*rows\s*:\s*2\s*,\s*format\s*:\s*['"]jpeg['"]\s*,\s*quality\s*:\s*)95(?=\s*,\s*chromaSubsampling\s*:\s*['"]4:4:4['"])/g

/** Serialized schema 159 code retained q95 in two older native-grid helpers.
 * The source helpers now use q90, which keeps this take's complete 243-frame
 * review under the existing transport byte limit without reducing frame count.
 * Its report-format retry branch also allowed no same-source resampling. Require
 * all eight exact old literals and the known review retry route; divergent user
 * code is left untouched for explicit review. */
export function upgradeNativeSequenceQualityWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || workflow.schemaVersion !== 159) return workflow
  const targets = ['sanguo-media-metrics', 'sanguo-media-accept']
  const replacements = new Map<string, string>()
  for (const id of targets) {
    const node = workflow.nodes.find(item => item.id === id), code = node?.code
    if (!code) return workflow
    const end = code.indexOf(END)
    const matches = [...code.matchAll(QUALITY_95)]
    const allQ95 = [...code.matchAll(/quality\s*:\s*95\b/g)]
    if (end < 0 || matches.length !== 4 || allQ95.length !== 4
      || matches.some(match => match.index === undefined || match.index <= end)) return workflow
    replacements.set(id, code.replace(QUALITY_95, (_, prefix: string) => `${prefix}90`))
  }
  const branch = workflow.nodes.find(node => node.id === 'sanguo-media-accept-error-branch')
  const attempts = branch?.params?.filter(param => param.id === 'principle-maxAttempts'
    && param.englishName === 'maxAttempts' && param.type === 'number') ?? []
  const patterns = branch?.params?.find(param => param.englishName === 'patterns')?.value
  const sources = branch?.params?.find(param => param.englishName === 'retryContextSources')?.value
  const falseEdges = workflow.edges?.filter(edge => edge.from === branch?.id && edge.branch === 'false') ?? []
  if (!branch?.code?.includes('branch.counts.false + 1 >= limit') || attempts.length !== 1 || attempts[0].value !== '1'
    || patterns !== '["REVIEW_RESULT_INVALID:"]'
    || sources !== '{"mediaSamplingRetry":["video_shot.samplingRetryPlan","mediaSamplingRetry"]}'
    || falseEdges.length !== 1 || falseEdges[0].to !== 'sanguo-media-request'
    || workflow.edges?.some(edge => edge.from === branch.id && edge.to === 'sanguo-video')) return workflow
  return { ...workflow, schemaVersion: 160, nodes: workflow.nodes.map(node => replacements.has(node.id)
    ? { ...node, code: replacements.get(node.id)! } : node.id === branch.id
      ? { ...node, params: node.params!.map(param => param === attempts[0] ? { ...param, value: '2' } : param) }
      : node) } as W
}
