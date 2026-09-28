import type { Pool } from 'pg'
import type { ExternalModelConfig } from './model-adapters.ts'
import { characterVoiceIdentity, createCharacterElement, refreshVoiceJob, submitVoiceJob } from './character-voices.ts'
import { extractKlingVoices, voiceAccountScope } from './kling-voices.ts'
import { originalVoiceScope, voiceDesignEndpoint } from './bailian-voice-design.ts'

export async function ensureOriginalVideoVoice(db: Pool, assetId: string, tts: ExternalModelConfig, video: ExternalModelConfig) {
  if (video.provider !== 'Kling') throw Error('VOICE_PROVIDER_UNSUPPORTED: 当前原创声音的视频映射仅接入可灵')
  const { identity } = await characterVoiceIdentity(db, assetId)
  const original = (await db.query("select * from original_character_voices where character_id=$1 and status='ready'", [identity.id])).rows[0]
  if (!original) throw Error('VOICE_BINDING_MISSING: 人物原创音色尚未就绪')
  if (original.account_scope !== originalVoiceScope(tts) || original.target_model !== tts.settings.model) throw Error('VOICE_DESIGN_SCOPE: 请使用创建原创音色时的 TTS 配置')
  const account = voiceAccountScope(video)
  const binding = (await db.query(`select binding from character_voice_versions where character_id=$1 and binding->>'originalVoiceId'=$2 and binding->>'accountScope'=$3 order by version desc limit 1`, [identity.id, original.voice_id, account])).rows[0]?.binding
  if (binding) return { status: 'ready', binding, cached: true }
  const client = await db.connect()
  const lockKey = `original-video:${identity.id}:${account}`
  const locked = (await client.query('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [lockKey])).rows[0].locked
  if (!locked) { client.release(); return { status: 'processing' } }
  try {
    let custom = (await db.query(`select * from character_voice_jobs where kind='custom' and account_scope=$1 and input->>'originalVoiceId'=$2 order by created_at desc limit 1`, [account, original.voice_id])).rows[0]
    if (!custom) {
      let hosted = original.provider_result?.hostedSample
      if (!hosted || hosted.expiresAt * 1000 < Date.now() + 60000) {
        const endpoint = voiceDesignEndpoint(tts).replace('/customization', '/SpeechSynthesizer')
        const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${tts.settings.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: original.target_model, input: { text: original.preview_text + '我们都在这里，有什么难处，就一起商量办法。', voice: original.voice_id, format: 'wav', sample_rate: 24000 } }), signal: AbortSignal.timeout(120000) })
        const result = await response.json() as { output?: { audio?: { url?: string; expires_at?: number } }; code?: string }
        const audio = result.output?.audio
        if (!response.ok || !audio?.url || !audio.expires_at) throw Error(`VOICE_SAMPLE_FAILED: 原创音色样音生成失败，HTTP ${response.status}`)
        hosted = { url: audio.url, expiresAt: audio.expires_at }
        await db.query(`update original_character_voices set provider_result=jsonb_set(coalesce(provider_result,'{}'::jsonb),'{hostedSample}',$2::jsonb),updated_at=now() where character_id=$1`, [identity.id, JSON.stringify(hosted)])
      }
      await submitVoiceJob(db, video, assetId, 'custom', { voice_name: Array.from(`${identity.character_name}原创`).slice(0,20).join(''), voice_url: hosted.url }, { originalVoiceId: original.voice_id })
      custom = (await db.query(`select * from character_voice_jobs where kind='custom' and account_scope=$1 and input->>'originalVoiceId'=$2 order by created_at desc limit 1`, [account, original.voice_id])).rows[0]
    }
    if (!['succeeded','failed'].includes(custom.status)) {
      await refreshVoiceJob(db, video, custom.id)
      custom = (await db.query('select * from character_voice_jobs where id=$1', [custom.id])).rows[0]
    }
    if (custom.status === 'failed') throw Error(`VOICE_SAMPLE_FAILED: ${custom.error ?? '可灵原创声音映射失败'}`)
    if (custom.status !== 'succeeded') return { status: 'processing', jobId: custom.id }
    const voice = extractKlingVoices(custom.output)[0]
    if (!voice || voice.source !== 'custom') throw Error('VOICE_BINDING_INVALID: 可灵没有返回对应自定义声音')
    let element = (await db.query(`select * from character_voice_jobs where kind='element' and account_scope=$1 and input->'binding'->>'originalVoiceId'=$2 order by created_at desc limit 1`, [account, original.voice_id])).rows[0]
    if (!element) {
      await createCharacterElement(db, video, assetId, { ...voice, originalVoiceId: original.voice_id })
      element = (await db.query(`select * from character_voice_jobs where kind='element' and account_scope=$1 and input->'binding'->>'originalVoiceId'=$2 order by created_at desc limit 1`, [account, original.voice_id])).rows[0]
    }
    if (!['succeeded','failed'].includes(element.status)) await refreshVoiceJob(db, video, element.id)
    const saved = (await db.query(`select binding from character_voice_versions where character_id=$1 and binding->>'originalVoiceId'=$2 and binding->>'accountScope'=$3 order by version desc limit 1`, [identity.id, original.voice_id, account])).rows[0]?.binding
    if (saved) return { status: 'ready', binding: saved, cached: false }
    const state = (await db.query('select status,error from character_voice_jobs where id=$1', [element.id])).rows[0]
    if (state.status === 'failed') throw Error(`VOICE_BINDING_INVALID: ${state.error}`)
    return { status: 'processing', jobId: element.id }
  } finally { await client.query('select pg_advisory_unlock(hashtextextended($1,0))', [lockKey]); client.release() }
}
