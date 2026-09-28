import test from 'node:test'
import assert from 'node:assert/strict'
import { validateReviewParts } from '../src/review-validation.ts'

for (const [mode, validate] of [['direct', validateReviewParts], ['embedded', new Function('return (' + validateReviewParts.toString() + ');')() as typeof validateReviewParts]] as const) {
  test(mode + ' report checks collect all independent failures and preserve successful values', () => {
    assert.deepEqual(validate({ first: () => ({ passed: true }), second: () => [1, 2] }), { first: { passed: true }, second: [1, 2] })
    const visited: string[] = []
    assert.throws(() => validate({ coverage: () => { visited.push('coverage'); throw Error('REVIEW_RESULT_INVALID: wrong frame range') }, defects: () => { visited.push('defects'); throw Error('REVIEW_RESULT_INVALID: phonetic rate below actual threshold') } }), error => {
      assert.ok(error instanceof Error);assert.match(error.message, /coverage: wrong frame range/);assert.match(error.message, /defects: phonetic rate below actual threshold/);return true
    })
    assert.deepEqual(visited, ['coverage', 'defects'])
    const infrastructure = new Error('MEDIA_REQUIREMENTS_INVALID: broken author timeline')
    assert.throws(() => validate({ source: () => { throw infrastructure }, later: () => assert.fail('unexpected failures must stop') }), error => error === infrastructure)
  })
}
