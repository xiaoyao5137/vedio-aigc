import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { verifyCompositeForSourceBoundFork } from '../scripts/fork-original-shot1-source-bound-composite.mjs'
import { compositeStageReceiptHashes,
  verifyCompositeForSourceBoundLineageSync } from '../server/scene-cut-source-bound-composite.mjs'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const sourcePlan = 'a'.repeat(64)
const continuationPlan = 'b'.repeat(64)

test('A8+B5 provisional evidence cannot enter a source-bound first-shot fork', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'staged-a8b5-unaccepted-'))
  try {
    await assert.rejects(verifyCompositeForSourceBoundFork(continuationPlan, 'a8b5', root))
    assert.throws(() => verifyCompositeForSourceBoundLineageSync(
      continuationPlan, 'a8b5', root))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('A8+B5 receipt hashes bind the old paid A files and the new B files across plan directories', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'staged-a8b5-hashes-'))
  const oldDir = path.join(root, '.runtime/staged-scene-cut', sourcePlan)
  const newDir = path.join(root, '.runtime/staged-scene-cut-a8b5', continuationPlan)
  try {
    mkdirSync(oldDir, { recursive: true })
    mkdirSync(newDir, { recursive: true })
    const old = { 'manifest.json': 'old signed manifest',
      'phase-A-task.json': 'paid A task', 'phase-A-media.json': 'paid A media' }
    const current = { 'provisional-A-review.json': 'provisional A review',
      'phase-B-task.json': 'paid B task', 'phase-B-media.json': 'paid B media',
      'phase-B-acceptance.json': 'reviewed B and seam' }
    for (const [name, value] of Object.entries(old))
      writeFileSync(path.join(oldDir, name), value)
    for (const [name, value] of Object.entries(current))
      writeFileSync(path.join(newDir, name), value)
    const manifest = { version: 'staged-scene-cut-a8b5-provisional-v1',
      source: { planId: sourcePlan, manifestSha256: hash(old['manifest.json']),
        taskSha256: hash(old['phase-A-task.json']), mediaSha256: hash(old['phase-A-media.json']) } }
    const receipts = compositeStageReceiptHashes(continuationPlan, root, 'a8b5', manifest)
    assert.equal(receipts.A.provisionalReview, hash(current['provisional-A-review.json']))
    assert.equal(receipts.B.acceptance, hash(current['phase-B-acceptance.json']))
    writeFileSync(path.join(oldDir, 'phase-A-media.json'), 'changed paid A media')
    assert.throws(() => compositeStageReceiptHashes(continuationPlan, root, 'a8b5', manifest),
      /original paid A source receipts changed/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
