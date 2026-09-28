import test from 'node:test'
import assert from 'node:assert/strict'
import { validateScriptStateEvidence } from '../src/script-state-evidence.ts'

const validators = [validateScriptStateEvidence, new Function(`return (${validateScriptStateEvidence.toString()})`)() as typeof validateScriptStateEvidence]
const quote = '2-5秒：人物保持双手拱于胸前，躯干直立。'
const state = { basis: 'visible-state-contradiction', violatedQuote: '保持双手拱于胸前', requiredStateQuote: '双手拱于胸前',
  observedState: '双手分离并下垂于身体两侧', temporalBasis: 'sustained-state', persistenceQuote: '保持双手拱于胸前' }

test('shared state evidence validates literal state and persistence without modifying the source', () => {
  for (const validate of validators) {
    const original = structuredClone(state)
    assert.deepEqual(validate(quote, state), [])
    assert.deepEqual(state, original)
    const { persistenceQuote: omitted, ...single } = state
    assert.ok(omitted)
    assert.deepEqual(validate('人物双手拱于胸前。', { ...single, violatedQuote: '双手拱于胸前', temporalBasis: 'state-at-sample' }), [])
    assert.match(validate(quote, { ...state, persistenceQuote: '说完后恢复直立' }).join(), /持续义务/)
    assert.match(validate(quote, { ...state, temporalBasis: 'state-at-sample' }).join(), /仅sustained-state/)
  }
})

test('invented attributes and missing observations produce contract errors, never fabricated acceptance', () => {
  for (const validate of validators) {
    const original = { ...state, violatedQuote: '恢复直立', requiredStateQuote: '双手放下' }
    assert.match(validate('人物恢复直立。', original).join(), /逐字绑定/)
    assert.equal(original.requiredStateQuote, '双手放下')
    for (const observedState of ['未观察到双手位置', '可能为双手下垂', 'unable to confirm, unknown']) {
      assert.match(validate(quote, { ...state, observedState }).join(), /正面可见反证/)
    }
    assert.ok(validate(quote, undefined).length >= 3)
    for (const requiredStateQuote of ['微微点头', '点头']) {
      assert.match(validate('人物微微点头。', { ...state, violatedQuote: '人物微微点头', requiredStateQuote,
        temporalBasis: 'state-at-sample', persistenceQuote: undefined }).join(), /轻微或短暂限定/)
    }
  }
})
