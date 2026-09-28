export type PronunciationHint = { term: string; pinyin: string[]; meaning: string; source: string }

// Syllable spellings from pypinyin 0.55.0's character dictionary (MIT),
// normalized with contrib.tone_convert.to_normal. Includes rare readings.
// This only rejects impossible spelling; it cannot certify a word's reading.
const PINYIN_SYLLABLES = new Set(`a ai an ang ao ba bai ban bang bao bei ben beng bi bian biang biao bie bin bing bo bong bu ca cai can cang cao ce cei cen ceng cha chai chan chang chao che chen cheng chi chong chou chu chua chuai chuan chuang chui chun chuo ci cong cou cu cuan cui cun cuo da dai dan dang dao de dei den deng di dia dian diao die din ding diu dong dou du duan dui dun duo e ei en eng er fa fan fang fei fen feng fiao fo fou fu ga gai gan gang gao ge gei gen geng gong gou gu gua guai guan guang gui gun guo ha hai han hang hao he hei hen heng hm hng hong hou hu hua huai huan huang hui hun huo ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun ka kai kan kang kao ke kei ken keng kong kou ku kua kuai kuan kuang kui kun kuo la lai lan lang lao le lei len leng li lia lian liang liao lie lin ling liu lo long lou lu luan lun luo lv lve m ma mai man mang mao me mei men meng mi mian miao mie min ming miu mo mou mu n na nai nan nang nao ne nei nen neng ng ni nia nian niang niao nie nin ning niu nong nou nu nuan nun nuo nv nve o ou pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu qi qia qian qiang qiao qie qin qing qiong qiu qu quan que qun ran rang rao re ren reng ri rong rou ru rua ruan rui run ruo sa sai san sang sao se sen seng sha shai shan shang shao she shei shen sheng shi shou shu shua shuai shuan shuang shui shun shuo si song sou su suan sui sun suo ta tai tan tang tao te tei teng ti tian tiao tie ting tong tou tu tuan tui tun tuo wa wai wan wang wei wen weng wo wong wu xi xia xian xiang xiao xie xin xing xiong xiu xu xuan xue xun ya yan yang yao ye yi yin ying yo yong you yu yuan yue yun za zai zan zang zao ze zei zen zeng zha zhai zhan zhang zhao zhe zhei zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun zhuo zi zong zou zu zuan zui zun zuo`.split(' '))

/** Authored reading instructions are text guidance, never acoustic evidence.
 * Keep the approved dialogue intact and reject guides for unrelated words. */
export function normalizePronunciationHints(value: unknown, audioText: unknown): PronunciationHint[] {
  if (value === undefined || value === null || value === '') return []
  if (!Array.isArray(value) || value.length > 12) throw Error('PRONUNCIATION_HINT_INVALID: pronunciationHints须为最多12项数组')
  const body = String(audioText ?? '').replace(/(^|\n)[^：:\n]{1,30}[：:]/g, '$1')
  const seen = new Set<string>()
  const hints = value.map((item, index) => {
    const row = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {}
    const term = typeof row.term === 'string' ? row.term.trim() : ''
    const meaning = typeof row.meaning === 'string' ? row.meaning.trim() : ''
    const source = typeof row.source === 'string' ? row.source.trim() : ''
    const pinyin = Array.isArray(row.pinyin) ? row.pinyin.map(value => typeof value === 'string' ? value.toLowerCase().replaceAll('ü', 'v') : '') : []
    if (!/^[\p{Script=Han}]{1,12}$/u.test(term) || !body.includes(term) || seen.has(term)
      || pinyin.length !== [...term].length || pinyin.some(value => !/^[a-zv]{1,7}[1-5]$/.test(value) || !PINYIN_SYLLABLES.has(value.slice(0, -1)))
      || !meaning || meaning.length > 80 || !source || source.length > 300
      || [...meaning + source].some(character => character.charCodeAt(0) < 32)) {
      throw Error(`PRONUNCIATION_HINT_INVALID: 第${index + 1}项须对应原台词中的唯一词条、逐字带1–5声调拼音、语境义项与来源；不能换字、补台词或伪称听审`)
    }
    seen.add(term)
    return { term, pinyin, meaning, source }
  })
  const characters = [...body], readings = new Map<number, string>()
  for (const hint of hints) for (let start = 0; start < characters.length; start++) {
    if (characters.slice(start, start + hint.pinyin.length).join('') !== hint.term) continue
    hint.pinyin.forEach((syllable, offset) => {
      const prior = readings.get(start + offset)
      if (prior && prior !== syllable) throw Error('PRONUNCIATION_HINT_INVALID: 重叠词条对同一汉字给出冲突读音，须明确当前语境')
      readings.set(start + offset, syllable)
    })
  }
  return hints
}

export function pronunciationInstruction(value: unknown, audioText: unknown) {
  const hints = normalizePronunciationHints(value, audioText)
  if (!hints.length) return ''
  return '【发音指导】保留原台词汉字；拼音数字1–4为声调、5为轻声、v为ü。只按义项准确发音，不朗读拼音、解释或来源：'
    + hints.map(hint => `${hint.term}=${hint.pinyin.join(' ')}（${hint.meaning}）`).join('；') + '。'
}

export const PRONUNCIATION_STORYBOARD_INSTRUCTION = `【语境读音契约】可选pronunciationHints字段是数组；仅为本镜实际台词中的生僻词、多音词或古代名词提供发音指导，每项{term:"台词中的原字词",pinyin:["每个汉字对应一个小写拼音加1–5声调数字"],meaning:"本句义项",source:"可核查字典词条或读音资料出处"}。没有可靠依据时不猜读音，保留为空数组，不凭空补齐。禁止用同音字或拼音替换audioText，禁止把相/向等不同字音视为已验证一致。指导字段不是实测声音证据，不能据此声明声调、音素或吐字已经通过。历史组织、官名、人名按本句语境选读，不套日常词的轻声。最多12项，只包含本镜出现的词。【语境读音契约结束】`

export function refreshPronunciationStoryboardPrompt(prompt: string) {
  const block = /【语境读音契约】[\s\S]*?【语境读音契约结束】/g
  return block.test(prompt) ? prompt.replace(block, PRONUNCIATION_STORYBOARD_INSTRUCTION) : prompt + '\n' + PRONUNCIATION_STORYBOARD_INSTRUCTION
}
