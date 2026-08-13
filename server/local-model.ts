import { createHash } from 'node:crypto'

export type LocalModelRequest = {
  capability: 'text' | 'image' | 'video' | 'audio'
  operation?: string
  prompt: string
  params?: Record<string, unknown>
}

function valueAsArray(value: unknown) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed
    } catch {
      return value.split(/[、，,\n]/).map((item) => item.trim()).filter(Boolean)
    }
  }
  return value === undefined || value === null || value === '' ? [] : [value]
}

function valueAsRecord(value: unknown) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return {}
}

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character] ?? character)
}

export function createSvgDataUrl(title: string, subtitle: string, accent = '#9f2d20') {
  const safeTitle = escapeXml(title.slice(0, 24))
  const safeSubtitle = escapeXml(subtitle.replace(/\s+/g, ' ').slice(0, 54))
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280" viewBox="0 0 720 1280">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#15130f"/>
          <stop offset="0.55" stop-color="#31281d"/>
          <stop offset="1" stop-color="#0d1718"/>
        </linearGradient>
        <filter id="grain"><feTurbulence baseFrequency="0.7" numOctaves="2" seed="8" type="fractalNoise" result="n"/><feBlend in="SourceGraphic" in2="n" mode="soft-light"/></filter>
      </defs>
      <rect width="720" height="1280" fill="url(#bg)"/>
      <circle cx="576" cy="220" r="190" fill="${accent}" opacity="0.34" filter="url(#grain)"/>
      <path d="M0 930 C170 790 322 895 470 742 C570 640 646 664 720 610 L720 1280 L0 1280Z" fill="#090d0d" opacity="0.93"/>
      <path d="M90 920 L168 516 L235 920Z M242 920 L342 402 L433 920Z M430 920 L532 550 L610 920Z" fill="#191a17" opacity="0.9"/>
      <rect x="58" y="74" width="10" height="238" rx="5" fill="${accent}"/>
      <text x="94" y="144" fill="#e8dfcf" font-size="48" font-family="serif" font-weight="700">${safeTitle}</text>
      <text x="96" y="204" fill="#b8aa94" font-size="22" font-family="sans-serif">${safeSubtitle}</text>
      <text x="96" y="1142" fill="#d0c2ac" font-size="20" font-family="sans-serif">LOCAL DRY-RUN PREVIEW · 9:16</text>
      <rect x="94" y="1172" width="210" height="4" fill="${accent}"/>
    </svg>
  `.trim()
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

export function createSilentWavDataUrl(durationSeconds = 1) {
  const sampleRate = 8000
  const samples = Math.max(1, Math.min(8, durationSeconds)) * sampleRate
  const dataSize = samples * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  return `data:audio/wav;base64,${buffer.toString('base64')}`
}

const episodeCharacters: Record<string, string[]> = {
  符水与饥民: ['张角', '张宝'],
  三十六方: ['张角', '张宝'],
  大方马元义: ['马元义', '张角'],
  洛阳内应: ['马元义', '封谞', '徐奉'],
  唐周告密: ['唐周', '马元义'],
  车裂马元义: ['马元义', '汉灵帝'],
  甲子提前: ['张角', '张宝', '张梁'],
  苍天已死: ['张角', '张宝', '张梁'],
  京师震动: ['汉灵帝', '何进'],
  解除党禁: ['汉灵帝', '皇甫嵩'],
  涿郡聚众: ['刘备', '关羽', '张飞', '张世平', '苏双', '邹靖'],
}

function inferCharacters(params: Record<string, unknown>, prompt: string) {
  const episodeTitle = String(params.episodeTitle ?? params.episode_title ?? '')
  const known = episodeCharacters[episodeTitle]
  if (known) return known
  const candidateNames = ['张角', '张宝', '张梁', '马元义', '唐周', '封谞', '徐奉', '汉灵帝', '何进', '皇甫嵩', '朱儁', '卢植', '刘备', '关羽', '张飞', '曹操', '邹靖', '波才']
  const found = candidateNames.filter((name) => prompt.includes(name))
  return found.length ? found : ['史事主角']
}

function buildCharacterPlan(params: Record<string, unknown>, prompt: string) {
  const storyboard = valueAsRecord(params.storyboard ?? params.shotScript)
  const storyboardCharacters = valueAsArray(storyboard.characters).map((item) => {
    if (item && typeof item === 'object' && 'name' in item) return String((item as Record<string, unknown>).name)
    return String(item)
  }).filter(Boolean)
  const characters = storyboardCharacters.length
    ? Array.from(new Set(storyboardCharacters))
    : inferCharacters(params, prompt)
  return {
    characters: characters.map((name, index) => ({
      name,
      role: index === 0 ? '本集核心人物' : '本集出场人物',
      continuityKey: `${name}-eastern-han-v1`,
      designPrompt: `东汉末年人物定妆三视图，${name}，正面、侧面、背面，真人历史电影质感，服饰材质考据准确，中性站姿，纯色背景，无文字无水印`,
    })),
    names: characters,
    count: characters.length,
  }
}

function sceneOutlinePromptContext(prompt: string) {
  const episodeTitle = prompt.match(/为《([^》]+)》/)?.[1] ?? ''
  const citationsStart = prompt.indexOf('史料引用清单：')
  const sourcesStart = prompt.indexOf('\n\n史料原文：', citationsStart)
  const citationsText = citationsStart >= 0
    ? prompt.slice(citationsStart + '史料引用清单：'.length, sourcesStart >= 0 ? sourcesStart : undefined).trim()
    : ''
  const citations = (() => {
    try {
      return valueAsArray(JSON.parse(citationsText))
    } catch {
      return valueAsArray(citationsText)
    }
  })()
  const historicalSources = sourcesStart >= 0 ? prompt.slice(sourcesStart + '\n\n史料原文：'.length).trim() : ''
  return { episodeTitle, citations, historicalSources }
}

function buildSceneOutline(params: Record<string, unknown>, prompt: string) {
  const promptContext = sceneOutlinePromptContext(prompt)
  const episodeTitle = String(params.episodeTitle ?? params.episode_title ?? promptContext.episodeTitle ?? '三国史事')
  const citations = valueAsArray(params.citations ?? promptContext.citations)
  const sourceText = `${String(params.historicalSources ?? promptContext.historicalSources)}\n${JSON.stringify(citations)}`
  const sourceSentenceCount = (sourceText.match(/[。！？；]/g) ?? []).length
  const sourceComplexity = citations.length + Math.ceil(sourceSentenceCount / 18)
  const count = Math.max(3, Math.min(12, 3 + sourceComplexity))
  const durations = Array.from({ length: count }, (_, index) => {
    const needsLongerBeat = sourceComplexity >= 4 && (index + sourceSentenceCount) % 3 === 1
    return needsLongerBeat ? 10 : 5
  })
  const beats = [
    '用反常动作或迫近危机开场：核心人物想立即稳住局面，却被身份、资源或时势阻住；以可见选择暴露其史载性格，并留下未答问题',
    '关键人物以符合其身份与性格的试探或行动争取目标，对手从细节察觉意图并给出有压力的反应，形成信息差',
    '人物间的性格差异正面碰撞：一方推进、一方牵制，机锋或处境反差带来趣味，但行动立刻产生代价',
    '史料所载关键行动发生并造成可见后果；用旁观者或对手的意外反应放大变化，而非旁白直叙结果',
    '核心人物在受限条件下作出符合史载性格的选择，关系或权力距离随之改变，并回扣前镜细节',
    '局势扩大且原计划出现偏差，人物必须反制或重新判断；以误判后的后果制造下一层冲突',
    '关键人物从动作、物证或他人沉默中意识到变化，不直说结论，以目光和决断形成情绪爆点',
    '以史实节点收束当前因果，同时留下一个人物决定、迫近威胁或未揭答案作为下一集钩子',
  ]
  const scenes = Array.from({ length: count }, (_, index) => ({
    id: `scene-${String(index + 1).padStart(2, '0')}`,
    sequence: index + 1,
    title: index === 0 ? `${episodeTitle}·入局` : index === count - 1 ? `${episodeTitle}·余波` : `${episodeTitle}·${index + 1}`,
    purpose: beats[index % beats.length],
    historicalBasis: citations.length
      ? `[史料${(index % citations.length) + 1}] ${String(valueAsRecord(citations[index % citations.length]).title ?? citations[index % citations.length])}`
      : `[史料1] 依据本集挂载史料表现“${episodeTitle}”`,
    adaptationBoundary: '具体对白、微动作、人物反应与场面调度为合理戏剧化，用于强化性格碰撞、信息差和悬念；不新增改变历史因果、人物核心立场或胜负归属的事实。',
    targetDuration: durations[index],
    continuityFromPrevious: index > 0 && index % 2 === 1,
  }))
  return { episodeTitle, scenes }
}

function promptStoryboardContext(prompt: string) {
  const sceneStart = prompt.indexOf('当前场景：')
  const sourceStart = sceneStart >= 0 ? prompt.indexOf('\n\n史料原文：', sceneStart) : -1
  const sceneText = sceneStart >= 0
    ? prompt.slice(sceneStart + '当前场景：'.length, sourceStart >= 0 ? sourceStart : undefined).trim()
    : ''
  const scene = (() => {
    try {
      return valueAsRecord(JSON.parse(sceneText))
    } catch {
      return {}
    }
  })()
  const episodeTitle = prompt.match(/本集《([^》]+)》/)?.[1] ?? ''
  return { scene, episodeTitle }
}

function buildStoryboard(params: Record<string, unknown>, prompt: string) {
  const promptContext = promptStoryboardContext(prompt)
  const scene = valueAsRecord(params.scene ?? promptContext.scene)
  const episodeTitle = String((params.episodeTitle ?? params.episode_title ?? promptContext.episodeTitle) || '三国史事')
  const title = String(scene.title ?? episodeTitle)
  const purpose = String(scene.purpose ?? '推进本集史事')
  const configuredCharacters = valueAsArray(params.characters).map((item) => {
    if (item && typeof item === 'object' && 'name' in item) return String((item as Record<string, unknown>).name)
    return String(item)
  }).filter(Boolean)
  const characters = configuredCharacters.length
    ? configuredCharacters
    : inferCharacters({ ...params, episodeTitle }, `${title} ${purpose} ${JSON.stringify(scene)}`)
  const sequence = Math.max(1, Number(scene.sequence ?? String(scene.id ?? '').match(/\d+/)?.[0] ?? 1))
  const cast = (sequence >= 7 ? characters : characters.slice(0, 1)).slice(0, 4)
  const duration = Number(scene.targetDuration ?? params.duration ?? 5)
  const visualPrompt = `竖屏9:16，东汉末年，${title}。开镜即见冲突或异常：${purpose}。人物：${cast.join('、') || '无具名人物'}；用动作、目光与站位表现人物目的、阻力和性格差异，对手或旁观者必须有可见反应，结尾留下代价或悬念。真人实景、低饱和土褐黛青色调、自然光、服化道考据准确、无现代物件、无字幕、无水印。`
  return {
    id: String(scene.id ?? `shot-${createHash('sha1').update(title).digest('hex').slice(0, 8)}`),
    title,
    duration,
    characters: cast,
    visualPrompt,
    camera: '从关键道具或异常动作特写快速揭示冲突，再切人物目光与对手反应，随权力距离变化推进或后撤，结尾停在悬念构图',
    mood: '写实历史质感中带紧张信息差、人物机锋与处境反差，不做流水账式肃穆陈述',
    firstFrameMode: scene.continuityFromPrevious === true ? 'reuse_previous_tail' : 'generate',
    firstFramePrompt: `${visualPrompt} 画面处于本镜头动作开始前的稳定构图。`,
    lastFramePrompt: `${visualPrompt} “${purpose}”完成后，不停在结果说明，而停在人物付出代价、对手意外反应或新威胁显现的稳定悬念构图。`,
    videoPrompt: `保持首帧人物身份与服饰一致；围绕一个强动作完成“意图—阻力—反应—变化”：${purpose}。人物表现符合史载身份与性格，不贴标签、不站桩念史；动作符合真实物理，镜头随关系变化运动，无玄幻特效，无AI塑料感。`,
    audioType: '对白',
    audioText: `${cast[0] || '旁白'}：先别急着信眼前这一幕。`,
    historicalBasis: scene.historicalBasis ?? '',
    adaptationBoundary: scene.adaptationBoundary ?? '',
  }
}

function buildGenericText(params: Record<string, unknown>, prompt: string) {
  const count = Math.max(1, Math.min(20, Number(params.count ?? params.vedio_count ?? 3)))
  return Array.from({ length: count }, (_, index) => ({
    title: `分镜 ${index + 1}`,
    content: `${prompt.slice(0, 120)}（第 ${index + 1} 段）`,
    duration: 5,
    camera: index % 2 === 0 ? '缓慢推进' : '横向跟拍',
    mood: '写实',
    firstFramePrompt: `第 ${index + 1} 段首帧`,
  }))
}

export function runLocalModel(request: LocalModelRequest) {
  const params = request.params ?? {}
  if (request.capability === 'text') {
    if (request.operation === 'history.character-plan') return buildCharacterPlan(params, request.prompt)
    if (request.operation === 'history.scene-outline') return buildSceneOutline(params, request.prompt)
    if (request.operation === 'history.storyboard') return buildStoryboard(params, request.prompt)
    return buildGenericText(params, request.prompt)
  }
  if (request.capability === 'image') {
    const title = String(params.title ?? params.characterName ?? params.character ?? '三国短剧首帧')
    return {
      url: createSvgDataUrl(title, request.prompt),
      revisedPrompt: request.prompt,
      status: 'simulated',
      provider: 'Local',
    }
  }
  if (request.capability === 'video') {
    const title = String(params.title ?? params.sceneTitle ?? '三国短剧镜头')
    const sound = String(params.sound ?? 'off')
    return {
      url: createSvgDataUrl(`${title} · 动态预演`, request.prompt, '#166f7a'),
      lastFrameUrl: createSvgDataUrl(`${title} · 尾帧`, request.prompt, '#6f4e37'),
      status: 'simulated',
      provider: 'Local',
      mediaType: 'video-dry-run-poster',
      duration: Math.max(1, Number(params.duration ?? 5)),
      sound,
      audioEmbedded: sound === 'on',
      prompt: request.prompt,
    }
  }
  return {
    url: createSilentWavDataUrl(Math.max(1, Number(params.duration ?? 1))),
    status: 'simulated',
    provider: 'Local',
    transcript: request.prompt,
    voice: String(params.voice ?? 'history_narrator'),
  }
}
