export type ScriptStateEvidence = {
  basis: 'visible-state-contradiction'
  violatedQuote: string
  requiredStateQuote: string
  observedState: string
  temporalBasis: 'state-at-sample' | 'sustained-state'
  persistenceQuote?: string
}

/** Structural and temporal evidence errors, shared by both reviewer paths.
 * An empty array validates this contract, not the truth of a visual claim or
 * arbitrary natural-language oppositions. Self-contained for editable gates. */
export function validateScriptStateEvidence(requirementQuote: unknown, stateEvidence: unknown): string[] {
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const nonempty = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim())
  const uncertain = (value: unknown) => typeof value === 'string' && /疑似|可能(?:是|为|存在|属于|手持|持有|有)|可能性|需(?:要)?(?:进一步)?确认|(?:无法|不能|难以|未能)\s*(?:完全\s*)?(?:确定|确认|判断|辨认|区分|排除)|不(?:明确|确定|清楚)|证据不足|看不清|\b(?:unknown|uncertain|may|might|possibly|unclear|unconfirmed)\b/i.test(value)
  const errors: string[] = [], defect = record(stateEvidence), quote = nonempty(requirementQuote) ? requirementQuote : ''
  if (defect.basis !== 'visible-state-contradiction' || !nonempty(defect.violatedQuote) || !quote.includes(defect.violatedQuote)
    || !nonempty(defect.requiredStateQuote) || !String(defect.violatedQuote).includes(String(defect.requiredStateQuote))) {
    errors.push('逐字绑定violatedQuote及其requiredStateQuote；未约束属性不能补猜目标状态')
  }
  if (!nonempty(defect.observedState) || uncertain(defect.observedState)
    || /未(?:见|观察到|呈现|采(?:样)?到|捕捉到)|没有(?:出现|发生|观察到)|(?:not|never)\s+(?:seen|observed|captured)|absence/i.test(String(defect.observedState))) {
    errors.push('observedState必须是同一属性的正面可见反证，少量采样未捕捉短暂动作不能证明缺失')
  }
  if (!['state-at-sample', 'sustained-state'].includes(String(defect.temporalBasis))) errors.push('temporalBasis须明确state-at-sample或sustained-state，不能以瞬时过程未采到拒绝')
  const persistence = nonempty(defect.persistenceQuote) && quote.includes(defect.persistenceQuote)
    && nonempty(defect.requiredStateQuote) && defect.persistenceQuote.includes(defect.requiredStateQuote)
    && /保持|持续|始终|全程|一直|不得(?:放下|离开|改变)|维持|throughout|continuously|maintain|remain|keep\b/i.test(defect.persistenceQuote)
  if (defect.temporalBasis === 'sustained-state' && !persistence) errors.push('sustained-state缺少原文明确持续义务的persistenceQuote，不能外推短暂动作')
  const stateAt = quote.indexOf(String(defect.requiredStateQuote)), statePrefix = stateAt < 0 ? '' : quote.slice(0, stateAt)
  const qualifiedTransient = /微微|轻微|略微|短暂|瞬间|一瞬|\b(?:slight|subtle|brief|momentary)\b/i.test(String(defect.requiredStateQuote))
    || /(?:微微|轻微|略微|短暂|瞬间|一瞬)(?:地)?\s*$|\b(?:slight|subtle|brief|momentary)\s*$/i.test(statePrefix)
  if (qualifiedTransient && !persistence) errors.push('原状态含轻微或短暂限定且未要求持续，不能把静帧中的未捕捉改称确证持续反证；复核实质要求与采样限制')
  if (defect.temporalBasis !== 'sustained-state' && defect.persistenceQuote !== undefined) errors.push('仅sustained-state可提供persistenceQuote，不能借用其他持续属性掩盖本项瞬时过程')
  return errors
}
