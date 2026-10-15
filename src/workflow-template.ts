export function stringifyTemplateValue(value: unknown): string {
  if (value && typeof value === 'object') return JSON.stringify(value)
  return value === undefined || value === null ? '' : String(value)
}

/** Shared by the UI and integration tests; object arrays must retain their fields. */
export function renderWorkflowTemplate(template: string, context: Record<string, unknown>) {
  return template.replace(/\$\{([^}]+)\}/g, (_, expression: string) => stringifyTemplateValue(resolveTemplatePath(context, expression)))
}

function resolveTemplatePath(context: Record<string, unknown>, expression: string) {
  return expression.trim().split('.').reduce<unknown>((current, key) => current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, context)
}

/** Resolve `${path}` placeholders inside a parsed json parameter without flattening its structure.
 * A whole-string placeholder becomes the referenced value itself, so arrays and objects stay
 * structured; a placeholder inside a longer sentence is substituted as text. An unresolvable
 * reference is left exactly as written, because silently turning it into `null` would hide a
 * mis-wired node instead of showing the author the template that never matched. */
export function resolveTemplateJsonValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const reference = value.trim().match(/^\$\{([^}]+)\}$/)
    if (reference) {
      const resolved = resolveTemplatePath(context, reference[1])
      return resolved === undefined ? value : resolved
    }
    return value.includes('${') ? renderWorkflowTemplate(value, context) : value
  }
  if (Array.isArray(value)) return value.map(item => resolveTemplateJsonValue(item, context))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, resolveTemplateJsonValue(item, context)]))
  }
  return value
}

/** Retry feedback comes from a reviewer model and is advice, never an override. A critic can
 * demand a fix the generation contract forbids (speaking a “（拟制）” tag inside dialogue) or
 * offer two mutually exclusive repairs, which made writers oscillate between rejections and burn
 * the whole paid budget. Every retried call therefore restates which authority wins. */
export function renderRetryFeedbackPrompt(feedback: unknown): string {
  feedback = withoutFailedTextCandidate(feedback)
  const text = stringifyTemplateValue(feedback)
  if (!text.trim()) return ''
  if (feedback && typeof feedback === 'object' && !Array.isArray(feedback) && 'kind' in feedback && feedback.kind === 'report-format') {
    return `\n【本次报告复核】${text}\n依据当前候选、原始采证和实际配置，一次修正全部已指出的报告错误。上一报告是待核对草稿；保留仍有事实支持的证据，纠正已被否定的结论，同步核对逐项检查、问题列表和最终判定。只返回当前审核契约要求的完整报告，不改动候选，不添加其他业务类型的字段，不补造证据，也不以通过为目标。`
  }
  if (feedback && typeof feedback === 'object' && !Array.isArray(feedback) && 'kind' in feedback && feedback.kind === 'image-review-retry') {
    return `\n【上一张首帧的实图退回原因】${text}\n这次只重新绘制当前分镜的单张首帧，逐条修复能从像素核对的缺陷。具名人物的脸、发须、衣甲以各自已标明人物姓名的三视图为准；前镜尾帧只提供场景、机位轴线和仍有效的束缚、道具及站位。对明确要求可见的手腕、绳圈、押解动作及后续行动空间，调整景别和人物位置使其真实入画，不以文字说明或画外推测代替。不得新增人物、互换身份、提前完成后续动作或改变已批准分镜。`
  }
  return `\n【本次重试反馈】${text}\n保留全部原始目标，只修复已指出的问题。反馈与生成契约冲突时以契约为准：拟制声明只写在 adaptationBoundary 字段，绝不在 audioText、对白或画面文字里加入“（拟制）”“【拟制对白】”等标签，也不得删去反馈点名保留的剧情。反馈给出多种互斥方案时，选择保留最多既有场景、节拍与台词的那一项，一次做完全部修复。`
}
import { withoutFailedTextCandidate } from './failed-text-candidate.ts'
