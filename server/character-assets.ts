import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { CharacterAsset, CharacterAssetInput, CharacterEquipment, CharacterEquipmentApplicability, CharacterEquipmentInput, CharacterEquipmentKind, CharacterPerson } from '../src/character-asset.ts'
import { normalizeCharacterBiography } from '../src/character-asset.ts'
import { mergeCharacterVisualMetadata } from '../src/character-visual-context.ts'
import { stableVoiceContinuityKey } from '../src/voice-character-input.ts'
import { existingCharacterVoiceContinuityKey } from './character-voices.ts'

// Biographies belong to the person, independently of visual and voice versions.
// The empty workflow key is reserved for legacy assets without an assignment.
export const characterBiographySchema = `
create table if not exists character_biographies (
  workflow_id text not null,
  character_name text not null,
  biography text not null default '' check (char_length(biography) <= 10000),
  updated_at timestamptz not null default now(),
  primary key (workflow_id, character_name)
);`

/** Equipment is owned by the person rather than an individual costume sheet.
 * The logical key matches the existing shared biography contract. */
export const characterEquipmentSchema = `
create table if not exists character_equipment (
  id text primary key,
  person_id text not null,
  workflow_id text not null default '',
  character_name text not null,
  name text not null,
  kind text not null check (kind in ('weapon','armor','prop','accessory','other')),
  description text not null default '',
  image_url text not null default '',
  aliases jsonb not null default '[]'::jsonb,
  applicability jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(aliases) = 'array'),
  check (jsonb_typeof(applicability) = 'object')
);
create index if not exists character_equipment_person_idx on character_equipment(person_id, updated_at desc);
create index if not exists character_equipment_lookup_idx on character_equipment(workflow_id, character_name);
create unique index if not exists character_equipment_person_name_idx
  on character_equipment(person_id, lower(regexp_replace(name, '[[:space:]]+', '', 'g')));
`

export function characterPersonId(workflowId: string | null | undefined, characterName: string) {
  return `person-${createHash('sha1').update(JSON.stringify([workflowId ?? '', characterName.trim()])).digest('hex').slice(0, 20)}`
}

const equipmentNameKey = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase()

function equipmentRow(row: Record<string, unknown>): CharacterEquipment {
  return {
    id: String(row.id), personId: String(row.person_id), workflowId: row.workflow_id ? String(row.workflow_id) : null,
    characterName: String(row.character_name), name: String(row.name), kind: row.kind as CharacterEquipmentKind,
    description: String(row.description ?? ''), imageUrl: String(row.image_url ?? ''),
    aliases: Array.isArray(row.aliases) ? row.aliases as string[] : [],
    applicability: row.applicability && typeof row.applicability === 'object' && !Array.isArray(row.applicability)
      ? row.applicability as CharacterEquipmentApplicability : {},
    createdAt: row.created_at as string, updatedAt: row.updated_at as string,
  }
}

function normalizeEquipmentInput(input: CharacterEquipmentInput) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('装备资料必须是对象')
  const string = (value: unknown, label: string, max: number, required = false) => {
    if (value === undefined && !required) return ''
    if (typeof value !== 'string' || (required && !value.trim()) || value.trim().length > max) throw Error(`${label}须为${required ? '非空' : ''}文本，最多 ${max} 字`)
    return value.trim()
  }
  const name = string(input.name, '装备名称', 120, true)
  const kinds = ['weapon', 'armor', 'prop', 'accessory', 'other']
  if (!kinds.includes(String(input.kind))) throw Error('装备类型无效')
  const kind = input.kind as CharacterEquipmentKind
  const description = string(input.description, '装备描述', 1000)
  const imageUrl = string(input.imageUrl, '装备图片地址', 12 * 1024 * 1024)
  const list = (value: unknown, label: string, maxItems: number, maxLength: number) => {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > maxItems || value.some(item => typeof item !== 'string' || !item.trim() || item.trim().length > maxLength)) {
      throw Error(`${label}须为有效文本列表`)
    }
    return [...new Set(value.map(item => String(item).trim()))]
  }
  const usedNames = new Set([equipmentNameKey(name)])
  const aliases = list(input.aliases, '装备别名', 20, 120).filter(alias => {
    const key = equipmentNameKey(alias)
    if (usedNames.has(key)) return false
    usedNames.add(key)
    return true
  })
  const source = input.applicability ?? {}
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw Error('装备适用条件必须是对象')
  const allowedKeys = ['ageStages', 'lookKeys', 'sceneTags']
  if (Object.keys(source).some(key => !allowedKeys.includes(key))) throw Error('装备适用条件包含未知字段')
  const ageStages = list(source.ageStages, '装备适用年龄阶段', 7, 20)
  if (ageStages.some(stage => !['child', 'adolescent', 'young_adult', 'adult', 'mature', 'elderly', 'unknown'].includes(stage))) throw Error('装备适用年龄阶段无效')
  const lookKeys = list(source.lookKeys, '装备适用造型', 30, 120)
  const sceneTags = list(source.sceneTags, '装备适用场景', 30, 120)
  const applicability: CharacterEquipmentApplicability = {}
  if (ageStages.length) applicability.ageStages = ageStages as CharacterEquipmentApplicability['ageStages']
  if (lookKeys.length) applicability.lookKeys = lookKeys
  if (sceneTags.length) applicability.sceneTags = sceneTags
  return { name, kind, description, imageUrl, aliases, applicability }
}

/** Workflow callers can request one workflow plus unassigned shared equipment.
 * The caller still checks applicability against the selected visual version. */
export async function readCharacterEquipment(pool: Pool, workflowId?: string, names?: string[]): Promise<CharacterEquipment[]> {
  if (names && !names.length) return []
  const requestedWorkflowId = workflowId?.trim() || null
  const result = await pool.query(`select * from character_equipment
    where ($1::text is null or workflow_id=$1 or workflow_id='')
      and ($2::text[] is null or btrim(character_name)=any($2::text[]))
    order by updated_at desc,id`, [requestedWorkflowId, names ?? null])
  return result.rows.map(equipmentRow)
}

export async function readCharacterPeople(pool: Pool, workflowId?: string, includeShared = false): Promise<CharacterPerson[]> {
  const requestedWorkflowId = workflowId?.trim() || undefined
  const [versions, equipment, biographies, voices] = await Promise.all([
    readCharacterAssets(pool, requestedWorkflowId, includeShared),
    readCharacterEquipment(pool, requestedWorkflowId),
    pool.query(`select workflow_id,character_name,biography,updated_at from character_biographies
      where ($1::text is null or workflow_id=$1 or ($2 and workflow_id=''))`, [requestedWorkflowId ?? null, includeShared]),
    pool.query(`select c.workflow_id,c.character_name,c.continuity_key,v.binding,
        coalesce(a.enabled,true) as voice_enabled,
        o.voice_id as original_voice_id,o.description as original_description,
        o.preview_url as original_preview_url,o.target_model as original_target_model,
        o.status as original_status,coalesce(o.updated_at,v.created_at) as voice_updated_at
      from voice_characters c
      left join character_voice_versions v on v.character_id=c.id and v.version=c.current_version
      left join character_voice_availability a on a.character_id=v.character_id and a.version=v.version
      left join original_character_voices o on o.character_id=c.id
      where c.continuity_key<>'__narrator__'
        and ($1::text is null or c.workflow_id=$1 or ($2 and c.workflow_id=''))
        and (v.binding is not null or o.character_id is not null)`, [requestedWorkflowId ?? null, includeShared]),
  ])
  const people = new Map<string, CharacterPerson>()
  const person = (scope: string | null, name: string) => {
    const normalizedName = name.trim()
    const id = characterPersonId(scope, normalizedName)
    let value = people.get(id)
    if (!value) {
      value = { id, workflowId: scope, characterName: normalizedName, biography: '', versions: [], equipment: [], updatedAt: '' }
      people.set(id, value)
    }
    return value
  }
  const newer = (current: string, candidate: string) => !current || new Date(candidate).getTime() > new Date(current).getTime() ? candidate : current
  for (const row of biographies.rows) {
    const item = person(row.workflow_id || null, String(row.character_name))
    item.biography = String(row.biography ?? '')
    item.updatedAt = newer(item.updatedAt, row.updated_at)
  }
  for (const item of versions) {
    const target = person(item.workflowId, item.characterName)
    target.versions.push(item)
    target.updatedAt = newer(target.updatedAt, item.updatedAt)
  }
  for (const item of equipment) {
    if (requestedWorkflowId && item.workflowId === null && !includeShared) continue
    const target = person(item.workflowId, item.characterName)
    target.equipment.push(item)
    target.updatedAt = newer(target.updatedAt, item.updatedAt)
  }
  const voiceGroups = new Map<string, typeof voices.rows>()
  for (const row of voices.rows) {
    const id = characterPersonId(row.workflow_id, String(row.character_name))
    const matches = voiceGroups.get(id) ?? []
    matches.push(row)
    voiceGroups.set(id, matches)
  }
  for (const [id, rows] of voiceGroups) {
    const canonical = rows.find(row => row.continuity_key === `voice:${String(row.character_name).trim()}`)
    const selected = canonical ?? (rows.length === 1 ? rows[0] : undefined)
    // Voice-only speaking roles are not automatically visual/person library
    // entries. Attach their sound when an asset, profile or equipment exists.
    const item = people.get(id)
    if (!item) continue
    if (!selected) { item.voiceAmbiguous = true; continue }
    if (selected.binding) {
      item.voice = selected.binding
      item.voiceAvailable = selected.voice_enabled
    }
    if (selected.original_status) {
      item.originalVoice = {
        voiceId: selected.original_voice_id ?? null,
        description: String(selected.original_description ?? ''),
        previewUrl: selected.original_preview_url ?? null,
        targetModel: String(selected.original_target_model ?? ''),
        status: String(selected.original_status),
      }
    }
    if (selected.voice_updated_at) item.updatedAt = newer(item.updatedAt, selected.voice_updated_at)
  }
  return [...people.values()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() || a.id.localeCompare(b.id))
}

async function resolveCharacterPerson(db: Pool | PoolClient, personId: string) {
  const result = await db.query(`select workflow_id,character_name from (
      select coalesce(workflow_id,'') as workflow_id,character_name from character_assets where asset_type='three-view'
      union select workflow_id,character_name from character_biographies
      union select workflow_id,character_name from character_equipment
    ) identities`)
  const row = result.rows.find(item => characterPersonId(item.workflow_id, item.character_name) === personId)
  if (!row) throw Error('人物不存在或已被删除')
  return { workflowId: String(row.workflow_id), characterName: String(row.character_name).trim() }
}

/** The person lock serializes overlapping names and aliases, including when
 * the first two equipment writes race before either has created a row. */
async function assertEquipmentNamesAvailable(db: PoolClient, personId: string, value: ReturnType<typeof normalizeEquipmentInput>, exceptId?: string) {
  await db.query('select pg_advisory_xact_lock(hashtext($1)::bigint)', [personId])
  const rows = (await db.query('select id,name,aliases from character_equipment where person_id=$1', [personId])).rows
  const requested = new Map([value.name, ...value.aliases].map(word => [equipmentNameKey(word), word]))
  for (const row of rows) {
    if (row.id === exceptId) continue
    for (const word of [row.name, ...(Array.isArray(row.aliases) ? row.aliases : [])]) {
      const conflict = requested.get(equipmentNameKey(String(word)))
      if (conflict) throw Error(`装备名称或别名“${conflict}”与该人物的已有装备“${row.name}”冲突`)
    }
  }
}

export async function createCharacterEquipment(pool: Pool, personId: string, input: CharacterEquipmentInput): Promise<CharacterEquipment> {
  const value = normalizeEquipmentInput(input)
  const db = await pool.connect()
  try {
    await db.query('begin')
    const person = await resolveCharacterPerson(db, personId)
    await assertEquipmentNamesAvailable(db, personId, value)
    const result = await db.query(`insert into character_equipment
      (id,person_id,workflow_id,character_name,name,kind,description,image_url,aliases,applicability)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb) returning *`,
    [`equipment-${randomUUID()}`, personId, person.workflowId, person.characterName, value.name, value.kind,
      value.description, value.imageUrl, JSON.stringify(value.aliases), JSON.stringify(value.applicability)])
    await db.query('commit')
    return equipmentRow(result.rows[0])
  } catch (error) { await db.query('rollback'); throw error } finally { db.release() }
}

export async function updateCharacterEquipment(pool: Pool, personId: string, equipmentId: string, input: CharacterEquipmentInput): Promise<CharacterEquipment> {
  const value = normalizeEquipmentInput(input)
  const db = await pool.connect()
  try {
    await db.query('begin')
    await assertEquipmentNamesAvailable(db, personId, value, equipmentId)
    const result = await db.query(`update character_equipment set name=$3,kind=$4,description=$5,image_url=$6,
        aliases=$7::jsonb,applicability=$8::jsonb,updated_at=now() where id=$1 and person_id=$2 returning *`,
    [equipmentId, personId, value.name, value.kind, value.description, value.imageUrl,
      JSON.stringify(value.aliases), JSON.stringify(value.applicability)])
    if (!result.rowCount) throw Error('装备不存在或不属于该人物')
    await db.query('commit')
    return equipmentRow(result.rows[0])
  } catch (error) { await db.query('rollback'); throw error } finally { db.release() }
}

export async function deleteCharacterEquipment(pool: Pool, personId: string, equipmentId: string) {
  const result = await pool.query('delete from character_equipment where id=$1 and person_id=$2', [equipmentId, personId])
  if (!result.rowCount) throw Error('装备不存在或不属于该人物')
}

/** Archive existing workflow evidence together with the portrait, without model calls.
 * A shared profile may have been edited or explicitly cleared, so automatic retries
 * and new costume versions only fill a profile that has never been saved.
 */
export async function archiveWorkflowCharacterAsset(pool: Pool, asset: {
  id: string; workflowId: string | null; characterName: string; uri: string; prompt: string
  metadata: Record<string, unknown>; biography?: string
}): Promise<string | undefined> {
  const biography = normalizeCharacterBiography(asset.biography)
  const values = [asset.id, asset.workflowId, asset.characterName, asset.uri, asset.prompt, JSON.stringify(asset.metadata)]
  const insert = `insert into character_assets as prior (id, workflow_id, character_name, asset_type, uri, prompt, version, metadata, updated_at)
    values ($1, $2, $3, 'three-view', $4, $5, 1, $6::jsonb, now())
    on conflict (id) do update set
      workflow_id = case when prior.metadata->'portraitLifecycle'->>'status' in ('superseded','pending-review','pending-unrecoverable')
          or prior.metadata->'identityConsistency'->>'status'='needs_manual_review'
          or (prior.metadata ? 'portraitReviewDecision')
          or prior.metadata->'artisticIdentity'->>'active'='true' then prior.workflow_id else excluded.workflow_id end,
      uri = case when prior.metadata->'portraitLifecycle'->>'status' in ('superseded','pending-review','pending-unrecoverable')
          or prior.metadata->'identityConsistency'->>'status'='needs_manual_review'
          or (prior.metadata ? 'portraitReviewDecision')
          or prior.metadata->'artisticIdentity'->>'active'='true' then prior.uri else excluded.uri end,
      prompt = case when prior.metadata->'portraitLifecycle'->>'status' in ('superseded','pending-review','pending-unrecoverable')
          or prior.metadata->'identityConsistency'->>'status'='needs_manual_review'
          or (prior.metadata ? 'portraitReviewDecision')
          or prior.metadata->'artisticIdentity'->>'active'='true' then prior.prompt else excluded.prompt end,
      metadata = case when prior.metadata->'portraitLifecycle'->>'status' in ('superseded','pending-review','pending-unrecoverable')
          or prior.metadata->'identityConsistency'->>'status'='needs_manual_review'
          or (prior.metadata ? 'portraitReviewDecision')
          or prior.metadata->'artisticIdentity'->>'active'='true' then prior.metadata else excluded.metadata end,
      updated_at = case when prior.metadata->'portraitLifecycle'->>'status' in ('superseded','pending-review','pending-unrecoverable')
          or prior.metadata->'identityConsistency'->>'status'='needs_manual_review'
          or (prior.metadata ? 'portraitReviewDecision')
          or prior.metadata->'artisticIdentity'->>'active'='true' then prior.updated_at else now() end`
  if (!biography) {
    await pool.query(insert, values)
    return undefined
  }
  // A single statement makes an unsuccessful biography write roll back the image
  // write too, including callers that do not already hold a transaction client.
  const result = await pool.query(`with archived as (${insert} returning workflow_id, character_name),
    profile as (
      insert into character_biographies(workflow_id,character_name,biography)
      select coalesce(workflow_id,''),character_name,$7::text from archived
      on conflict(workflow_id,character_name) do nothing returning biography
    )
    select coalesce((select biography from profile),
      (select biography from character_biographies where workflow_id=coalesce($2::text,'') and character_name=$3),$7::text) as biography
    from archived`, [...values, biography])
  return typeof result.rows[0]?.biography === 'string' ? result.rows[0].biography : biography
}

export async function readCharacterAssets(pool: Pool, workflowId?: string, includeShared = false): Promise<CharacterAsset[]> {
  const result = await pool.query(
    `select a.id, a.workflow_id, a.character_name, a.uri, a.prompt, a.version, a.metadata, a.created_at, a.updated_at,
            coalesce(b.biography, '') as biography
       from character_assets a
       left join character_biographies b on b.workflow_id=coalesce(a.workflow_id, '') and b.character_name=a.character_name
      where a.asset_type = 'three-view' ${workflowId ? 'and (a.workflow_id = $1 or ($2 and a.workflow_id is null))' : ''}
      order by ${workflowId ? '(a.workflow_id = $1) desc nulls last, ' : ''}a.updated_at desc`,
    workflowId ? [workflowId, includeShared] : [],
  )
  const voiceRows = (await pool.query(`select c.workflow_id,c.continuity_key,v.binding,coalesce(a.enabled,true) as enabled from voice_characters c join character_voice_versions v on v.character_id=c.id and v.version=c.current_version left join character_voice_availability a on a.character_id=v.character_id and a.version=v.version`)).rows
  return result.rows.map((row) => {
    const visualKey = String(row.metadata?.continuityKey || row.id)
    const voiceKey = stableVoiceContinuityKey({ name: String(row.character_name), continuityKey: visualKey,
      ...(typeof row.metadata?.voiceContinuityKey === 'string' ? { voiceContinuityKey: row.metadata.voiceContinuityKey } : {}) })
    const voice = voiceRows.find(v => v.workflow_id === (row.workflow_id ?? '') && v.continuity_key === voiceKey)
      ?? voiceRows.find(v => v.workflow_id === (row.workflow_id ?? '') && v.continuity_key === visualKey)
    return {
      voice: voice?.binding,
      voiceAvailable: voice?.enabled,
      id: row.id,
      workflowId: row.workflow_id,
      characterName: row.character_name,
      description: row.prompt,
      biography: row.biography,
      threeViewUrl: row.uri,
      version: row.version,
      metadata: row.metadata ?? {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  })
}

async function inheritCharacterVoiceIdentity(db: PoolClient, workflowId: string, name: string, metadata: Record<string, unknown>) {
  const originalVoice = metadata.originalVoice && typeof metadata.originalVoice === 'object' ? metadata.originalVoice as Record<string, unknown> : undefined
  const key = await existingCharacterVoiceContinuityKey(db, { workflowId, characterName: name, visualKey: String(metadata.continuityKey ?? ''),
    ...(typeof metadata.voiceContinuityKey === 'string' ? { preferredKey: metadata.voiceContinuityKey } : {}),
    ...(typeof originalVoice?.characterId === 'string' ? { originalCharacterId: originalVoice.characterId } : {}),
  })
  if (key) metadata.voiceContinuityKey = key
}

async function saveBiography(db: PoolClient, workflowId: string, name: string, biography: string | undefined) {
  if (biography === undefined) return
  await db.query(`insert into character_biographies(workflow_id,character_name,biography)
    values($1,$2,$3) on conflict(workflow_id,character_name) do update set biography=excluded.biography,updated_at=now()`,
  [workflowId, name, biography])
}

function validateInput(input: CharacterAssetInput) {
  const name = input.characterName.trim()
  if (!name) throw new Error('角色名称不能为空')
  if (!input.workflowId) throw new Error('请选择所属工作流')
  if (!input.threeViewUrl.trim()) throw new Error('请上传或填写角色三视图')
  return { name, biography: normalizeCharacterBiography(input.biography) }
}

export async function createCharacterAsset(pool: Pool, input: CharacterAssetInput): Promise<CharacterAsset> {
  const { name, biography } = validateInput(input)
  const workflowId = input.workflowId as string
  const id = `character-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const metadata = mergeCharacterVisualMetadata(input.metadata)
  const inheritedEvidence = ['visualProfile', 'identityVisualProfile', 'visualContextAssessment', 'quality',
    'identityConsistency', 'sourceMediaProvenance', 'visualContextSource', 'visualContextRequestSignature',
    'visualContextImageFingerprint', 'identityReferenceAssetId', 'identityReferenceUrl',
    'identityReferenceTransportUrl', 'identityReferenceAnchor', 'artisticIdentity',
    'portraitLifecycle', 'portraitReviewDecision', 'historicalPortrait', 'generatedBy', 'archivedFromNodeId']
    .filter(key => metadata[key] !== undefined)
  if (inheritedEvidence.length) throw Error(`CHARACTER_NEW_PORTRAIT_EVIDENCE_INVALID: 新三视图不得继承旧图的审核或来源记录（${inheritedEvidence.join('、')}）；请只提交人物声音、年龄与场景造型`)
  const db = await pool.connect()
  try {
    await db.query('begin')
    await inheritCharacterVoiceIdentity(db, workflowId, name, metadata)
    await db.query(
      `insert into character_assets (id, workflow_id, character_name, asset_type, uri, prompt, version, metadata, updated_at)
       values ($1, $2, $3, 'three-view', $4, $5, 1, $6::jsonb, now())`,
      [id, workflowId, name, input.threeViewUrl.trim(), input.description.trim(), JSON.stringify(metadata)],
    )
    await saveBiography(db, workflowId, name, biography)
    await db.query('commit')
  } catch (error) {
    await db.query('rollback')
    throw error
  } finally { db.release() }
  return (await readCharacterAssets(pool)).find((item) => item.id === id) as CharacterAsset
}

export async function updateCharacterAsset(pool: Pool, id: string, input: CharacterAssetInput): Promise<CharacterAsset> {
  const { name, biography } = validateInput(input)
  const workflowId = input.workflowId as string
  const db = await pool.connect()
  try {
    await db.query('begin')
    const previous = (await db.query("select workflow_id,character_name,uri,prompt,metadata from character_assets where id=$1 and asset_type='three-view' for update", [id])).rows[0]
    if (!previous) throw new Error('角色不存在或已被删除')
    if (previous.workflow_id !== workflowId || previous.character_name !== name) {
      throw new Error('不能通过编辑三视图版本更换人物名称或所属工作流；该人物的装备、声音和历史执行已关联原身份')
    }
    const imageChanged = previous.uri !== input.threeViewUrl.trim()
    const previousMetadata = previous.metadata && typeof previous.metadata === 'object'
      ? previous.metadata as Record<string, unknown> : {}
    const suppliedMetadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? input.metadata as Record<string, unknown> : {}
    // The person-library edit endpoint cannot issue or replace a media review.
    // Older clients may echo unchanged evidence, so accept only byte-for-byte
    // equivalent values and let mergeCharacterVisualMetadata keep the DB copy.
    const protectedEvidence = ['visualProfile', 'identityVisualProfile', 'visualContextAssessment', 'quality',
      'identityConsistency', 'sourceMediaProvenance', 'visualContextSource', 'visualContextRequestSignature',
      'visualContextImageFingerprint', 'identityReferenceAssetId', 'identityReferenceUrl',
      'identityReferenceTransportUrl', 'identityReferenceAnchor', 'artisticIdentity',
      'portraitLifecycle', 'portraitReviewDecision', 'historicalPortrait', 'generatedBy', 'archivedFromNodeId']
    const changedEvidence = protectedEvidence.filter(key => key in suppliedMetadata
      && JSON.stringify(suppliedMetadata[key]) !== JSON.stringify(previousMetadata[key]))
    if (changedEvidence.length) throw Error(`CHARACTER_PORTRAIT_EVIDENCE_IMMUTABLE: 不能通过人物编辑接口修改三视图审核或来源记录（${changedEvidence.join('、')}）；请使用待核验图审核操作`)
    const lifecycle = previousMetadata.portraitLifecycle && typeof previousMetadata.portraitLifecycle === 'object'
      ? previousMetadata.portraitLifecycle as Record<string, unknown> : {}
    const artisticIdentity = previousMetadata.artisticIdentity && typeof previousMetadata.artisticIdentity === 'object'
      ? previousMetadata.artisticIdentity as Record<string, unknown> : {}
    if (imageChanged && (artisticIdentity.active === true || ['superseded', 'pending-review', 'pending-unrecoverable'].includes(String(lifecycle.status ?? ''))
      || ['visualProfile', 'identityVisualProfile', 'identityConsistency', 'sourceMediaProvenance', 'generatedBy']
        .some(key => previousMetadata[key] !== undefined))) {
      throw Error('CHARACTER_REVIEWED_PORTRAIT_IMMUTABLE: 已审核或已付费的三视图不能原位换图；请在该人物下新建年龄 / 场景版本，保留旧图和历史记录')
    }
    const editableMetadata = Object.fromEntries(Object.entries(suppliedMetadata).filter(([key]) => !protectedEvidence.includes(key)))
    const metadata = mergeCharacterVisualMetadata(editableMetadata, previous.metadata ?? {}, {
      imageChanged, descriptionChanged: previous.prompt !== input.description.trim(),
    })
    await inheritCharacterVoiceIdentity(db, workflowId, name, metadata)
    await db.query(
      `update character_assets
          set workflow_id = $2, character_name = $3, uri = $4, prompt = $5,
              version = version + 1, metadata = $6::jsonb, updated_at = now()
        where id = $1 and asset_type = 'three-view'`,
      [id, workflowId, name, input.threeViewUrl.trim(), input.description.trim(), JSON.stringify(metadata)],
    )
    await saveBiography(db, workflowId, name, biography)
    await db.query('commit')
  } catch (error) {
    await db.query('rollback')
    throw error
  } finally { db.release() }
  return (await readCharacterAssets(pool)).find((item) => item.id === id) as CharacterAsset
}

export async function deleteCharacterAsset(pool: Pool, id: string) {
  const result = await pool.query("delete from character_assets where id = $1 and asset_type = 'three-view'", [id])
  if (!result.rowCount) throw new Error('角色不存在或已被删除')
}
