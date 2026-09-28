type Value = Record<string, unknown>
const record = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown): string => typeof value === 'string' ? value : ''
const actors = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : []
const lexical = /交谈|谈话|对话|问答|复述|讲述|讲解|讲话|说话|喊话|宣示|宣布|宣告|宣读|说道|说出|问道|答道|(?:齐声|出声|高声|大声|朗声|低声)(?:应和|回应|响应)/g
const calls = /呼唤|呼喊|喊叫|呼叫/g

// Deliberately bounded to explicit authored performance verbs. Looking,
// listening, gestures, breathing and expressions do not invent a voice role.
function obligations(value: unknown): Array<{ kind: 'lexical' | 'call'; text: string }> {
  const result: Array<{ kind: 'lexical' | 'call'; text: string }> = []
  for (const sentence of string(value).split(/[。；;！!？?\n]/)) for (const clause of sentence.split(/[，,]|(?:但是|随后|转而|然后|并(?=开始|开口|大声|低声|转身|继续|向))/)) {
    for (const [kind, pattern] of [['lexical', lexical], ['call', calls]] as const) {
      for (const match of clause.matchAll(pattern)) {
        const before = clause.slice(0, match.index), after = clause.slice(match.index + match[0].length)
        if (/(?:不|未|无须|无需|禁止|避免|停止|结束|不能|不得|不要|没有|并非|无人)(?:允许|再|继续|相互|互相|彼此|进行|任何|高声|大声|朗声|低声|开口|的|人们|人物|人|百姓|他们|群众|交谈|谈话|复述|讲述|讲话|说话|宣示|宣布|宣告|呼唤|呼喊|齐声应和|或|和|及|与){0,6}\s*$/.test(before)) continue
        if (/(?:无声|默默|不出声|没有声音|保持安静|闭口)[^\s]{0,16}$/.test(before) || /^(?:而?不出声|但无声|没有声音|结束|停止)/.test(after)) continue
        if (/(?:听见|听到|听着|聆听|倾听|听取|听完)[^。；]{0,30}$/.test(before) || /(?:画外旁白|旁白|解说词)[^。；]{0,12}$/.test(before)) continue
        if (/(?:背景|画外|远处|身后|耳边)(?:里|中|的)?(?:传来|响起)[^。；]{0,30}$/.test(before)) continue
        // A named pose is a visual action. This narrow noun-form exception
        // never exempts a separate clause that actually retells/speaks words.
        if (match[0] === '讲述' && /(?:做出|摆出|保持|呈现|显出|作)$/.test(before) && /^(?:手势|姿态)(?:$|并|和|而)/.test(after)) continue
        // A raised arm may visibly declare intent. Explicitly voiced wording
        // overrides that exception; a bare declaration remains a speech duty.
        if (match[0] === '宣示' && !/(?:高声|大声|朗声|出声|开口|张口|说出|喊出|讲话|讲述|说话|宣布|宣告|台词|口型)/.test(sentence)
          && (/(?:挥臂|举臂|挥手|抬手|举手|举拳|挥拳|手势|动作|眼神)(?:来|以|作|进行|庄严地|坚定地|庄严|坚定)?$/.test(before)
            || /^(?:动作|姿态|手势)/.test(after)
            || /(?:挥臂|举臂|挥手|抬手|举手|举拳|挥拳|(?:举起|抬起|伸出)(?:左|右|双)?(?:手臂|手|臂))/.test(sentence)
              && !/(?:随后|然后|接着|之后|转而)/.test(sentence))) continue
        result.push({ kind, text: match[0] })
      }
    }
  }
  return result
}

function synchronousVoice(beat: Value, voice: Value, byId: Map<string, Value>): boolean {
  const beatId = string(beat.id), voiceId = string(voice.id)
  if (!beatId || !voiceId || !actors(beat.overlapAllowedWith).includes(voiceId) || !actors(voice.overlapAllowedWith).includes(beatId)) return false
  const follows = (from: Value, target: string, visited = new Set<string>()): boolean => actors(from.dependsOn).some(id => {
    if (id === target) return true
    if (visited.has(id)) return false
    visited.add(id)
    const parent = byId.get(id)
    return parent ? follows(parent, target, visited) : false
  })
  return !follows(beat, voiceId) && !follows(voice, beatId)
}

function coversScheduledAction(beat: Value, voices: Value[], schedule: unknown): boolean {
  // Authoring requires explicit mutual synchronization. At the provider
  // boundary the compiled clock also proves coverage, including any late tail.
  if (!Array.isArray(schedule)) return true
  const interval = (id: string) => {
    const rows = schedule.filter(row => record(row) && row.beatId === id)
    if (rows.length !== 1) return undefined
    const row = rows[0] as Value, start = row.startSecond, end = row.endSecond
    return typeof start === 'number' && typeof end === 'number' && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start ? { start, end } : undefined
  }
  const action = interval(string(beat.id))
  if (!action) return false
  const windows = voices.map(voice => interval(string(voice.id))).filter((value): value is { start: number; end: number } => Boolean(value)).sort((a, b) => a.start - b.start)
  let coveredUntil = action.start
  for (const window of windows) {
    if (window.start > coveredUntil + .001) break
    coveredUntil = Math.max(coveredUntil, window.end)
    if (coveredUntil >= action.end - .001) return true
  }
  return false
}

/** Reject missing authored voice roles before a provider can choose random
 * words or animate silent talking. This diagnoses only; never rewrites text. */
export function assertVoiceObligationCoverage(shot: Value, authoredBeats?: unknown): void {
  const pacing = record(shot.pacing) ? shot.pacing : {}
  const beats = (Array.isArray(authoredBeats) ? authoredBeats : Array.isArray(pacing.beats) ? pacing.beats : []).filter(record)
  const voices = beats.filter(beat => (beat.kind === 'speech' && beat.deliveryStyle !== 'narration' && string(beat.textOrVocalization).trim())
    || beat.kind === 'vocalization' && record(beat.vocalization) && string(beat.vocalization.vocalizationType).trim())
  const byId = new Map(beats.map(beat => [string(beat.id), beat]))
  // The compiler passes freshly normalized beats before computing their new
  // clock. Any schedule still on that draft belongs to its previous revision.
  const schedule = Array.isArray(authoredBeats) ? undefined : pacing.schedule ?? shot.schedule
  const missing: Array<{ beatId: string; actorIds: string[]; requiredVoice: string; obligation: string }> = []
  for (const beat of beats) {
    if (!['action', 'reaction'].includes(string(beat.kind))) continue
    const needed = [...obligations(beat.textOrVocalization), ...obligations(beat.performanceInstruction)]
    if (!needed.length) continue
    const actorIds = actors(beat.actorIds)
    for (const requirement of needed) {
      const uncovered = actorIds.filter(actor => {
        const synchronous = voices.filter(voice => actors(voice.actorIds).includes(actor)
          && (requirement.kind === 'call' || voice.kind === 'speech') && synchronousVoice(beat, voice, byId))
        return !synchronous.length || !coversScheduledAction(beat, synchronous, schedule)
      })
      if (!actorIds.length || uncovered.length) missing.push({ beatId: string(beat.id), actorIds: uncovered,
        requiredVoice: requirement.kind === 'call' ? 'speech 或明确无词 vocalization' : '带原台词的 speech', obligation: requirement.text })
    }
  }
  if (missing.length) throw Error('STORYBOARD_VOICE_OBLIGATION_MISSING: 动作正文要求实际发声，却没有对应演员的声部覆盖：'
    + JSON.stringify(missing) + '。按原剧情义务将讲话表演并入对应 speech，或让动作与同 actorIds 的声部互相声明 overlapAllowedWith，且实际声部时间窗须覆盖该讲话动作；不能用同角色此前说过的一句冒充后续讲话。保留完整原 audioText，无词呼唤可声明同步 vocalization。环境声音轨不能藏入词汇交谈，需先回到分镜明确原义务与音轨；不得静默删除交谈/呼唤、自动编造台词或交给视频模型随机发挥。')
}
