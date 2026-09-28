/** Recognize complete sound-effect labels with an explicit physical source.
 * Unknown sounds stay conservative: they may contain speech and must not be
 * used to waive an authored narration/context obligation. */
const SPEECH_OR_QUOTATION = /旁白|画外音|解说|对白|台词|说|谈|讲|述|念|诵|唱|喊|叫|呼唤|问|答|话语|语言|人声|口号|吆喝|歌词|["'“”‘’「」『』：:]/u
// Modifiers may describe a proven source's distance, density or level, but
// cannot turn an arbitrary sentence or an unidentified voice into an effect.
const PHYSICAL_SOUND = /^(?:(?:低沉|急促|远处|近处|轻微|持续|渐强|渐弱|清晰|沉闷|缓慢|细微|自然|背景|阵阵|一阵|密集|稀疏|隐约|微弱|响亮)(?:的)?){0,6}(?:(?:城|殿|宫|院|庭|木|铁|石)?门(?:轴)?|车(?:轮|轴|马)?|马(?:车|蹄)?|鼓|钟|风|雨|雷|脚步|鸟鸣|虫鸣|(?:流|河|溪|江|湖|海|泉|池)?水(?:流|滴)?|火(?:焰)?|兵器|刀剑|衣料|布料|树叶|树枝)(?:开(?:启)?|关(?:闭)?|推开|闭合|转动|摩擦|撞击|碰撞|滚动|行驶|驶过|进出|碾过|敲击|摇动|燃烧|流动|滴落|吹动)*(?:的)?(?:吱呀|沙沙|噼啪|轰鸣)?(?:声|声响|声音)(?:渐近|渐远|渐强|渐弱|逐渐靠近|逐渐远去|逐渐增强|逐渐减弱){0,2}$/u
// A source-backed sound can be described as a complete physical action rather
// than the short label above. Keep the syntax bounded: a named surface for
// footfalls, or two identifiable objects making contact. This cannot waive a
// narration requirement for an unidentified voice or arbitrary prose.
const GROUNDED_FOOTSTEP = /^(?:[\p{Script=Han}]{1,6})?(?:鞋底|靴底|脚掌)(?:落在|踏在|踩在)[\p{Script=Han}]{0,12}(?:地面|石板|木板|泥地|台阶)(?:上)?的脚步(?:声|声响|声音)$/u
const GROUNDED_OBJECT_CONTACT = /^(?:(?:行走|移动|搬运|取放|放置)时)?([\p{Script=Han}]{1,8})(?:与|和)([\p{Script=Han}]{1,8})(?:轻碰|碰撞|相撞|撞击|摩擦)(?:的)?(?:声|声响|声音)$/u
const PHYSICAL_OBJECT = /(?:杯|盘|碗|盏|壶|罐|案|门|窗|车|轮|鼓|钟|刀|剑|盾|甲|器|简)$/u

export function isNonSpeechAudioObligation(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false
  // Strip only a leading sound-design label. An actor label or a second
  // colon still belongs to the source and keeps the conservative speech path.
  const text = value.trim().replace(/^(?:音效|环境声|环境音)[：:]\s*/u, '')
  if (SPEECH_OR_QUOTATION.test(text)) return false
  if (GROUNDED_FOOTSTEP.test(text)) return true
  const contact = text.match(GROUNDED_OBJECT_CONTACT)
  if (contact && PHYSICAL_OBJECT.test(contact[1]) && PHYSICAL_OBJECT.test(contact[2])) return true
  return text.split(/[，、,；;]|(?:以及|伴随|和|与|及)/u).every(part => {
    const sound = part.trim()
    return /^(?:环境音|自然环境音|音效|音乐|配乐)$/u.test(sound) || PHYSICAL_SOUND.test(sound)
  })
}
