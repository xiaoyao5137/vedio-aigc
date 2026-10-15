import assert from 'node:assert/strict'
import test from 'node:test'
import { hasExecutionPlanMismatch, refreshPendingExecutionNodes } from
  '../src/workflow-core.ts'
import { A8B6_LOCAL_FRAME_VERSION,
  A8B6_LOCAL_FRAME_REVIEW_PROMPT, A8B6_LOCAL_V2_FRAME_VERSION,
  A8B6_LOCAL_V2_FRAME_REVIEW_PROMPT,
  A8B6_LOCAL_V4_FRAME_VERSION,
  A8B6_LOCAL_V4_FRAME_REVIEW_PROMPT,
  A8B6_LOCAL_V5_FRAME_VERSION,
  A8B6_LOCAL_V5_FRAME_REVIEW_PROMPT,
  A8B6_LOCAL_V6_FRAME_VERSION,
  A8B6_LOCAL_V6_FRAME_REVIEW_PROMPT,
  A8B6_LOCAL_V7_FRAME_VERSION,
  A8B6_LOCAL_V7_FRAME_REVIEW_PROMPT,
  A8B6_LOCAL_V8_FRAME_VERSION,
  A8B6_LOCAL_V8_FRAME_REVIEW_PROMPT,
  A8B6_LOCAL_V9_FRAME_VERSION,
  A8B6_LOCAL_V9_FRAME_REVIEW_PROMPT } from
  '../src/scene-cut-a8b6-local-frame-workflow.ts'
import { A8B6_LOCAL_V8_REVIEW_IMAGE_DETAIL } from
  '../src/scene-cut-a8b6-local-detail-review.ts'

const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)

function fixture() {
  const nodes = [
    { id: 'sanguo-scene-cut-first-frame', kind: 'image', prompt: 'base image',
      params: [] },
    { id: 'sanguo-scene-cut-review', kind: 'text', prompt: 'base review',
      params: [{ name: 'reviewImages', type: 'json', value: '${evidence.reviewImages}' }] },
    { id: 'ordinary-after', kind: 'http', prompt: 'new base', params: [] },
  ]
  const marker = { version: A8B6_LOCAL_FRAME_VERSION,
    sourceExecutionId: 'record-4x5m31-a8b6-timing-approval-v3',
    workflowSchemaVersion: 180,
    workflowNodesMd5: '3ed9cf16e56b311458f4c6fa7e7f1e2e',
    workflowEdgesMd5: '1d0a75acb3d4778a122a4cfd96a23b49',
    firstPendingIndex: 46, sourceReceiptSha256: 'a'.repeat(64),
    reviewPromptSha256: '5fa24ee1bfb73f8729318b611d1c5d8e207d4cc02b81b42ef2120ead39233328' }
  const review = { node: { ...nodes[1], prompt: A8B6_LOCAL_FRAME_REVIEW_PROMPT,
    params: [...nodes[1].params, { name: 'sceneCutLocalComposite',
      englishName: 'sceneCutLocalComposite', type: 'json',
      value: canonical(marker) }] }, status: 'idle',
  sourceBoundNodeOverride: { version: A8B6_LOCAL_FRAME_VERSION,
    nodeId: nodes[1].id, marker } }
  const runs = [{ node: nodes[0], status: 'success' }, review,
    { node: { ...nodes[2], prompt: 'stale base' }, status: 'idle' }]
  return { workflow: { id: 'wf-sanguo-history-drama', nodes, edges: [] }, runs }
}

test('local source keeps only exact review override through refresh', () => {
  const { workflow, runs } = fixture()
  const refreshed = refreshPendingExecutionNodes(workflow, runs)
  assert.equal(refreshed[1], runs[1])
  assert.equal(refreshed[2].node.prompt, 'new base')
  assert.equal(hasExecutionPlanMismatch(workflow, refreshed), false)
})

test('altered local marker or prompt falls back to the schema node', () => {
  const { workflow, runs } = fixture()
  const bad = [
    { ...runs[1], node: { ...runs[1].node, prompt: 'unsigned review' } },
    { ...runs[1], sourceBoundNodeOverride: {
      ...runs[1].sourceBoundNodeOverride,
      marker: { ...runs[1].sourceBoundNodeOverride.marker,
        sourceReceiptSha256: 'b'.repeat(64) } } },
  ]
  for (const review of bad) {
    const refreshed = refreshPendingExecutionNodes(workflow,
      [runs[0], review, runs[2]])
    assert.equal(refreshed[1].node.prompt, 'base review')
    assert.deepEqual(refreshed[1].node.params, workflow.nodes[1].params)
  }
})

test('second local source version keeps its own exact review contract', () => {
  const { workflow, runs } = fixture()
  const base = runs[1]
  const marker = { ...base.sourceBoundNodeOverride.marker,
    version: A8B6_LOCAL_V2_FRAME_VERSION,
    reviewPromptSha256:
      '91ce65e3582fe906549cc8011d3ad3a2948e854694c27683587818571ee2e458' }
  const review = { ...base,
    sourceBoundNodeOverride: { version: A8B6_LOCAL_V2_FRAME_VERSION,
      nodeId: base.node.id, marker },
    node: { ...base.node, prompt: A8B6_LOCAL_V2_FRAME_REVIEW_PROMPT,
      params: [workflow.nodes[1].params[0],
        { name: 'sceneCutLocalComposite',
          englishName: 'sceneCutLocalComposite', type: 'json',
          value: canonical(marker) }] } }
  assert.equal(refreshPendingExecutionNodes(workflow,
    [runs[0], review, runs[2]])[1], review)
  const wrong = { ...review, node: { ...review.node,
    prompt: A8B6_LOCAL_FRAME_REVIEW_PROMPT } }
  assert.equal(refreshPendingExecutionNodes(workflow,
    [runs[0], wrong, runs[2]])[1].node.prompt, 'base review')
})

test('V4 wall correction survives refresh only with its exact signed prompt', () => {
  const { workflow, runs } = fixture()
  const base = runs[1]
  const marker = { ...base.sourceBoundNodeOverride.marker,
    version: A8B6_LOCAL_V4_FRAME_VERSION,
    reviewPromptSha256:
      '0070e5bb385b26e81dc6e38da5942a4f9a6a48e9ed7995de561dffe593798c6e' }
  const review = { ...base,
    sourceBoundNodeOverride: { version: A8B6_LOCAL_V4_FRAME_VERSION,
      nodeId: base.node.id, marker },
    node: { ...base.node, prompt: A8B6_LOCAL_V4_FRAME_REVIEW_PROMPT,
      params: [workflow.nodes[1].params[0],
        { name: 'sceneCutLocalComposite',
          englishName: 'sceneCutLocalComposite', type: 'json',
          value: canonical(marker) }] } }
  const refreshed = refreshPendingExecutionNodes(workflow,
    [runs[0], review, runs[2]])
  assert.equal(refreshed[1], review)
  assert.equal(refreshed[2].node.prompt, 'new base')
  assert.equal(hasExecutionPlanMismatch(workflow, refreshed), false)
  for (const tampered of [
    { ...review, node: { ...review.node, prompt: 'unsourced wall review' } },
    { ...review, sourceBoundNodeOverride: {
      ...review.sourceBoundNodeOverride,
      marker: { ...marker, reviewPromptSha256: '0'.repeat(64) } } },
  ]) {
    assert.equal(refreshPendingExecutionNodes(workflow,
      [runs[0], tampered, runs[2]])[1].node.prompt, 'base review')
  }
})

test('V5 wall correction survives refresh only with its own review prompt and hash', () => {
  const { workflow, runs } = fixture()
  const base = runs[1]
  const marker = { ...base.sourceBoundNodeOverride.marker,
    version: A8B6_LOCAL_V5_FRAME_VERSION,
    reviewPromptSha256:
      'f13538320c9d566bf01725e7e7e57be71fff43ae394f80ca9b442c4969422dff' }
  const review = { ...base,
    sourceBoundNodeOverride: { version: A8B6_LOCAL_V5_FRAME_VERSION,
      nodeId: base.node.id, marker },
    node: { ...base.node, prompt: A8B6_LOCAL_V5_FRAME_REVIEW_PROMPT,
      params: [workflow.nodes[1].params[0],
        { name: 'sceneCutLocalComposite',
          englishName: 'sceneCutLocalComposite', type: 'json',
          value: canonical(marker) }] } }
  assert.equal(refreshPendingExecutionNodes(workflow,
    [runs[0], review, runs[2]])[1], review)
  for (const tampered of [
    { ...review, node: { ...review.node, prompt: A8B6_LOCAL_V4_FRAME_REVIEW_PROMPT } },
    { ...review, sourceBoundNodeOverride: {
      ...review.sourceBoundNodeOverride,
      marker: { ...marker, reviewPromptSha256: '0'.repeat(64) } } },
  ]) {
    assert.equal(refreshPendingExecutionNodes(workflow,
      [runs[0], tampered, runs[2]])[1].node.prompt, 'base review')
  }
})

test('V6 wall correction preserves only its exact independent review', () => {
  const { workflow, runs } = fixture()
  const base = runs[1]
  const marker = { ...base.sourceBoundNodeOverride.marker,
    version: A8B6_LOCAL_V6_FRAME_VERSION,
    reviewPromptSha256:
      '95fa03dd3d7c9474203e33306284d2005c8c3cec220172ba5c9810da33a14eda' }
  const review = { ...base,
    sourceBoundNodeOverride: { version: A8B6_LOCAL_V6_FRAME_VERSION,
      nodeId: base.node.id, marker },
    node: { ...base.node, prompt: A8B6_LOCAL_V6_FRAME_REVIEW_PROMPT,
      params: [workflow.nodes[1].params[0],
        { name: 'sceneCutLocalComposite',
          englishName: 'sceneCutLocalComposite', type: 'json',
          value: canonical(marker) }] } }
  assert.equal(refreshPendingExecutionNodes(workflow,
    [runs[0], review, runs[2]])[1], review)
  for (const tampered of [
    { ...review, node: { ...review.node,
      prompt: A8B6_LOCAL_V5_FRAME_REVIEW_PROMPT } },
    { ...review, sourceBoundNodeOverride: {
      ...review.sourceBoundNodeOverride,
      marker: { ...marker, reviewPromptSha256: '0'.repeat(64) } } },
  ]) {
    assert.equal(refreshPendingExecutionNodes(workflow,
      [runs[0], tampered, runs[2]])[1].node.prompt, 'base review')
  }
})

test('V7 wall correction preserves only its exact independent review', () => {
  const { workflow, runs } = fixture()
  const base = runs[1]
  const marker = { ...base.sourceBoundNodeOverride.marker,
    version: A8B6_LOCAL_V7_FRAME_VERSION,
    reviewPromptSha256:
      'd89c5588deb01c417c2af0574f0015e191ed15f50aef97e386f56d35a47f5b1f' }
  const review = { ...base,
    sourceBoundNodeOverride: { version: A8B6_LOCAL_V7_FRAME_VERSION,
      nodeId: base.node.id, marker },
    node: { ...base.node, prompt: A8B6_LOCAL_V7_FRAME_REVIEW_PROMPT,
      params: [workflow.nodes[1].params[0],
        { name: 'sceneCutLocalComposite',
          englishName: 'sceneCutLocalComposite', type: 'json',
          value: canonical(marker) }] } }
  assert.equal(refreshPendingExecutionNodes(workflow,
    [runs[0], review, runs[2]])[1], review)
  for (const tampered of [
    { ...review, node: { ...review.node,
      prompt: A8B6_LOCAL_V6_FRAME_REVIEW_PROMPT } },
    { ...review, sourceBoundNodeOverride: {
      ...review.sourceBoundNodeOverride,
      marker: { ...marker, reviewPromptSha256: '0'.repeat(64) } } },
  ]) {
    assert.equal(refreshPendingExecutionNodes(workflow,
      [runs[0], tampered, runs[2]])[1].node.prompt, 'base review')
  }
})

test('V8 review retains only exact independent prompt and source-pixel detail', () => {
  const { workflow, runs } = fixture()
  const base = runs[1]
  const marker = { ...base.sourceBoundNodeOverride.marker,
    version: A8B6_LOCAL_V8_FRAME_VERSION,
    reviewPromptSha256:
      '142f11602d7b173385df92b08f6b9640ef2e97c9431d49a2190de4337d27a795' }
  const detail = { name: 'reviewImageDetail',
    englishName: 'reviewImageDetail', type: 'json',
    value: canonical(A8B6_LOCAL_V8_REVIEW_IMAGE_DETAIL) }
  const review = { ...base,
    sourceBoundNodeOverride: { version: A8B6_LOCAL_V8_FRAME_VERSION,
      nodeId: base.node.id, marker },
    node: { ...base.node, prompt: A8B6_LOCAL_V8_FRAME_REVIEW_PROMPT,
      params: [workflow.nodes[1].params[0],
        { name: 'sceneCutLocalComposite',
          englishName: 'sceneCutLocalComposite', type: 'json',
          value: canonical(marker) }, detail] } }
  assert.equal(refreshPendingExecutionNodes(workflow,
    [runs[0], review, runs[2]])[1], review)
  for (const tampered of [
    { ...review, node: { ...review.node,
      prompt: A8B6_LOCAL_V7_FRAME_REVIEW_PROMPT } },
    { ...review, node: { ...review.node,
      params: review.node.params.slice(0, -1) } },
    { ...review, node: { ...review.node,
      params: [...review.node.params.slice(0, -1),
        { ...detail, value: canonical({ ...A8B6_LOCAL_V8_REVIEW_IMAGE_DETAIL,
          rows: 1 }) }] } },
    { ...review, sourceBoundNodeOverride: {
      ...review.sourceBoundNodeOverride,
      marker: { ...marker, reviewPromptSha256: '0'.repeat(64) } } },
  ]) {
    assert.equal(refreshPendingExecutionNodes(workflow,
      [runs[0], tampered, runs[2]])[1].node.prompt, 'base review')
  }
})

test('V9 review retains its new prompt and the same signed native crop contract', () => {
  const { workflow, runs } = fixture()
  const base = runs[1]
  const marker = { ...base.sourceBoundNodeOverride.marker,
    version: A8B6_LOCAL_V9_FRAME_VERSION,
    reviewPromptSha256:
      '2bf1a767ac99e97c78ff50880aaa700f08d1eafdd842e86d4e22276bf40c7439' }
  const detail = { name: 'reviewImageDetail',
    englishName: 'reviewImageDetail', type: 'json',
    value: canonical(A8B6_LOCAL_V8_REVIEW_IMAGE_DETAIL) }
  const review = { ...base,
    sourceBoundNodeOverride: { version: A8B6_LOCAL_V9_FRAME_VERSION,
      nodeId: base.node.id, marker },
    node: { ...base.node, prompt: A8B6_LOCAL_V9_FRAME_REVIEW_PROMPT,
      params: [workflow.nodes[1].params[0],
        { name: 'sceneCutLocalComposite',
          englishName: 'sceneCutLocalComposite', type: 'json',
          value: canonical(marker) }, detail] } }
  assert.equal(refreshPendingExecutionNodes(workflow,
    [runs[0], review, runs[2]])[1], review)
  for (const tampered of [
    { ...review, node: { ...review.node,
      prompt: A8B6_LOCAL_V8_FRAME_REVIEW_PROMPT } },
    { ...review, node: { ...review.node,
      params: review.node.params.slice(0, -1) } },
    { ...review, node: { ...review.node,
      params: [...review.node.params.slice(0, -1),
        { ...detail, value: canonical({ ...A8B6_LOCAL_V8_REVIEW_IMAGE_DETAIL,
          overlap: 0 }) }] } },
    { ...review, sourceBoundNodeOverride: {
      ...review.sourceBoundNodeOverride,
      marker: { ...marker, reviewPromptSha256: '0'.repeat(64) } } },
  ]) {
    assert.equal(refreshPendingExecutionNodes(workflow,
      [runs[0], tampered, runs[2]])[1].node.prompt, 'base review')
  }
})
