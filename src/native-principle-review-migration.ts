import { principleNativeSequenceMetricsCode } from './principle-workflow.ts'

type Param = { id?: string; name?: string; englishName?: string; type?: string; value?: string; required?: boolean }
type Node = { id: string; code?: string; params?: Param[] }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[] }

const START = '// PRINCIPLE_POLICY_START'
const END = '// PRINCIPLE_POLICY_END'
const OLD = 'return principleMediaQuality.mediaMetrics(context,params);'
const MARKER = '// NATIVE_PRINCIPLE_SEQUENCE_GRID_SCHEMA163'

/** The principle branch returned before the legacy native-grid helper and
 * stripped the review detail parameter. Restore both bindings together so a
 * complete native frame sequence reaches the reviewer without truncation. */
export function upgradeNativePrincipleReviewWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || workflow.schemaVersion !== 162) return workflow
  const metrics = workflow.nodes.find(node => node.id === 'sanguo-media-metrics')
  const review = workflow.nodes.find(node => node.id === 'sanguo-media-review')
  const code = metrics?.code, params = review?.params
  if (!code || !params || code.includes(MARKER)) return workflow
  const start = code.indexOf(START), end = code.indexOf(END), old = code.indexOf(OLD)
  if (start < 0 || end <= start || old <= start || old >= end
    || code.indexOf(OLD, old + OLD.length) !== -1 && code.indexOf(OLD, old + OLD.length) < end
    || params.some(param => (param.englishName || param.name) === 'reviewImageDetail')
    || params.filter(param => (param.englishName || param.name) === 'reviewImages'
      && param.value === '${video_evidence.frames}').length !== 1) return workflow
  const nextCode = code.slice(0, old) + principleNativeSequenceMetricsCode + code.slice(old + OLD.length)
  const detail: Param = { id: 'native-principle-reviewImageDetail', name: 'reviewImageDetail',
    englishName: 'reviewImageDetail', type: 'json', value: '${media_metrics.nativeReviewImageDetail}', required: false }
  return { ...workflow, schemaVersion: 163, nodes: workflow.nodes.map(node => node === metrics
    ? { ...node, code: nextCode } : node === review ? { ...node, params: [...params, detail] } : node) } as W
}
