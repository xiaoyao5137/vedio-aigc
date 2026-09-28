import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ExternalModelConfig } from './model-adapters.ts'
import { buildVoiceDesignInput, callVoiceDesign, originalVoiceScope, persistVoicePreview } from './bailian-voice-design.ts'
import { characterVoiceDesignDescription } from '../src/voice-character-input.ts'

export type VoiceCandidate = {
  contract: 'voice-candidate-v2'; workflowId: string; continuityKey: string; characterName: string;
  modelId: string; accountScope: string; targetModel: string; prefix: string; description: string;
  previewText: string; voiceId: string; previewUrl: string | null; providerResult: unknown; cached: boolean;
  audioRole?: 'offscreen-dialogue'; actorGroupId?: string
}
type CharacterInput = { name?: string; characterName?: string; continuityKey?: string; description?: string; voiceProfile?: unknown; audioRole?: 'offscreen-dialogue'; actorGroupId?: string }
const previewText = '天色渐渐暗了下来，大家先坐下来，把今天发生的事情慢慢说清楚。'

/** Model inference only: no database dependency and no character/voice asset writes.
 * A transport journal retains provider receipts across interrupted HTTP calls. */
export async function inferCharacterVoices(model: ExternalModelConfig, prompt: string, params: Record<string, unknown>, dependencies: { root?: string; call?: typeof callVoiceDesign } = {}) {
  const workflowId = String(params.workflowId ?? '').trim()
  if (!workflowId || !Array.isArray(params.characters)) throw Error('VOICE_DESIGN_INPUT: 缺少工作流身份或人物数组')
  const scope = originalVoiceScope(model)
  const call = dependencies.call ?? callVoiceDesign
  const cached = Array.isArray(params.existingVoices) ? params.existingVoices as VoiceCandidate[] : []
  const items: VoiceCandidate[] = []
  for (const input of params.characters as Array<string | CharacterInput>) {
    const character = typeof input === 'string' ? { name: input } : input
    const name = String(character.name ?? character.characterName ?? '').trim()
    const key = String(character.continuityKey ?? '').trim()
    if (!name || !key) throw Error('VOICE_IDENTITY_AMBIGUOUS: 原创音色需要人物姓名及稳定连续性标识')
    if (items.some(v => v.continuityKey === key)) continue
    const prior = cached.find(v => v.workflowId === workflowId && v.continuityKey === key)
    if (prior) {
      if (prior.accountScope !== scope || prior.targetModel !== model.settings.model) throw Error('VOICE_DESIGN_SCOPE: 已归档音色属于其他 TTS 配置')
      if (!prior.voiceId) throw Error('VOICE_DESIGN_INPUT: 召回音色缺少供应商 ID')
      items.push({ ...prior, ...(character.audioRole ? { audioRole: character.audioRole, actorGroupId: character.actorGroupId } : {}), cached: true }); continue
    }
    const descriptions = params.voiceDescriptions as Record<string, unknown> | undefined
    const profiles = params.voiceProfiles as Record<string, unknown> | undefined
    const hash = createHash('sha256').update(`${workflowId}:${key}:${scope}:${model.settings.model}`).digest('hex')
    const prefix = `v${hash.slice(0,9)}`
    const dir = path.join(dependencies.root ?? process.cwd(), '.runtime/voice-inference')
    const journal = path.join(dir, `${hash}.json`)
    // Recover the exact paid request even when a newer casting policy would
    // require more information for a first create. A retry must not recast it.
    let previous: { request: { input: { voice_prompt: string } } } | undefined
    try { previous = JSON.parse(await readFile(journal, 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    let description = previous?.request.input.voice_prompt ?? characterVoiceDesignDescription(character, prompt, { description: descriptions?.[name], voiceProfile: profiles?.[name] })
    const request = buildVoiceDesignInput(model, description, previewText, prefix)
    await mkdir(dir, { recursive: true })
    let receipt: Awaited<ReturnType<typeof callVoiceDesign>> | undefined
    let claimed = false
    try { await writeFile(journal, JSON.stringify({ status: 'submitting', request }), { flag: 'wx' }); claimed = true }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    if (claimed) {
      receipt = await call(model, request)
      if (!receipt.output?.voice_id) throw Error('VOICE_DESIGN_UNCERTAIN: 未收到创建回执，请恢复查询，不重复创建')
      await writeFile(journal, JSON.stringify({ status: 'created', request, receipt }))
    } else {
      const saved = JSON.parse(await readFile(journal, 'utf8'))
      description = saved.request.input.voice_prompt
      receipt = saved.receipt
      if (!receipt?.output?.voice_id) {
        const result = await call(model, { model: 'voice-enrollment', input: { action: 'list_voice', prefix, page_index: 0, page_size: 100 } })
        const matches = (result.output?.voice_list ?? []).filter(v => v.voice_id.startsWith(`${model.settings.model}-vd-${prefix}-`))
        if (matches.length !== 1) throw Error('VOICE_DESIGN_UNCERTAIN: 原音色创建结果待确认；不会重复创建')
        receipt = { output: { voice_id: matches[0].voice_id } }
        await writeFile(journal, JSON.stringify({ status: 'created', request: saved.request, receipt }))
      }
    }
    const voiceId = receipt.output!.voice_id!
    const detail = await call(model, { model: 'voice-enrollment', input: { action: 'query_voice', voice_id: voiceId } })
    if (detail.output?.status !== 'OK') throw Error(`VOICE_DESIGN_PENDING: ${detail.output?.status ?? '处理中'}，继续查询原音色`)
    const preview = receipt.output?.preview_audio?.data
    items.push({ contract: 'voice-candidate-v2', workflowId, continuityKey: key, characterName: name, modelId: model.id, accountScope: scope,
      targetModel: model.settings.model, prefix, description, previewText, voiceId,
      previewUrl: preview ? await persistVoicePreview(preview, dependencies.root) : null, providerResult: receipt, cached: !claimed,
      ...(character.audioRole ? { audioRole: character.audioRole, actorGroupId: character.actorGroupId } : {}) })
  }
  return { items, count: items.length, generatedCount: items.filter(v => !v.cached).length, cachedCount: items.filter(v => v.cached).length }
}
