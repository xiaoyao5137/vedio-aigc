import test from 'node:test'
import assert from 'node:assert/strict'
import { assertCurrentCharacterEquipmentBindings } from '../server/character-equipment-paid-gate.ts'
import { characterPersonId } from '../server/character-assets.ts'

const workflowId = 'wf-sanguo-history-drama'
const row = {
  id: 'equipment-spear', person_id: characterPersonId(workflowId, '张飞'), workflow_id: workflowId,
  character_name: '张飞', name: '丈八蛇矛', kind: 'weapon', description: '长柄蛇矛', image_url: '/spear.png',
  aliases: ['蛇矛'], applicability: { ageStages: ['mature'], lookKeys: ['battle-cloak'], sceneTags: ['战场'] },
  created_at: new Date(), updated_at: new Date(),
}
const binding = { id: row.id, characterName: '张飞', name: row.name, kind: row.kind,
  description: row.description, imageUrl: row.image_url, matchedName: '蛇矛', requirementSource: 'shot_script.characterEquipment' }
const request = {
  model: { capability: 'video' }, executionContext: { workflowId, nodeId: 'sanguo-video' },
  params: { characters: ['张飞'], characterEquipment: [{ name: '张飞', equipmentNames: ['蛇矛'], sceneTags: ['战场'] }],
    characterVisuals: [{ name: '张飞', visualContext: { age: { stage: 'mature' }, look: { key: 'battle-cloak' } } }],
    equipmentBindings: [binding] },
}
const database = (rows: unknown[]) => ({ query: async () => ({ rows }) }) as never

test('paid video boundary rechecks a current, applicable person-owned equipment asset', async () => {
  await assertCurrentCharacterEquipmentBindings(database([row]), request)
  await assert.rejects(assertCurrentCharacterEquipmentBindings(database([]), request), /CHARACTER_EQUIPMENT_STALE/)
  await assert.rejects(assertCurrentCharacterEquipmentBindings(database([{ ...row, person_id: characterPersonId(workflowId, '关羽') }]), request), /CHARACTER_EQUIPMENT_STALE/)
  await assert.rejects(assertCurrentCharacterEquipmentBindings(database([{ ...row, description: '已修订' }]), request), /CHARACTER_EQUIPMENT_STALE/)
  await assert.rejects(assertCurrentCharacterEquipmentBindings(database([{ ...row, applicability: { ageStages: ['elderly'] } }]), request), /CHARACTER_EQUIPMENT_STALE/)
  await assert.rejects(assertCurrentCharacterEquipmentBindings(database([{ ...row, applicability: { sceneTags: ['朝堂'] } }]), request), /CHARACTER_EQUIPMENT_STALE/)
})

test('old video requests without equipment do not need an equipment database read', async () => {
  let reads = 0
  const db = { query: async () => { reads++; throw Error('unexpected query') } } as never
  await assertCurrentCharacterEquipmentBindings(db, { ...request, params: { ...request.params, characterEquipment: [], equipmentBindings: [] } })
  assert.equal(reads, 0)
})
