import { voiceReviewIdentity, type VoiceReviewTarget, type VoiceListeningReview } from '../src/voice-review.ts'
import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { CharacterVoice, VoiceManifest } from '../src/character-voice.ts'
import { anonymousVoiceRoles, nativeGroupVoicePlan, resolveShotVoices, speechStagingConflict, voiceSpeakers } from '../src/character-voice.ts'
import { callKlingAsset, extractKlingVoices, voiceAccountScope, KlingAssetRejectedError } from './kling-voices.ts'
import type { ExternalModelConfig } from './model-adapters.ts'
import { extractAllThreeViewReferences, validateThreeViewReference } from './image-references.ts'
import { stableVoiceContinuityKey } from '../src/voice-character-input.ts'

export const voiceSchema = `
create table if not exists voice_listening_reviews (id text primary key, target jsonb not null, review jsonb not null);

create table if not exists voice_characters (
  id text primary key, workflow_id text not null, continuity_key text not null,
  character_name text not null, current_version integer not null default 0,
  unique(workflow_id,continuity_key)
);
create table if not exists character_voice_versions (
  character_id text not null references voice_characters(id), version integer not null,
  binding jsonb not null, created_at timestamptz not null default now(), primary key(character_id,version)
);
create table if not exists character_voice_availability (
  character_id text not null, version integer not null, enabled boolean not null,
  reason text not null, updated_at timestamptz not null default now(),
  primary key(character_id,version),
  foreign key(character_id,version) references character_voice_versions(character_id,version)
);
create table if not exists execution_voice_manifests (
  execution_id text primary key, workflow_id text not null, manifest jsonb not null, created_at timestamptz not null default now()
);
create table if not exists execution_original_voice_manifests (
  execution_id text not null, character_id text not null, workflow_id text not null, binding jsonb not null,
  created_at timestamptz not null default now(), primary key(execution_id,character_id)
);
create table if not exists character_voice_jobs (
  id text primary key, character_asset_id text, model_id text not null, account_scope text not null,
  kind text not null, status text not null, task_id text, input jsonb not null, output jsonb,
  error text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists voice_element_job_pending on character_voice_jobs(character_asset_id)
  where kind='element' and status in ('submitting','processing','uncertain');
create unique index if not exists voice_identity_job_pending on character_voice_jobs((input->'binding'->>'characterId'))
  where kind='element' and status in ('submitting','processing','uncertain');`

/** A visual variant may retain a legacy voice key, but only after verifying
 * that the existing identity belongs to this same workflow and named actor. */
export async function preservedCharacterVoiceIdentity(db: Pool | PoolClient, workflowId: string, characterName: string, continuityKey: unknown) {
  if (continuityKey === undefined || continuityKey === null || continuityKey === '') return undefined
  if (typeof continuityKey !== 'string' || !continuityKey.trim() || continuityKey === '__narrator__') throw Error('VOICE_IDENTITY_MISMATCH: 人物保留音色的标识无效')
  const identity = (await db.query('select * from voice_characters where workflow_id=$1 and character_name=$2 and continuity_key=$3', [workflowId, characterName, continuityKey.trim()])).rows[0]
  if (!identity) throw Error('VOICE_IDENTITY_MISMATCH: 保留音色必须属于同一工作流和同一人物，不能借用其他角色的声音')
  return identity
}

/** Reused by lookup, direct ensure/archive and library writes. A new visual
 * variant never authorizes purchasing a second voice for the same named actor. */
export async function existingCharacterVoiceContinuityKey(db: Pool | PoolClient, options: { workflowId: string; characterName: string; preferredKey?: string; originalCharacterId?: string; visualKey: string }) {
  if (options.preferredKey) {
    const identity = await preservedCharacterVoiceIdentity(db, options.workflowId, options.characterName, options.preferredKey)
    return String(identity.continuity_key)
  }
  if (options.originalCharacterId) {
    const identity = (await db.query('select continuity_key from voice_characters where id=$1 and workflow_id=$2 and character_name=$3', [options.originalCharacterId, options.workflowId, options.characterName])).rows[0]
    if (!identity) throw Error('VOICE_IDENTITY_MISMATCH: 原音色身份不属于同一工作流和同一人物')
    return String(identity.continuity_key)
  }
  const identities = (await db.query('select id,continuity_key from voice_characters where workflow_id=$1 and character_name=$2', [options.workflowId, options.characterName])).rows
    .filter(identity => typeof identity.continuity_key === 'string')
  const stableKey = stableVoiceContinuityKey({ name: options.characterName, continuityKey: options.visualKey })
  const chosen = identities.find(identity => identity.continuity_key === stableKey)
    ?? identities.find(identity => identity.continuity_key === options.visualKey)
    ?? (identities.length === 1 && stableKey === `voice:${options.characterName}` ? identities[0] : undefined)
  if (identities.length && !chosen && stableKey === `voice:${options.characterName}`) throw Error('VOICE_IDENTITY_AMBIGUOUS: 同一人物有多个既有音色身份，请明确保留voiceContinuityKey，不随机创建新声音')
  return chosen ? String(chosen.continuity_key) : undefined
}

export async function characterVoiceIdentity(db: Pool | PoolClient, assetId: string) {
  if (assetId.startsWith('narrator:')) {
    const workflowId = assetId.slice('narrator:'.length)
    const workflow = await db.query('select id from workflow_configs where id=$1', [workflowId])
    if (!workflow.rowCount) throw Error('旁白所属工作流不存在')
    const identity = await db.query(`insert into voice_characters(id,workflow_id,continuity_key,character_name)
      values($1,$2,'__narrator__','旁白') on conflict(workflow_id,continuity_key) do update set character_name='旁白' returning *`, [randomUUID(), workflowId])
    return { identity: identity.rows[0], asset: { id: assetId, workflow_id: workflowId, character_name: '旁白', asset_type: 'narrator', uri: '', prompt: '' } }
  }
  const result = await db.query("select * from character_assets where id=$1 and asset_type='three-view'", [assetId])
  const asset = result.rows[0]
  if (!asset) throw Error('人物不存在')
  const preserved = await preservedCharacterVoiceIdentity(db, asset.workflow_id ?? '', String(asset.character_name), asset.metadata?.voiceContinuityKey)
  if (preserved) return { identity: preserved, asset }
  const visualKey = String(asset.metadata?.continuityKey || asset.id)
  if (asset.metadata?.visualContext) {
    const originalCharacterId = asset.metadata?.originalVoice?.characterId
    const retained = await existingCharacterVoiceContinuityKey(db, { workflowId: asset.workflow_id ?? '', characterName: String(asset.character_name), visualKey,
      ...(typeof originalCharacterId === 'string' ? { originalCharacterId } : {}) })
    if (retained) {
      const identity = await preservedCharacterVoiceIdentity(db, asset.workflow_id ?? '', String(asset.character_name), retained)
      if (identity) return { identity, asset }
    }
  }
  const key = stableVoiceContinuityKey({ name: String(asset.character_name), continuityKey: visualKey })
  if (key === '__narrator__') throw Error('VOICE_BINDING_INVALID: 此连续性标识保留给工作流旁白，请为人物使用其他标识')
  const identity = await db.query(`insert into voice_characters(id,workflow_id,continuity_key,character_name)
    values($1,$2,$3,$4) on conflict(workflow_id,continuity_key) do update set character_name=excluded.character_name returning *`,
  [randomUUID(), asset.workflow_id ?? '', key, asset.character_name])
  return { identity: identity.rows[0], asset }
}

export async function readCharacterVoice(db: Pool, assetId: string) {
  const { identity } = await characterVoiceIdentity(db, assetId)
  const versions = await db.query('select binding from character_voice_versions where character_id=$1 order by version desc', [identity.id])
  const jobs = await db.query('select id,kind,status,task_id,error,output,created_at,model_id as "modelId" from character_voice_jobs where character_asset_id=$1 order by created_at desc limit 10', [assetId])
  const availability = await db.query('select version,enabled,reason from character_voice_availability where character_id=$1 order by version desc', [identity.id])
  return { characterId: identity.id, current: versions.rows[0]?.binding ?? null, versions: versions.rows.map(r => r.binding), jobs: jobs.rows, availability: availability.rows }
}

export async function setCharacterVoiceAvailability(db: Pool, assetId: string, version: number, enabled: boolean, reason: string) {
  if (!Number.isInteger(version) || version < 1 || typeof enabled !== 'boolean' || typeof reason !== 'string' || !reason.trim() || reason.length > 1000) throw Error('VOICE_BINDING_INVALID: 请选择声音版本并填写 1–1000 字原因')
  const { identity } = await characterVoiceIdentity(db, assetId)
  const exists = await db.query('select 1 from character_voice_versions where character_id=$1 and version=$2', [identity.id, version])
  if (!exists.rowCount) throw Error('VOICE_BINDING_INVALID: 声音版本不存在')
  await db.query(`insert into character_voice_availability(character_id,version,enabled,reason) values($1,$2,$3,$4)
    on conflict(character_id,version) do update set enabled=excluded.enabled,reason=excluded.reason,updated_at=now()`, [identity.id, version, enabled, reason.trim()])
  return { version, enabled, reason: reason.trim() }
}

/** Run after task recovery has resolved: stopped assets still permit querying
 * tasks already submitted, but never authorize a replacement generation. */
export async function assertVoiceSynthesisAllowed(db: Pool, params: Record<string, unknown>) {
  if (typeof params.resumeTaskId === 'string' && params.resumeTaskId.trim()) return
  if (!Array.isArray(params.characterVoices) || !params.characterVoices.length) return
  const voices = params.characterVoices as CharacterVoice[]
  const blocked = await db.query(`select a.character_id,a.version,a.reason from character_voice_availability a
    join jsonb_to_recordset($1::jsonb) as v("characterId" text,version integer) on v."characterId"=a.character_id and v.version=a.version
    where not a.enabled`, [JSON.stringify(voices)])
  if (blocked.rows.length) throw Error(`VOICE_ASSET_UNAVAILABLE: ${blocked.rows.map(r => `${voices.find(v => v.characterId === r.character_id)?.characterName ?? r.character_id} V${r.version}（${r.reason}）`).join('；')} 已停用。旧视频仍可查看；请恢复可用状态或创建采用新声音的执行分支`)
}

/** Read existing evidence only. Changing the default never upgrades these snapshots. */
export async function readCharacterVoiceImpact(db: Pool, assetId: string) {
  const { identity } = await characterVoiceIdentity(db, assetId)
  const match = JSON.stringify([{ characterId: identity.id }])
  const [executions, shots] = await Promise.all([
    db.query(`select execution_id, manifest, count(*) over()::int as total
      from execution_voice_manifests where workflow_id=$1 and manifest->'characters' @> $2::jsonb
      order by created_at desc,execution_id limit 100`, [identity.workflow_id, match]),
    db.query(`select id, node_name, status, task_id, created_at,
      request_data->>'requestKey' as request_key,
      request_data->'params'->'voiceManifest'->>'executionId' as execution_id,
      request_data->'params'->'characterVoices' as voices, count(*) over()::int as total
      from model_execution_records where workflow_id=$1 and capability='video'
      and request_data->'params'->'characterVoices' @> $2::jsonb
      order by created_at desc,id limit 100`, [identity.workflow_id, match]),
  ])
  const version = (voices: CharacterVoice[]) => voices.find(v => v.characterId === identity.id)?.version
  return {
    executionCount: executions.rows[0]?.total ?? 0,
    requestCount: shots.rows[0]?.total ?? 0,
    executions: executions.rows.map(r => ({ executionId: r.execution_id, version: version(r.manifest.characters) })),
    requests: shots.rows.map(r => ({ id: r.id, executionId: r.execution_id, requestKey: r.request_key,
      nodeName: r.node_name, taskId: r.task_id, status: r.status, version: version(r.voices), createdAt: r.created_at })),
  }
}

export async function listProviderVoices(model: ExternalModelConfig, page = 1) {
  const values = await Promise.all(['presets-voices', 'custom-voices'].map(route => callKlingAsset(model, `${route}?pageNum=${page}&pageSize=30`)))
  return values.flatMap(extractKlingVoices)
}

/** Reserve a durable ID before sending any remote asset creation request. */
export async function submitVoiceJob(db: Pool, model: ExternalModelConfig, assetId: string | null, kind: 'custom' | 'element', input: Record<string, unknown>, local: Record<string, unknown> = {}) {
  const id = randomUUID(), account = voiceAccountScope(model)
  const body = { ...input, external_task_id: id }
  await db.query(`insert into character_voice_jobs(id,character_asset_id,model_id,account_scope,kind,status,input)
    values($1,$2,$3,$4,$5,'submitting',$6)`, [id, assetId, model.id, account, kind, JSON.stringify({ ...body, ...local })])
  try {
    const output = await callKlingAsset(model, kind === 'custom' ? 'custom-voices' : 'advanced-custom-elements', body)
    const data = output.data as { task_id?: string; task_status?: string }
    if (!data?.task_id) throw Error('供应商未返回任务 ID，需按外部任务 ID 查询，不能重复创建')
    await db.query("update character_voice_jobs set task_id=$2,status='processing',output=$3,updated_at=now() where id=$1", [id, data.task_id, JSON.stringify(output)])
    return { id, status: 'processing' }
  } catch (error) {
    if (error instanceof KlingAssetRejectedError) {
      await db.query("update character_voice_jobs set status='failed',error=$2,updated_at=now() where id=$1", [id, error.message])
      throw error
    }
    await db.query("update character_voice_jobs set status='uncertain',error=$2,updated_at=now() where id=$1", [id, String(error)])
    throw new Error(`声音任务 ${id} 提交结果不确定，请恢复查询：${String(error)}`, { cause: error })
  }
}

export async function createCharacterElement(db: Pool, model: ExternalModelConfig, assetId: string, voice: { voiceId: string; voiceName: string; previewUrl: string; originalVoiceId?: string }) {
  const { asset, identity } = await characterVoiceIdentity(db, assetId)
  if (asset.asset_type === 'narrator' && model.settings.model !== 'kling-v2-6') throw Error('VOICE_PROVIDER_UNSUPPORTED: 旁白请选择配置为 kling-v2-6 的视频服务；生成要求 pro 1080P、首帧及 5 或 10 秒。不能把旁白绑定为画内人物主体')
  if (!voice.voiceId || !voice.previewUrl) throw Error('请先选择并试听有效音色')
  // Validate against this account's provider assets, never accept an arbitrary ID as confirmed.
  let found = false
  for (let page = 1; page <= 34 && !found; page++) {
    const voices = await listProviderVoices(model, page)
    found = voices.some(v => v.voiceId === voice.voiceId && v.previewUrl === voice.previewUrl)
    if (voices.length < 30) break
  }
  if (!found) throw Error('VOICE_ASSET_UNAVAILABLE: 当前账户没有该音色，请刷新音色库')
  if (asset.asset_type === 'narrator') return saveNarratorVoiceVersion(db, identity.id, model, voice)
  await validateThreeViewReference(String(asset.uri))
  const panels = await extractAllThreeViewReferences(String(asset.uri))
  const input = {
    element_name: Array.from(String(asset.character_name)).slice(0, 20).join(''),
    element_description: Array.from(String(asset.prompt || asset.character_name)).slice(0, 100).join(''),
    reference_type: 'image_refer', element_voice_id: voice.voiceId, tag_list: [{ tag_id: 'o_102' }],
    element_image_list: { frontal_image: panels[0].replace(/^data:image\/[^;]+;base64,/, ''), refer_images: panels.slice(1, 2).map(image_url => ({ image_url: image_url.replace(/^data:image\/[^;]+;base64,/, '') })) },
  }
  const job = await submitVoiceJob(db, model, assetId, 'element', input, { binding: { ...voice, characterId: identity.id, characterName: asset.character_name,
    referenceHash: createHash('sha256').update(panels.join('')).digest('hex'), modelId: model.id, accountScope: voiceAccountScope(model) } })
  return job
}

/** Voice-only narrator identity has no portrait, element creation, or visual role. */
export async function saveNarratorVoiceVersion(db: Pool, characterId: string, model: ExternalModelConfig, voice: { voiceId: string; voiceName: string; previewUrl: string }) {
  if (model.settings.model !== 'kling-v2-6') throw Error('VOICE_PROVIDER_UNSUPPORTED: 旁白声音需要已配置的 Kling 2.6 服务')
  const client = await db.connect()
  try {
    await client.query('begin')
    const identity = (await client.query("update voice_characters set current_version=current_version+1 where id=$1 and continuity_key='__narrator__' returning current_version", [characterId])).rows[0]
    if (!identity) throw Error('VOICE_BINDING_INVALID: 旁白身份不存在')
    const binding: CharacterVoice = { ...voice, characterId, characterName: '旁白', version: identity.current_version, modelId: model.id, accountScope: voiceAccountScope(model) }
    await client.query('insert into character_voice_versions(character_id,version,binding) values($1,$2,$3)', [characterId, binding.version, JSON.stringify(binding)])
    await client.query('commit')
    return { status: 'succeeded', binding }
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
}

export async function refreshVoiceJob(db: Pool, model: ExternalModelConfig, id: string, callAsset = callKlingAsset) {
  const row = (await db.query('select * from character_voice_jobs where id=$1', [id])).rows[0]
  if (!row || row.model_id !== model.id || row.account_scope !== voiceAccountScope(model)) throw Error('声音任务不存在或账户已改变')
  if (['succeeded', 'failed'].includes(row.status)) return row
  const route = row.kind === 'custom' ? 'custom-voices' : 'advanced-custom-elements'
  const output = await callAsset(model, `${route}/${encodeURIComponent(row.task_id ?? row.id)}`)
  const data = output.data as { task_status?: string; task_status_msg?: string; task_result?: { elements?: Array<{ element_id: string; element_voice_info?: { voice_id: string } }> } }
  const status = data?.task_status === 'succeed' ? 'succeeded' : data?.task_status === 'failed' ? 'failed' : 'processing'
  const client = await db.connect()
  try {
    await client.query('begin')
    const locked = (await client.query('select status from character_voice_jobs where id=$1 for update', [id])).rows[0]
    if (locked.status === 'succeeded') { await client.query('commit'); return (await db.query('select * from character_voice_jobs where id=$1', [id])).rows[0] }
    if (status === 'succeeded' && row.kind === 'element') {
      const binding = row.input.binding
      const element = data.task_result?.elements?.[0]
      if (!binding || !element?.element_id || element.element_voice_info?.voice_id !== binding.voiceId) throw Error('VOICE_BINDING_INVALID: 返回主体未绑定选定声音')
      const identity = (await client.query('update voice_characters set current_version=current_version+1 where id=$1 returning current_version', [binding.characterId])).rows[0]
      await client.query('insert into character_voice_versions(character_id,version,binding) values($1,$2,$3)', [binding.characterId, identity.current_version,
        JSON.stringify({ ...binding, version: identity.current_version, elementId: String(element.element_id) })])
    }
    await client.query('update character_voice_jobs set status=$2,output=$3,error=$4,updated_at=now() where id=$1', [id, status, JSON.stringify(output), data.task_status_msg ?? null])
    await client.query('commit')
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  return { id, status, output }
}

function selectRequiredVoiceBindings(candidates: CharacterVoice[], requiredNames: string[], preferredCharacterIds: string[] = []): CharacterVoice[] {
  const preferred = new Set(preferredCharacterIds)
  return [...new Set(requiredNames)].map(name => {
    const matches = candidates.filter(v => v.characterName === name || v.characterId === name)
    const referenced = matches.filter(v => preferred.has(v.characterId))
    if (referenced.length === 1) return referenced[0]
    if (referenced.length > 1 || matches.length > 1) throw Error(`VOICE_IDENTITY_AMBIGUOUS: ${name}`)
    if (!matches.length) throw Error(`VOICE_BINDING_MISSING: ${name}`)
    return matches[0]
  })
}

export async function lockExecutionVoices(db: Pool, executionId: string, workflowId: string, requiredNames: string[] = [], preferredCharacterIds: string[] = []): Promise<VoiceManifest> {
  const saved = (await db.query('select manifest,workflow_id from execution_voice_manifests where execution_id=$1', [executionId])).rows[0]
  if (saved) {
    if (saved.workflow_id !== workflowId) throw Error('VOICE_BINDING_INVALID: 执行声音快照所属工作流不一致')
    const missingNames = requiredNames.filter(name => !saved.manifest.characters.some((v: CharacterVoice) => v.characterName === name || v.characterId === name))
    if (!missingNames.length) return saved.manifest
    // A later scene can introduce a previously unknown actor. Append that actor;
    // never reread or replace any identity that this execution already locked.
    const additions = await db.query(`select v.binding || jsonb_build_object('characterName',c.character_name) as binding from voice_characters c join character_voice_versions v
      on v.character_id=c.id and v.version=c.current_version where c.workflow_id=$1 and c.character_name=any($2::text[])`, [workflowId, missingNames])
    const selectedAdditions = selectRequiredVoiceBindings(additions.rows.map(r => r.binding), missingNames, preferredCharacterIds)
    resolveShotVoices({ ...saved.manifest, characters: selectedAdditions }, missingNames)
    const client = await db.connect()
    try {
      await client.query('begin')
      const current: VoiceManifest = (await client.query('select manifest from execution_voice_manifests where execution_id=$1 for update', [executionId])).rows[0].manifest
      const names = new Set(current.characters.map(v => v.characterName))
      const appended = selectedAdditions.filter(v => !names.has(v.characterName))
      const next: VoiceManifest = { ...current, characters: [...current.characters, ...appended] }
      resolveShotVoices(next, requiredNames)
      await client.query('update execution_voice_manifests set manifest=$2 where execution_id=$1', [executionId, JSON.stringify(next)])
      await client.query('commit')
      return next
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  }
  const versions = await db.query(`select v.binding || jsonb_build_object('characterName',c.character_name) as binding from voice_characters c join character_voice_versions v
    on v.character_id=c.id and v.version=c.current_version where c.workflow_id=$1`, [workflowId])
  const candidates = versions.rows.map(r => r.binding as CharacterVoice)
  const selected = requiredNames.length ? selectRequiredVoiceBindings(candidates, requiredNames, preferredCharacterIds) : candidates
  const manifest: VoiceManifest = { version: 'character-voice-v1', executionId, characters: selected }
  resolveShotVoices(manifest, requiredNames)
  const stored = await db.query(`insert into execution_voice_manifests(execution_id,workflow_id,manifest) values($1,$2,$3)
    on conflict(execution_id) do update set execution_id=excluded.execution_id returning manifest`, [executionId, workflowId, JSON.stringify(manifest)])
  return stored.rows[0].manifest
}

/** Bailian may vary a Voice Design voice between otherwise identical synthesis
 * requests when seed=0.  Derive one stable, non-zero seed from the archived
 * narrator identity so every shot using that asset shares the same synthesis
 * profile. */
export function narratorSynthesisSeed(characterId: string, voiceId: string) {
  const value = createHash('sha256').update(`narrator-synthesis-v1:${characterId}:${voiceId}`).digest().readUInt16BE(0)
  return value || 1
}

export async function bindVideoVoices<T extends { model: ExternalModelConfig; params: Record<string, unknown>; executionContext?: { voiceExecutionId?: string; voicePolicy?: string; workflowId?: string; knownVoiceSpeakers?: string[] } }>(db: Pool, request: T): Promise<T> {
  if (request.model.capability !== 'video' || request.executionContext?.voicePolicy !== 'strict') return request
  const allNames = voiceSpeakers(request.params)
  const anonymous = anonymousVoiceRoles(request.params)
  const nativeGroups = nativeGroupVoicePlan(request.params)
  const nativeNames = new Set(nativeGroups.map(group => group.name))
  const names = allNames.filter(name => !nativeNames.has(name))
  const namedConflict = names.filter(name => !anonymous.some(role => role.name === name))
    .map(name => speechStagingConflict(request.params, name)).find(Boolean)
  if (namedConflict) throw Error(`${namedConflict.code}: ${namedConflict.reason}`)
  const withNativeGroups = (bound: T): T => {
    if (!nativeGroups.length) return bound
    const params = { ...bound.params }
    delete params.narrationVoice
    delete params.offscreenDialogueVoice
    return { ...bound, params: { ...params, nativeGroupVoices: nativeGroups, voiceConsistency: {
      status: 'uncertain', method: 'manual-review-pending', qualityDisposition: 'manual-review-v1', bindingScope: names.length ? 'named-characters-only' : 'none',
      nativeGroupVoices: nativeGroups, speechVerified: false, lipSyncVerified: false,
      reason: `${names.length ? `具名人物${names.join('、')}继续使用已锁定音色；` : ''}群体${nativeGroups.map(group => group.name).join('、')}使用原生声音，未锁定群体音色，台词、声音和口型等待人工复核`,
    } } }
  }
  if (nativeGroups.length) {
    if (!request.executionContext.voiceExecutionId || !request.executionContext.workflowId) throw Error('VOICE_BINDING_INVALID: 原生群体对白缺少可追踪执行身份')
    if (request.model.provider !== 'Kling' || (request.params.sound ?? request.model.settings.sound) !== 'on'
      || !/^kling-v3(?:$|-)/.test(String(request.params.model_name ?? request.params.modelName ?? request.model.settings.model ?? 'kling-v3'))) throw Error('VOICE_PROVIDER_UNSUPPORTED: 原生群体对白需要开启 Kling 3 原生声音')
    if (!names.length) return withNativeGroups({ ...request, params: { ...request.params, characterVoices: [],
      voiceManifest: { version: 'native-group-voice-v1', executionId: request.executionContext.voiceExecutionId, characters: [], bindingScope: 'none' } } })
  }
  if (anonymous.length && !nativeGroups.length) {
    const conflict = anonymous.find(role => role.stagingConflict)?.stagingConflict
    if (conflict) throw Error(`${conflict.code}: ${conflict.reason}`)
    if (anonymous.length !== 1 || names.length !== 1 || names[0] !== anonymous[0].name || !anonymous[0].offscreen) throw Error('VOICE_PROVIDER_UNSUPPORTED: 匿名角色固定音色目前只支持单一明确画外对白；不得把画内对白或混合声部静默改为旁白')
    const role = anonymous[0]
    const executionId = request.executionContext.voiceExecutionId, workflowId = request.executionContext.workflowId
    if (!executionId || !workflowId) throw Error('VOICE_BINDING_INVALID: 画外角色对白缺少执行身份')
    const assets = Array.isArray(request.params.voiceAssets) ? request.params.voiceAssets.filter(asset => asset?.audioRole === 'offscreen-dialogue'
      && asset.continuityKey === role.continuityKey && asset.characterName === role.name && asset.actorGroupId === role.actorGroupId) : []
    if (assets.length !== 1) throw Error(`VOICE_BINDING_MISSING: ${role.name} 缺少同一源场景角色的已归档画外音色`)
    const asset = assets[0]
    const prior = (await db.query(`select m.workflow_id,m.binding from execution_original_voice_manifests m
      join voice_characters c on c.id=m.character_id where m.execution_id=$1 and c.continuity_key=$2`, [executionId, role.continuityKey])).rows[0]
    let binding: Record<string, unknown>
    if (prior) {
      binding = { ...prior.binding }
      if (prior.workflow_id !== workflowId || binding.continuityKey !== role.continuityKey || binding.characterName !== role.name
        || binding.synthesisSeed !== narratorSynthesisSeed(String(binding.characterId), String(binding.voiceId))) throw Error('VOICE_BINDING_INVALID: 已锁定画外角色的身份或合成配置不一致')
    } else {
      const saved = (await db.query(`select v.*,c.character_name from original_character_voices v join voice_characters c on c.id=v.character_id
        where c.workflow_id=$1 and c.continuity_key=$2 and v.status='ready'`, [workflowId, role.continuityKey])).rows[0]
      if (!saved || asset.characterId !== saved.character_id || asset.voiceId !== saved.voice_id || asset.accountScope !== saved.account_scope
        || asset.modelId !== saved.model_id || asset.targetModel !== saved.target_model || saved.character_name !== role.name) throw Error('VOICE_BINDING_INVALID: 画外角色引用与已归档原创声音不一致')
      binding = { characterId: saved.character_id, characterName: role.name, continuityKey: role.continuityKey,
        voiceId: saved.voice_id, modelId: saved.model_id, accountScope: saved.account_scope, targetModel: saved.target_model,
        version: 1, audioRole: 'offscreen-dialogue', synthesisSeed: narratorSynthesisSeed(saved.character_id, saved.voice_id) }
      await db.query('insert into execution_original_voice_manifests(execution_id,character_id,workflow_id,binding) values($1,$2,$3,$4) on conflict(execution_id,character_id) do nothing', [executionId, binding.characterId, workflowId, binding])
      const locked = (await db.query('select binding from execution_original_voice_manifests where execution_id=$1 and character_id=$2', [executionId, binding.characterId])).rows[0]?.binding
      if (locked) binding = locked
    }
    const params = { ...request.params }
    delete params.characterVoices
    delete params.narrationVoice
    return { ...request, params: { ...params, offscreenDialogueVoice: binding,
      voiceManifest: { version: 'original-offscreen-dialogue-v1', executionId, characters: [binding] },
      voiceConsistency: { status: 'uncertain', reason: `已锁定画外角色${role.name}的原创音色与完整对白，等待成片听审` } } }
  }
  if (names.includes('旁白') && Array.isArray(request.params.voiceAssets) && request.params.voiceAssets.some(asset => asset?.audioRole === 'narration')) {
    if (names.length !== 1) throw Error('NARRATION_ROUTE_UNSUPPORTED: 混合画内对白和画外旁白尚未接入独立混音，请拆分声部节点')
    const executionId = request.executionContext.voiceExecutionId, workflowId = request.executionContext.workflowId
    if (!executionId || !workflowId) throw Error('VOICE_BINDING_INVALID: 旁白缺少执行身份')
    const assets = request.params.voiceAssets.filter(asset => asset?.audioRole === 'narration')
    if (assets.length !== 1) throw Error('VOICE_BINDING_INVALID: 旁白音色资产必须唯一')
    const asset = assets[0]
    const prior = (await db.query(`select m.workflow_id,m.binding from execution_original_voice_manifests m
      join voice_characters c on c.id=m.character_id
      where m.execution_id=$1 and c.continuity_key='__narrator__'`, [executionId])).rows[0]
    let binding: Record<string, unknown>
    if (prior) {
      if (prior.workflow_id !== workflowId) throw Error('VOICE_BINDING_INVALID: 本次执行已锁定其他工作流的旁白')
      binding = { ...prior.binding }
      const expectedSeed = narratorSynthesisSeed(String(binding.characterId), String(binding.voiceId))
      if (binding.synthesisSeed === undefined) {
        binding.synthesisSeed = expectedSeed
        await db.query(`update execution_original_voice_manifests set binding=$3
          where execution_id=$1 and character_id=$2`, [executionId, binding.characterId, binding])
      } else if (binding.synthesisSeed !== expectedSeed) throw Error('VOICE_BINDING_INVALID: 执行旁白合成配置已被篡改')
    } else {
      const saved = (await db.query(`select v.*,c.character_name from original_character_voices v join voice_characters c on c.id=v.character_id where c.workflow_id=$1 and c.continuity_key='__narrator__' and v.status='ready'`, [workflowId])).rows[0]
      if (!saved || asset.characterId !== saved.character_id || asset.voiceId !== saved.voice_id || asset.accountScope !== saved.account_scope || asset.modelId !== saved.model_id || asset.targetModel !== saved.target_model) throw Error('VOICE_BINDING_INVALID: 旁白引用与已归档原创声音不一致')
      binding = { characterId: saved.character_id, characterName: '旁白', voiceId: saved.voice_id, modelId: saved.model_id,
        accountScope: saved.account_scope, targetModel: saved.target_model, synthesisSeed: narratorSynthesisSeed(saved.character_id, saved.voice_id) }
      await db.query('insert into execution_original_voice_manifests(execution_id,character_id,workflow_id,binding) values($1,$2,$3,$4)', [executionId, binding.characterId, workflowId, binding])
    }
    return { ...request, params: { ...request.params, narrationVoice: binding, voiceManifest: { version: 'original-narration-v2', executionId, characters: [binding] }, voiceConsistency: { status: 'uncertain', reason: '已锁定原创旁白音色与合成配置，等待成片听审' } } }
  }
  const known = request.executionContext.knownVoiceSpeakers ?? []
  if (!Array.isArray(known) || known.some(name => typeof name !== 'string' || !name.trim() || name.includes('${'))) throw Error('VOICE_BINDING_INVALID: 已知说话人预检清单无效')
  let requiredNames = [...new Set([...names, ...known.filter(name => !nativeNames.has(name))])]
  if (!requiredNames.length) return request
  const executionId = request.executionContext.voiceExecutionId, workflowId = request.executionContext.workflowId
  if (!executionId || !workflowId) throw Error('VOICE_BINDING_INVALID: 缺少执行身份，不能锁定音色')
  const preferredCharacterIds = Array.isArray(request.params.voiceAssets)
    ? request.params.voiceAssets.map(asset => asset?.characterId).filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
    : []
  const alreadyLocked = (await db.query('select 1 from execution_voice_manifests where execution_id=$1', [executionId])).rowCount !== 0
  // Later unknown speakers are appended when encountered. A changed future
  // plan must not prevent querying an already-submitted earlier shot.
  if (alreadyLocked) requiredNames = names
  const manifest = await lockExecutionVoices(db, executionId, workflowId, requiredNames, preferredCharacterIds)
  if (!alreadyLocked) await assertVoiceSynthesisAllowed(db, { characterVoices: resolveShotVoices(manifest, requiredNames) })
  if (!names.length) return request
  const voices: CharacterVoice[] = resolveShotVoices(manifest, names)
  const preservedLocks: string[] = []
  if (request.params.voiceAssets !== undefined) {
    if (!Array.isArray(request.params.voiceAssets)) throw Error('VOICE_BINDING_INVALID: 视频人物音色资产参考必须为数组')
    for (const voice of voices) {
      const asset = request.params.voiceAssets.find((v: { characterId?: string }) => v?.characterId === voice.characterId)
      const binding = asset?.videoBinding
      if (asset && binding && asset.voiceId === (voice as CharacterVoice & { originalVoiceId?: string }).originalVoiceId && binding.voiceId === voice.voiceId && binding.elementId === voice.elementId && binding.version === voice.version && binding.accountScope === voice.accountScope) continue

      // A portrait-quality repair advances the visual continuity key and can
      // therefore supply a newer character/element asset for the same named
      // actor.  That must never mutate or invalidate an execution's immutable
      // voice snapshot.  Confirm the supplied asset really belongs to the same
      // workflow + actor, then deliberately keep the frozen binding.  Unknown
      // or cross-workflow assets still fail closed.
      const referencedIds = request.params.voiceAssets
        .map((value: { characterId?: unknown }) => value?.characterId)
        .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
      const sameActor = referencedIds.length ? await db.query(`select 1 from voice_characters
        where id=any($1::text[]) and workflow_id=$2 and character_name=$3 limit 1`, [referencedIds, workflowId, voice.characterName]) : { rowCount: 0 }
      if (!sameActor.rowCount) throw Error(`VOICE_BINDING_INVALID: ${voice.characterName} 的音色资产参考与执行锁定版本不一致`)
      preservedLocks.push(voice.characterName)
    }
  }
  if (request.model.provider !== 'Kling' || voices.some(v => v.accountScope !== voiceAccountScope(request.model))) throw Error('VOICE_PROVIDER_UNSUPPORTED: 当前视频供应商或账户与已绑定音色不一致')
  const reason = preservedLocks.length
    ? `人物视觉资产已更新；本执行继续使用已锁定音色（${preservedLocks.join('、')}），等待成片听审`
    : '已锁定输入音色；等待成片听审'
  return withNativeGroups({ ...request, params: { ...request.params, characterVoices: voices, voiceManifest: { ...manifest, characters: voices }, voiceConsistency: { status: 'uncertain', reason } } })
}

export async function readVoiceListeningReview(db: Pool, target: VoiceReviewTarget): Promise<VoiceListeningReview | null> {
  const id = createHash('sha256').update(voiceReviewIdentity(target)).digest('hex')
  return (await db.query('select review from voice_listening_reviews where id=$1', [id])).rows[0]?.review ?? null
}

export async function previewVoiceUpgrade(db: Pool | PoolClient, sourceId: string, characterIds: string[]) {
  if (!Array.isArray(characterIds) || !characterIds.length || characterIds.some(id => typeof id !== 'string')) throw Error('VOICE_BINDING_INVALID: 请选择换声人物')
  const source = (await db.query('select workflow_id,manifest from execution_voice_manifests where execution_id=$1', [sourceId])).rows[0]
  if (!source) throw Error('VOICE_BINDING_MISSING: 原执行没有声音快照，请按原参数创建完整新执行')
  const manifest = source.manifest as VoiceManifest
  const ids = new Set(characterIds)
  if ([...ids].some(id => !manifest.characters.some(v => v.characterId === id))) throw Error('VOICE_BINDING_INVALID: 换声人物不在原执行快照中')
  const latest = await db.query(`select v.binding,a.enabled from voice_characters c join character_voice_versions v on v.character_id=c.id and v.version=c.current_version
    left join character_voice_availability a on a.character_id=v.character_id and a.version=v.version where c.id=any($1::text[])`, [[...ids]])
  const changes = [...ids].map(id => {
    const from = manifest.characters.find(v => v.characterId === id)!
    const to = latest.rows.map(r => r.binding as CharacterVoice).find(v => v.characterId === id)
    if (!to) throw Error(`VOICE_BINDING_MISSING: ${from.characterName}`)
    if (latest.rows.find(r => r.binding.characterId === id)?.enabled === false) throw Error(`VOICE_ASSET_UNAVAILABLE: ${from.characterName} 的当前声音版本已停用`)
    if (to.version === from.version) throw Error(`VOICE_BINDING_INVALID: ${from.characterName} 已使用当前版本；请先在人物库绑定新声音`)
    if (to.accountScope !== from.accountScope || to.modelId !== from.modelId) throw Error(`VOICE_PROVIDER_UNSUPPORTED: ${from.characterName} 的新声音更换了服务或账户，需要创建完整新执行`)
    return { from, to }
  })
  return { workflowId: source.workflow_id as string, manifest, changes }
}

/** User-selected upgrades get a new scope; the source row is never updated. */
export async function forkVoiceUpgrade(db: Pool, sourceId: string, targetId: string, expected: Array<{ characterId: string; version: number }>) {
  if (!targetId || targetId === sourceId || !Array.isArray(expected) || !expected.length) throw Error('VOICE_BINDING_INVALID: 换声必须创建新执行')
  const client = await db.connect()
  try {
    await client.query('begin isolation level repeatable read')
    const preview = await previewVoiceUpgrade(client, sourceId, expected.map(v => v.characterId))
    if (preview.changes.some(c => expected.find(v => v.characterId === c.to.characterId)?.version !== c.to.version)) throw Error('VOICE_BINDING_INVALID: 人物声音已更新，请重新检查换声范围')
    const manifest: VoiceManifest = { ...preview.manifest, executionId: targetId, characters: preview.manifest.characters.map(v => preview.changes.find(c => c.to.characterId === v.characterId)?.to ?? v) }
    await client.query('insert into execution_voice_manifests(execution_id,workflow_id,manifest) values($1,$2,$3)', [targetId, preview.workflowId, JSON.stringify(manifest)])
    await client.query('commit')
    return { manifest, changes: preview.changes }
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
}
export async function saveVoiceListeningReview(db: Pool, target: VoiceReviewTarget, status: unknown, note: unknown) {
  const id = createHash('sha256').update(voiceReviewIdentity(target)).digest('hex')
  if (!['passed','failed','uncertain'].includes(String(status)) || typeof note !== 'string' || !note.trim() || note.length > 2000) throw Error('VOICE_REVIEW_INVALID: 请选择听审结论并填写 1–2000 字记录')
  const review: VoiceListeningReview = { status: status as VoiceListeningReview['status'], note: note.trim(), reviewedAt: new Date().toISOString(), method: 'user-listening' }
  await db.query('insert into voice_listening_reviews(id,target,review) values($1,$2,$3) on conflict(id) do update set review=excluded.review', [id, JSON.stringify(target), JSON.stringify(review)])
  return review
}
