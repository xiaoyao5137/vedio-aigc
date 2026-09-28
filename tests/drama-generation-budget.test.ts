import test from 'node:test'
import assert from 'node:assert/strict'
import { createDramaGenerationBudget, createDramaRepairProgressGuard, resolveDramaGenerationLimit } from '../src/drama-generation-budget.ts'

test('structural repair and a later editorial retry cannot multiply the three-candidate budget', () => {
  const initial = createDramaGenerationBudget(undefined, 3)
  initial.consume(); initial.consume()
  const feedback = { previousCandidate: { repairProvenance: { generationAttempts: initial.used } } }
  const editorial = createDramaGenerationBudget(feedback, 3)
  editorial.consume()
  assert.equal(editorial.used, 3)
  assert.throws(() => editorial.consume(), /DRAMA_GENERATION_LIMIT/)
  assert.throws(() => createDramaGenerationBudget({ previousCandidate: { repairProvenance: { generationAttempts: -1 } } }), /无效/)
  assert.equal(createDramaGenerationBudget(undefined).used, 0, 'next independent scene has its own budget')
})

// The structural correction loop is written for three attempts while the shared budget only affords
// three generations in total, counting the initial one. Letting `consume()` end the loop replaced the
// real defect list with a cost message, so the run reported DRAMA_GENERATION_LIMIT and hid the reason.
test('structural correction stops before the shared budget is spent so the real defect surfaces', () => {
  const budget = createDramaGenerationBudget(undefined, 3)
  assert.equal(budget.canConsume(), true)
  budget.consume(); budget.consume(); budget.consume()
  assert.equal(budget.used, 3)
  assert.equal(budget.canConsume(), false, '预算用尽时循环必须退出并抛出真实校验错误')
  assert.throws(() => budget.consume(), /DRAMA_GENERATION_LIMIT/)
  const exhausted = createDramaGenerationBudget({ previousCandidate: { repairProvenance: { generationAttempts: 3 } } }, 3)
  assert.equal(exhausted.canConsume(), false, '已达上限的内容重写不得再购买生成')
  assert.throws(() => exhausted.consume(), /DRAMA_GENERATION_LIMIT/)
})

test('configured writer attempts stay available beyond the old four-call cutoff and share one safe limit', () => {
  for (const configured of [5, 8, 12, 20, 99]) {
    const limit = resolveDramaGenerationLimit(configured)
    const budget = createDramaGenerationBudget(undefined, limit)
    budget.consume()
    let repairs = 0
    while (repairs < limit - 1 && budget.canConsume()) { budget.consume(); repairs += 1 }
    assert.equal(budget.used, Math.min(configured, 5))
    assert.equal(budget.canConsume(), false)
    const resumed = createDramaGenerationBudget({previousCandidate:{repairProvenance:{generationAttempts:budget.used}}}, limit)
    assert.equal(resumed.canConsume(), false)
  }
  assert.equal(resolveDramaGenerationLimit(undefined, 4), 4)
  assert.equal(resolveDramaGenerationLimit(-1, 7), 5)
  assert.equal(resolveDramaGenerationLimit(1.5, 5), 5)
})

test('repeated diagnostics cannot truncate the configured five-attempt budget', () => {
  const progress = createDramaRepairProgressGuard(6)
  progress.record('HISTORY_DRAMA_INVALID: scenes[4].cast 必须是非空数组')
  progress.record('HISTORY_DRAMA_INVALID: scenes[4].cast 必须是非空数组')
  progress.record('HISTORY_DRAMA_INVALID: scenes[4].cast 必须是非空数组')
  progress.record('HISTORY_DRAMA_INVALID: scenes[4].cast 必须是非空数组')
  progress.record('HISTORY_DRAMA_INVALID: scenes[4].cast 必须是非空数组')
  assert.throws(() => progress.record('HISTORY_DRAMA_INVALID: scenes[4].cast 必须是非空数组'), error => {
    assert.match(String(error), /scenes\[4\]\.cast/)
    assert.match(String(error), /DRAMA_REPAIR_STALLED/)
    return true
  })
})
