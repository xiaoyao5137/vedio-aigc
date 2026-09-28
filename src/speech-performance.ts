import { anonymousVoiceRoles, explicitlyOffscreenSpeaker, speechStagingConflict } from './character-voice.ts'

type Value = Record<string, unknown>
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
const rows = (value: unknown): Value[] => Array.isArray(value) ? value.map(object) : []

export const STORYBOARD_SPEECH_STAGING_PROMPT = `【说话人与声画一致性】
每行audioText的说话人必须与对应speech.actorIds为同一人或同一已声明群体。画内人物实际开口讲述、宣示或应答时保持对白与可见同期表演，completion.modality=audio-visual；不能为规避匿名人物的音色或素材绑定困难，仅添加“画外”标签再删除同期声。只有本句声源确在画外且原义务不要求看见本人说话时，才可明确标注画外并使用audio完成；听众反应单列视觉节拍，不混写为说话者对口型。
匿名有词角色可在actorGroups对应项提供voiceProfile:{description,age,pitch,resonance,texture,delivery,genderPresentation,language}，只填角色资料或已确定选角支持的声线属性；设定必须与出镜角色一致，不根据泛称、衣服或默认TTS音色猜性别。允许明确的中性声线；无法确定时保留缺项，不能冒充已确定音色。已有角色音色保持同一版本，不用新描述覆盖历史声音。
不同人物接力说相同台词也分别保留完整声部。本人说完后结束语言口型；其他人应答时本人倾听或做原动作。环境声动作与收尾不附加讲述、默念或无声语言口型，保留自然呼吸与非语言表情。
环境声与动作节拍须一致：交谈、讲述、问答、呼唤等发声义务不能藏在action或reaction里。若原义务需要可辨语言，明确说话人、原词及speech；确实只需无词呼声则声明对应actor的vocalization。若原义务只需示意或行礼，可以无声手势完成，但不得为了过检删去已要求的讲话或回应。
【说话人与声画一致性结束】`

/** Derive audible performers from the same authored beats as the timeline.
 * This is a provider instruction, never evidence that a generated mouth moved
 * in sync. It also applies to retries of already approved older storyboards. */
export function speechPerformanceContract(params: Value): string {
  const pacing = object(params.pacing)
  if (!Array.isArray(pacing.beats)) return ''
  if (params.pacingVersion === 'independent-narration-v1' && params.audioType === '环境声' && params.audioText === '') {
    return '【逐声部声画绑定】本次只生成画面和自然环境音，画外人声由独立音轨提供；画内不说话、不默念、不作语言口型，保留原动作及自然表情，不生成任何配音。'
  }
  const beats = rows(pacing.beats)
  const audible = beats.filter(beat => beat.kind === 'speech' || beat.kind === 'vocalization')
  if (!audible.length) return '【逐声部声画绑定】本镜没有语言声部：保留环境音和已写动作；画内人物不说话、不默念、不作连续语言口型，指点、行礼、颔首不附加讲话。自然呼吸、微笑及非语言表情照常。'
  const groups = rows(pacing.actorGroups)
  const anonymous = anonymousVoiceRoles(params)
  const lines = String(params.audioText ?? '').split(/\r?\n/).filter(line => line.trim())
  const schedule = rows(pacing.schedule)
  const contracts = audible.map(beat => {
    const ids = Array.isArray(beat.actorIds) ? beat.actorIds.map(String) : []
    const names = ids.map(id => String(groups.find(group => group.id === id)?.label ?? id))
    const offscreen = beat.deliveryStyle === 'narration' || names.length > 0 && names.every((name, index) => {
      if (speechStagingConflict(params, ids[index])) return false
      const role = anonymous.find(role => role.name === name)
      if (role) return role.offscreen
      const labels = lines.map(line => line.match(/^\s*([^：:]+)[：:]/)?.[1]?.trim()).filter((label): label is string => Boolean(label))
        .filter(label => label.replace(/（[^）]*）|\([^)]*\)/g, '').trim() === name)
      return labels.length > 0 && labels.every(explicitlyOffscreenSpeaker)
    })
    const window = schedule.find(row => row.beatId === beat.id)
    const time = window ? `${window.startSecond}至${window.endSecond}秒参考，` : ''
    const performance = offscreen ? '画外发声，画内不跟随口型'
      : beat.kind === 'vocalization' ? '按声明发出无词声音，表演与声音同时发生'
        : '本人同期发声，嘴部表演与本人完整原词同时开始、同时结束'
    const voiceProfiles = ids.flatMap(id => {
      const profile = groups.find(group => group.id === id)?.voiceProfile
      if (typeof profile === 'string') return profile.trim() ? [profile.trim()] : []
      const value = object(profile)
      return ['description', 'genderPresentation', 'age', 'pitch', 'resonance', 'texture', 'delivery', 'language']
        .flatMap(key => typeof value[key] === 'string' && value[key].trim() ? [value[key].trim()] : [])
    })
    return `${String(beat.id)}（${time}${names.join('、') || '旁白'}）：${performance}${voiceProfiles.length ? `，声线遵循已给定设定：${voiceProfiles.join('、')}` : ''}`
  })
  return `【逐声部声画绑定】${contracts.join('；')}。各声部保持独立，即使原词相同也不得用一次发声替代两次或互相代说。说完即结束语言口型；他人回应时，未被安排发声的人只倾听或执行原动作。无声动作、反应及收尾不追加讲话或无声口型，允许自然呼吸、表情和微动；不改变原台词及动作顺序。`
}
