import { resolveDurationPolicy } from './duration-policy.ts'
import { speechPerformanceContract } from './speech-performance.ts'
import { isHistoricalSandTable } from './sand-table-contract.ts'

type Value = Record<string, unknown>
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}

export const VIDEO_NO_SUBTITLES_CONTRACT = '【无字幕硬约束】全片不生成字幕、台词文字、标题或乱码字形。参考帧中的字幕必须消除并还原为自然场景；声音照常，台词只发声不显示。'
export const VIDEO_NO_SUBTITLES_NEGATIVE = '自动字幕、对白文字、乱码字幕、字幕样伪字、captions、subtitles'

/** This is an explicit output requirement, independent of the audio mode.
 * Keep all authored words and voice windows; they describe audible speech. */
export function videoSubtitleContract(params: Value): string {
  const policy = params.subtitlePolicy
  if (!Object.hasOwn(params, 'subtitlePolicy') || policy === 'allow') return ''
  if (policy !== 'none') throw new Error('SUBTITLE_POLICY_INVALID: subtitlePolicy 仅支持 none 或 allow')
  return VIDEO_NO_SUBTITLES_CONTRACT
}

export function subtitleFreeVideoPrompt(prompt: string, params: Value): string {
  const contract = videoSubtitleContract(params)
  if (!contract) return prompt
  let fence: { char: string; length: number } | undefined
  let existing = false
  for (const line of prompt.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length }
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined
    } else if (!fence && line === contract) existing = true
  }
  if (fence) throw new Error('SUBTITLE_CONTRACT_SCOPE_INVALID: 未闭合的引用块使无字幕约束无法独立生效；请修正原提示词，已阻止付费生成')
  if (existing) return prompt
  return prompt + '\n' + contract
}

const liveAction = 'live_action 必须生成具有真实空间深度、自然光影和可信时代环境的完整实景'
const exclusions = '禁止低幼卡通、Q版、现代动漫符号、游戏CG和玄幻光效。'
const identity = '人物参考附件只用于身份、脸部、体型和服装。'
const ownedVisualRules = `【视觉处理硬约束】${liveAction}；animated 严格执行 animationStyle 与 animationAesthetic，可使用历史人物插画、历史场景、象征物、时间或环境动画，不默认地图。character_illustration 使用系统二维插画编排路线：人物素材内部姿态、表情、嘴部和衣物全程不变，只允许整个人物图层在合适的历史背景上淡入、平移、缩放、淡出；historical_tableau 仅允许整幅定格画面轻微缩放、平移或渐变。二者均不向视频模型请求人物走路、转身、说话等肢体动画，背景由独立画外旁白讲清。其他动画按分镜运动。${exclusions}旧 animated_map/historical_montage 分别按 historical_map/historical_tableau 兼容。${identity}`
const currentOwnedVisualRules = ownedVisualRules.replace('；historical_tableau', '；系统裁切人物正面并必须完全忽略附件中的纯色底。historical_tableau')
const applicableVisualRules = `【视觉处理硬约束】${liveAction}。${exclusions}${identity}`
// The video provider has a 2500-character prompt budget. Keep the full map
// guidance upstream and send only the motion and clean-background rule here.
export const SAND_TABLE_VIDEO_MOTION_PROMPT = '全画幅古代历史地理裸地图底片：二维宣纸墨线与克制设色，山川、水道、道路、城址、当时疆域及相对方位清楚；按首尾参考帧维持同一地理范围、朝向、边界和设色，仅允许已批准的地理底色变化，未指定地理不漂移。视频模型绝不绘制人物、肖像、头像、地图地名、年代、势力文字、路线线条、箭头、标记或字幕；已批准 mapAnnotations 地名与路线、illustrationLayers 静态肖像均由本地后期叠加。禁止伪字、标题、水印、盘框、砂土、玩具城堡、兵偶、棋子、桌面摄影、游戏界面、悬浮三维箭头和新增史实。'

/** The independent soundtrack projection keeps the approved duration-v2
 * pictures, but deliberately changes the provider audio route. Require its
 * complete owned contract and picture-only fields, not just a version claim. */
function independentPictureProjection(prompt: string, params: Value): boolean {
  if (params.pacingVersion !== 'independent-narration-v1' || params.audioType !== '环境声'
    || params.audioText !== '' || params.sound !== 'on'
    || !Array.isArray(params.characterVoices) || params.characterVoices.length !== 0) return false
  const contracts = prompt.split(/\r?\n/).filter(line => line.startsWith('【独立画外配音】'))
  return contracts.length === 1 && /^【独立画外配音】本次仅生成画面和与场景相符的自然环境音。(?:旁白|画外角色[^\r\n]+的对白)将在后期添加，本次不得生成任何可辨词语或配音；画内人物不朗读、不作说话口型，保留已批准的动作、视线、呼吸和微动。$/.test(contracts[0])
}

/** Render only the applicable branch of an exact known managed rule. The
 * provider does not need authoring instructions for other media routes. Every
 * authored opening, timeline, ending, voice and custom rule remains untouched;
 * the complete final provider prompt still faces the original length gate. */
export function renderVideoProviderPrompt(prompt: string, params: Value): string {
  const sandTable = isHistoricalSandTable(params)
  if (params.visualTreatment !== 'live_action' && !sandTable
    || params.pacingVersion !== 'duration-v2' && !independentPictureProjection(prompt, params)) return prompt
  const headers = [...prompt.matchAll(/^【本镜影视处理】\s*([^/\r\n]+)\s*\/\s*([^\r\n]+)$/gm)]
  if (headers.length !== 1 || headers[0][1].trim() !== params.visualTreatment
    || headers[0][2].trim() !== params.editorialRole) return prompt
  const rules = prompt.split(/\r?\n/).filter(line => line.startsWith('【视觉处理硬约束】'))
  if (rules.length !== 1 || ![ownedVisualRules, currentOwnedVisualRules].includes(rules[0])) return prompt
  // Replace only the validated whole line. An authored quotation may contain
  // the same bytes earlier in the body and must remain intact, as do newlines.
  const applicable = sandTable ? '【视觉处理硬约束】' + SAND_TABLE_VIDEO_MOTION_PROMPT : applicableVisualRules
  return prompt.split(/(\r?\n)/).map(part => part === rules[0] ? applicable : part).join('')
}

const compiledVoiceSuffix = (reserve: number) => `。对白按角色绑定嘴唇，画外旁白不绑定画内口型；歌谣、吟诵和歌唱遵循各自表演节奏，不强制改成每秒4.5字的对话。已声明的无词群体声部必须实际可听，不能因不在audioText中而静音；未声明声部不得新增可辨语言。完整保留每句台词及原动作先后关系，动作与必需回应完成后保留 ${reserve} 秒可读收尾，允许自然呼吸微动，不新增剧情动作或以静帧补齐缺失动作。导演参考窗口用于定位表演，硬边界和前置依赖必须遵守。`

/** A second, lossless rendering of owned provider contracts for a request that
 * exceeds the provider budget. Validate the compiler metadata against actual
 * beats and policy first; unknown or authored blocks are never rewritten.
 * Opening, timeline, camera, ending, audioText and voice/element bindings stay
 * byte-for-byte intact. The caller still rejects a remaining overflow. */
export function compactManagedVideoProviderPrompt(prompt: string, params: Value): string {
  if (params.pacingVersion !== 'duration-v2' || params.visualTreatment !== 'live_action') return prompt
  const visualRules = prompt.split(/\r?\n/).filter(line => line.startsWith('【视觉处理硬约束】'))
  if (visualRules.length !== 1 || visualRules[0] !== applicableVisualRules) return prompt
  const pacing = object(params.pacing)
  if (pacing.version !== 'duration-v2' || !Array.isArray(pacing.beats)) return prompt
  let policy: ReturnType<typeof resolveDurationPolicy>
  try { policy = resolveDurationPolicy(pacing.timingPolicy) } catch { return prompt }
  const styles: Record<string, string> = { dialogue: '对白', narration: '旁白', chant: '吟诵', singing: '歌唱' }
  const voices = pacing.beats.map(object).filter(beat => beat.kind === 'speech' || beat.kind === 'vocalization')
    .map(beat => ({ beatId: beat.id, actorIds: beat.actorIds, kind: beat.kind, deliveryStyle: beat.deliveryStyle,
      textOrVocalization: beat.textOrVocalization, ...(beat.vocalization ? { vocalization: beat.vocalization } : {}) }))
  if (voices.some(voice => typeof voice.beatId !== 'string' || !voice.beatId
    || !Array.isArray(voice.actorIds) || !voice.actorIds.length || voice.actorIds.some(id => typeof id !== 'string' || !id)
    || typeof voice.textOrVocalization !== 'string' || !voice.textOrVocalization
    || voice.kind === 'speech' && !styles[String(voice.deliveryStyle)])) return prompt
  const compiled = `【声部与收束】按共享策略 ${policy.version} 和已编译节拍分别完成下列声部：${JSON.stringify(voices)}${compiledVoiceSuffix(policy.endingReadabilityReserve)}`
  const compilerLines = prompt.split(/\r?\n/).filter(line => line.startsWith('【声部与收束】'))
  if (compilerLines.length !== 1 || compilerLines[0] !== compiled) return prompt
  const replacements = new Map<string, string>()
  const performance = speechPerformanceContract(params)
  const performanceSuffix = '。各声部保持独立，即使原词相同也不得用一次发声替代两次或互相代说。说完即结束语言口型；他人回应时，未被安排发声的人只倾听或执行原动作。无声动作、反应及收尾不追加讲话或无声口型，允许自然呼吸、表情和微动；不改变原台词及动作顺序。'
  const schedule = Array.isArray(pacing.schedule) ? pacing.schedule.map(object) : []
  const windows = voices.map(voice => schedule.filter(window => window.beatId === voice.beatId))
  const completeWindows = windows.every(matches => matches.length === 1 && typeof matches[0].startSecond === 'number'
    && typeof matches[0].endSecond === 'number' && Number.isFinite(matches[0].startSecond) && Number.isFinite(matches[0].endSecond))
  // A native-only contract without additional profiles repeats the same beat,
  // actor and voice rules twice. Merge its exact windows into the summary;
  // narration, offscreen staging and voice profiles retain their own contract.
  const nativePerformance = '【逐声部声画绑定】' + voices.map((voice, index) =>
    `${voice.beatId}（${windows[index][0]?.startSecond}至${windows[index][0]?.endSecond}秒参考，${(voice.actorIds as string[]).join('、')}）：本人同期发声，嘴部表演与本人完整原词同时开始、同时结束`).join('；') + performanceSuffix
  const mergeNativePerformance = voices.length > 0 && completeWindows
    && voices.every(voice => voice.kind === 'speech' && voice.deliveryStyle !== 'narration') && performance === nativePerformance
  const summary = voices.map((voice, index) => `${voice.beatId} ${JSON.stringify(voice.actorIds)}${voice.kind === 'speech' ? styles[String(voice.deliveryStyle)] : '无词声'}${mergeNativePerformance ? `（${windows[index][0].startSecond}至${windows[index][0].endSecond}秒参考）` : ''}：${JSON.stringify(voice.textOrVocalization)}${voice.vocalization ? `（${JSON.stringify(voice.vocalization)}）` : ''}`).join('；')
  replacements.set(compiled, `【声部与收束】${policy.version}；${summary}。仅声明声部发声；画内完整词与本人口型同步始终，旁白无画内口型。吟诵歌唱依各自节奏，无词声部可听；声部独立，不代说合并。句末停语言口型，他人发声仅倾听或原动作；无声段禁语言口型，呼吸表情微动保留。完整词、动作顺序、硬边界与前置依赖不变；动作回应完成后留${policy.endingReadabilityReserve}秒可读收尾，禁新剧情、禁静帧补动作。`)
  if (performance.endsWith(performanceSuffix)) replacements.set(performance,
    mergeNativePerformance ? '' : performance.slice(0, -performanceSuffix.length)
      .replaceAll('本人同期发声，嘴部表演与本人完整原词同时开始、同时结束', '本人同期声、口型与完整原词同步始终') + '。')
  replacements.set('【同期声音与可见口型】画内声部匹配自然口型，旁白不绑定画内口型；无词声部须可听。完整执行原节拍与收尾余量。', '')

  // These lines are exclusively produced by the identity-reference adapter.
  // Reconstruct the entire line from bindings before replacing it; an author
  // using the same heading or adding a new constraint remains untouched.
  if (object(params.referenceDiagnostics).composition === 'whole-identity-sheets'
    && Array.isArray(params.referenceImages) && params.referenceImages.length) {
    const bindings = Array.isArray(params.referenceBindings) ? params.referenceBindings : []
    const names = bindings.map((binding, index) => typeof binding === 'string' ? binding.trim() || `人物${index + 1}`
      : String(object(binding).characterName ?? object(binding).name ?? '').trim() || `人物${index + 1}`)
    const references = params.referenceImages.map((_, index) => `${names[index] ?? `人物${index + 1}`}：<<<image_${index + 1}>>>（完整原参考图）`).join('；')
    const castRows = [['characters', '本镜可见或行动人物'], ['initialCharacters', '开场人物'], ['presentCharacters', '场内人物（可在画外）']]
      .flatMap(([key, label]) => Array.isArray(params[key]) ? [{ label, json: JSON.stringify(params[key]) }] : [])
    const castContract = castRows.map(({ label, json }) => `${label}：${json}`).join('；')
    const fullIdentity = `人物身份参考：${references}。每张附件内出现的是该具名人物的多个视角参考，不代表多个独立真人；同一具名角色在成片中只能对应一个人，不得复制参考视图为多个同人。${castContract ? `${castContract}；成片人物数量与开场、入场和画外关系必须遵循这些分镜名单。` : ''}实际有哪些参考角度以图片为准，不假定固定正面、侧面、背面顺序。只继承同一人物的脸部、体型与服装，不复制参考图排版或增加人物。`
    const castGroups = new Map<string, string[]>()
    for (const { label, json } of castRows) castGroups.set(json, [...(castGroups.get(json) ?? []), label])
    const compactCast = [...castGroups].map(([json, labels]) => `${labels.join('、')}：${json}`).join('；')
    replacements.set(fullIdentity, `人物身份参考：${references.replaceAll('（完整原参考图）', '')}。每张为同一人物多角度，仅继承脸、体型、服装；同角色只一人，禁复制视图或排版。角度以图为准，不预设顺序。${compactCast ? `${compactCast}；严格遵守人数、开场、入场和画外关系。` : ''}`)
  }
  replacements.set('【参考图背景隔离】人物附件中的纯色底、摄影棚底、画布边界和三视图排版都是资产制作痕迹，不是故事场景；必须完全忽略并以文字中的“场景与开场实景”重建完整环境，不得生成幕布、棚拍、舞台布景、纯色背景或人物抠图感。',
    '【参考图背景隔离】忽略附件的纯色底、摄影棚底、画布边界、三视图排版；按文字重建完整实景，禁幕布、棚拍、舞台、纯色背景或抠图感。')
  replacements.set('【身份参考与动作分离】附件中性站姿、手臂姿势和朝向不是动作要求。按原节拍执行，持续动作保持至该段结束并完成结尾；禁止说话时回到附件站姿。若有实际首帧，开场以其为准，再连续执行后续动作。',
    '【身份参考与动作分离】附件站姿、手臂和朝向不作动作要求；持续执行原节拍至结束及结尾，禁说话时回站姿；实际首帧优先并连续后续动作。')
  replacements.set('【实际首帧优先】全画幅首帧锁定实际环境、机位、人物位置与开场姿态；多角度人物附件仅补充身份与服装细节，不重排人物、不改变首帧环境、不增加已在首帧中的人物副本。',
    '【实际首帧优先】锁定全画幅首帧环境、机位、人物位置与姿态；附件只补身份服装，禁重排、改环境或复制人物。')
  // Whole-line replacements preserve CRLF and do not rewrite quoted text,
  // authored additions, entrances, dialogue, group counts or dependencies.
  return prompt.split(/(\r?\n)/).map(part => replacements.get(part) ?? part).join('')
}
