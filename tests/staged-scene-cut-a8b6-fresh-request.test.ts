import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { freshA8B6PhaseAPrompt, freshA8B6PhaseBPrompt,
  previewFreshA8B6PhaseB } from
  '../server/staged-scene-cut-a8b6-fresh-ledger.mjs'
import { selectFreshA8B6IdentityTransportEntries } from
  '../server/staged-scene-cut-a8b6-fresh-phases.mjs'

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const jpeg = (fill: number) => {
  const bytes = Buffer.alloc(1200, fill)
  bytes[0] = 0xff; bytes[1] = 0xd8
  return bytes
}

test('fresh B pays for six original seconds with accepted A tail as the sole first frame', () => {
  const tail = jpeg(1), Zhang = jpeg(2), Yan = jpeg(3)
  const preview = previewFreshA8B6PhaseB(tail, [Zhang, Yan])
  assert.equal(preview.duration, 6)
  assert.deepEqual(preview.imageTypes,
    ['reference', 'reference', 'first_frame'])
  assert.deepEqual(preview.identityTransportSha256s,
    [sha(Zhang), sha(Yan)])
  assert.equal(preview.firstFrameTransportSha256, sha(tail))
  assert.equal(preview.request.duration, '6')
  assert.equal(preview.request.sound, 'off')
  assert.equal(preview.request.model_name, 'kling-v3-omni')
  assert.equal(preview.request.image_list?.[2]?.image_url,
    tail.toString('base64'))
  assert.equal('end_frame' in preview.request, false)
  assert.equal('multi_shot' in preview.request, false)
  assert.equal(previewFreshA8B6PhaseB(tail, [Zhang, Yan]).requestSha256,
    preview.requestSha256)
})

test('fresh A/B prompts keep picture speech off and B withdrawal visible', () => {
  assert.match(freshA8B6PhaseAPrompt(), /第八秒画面保留双手离腕/)
  assert.match(freshA8B6PhaseAPrompt(), /无语言声和语言口型/)
  assert.match(freshA8B6PhaseBPrompt(), /向侧后方退到看押位/)
  assert.match(freshA8B6PhaseBPrompt(), /5–6秒：张飞站稳/)
  assert.match(freshA8B6PhaseBPrompt(), /无语言声和语言口型/)
})

test('B selects exactly the two identity plates from v1 and v2 A transport', () => {
  const entry = (role: string) => ({ role, transport: { sha256: sha(role) } })
  const first = entry('first_frame')
  const Zhang = entry('identity_1')
  const Yan = entry('identity_2')
  const endGuide = entry('end_frame')
  assert.deepEqual(selectFreshA8B6IdentityTransportEntries({
    entries: [first, Zhang, Yan],
  }), [Zhang, Yan])
  assert.deepEqual(selectFreshA8B6IdentityTransportEntries({
    entries: [first, endGuide, Yan, Zhang],
  }), [Zhang, Yan])
  assert.throws(() => selectFreshA8B6IdentityTransportEntries({
    entries: [first, Zhang, Yan, Yan],
  }), /identity roles or hashes changed/)
  assert.throws(() => selectFreshA8B6IdentityTransportEntries({
    entries: [first, Zhang, endGuide],
  }), /identity roles or hashes changed/)
})
