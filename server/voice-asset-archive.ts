import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { VoiceCandidate } from './voice-design-inference.ts'

export async function archiveVoiceCandidates(db: Pool, workflowId: string, candidates: VoiceCandidate[]) {
  if (!workflowId || !Array.isArray(candidates)) throw Error('VOICE_ARCHIVE_INPUT: 缺少工作流或音色候选')
  const client = await db.connect()
  try {
    await client.query('begin')
    const items = []
    for (const v of candidates) {
      if (v.contract !== 'voice-candidate-v2' || v.workflowId !== workflowId || !v.continuityKey || !v.characterName || !v.voiceId || !v.accountScope || !v.targetModel) throw Error('VOICE_ARCHIVE_INPUT: 音色候选身份不完整或工作流不一致')
      if ((v.continuityKey === '__narrator__') !== (v.characterName === '旁白')) throw Error('VOICE_ARCHIVE_INPUT: 旁白必须使用工作流专属的稳定声音身份')
      if (v.continuityKey.startsWith('anonymous-voice:') && (v.audioRole !== 'offscreen-dialogue' || !v.actorGroupId)) throw Error('VOICE_ARCHIVE_INPUT: 匿名声音必须声明真实群体与画外角色身份')
      const identity = (await client.query(`insert into voice_characters(id,workflow_id,continuity_key,character_name) values($1,$2,$3,$4)
        on conflict(workflow_id,continuity_key) do update set character_name=excluded.character_name returning id`, [randomUUID(), workflowId, v.continuityKey, v.characterName])).rows[0]
      await client.query(`insert into original_character_voices(character_id,model_id,account_scope,target_model,prefix,description,preview_text,status,voice_id,preview_url,provider_result)
        values($1,$2,$3,$4,$5,$6,$7,'ready',$8,$9,$10) on conflict(character_id) do nothing`, [identity.id, v.modelId, v.accountScope, v.targetModel, v.prefix, v.description, v.previewText, v.voiceId, v.previewUrl, v.providerResult])
      const saved = (await client.query('select * from original_character_voices where character_id=$1', [identity.id])).rows[0]
      if (saved.voice_id !== v.voiceId || saved.account_scope !== v.accountScope || saved.target_model !== v.targetModel) throw Error('VOICE_ARCHIVE_CONFLICT: 已有人物音色与候选不同，不能覆盖已有声音')
      items.push({ ...v, characterId: identity.id, status: 'ready' })
    }
    await client.query('commit')
    return { items, count: items.length, byCharacter: Object.fromEntries(items.map(v => [v.characterName, v])) }
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
}

export async function lookupArchivedVoices(db: Pool, workflowId: string, keys: string[]): Promise<VoiceCandidate[]> {
  if (!keys.length) return []
  const rows = (await db.query(`select v.*,c.workflow_id,c.continuity_key,c.character_name from original_character_voices v join voice_characters c on c.id=v.character_id where c.workflow_id=$1 and c.continuity_key=any($2::text[]) and v.status='ready'`, [workflowId, keys])).rows
  return rows.map(v => ({ contract: 'voice-candidate-v2', workflowId: v.workflow_id, continuityKey: v.continuity_key, characterName: v.character_name,
    modelId: v.model_id, accountScope: v.account_scope, targetModel: v.target_model, prefix: v.prefix, description: v.description,
    previewText: v.preview_text, voiceId: v.voice_id, previewUrl: v.preview_url, providerResult: v.provider_result, cached: true }))
}
