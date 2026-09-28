import { randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import { characterVoiceIdentity } from './character-voices.ts'
import type { ExternalModelConfig } from './model-adapters.ts'
import { buildVoiceDesignInput, callVoiceDesign, originalVoiceScope, persistVoicePreview } from './bailian-voice-design.ts'
import { characterVoiceDesignDescription } from '../src/voice-character-input.ts'

export const originalVoiceSchema = `create table if not exists original_character_voices (
 character_id text primary key references voice_characters(id), model_id text not null, account_scope text not null,
 target_model text not null, prefix text not null unique, description text not null, preview_text text not null,
 status text not null, voice_id text, preview_url text, provider_result jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);`
export const ORIGINAL_VOICE_PREVIEW = '天色渐渐暗了下来，大家先坐下来，把今天发生的事情慢慢说清楚。'

export async function ensureOriginalCharacterVoice(db: Pool, assetId: string, model: ExternalModelConfig, description: string, dependencies: { call?: typeof callVoiceDesign; root?: string } = {}) {
  const scope = originalVoiceScope(model)
  const { identity, asset } = await characterVoiceIdentity(db, assetId)
  const call = dependencies.call ?? callVoiceDesign
  const existing = (await db.query('select * from original_character_voices where character_id=$1', [identity.id])).rows[0]
  if (existing) {
    if (existing.account_scope !== scope || existing.target_model !== model.settings.model) throw Error('VOICE_DESIGN_SCOPE: 此人物已有其他账户或模型的原创音色，请使用原绑定 TTS；不会重复创建')
    if (existing.status === 'ready') return { ...publicOriginalVoice(existing), cached: true }
  }
  // The direct asset endpoint also requires a deliberate voice description;
  // keep legacy claims/receipts resumable without paying for another voice.
  if (!existing) description = characterVoiceDesignDescription({ name: identity.character_name, description: String(asset.prompt ?? '') }, '', { description })
  const prefix = `v${randomBytes(4).toString('hex')}`
  // Validate before claiming; the durable claim prevents a second create even after a crash.
  const input = buildVoiceDesignInput(model, existing?.description ?? description, existing?.preview_text ?? ORIGINAL_VOICE_PREVIEW, prefix)
  const claimed = await db.query(`insert into original_character_voices(character_id,model_id,account_scope,target_model,prefix,description,preview_text,status)
    values($1,$2,$3,$4,$5,$6,$7,'submitting') on conflict(character_id) do nothing returning *`, [identity.id, model.id, scope, model.settings.model, prefix, description, ORIGINAL_VOICE_PREVIEW])
  let row = claimed.rows[0] ?? (await db.query('select * from original_character_voices where character_id=$1', [identity.id])).rows[0]
  if (row.account_scope !== scope || row.target_model !== model.settings.model) throw Error('VOICE_DESIGN_SCOPE: 此人物已有其他账户或模型的原创音色，请使用原绑定 TTS；不会重复创建')
  if (row.status === 'ready') return { ...publicOriginalVoice(row), cached: true }
  if (claimed.rowCount) {
    const result = await call(model, input)
    if (!result.output?.voice_id) throw Error('VOICE_DESIGN_UNCERTAIN: 服务未返回音色 ID；保留创建记录，重试只查询已有音色')
    await db.query(`update original_character_voices set voice_id=$2,provider_result=$3,status='created',updated_at=now() where character_id=$1`, [identity.id, result.output.voice_id, result])
  } else if (!row.voice_id) {
    const result = await call(model, { model: 'voice-enrollment', input: { action: 'list_voice', prefix: row.prefix, page_index: 0, page_size: 100 } })
    const matches = (result.output?.voice_list ?? []).filter(v => v.voice_id.startsWith(`${row.target_model}-vd-${row.prefix}-`))
    if (matches.length !== 1) throw Error('VOICE_DESIGN_UNCERTAIN: 原创建仍待确认；没有重复创建音色，请稍后查询')
    await db.query(`update original_character_voices set voice_id=$2,status='created',updated_at=now() where character_id=$1`, [identity.id, matches[0].voice_id])
  }
  row = (await db.query('select * from original_character_voices where character_id=$1', [identity.id])).rows[0]
  const detail = await call(model, { model: 'voice-enrollment', input: { action: 'query_voice', voice_id: row.voice_id } })
  if (detail.output?.status !== 'OK') throw Error(`VOICE_DESIGN_PENDING: 原创音色 ${detail.output?.status ?? '待确认'}；再次运行只查询，不重复创建`)
  const previewData = row.provider_result?.output?.preview_audio?.data
  const previewUrl = previewData ? await persistVoicePreview(previewData, dependencies.root) : null
  row = (await db.query(`update original_character_voices set status='ready',preview_url=$2,updated_at=now() where character_id=$1 returning *`, [identity.id, previewUrl])).rows[0]
  return { ...publicOriginalVoice(row), cached: !claimed.rowCount }
}

export function publicOriginalVoice(row: Record<string, unknown>) {
  return { characterId: row.character_id, modelId: row.model_id, targetModel: row.target_model, voiceId: row.voice_id, description: row.description, previewText: row.preview_text, previewUrl: row.preview_url, status: row.status, source: 'voice-design', version: 1 }
}
