import test from 'node:test'
import assert from 'node:assert/strict'
import { characterContextSearchText, characterContextSummary, characterPersonAgeLabels, characterVersionMetadata, emptyVisualContextDraft,
  groupCharacterAssets, personMatchesContext, visualContextDraftFrom, visualContextFromDraft } from '../src/character-library-model.ts'
import type { CharacterAsset } from '../src/character-asset.ts'

const visual = {
  version: 'character-visual-context-v1', age: { stage: 'mature', basis: 'artistic', years: { min: 38, max: 48 },
    asOf: '建安十三年（208年）长坂撤退', sourceRefs: ['本剧壮年设定，具体生年不详'] },
  look: { key: '行军甲胄', description: '深色札甲、布帻' },
  appearanceConstraints: { hair: 'dark', facialHair: 'dark', build: '肩背宽厚' },
}
const asset = { id: 'zhangfei-reference', metadata: { continuityKey: '张飞-original', voiceContinuityKey: 'voice:张飞',
  historicalPortrait: { description: '保留的体貌资料' }, visualContext: visual } }

test('UI draft roundtrips all stage, evidence, period and costume fields', () => {
  const draft = visualContextDraftFrom(asset)
  assert.equal(draft.enabled, true)
  assert.equal(draft.minAge, '38')
  assert.equal(draft.sourceRefs, '本剧壮年设定，具体生年不详')
  assert.deepEqual(visualContextFromDraft(draft), visual)
})
test('legacy asset remains unmarked without invented age or stage', () => {
  const legacy = { id: 'old', metadata: { continuityKey: 'old-identity' } }
  const draft = visualContextDraftFrom(legacy)
  assert.equal(draft.enabled, false)
  assert.equal(visualContextFromDraft(draft), undefined)
  assert.equal(characterContextSummary(legacy).age, '年龄阶段未标注')
  assert.equal(characterContextSummary(legacy).context, undefined)
  assert.equal(Object.hasOwn(characterVersionMetadata(legacy, '张飞', draft), 'visualContext'), false)
})
test('malformed old metadata is shown as requiring correction, never confirmed age', () => {
  const invalid = { metadata: { visualContext: { ...visual, age: { stage: 'mature', basis: 'unknown', years: { min: 38, max: 48 } } } } }
  assert.equal(characterContextSummary(invalid).invalid, true)
  assert.equal(characterContextSummary(invalid).age, '年龄与造型资料待校对')
  assert.equal(characterContextSummary(invalid).context, undefined)
})
test('same-character variant gets a new visual key and only inherits person-level voice', () => {
  const base = { ...asset, metadata: { ...asset.metadata, quality: { status: 'passed' },
    identityConsistency: { status: 'passed', distance: 0.2 }, sourceMediaProvenance: { contentSha256: 'old-image' },
    visualProfile: { appearance: 'old image' }, portraitLifecycle: { status: 'superseded' },
    identityReferenceAnchor: { anchorUrl: '/generated/old-face.jpg' } } }
  const before = structuredClone(base)
  const draft = { ...visualContextDraftFrom(asset), lookKey: '便服', lookDescription: '深色布袍、布帻' }
  const metadata = characterVersionMetadata(base, '张飞', draft, { newVersion: true, versionId: 'variant-1' })
  assert.equal(metadata.continuityKey, '张飞-library-variant-1')
  assert.equal(metadata.voiceContinuityKey, 'voice:张飞')
  for (const key of ['historicalPortrait', 'quality', 'identityConsistency', 'sourceMediaProvenance',
    'visualProfile', 'portraitLifecycle', 'identityReferenceAnchor']) assert.equal(metadata[key as keyof typeof metadata], undefined, key)
  assert.equal(metadata.visualContext?.look.key, '便服')
  assert.deepEqual(base, before)
})
test('editing an existing legacy version retains its continuity key and voice', () => {
  const metadata = characterVersionMetadata({ id: 'anonymous-old', metadata: { voiceContinuityKey: 'bound-original' } }, '桥头守卫',
    { ...emptyVisualContextDraft, lookKey: '行军甲胄', lookDescription: '布甲' })
  assert.equal(metadata.continuityKey, 'anonymous-old')
  assert.equal(metadata.voiceContinuityKey, 'bound-original')
})
test('new identity has a stable default and explicitly unknown age is distinct from legacy unmarked', () => {
  const metadata = characterVersionMetadata(undefined, ' 刘备 ', { ...emptyVisualContextDraft, lookKey: '便服', lookDescription: '布袍' })
  assert.equal(metadata.continuityKey, '刘备-v1')
  assert.equal(metadata.visualContext?.age.stage, 'unknown')
  assert.equal(characterContextSummary({ metadata }).age, '年龄阶段未知')
})
test('search indexes age range, uncertainty, period, look, description and body', () => {
  const search = characterContextSearchText(asset)
  for (const keyword of ['成熟壮年', '38–48岁', '艺术设定', '208年', '行军甲胄', '深色札甲', '具体生年不详', '肩背宽厚']) {
    assert.ok(search.includes(keyword), keyword)
  }
})
test('person age summary prefers a range over the same stage without hiding other ranges', () => {
  const make = (id: string, stage: string, years?: { min: number; max: number }) => ({ id, metadata: { visualContext: {
    version: 'character-visual-context-v1', age: { stage, basis: 'artistic', ...(years ? { years } : {}) },
    look: { key: id, description: id },
  } } })
  assert.deepEqual(characterPersonAgeLabels([
    make('mature-no-range', 'mature'), make('mature-32-40', 'mature', { min: 32, max: 40 }),
    make('adult-no-range', 'adult'), make('mature-45-50', 'mature', { min: 45, max: 50 }),
  ]), ['成熟壮年 · 32–40岁', '成年', '成熟壮年 · 45–50岁'])
})
test('documented and estimated age require sources, artistic age remains distinct', () => {
  const draft = { ...emptyVisualContextDraft, stage: 'mature' as const, basis: 'documented' as const, lookKey: '甲胄', lookDescription: '札甲' }
  assert.throws(() => visualContextFromDraft(draft), /请填写年龄依据/)
  assert.equal(visualContextFromDraft({ ...draft, sourceRefs: '可靠史料' })?.age.basis, 'documented')
  assert.throws(() => visualContextFromDraft({ ...draft, basis: 'estimated' }), /请填写年龄依据/)
  assert.equal(visualContextFromDraft({ ...draft, basis: 'estimated', sourceRefs: '史料估计依据' })?.age.basis, 'estimated')
  assert.equal(visualContextFromDraft({ ...draft, basis: 'artistic' })?.age.basis, 'artistic')
})
test('partial, reversed, fractional and out-of-range ages cannot be saved', () => {
  const draft = { ...visualContextDraftFrom(asset) }
  for (const [minAge, maxAge] of [['40', ''], ['50', '40'], ['40.5', '50'], ['40', '121']]) {
    assert.throws(() => visualContextFromDraft({ ...draft, minAge, maxAge }))
  }
})
test('unknown age cannot carry a known stage or asserted numeric age', () => {
  const draft = { ...emptyVisualContextDraft, lookKey: '便服', lookDescription: '布袍' }
  assert.throws(() => visualContextFromDraft({ ...draft, stage: 'mature' }))
  assert.throws(() => visualContextFromDraft({ ...draft, minAge: '40', maxAge: '50' }))
})
test('a labelled visual version needs both stable look and description', () => {
  assert.throws(() => visualContextFromDraft({ ...emptyVisualContextDraft, lookKey: '甲胄' }), /造型名称/)
  assert.throws(() => visualContextFromDraft({ ...emptyVisualContextDraft, lookDescription: '札甲' }), /造型名称/)
})

test('one person row groups all of their portrait versions but keeps other workflows separate', () => {
  const make = (id: string, workflowId: string, characterName: string, updatedAt: string): CharacterAsset => ({
    id, workflowId, characterName, description: '', threeViewUrl: `https://example.test/${id}.png`, version: 1,
    metadata: {}, createdAt: updatedAt, updatedAt,
  })
  const rows = [make('old', 'wf-a', '张飞', '2026-01-01'), make('other', 'wf-b', '张飞', '2026-01-03'),
    make('new', 'wf-a', '张飞', '2026-01-02')]
  const groups = groupCharacterAssets(rows)
  assert.equal(groups.length, 2)
  assert.deepEqual(groups.find(group => group.workflowId === 'wf-a')?.versions.map(item => item.id), ['new', 'old'])
  assert.equal(groups.find(group => group.workflowId === 'wf-b')?.versions.length, 1)
  assert.deepEqual(rows.map(item => item.id), ['old', 'other', 'new'])
})

test('combined age and scene filters must match the same portrait version within a person', () => {
  const make = (id: string, stage: string, look: string): CharacterAsset => ({
    id, workflowId: 'wf-a', characterName: '张飞', description: '', biography: '', threeViewUrl: `https://example.test/${id}.png`,
    version: 1, metadata: { visualContext: { version: 'character-visual-context-v1', age: { stage, basis: 'artistic' },
      look: { key: look, description: look } } }, createdAt: '2026-01-01', updatedAt: '2026-01-01',
  })
  const person = groupCharacterAssets([make('young-armored', 'young_adult', '行军甲胄'), make('older-casual', 'mature', '便服')])[0]
  assert.equal(personMatchesContext(person, { age: 'young_adult', look: '行军甲胄' }), true)
  assert.equal(personMatchesContext(person, { age: 'young_adult', look: '便服' }), false)
  assert.equal(personMatchesContext(person, { keyword: '丈八蛇矛', equipmentText: '丈八蛇矛 武器' }), true)
})

test('person-level biography and equipment remain visible after the last portrait is removed', () => {
  const person = { characterName: '关羽', biography: '河东解良人', versions: [] }
  assert.equal(personMatchesContext(person, { age: 'all', basis: 'all', look: 'all', period: 'all' }), true)
  assert.equal(personMatchesContext(person, { keyword: '青龙偃月刀', equipmentText: '青龙偃月刀' }), true)
  assert.equal(personMatchesContext(person, { keyword: '河东解良' }), true)
  assert.equal(personMatchesContext(person, { age: 'mature' }), false)
})
