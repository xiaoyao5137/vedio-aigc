import { SCENE_CUT_FIRST_FRAME_PROMPT, SCENE_CUT_FRAME_REVIEW_PROMPT } from './scene-cut-first-frame-gate.ts'
import { sceneCutVisualChangeRequired } from './scene-cut-visual-change.ts'
import { sceneCutEstablishmentBeat } from './scene-cut-establishment.ts'

/** Schema 167 is staged separately from the active schema 166 reviewer. The
 * in-flight review keeps its original prompt and ledger contract until CAS. */
const IMAGE_ADDENDUM = `
【可见的操作起点、衣摆与无字背景·v3】逐条检查将绳、带、扣、结由松变紧或完成系结的必需视觉动作。零秒必须看见至少一处明确的松量、弧线或物体与束缚物之间的空隙，并看见操作端尚未拉成绷直的受力线；结或扣仍有可继续完成的步骤。已绕多圈、贴肤收口、结扣闭合或手到腕之间绳段直线绷紧的画面，不能冒充“待收紧”，即使文字写了“尚未收紧”也不行。把手和操作端放在镜头可见位置，让后续收紧能被拍到。每位人物只有一张从原人设正面派生的局部参考板：左部是头肩至腰的身份与上装，右部是腰部至衣摆、裤靴的下装细节；两块属于同一人，只复制发式、脸、衣甲、腰带、长袍下摆和鞋靴，不拼接成两个演员，也不复制原三视图的直立全身姿势。若画出下半身，下摆长度、层次与裤靴露出比例必须和局部参考一致。若已批准分镜禁止可读文字，旗帜、匾额、衣甲、兵器、墙面、道具和远景也不得有可辨汉字、字母或拟字形；改用纯色或无字纹样，不靠模糊/小字掩盖。`

const REVIEW_ADDENDUM = `
【收紧起点与背景文字逐项硬核对·v3】对每个 requiredThisClip 视觉动作，若动作要收紧、系结、拉紧或闭合绳带扣，且没有已批准的前置复位，requiredVisualActionChecks 对应项必须增加 manipulationStartCheck：{"applicable":true,"slackOrGapVisible":false,"operatingEndUntensioned":false,"unfinishedFastenerVisible":false,"pixelEvidence":"分别说明松量或空隙、未绷直操作端、尚未闭合结扣在画面何处"}。三项必须都由像素确认才可 true；绳已绕多圈不代表松，手腕间绳段直线绷紧、贴肤紧绕或无法看清结扣时一律 false。其他动作填 {"applicable":false}。若该动作有经过批准且排程在前的显式复位，按原复位规则审核，不伪造零秒松绳。
最外层增加 readableTextCheck：{"applicable":false,"backgroundInspected":false,"readableGlyphsPresent":false,"pixelEvidence":""}。若分镜明禁可读文字，applicable=true，逐一看背景旗帜、匾额、建筑、服装、兵器和道具；只要出现可辨文字或拟字形，或远景无法确认无字，readableGlyphsPresent=true 或 backgroundInspected=false，passed=false，issues 写出区域；无字时说明实见证据。不得只检查字幕/水印而放过场景内旗字。最外层还要有 wardrobeHemCheck：{"applicable":false,"originalHemAndFootwear":"原人设所见","candidateHemAndFootwear":"首帧所见","matches":false}。审核附件仍是原始三视图，生图时使用的局部参考板不能替代它；从三视图原图逐项比对袍摆长度、内层下摆、裤腿露出比例和鞋靴。首帧显出下半身或分镜要求全身时 applicable=true，匹配才填 matches=true，不可用脸相似代替衣摆一致。`

export const SCENE_CUT_FIRST_FRAME_PROMPT_V167 = SCENE_CUT_FIRST_FRAME_PROMPT
  .replace('身份参考仅裁取头肩上身，不提供站姿依据。',
    '身份参考由上身和下装两个局部拼成单张板，不提供完整站姿依据。') + IMAGE_ADDENDUM
export const SCENE_CUT_FRAME_REVIEW_PROMPT_V167 = SCENE_CUT_FRAME_REVIEW_PROMPT + REVIEW_ADDENDUM

type Value = Record<string, unknown>
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
const reject = (reason: string): never => { throw Error(`SCENE_CUT_FRAME_REJECTED: ${reason}`) }

/** The beat's approved action predicate. Later explanatory sentences often
 * mention a prior result or a maintained posture and must not create actions. */
export function sceneCutActionAnchor(beat: unknown) {
  const b = object(beat), completion = object(b.completion)
  if (typeof completion.evidenceAnchor === 'string' && completion.evidenceAnchor.trim())
    return completion.evidenceAnchor.trim()
  return typeof b.textOrVocalization === 'string'
    ? b.textOrVocalization.split(/[。；\n]/u)[0].trim() : ''
}

export function sceneCutManipulationStartRequired(beat: unknown) {
  const item = object(beat), completion = object(item.completion)
  if (item.kind !== 'action' || completion.requiredThisClip !== true) return false
  const description = sceneCutActionAnchor(item)
  return /收紧|拉紧|牵紧|系结|打结|结绳|系紧|绑紧|扎紧|捆紧|勒紧|扣紧|拧紧|束紧|绷紧|系牢|绑牢|扎牢|扣牢|扣合|闭合/.test(description)
    && /绳|带|扣|结|绑|捆|缚|束|扎|勒|腕|襟|鞋|靴/.test(description)
}

export function sceneCutStanceStartRequired(beat: unknown) {
  const b = object(beat)
  if (!sceneCutVisualChangeRequired(b) || sceneCutEstablishmentBeat(b)) return false
  // Later clauses can describe another actor's prerequisite (for example,
  // "the guards stand still before Zhang Fei steps"). Only the beat's own
  // leading action can demand a bent-knee zero-second stance.
  const text = sceneCutActionAnchor(b).split(/[。；\n]/u)[0]
  return /站稳|站直|站实|挺直|直起|起身|起立|踏稳/.test(text)
    && /站|背|脊|躯|身|脚|足|膝|腿|腰/.test(text)
}

export function sceneCutMovementStartRequired(beat: unknown) {
  const b = object(beat), completion = object(b.completion)
  if (b.kind !== 'action' || completion.requiredThisClip !== true) return false
  const text = sceneCutActionAnchor(b)
  return /押送|行走|步行|迈步|起步|走向|走去|前行|靠近|抵达|到达|入门|进门|跨门|跨过|离开|移至|转移/.test(text)
}

/** An active change from free limbs to bound limbs, as opposed to a shot that
 * merely establishes someone who is already bound. Kept separate from the
 * earlier tightening classifier so old signed plans remain byte-identical. */
export function sceneCutBindingFromUnboundRequired(beat: unknown) {
  const b = object(beat), completion = object(b.completion)
  if (b.kind !== 'action' || completion.requiredThisClip !== true) return false
  const text = sceneCutActionAnchor(b)
  return /(?:将|把|给)[^。；]{0,36}(?:缚住|绑住|捆住|扎住|束住)/u.test(text)
    || /^(?![^。；]{0,24}(?:已|被|仍|保持)[^。；]{0,10}(?:缚|绑|捆))[^。；]{0,20}(?:缚住|绑住|捆住)[^。；]{0,24}(?:腕|手|腿|足|脚)/u.test(text)
}

export function sceneCutGestureClosureStartRequired(beat: unknown) {
  const b = object(beat), completion = object(b.completion)
  if (b.kind !== 'action' || completion.requiredThisClip !== true) return false
  const text = sceneCutActionAnchor(b)
  return /(?:抬手|举手|挥手|示意)/u.test(text)
    && /(?:合拢|封住|封堵|堵住|围住|拦住|堵上)/u.test(text)
    && /(?:缺口|通道|退路|出口|道路|路口|空隙|口子)/u.test(text)
}

export function sceneCutApproachStartRequired(beat: unknown) {
  const b = object(beat), completion = object(b.completion)
  if (b.kind !== 'action' || completion.requiredThisClip !== true) return false
  return /(?:走到|走近|来到|趋近|移到)[^。；]{0,24}(?:面前|身边|身旁|旁边|跟前|近处)/u
    .test(sceneCutActionAnchor(b))
}

/** Feet need pixel-level inspection only when the approved framing exposes
 * them. A close shot still needs visible evidence that travel has not begun. */
export function sceneCutFeetInspectionRequired(shot: unknown) {
  const s = object(shot)
  const framing = [s.visualPrompt, s.camera, s.visualConstraints]
    .filter(value => typeof value === 'string').join(' ')
  return /全身|中全景|大远景|远景|脚掌|脚跟|双脚|两脚|足部|脚下|腿部|膝部|靴子可见|下半身/.test(framing)
}

export function sceneCutReadableTextForbidden(shot: unknown) {
  const s = object(shot)
  const text = [s.visualPrompt, s.negativePrompt, s.visualConstraints]
    .filter(value => typeof value === 'string').join(' ')
  return /(?:无|不得|不要|禁止|禁用|避免|不出现|不含)[^。！？；\n]{0,48}(?:可读|可识|文字|字幕|标题|水印|汉字|字母|标语|字形)/u.test(text)
}

/** Additional schema-167 hard gate. Call after the existing frame/ledger
 * validator when the persisted workflow uses the v167 prompt pair. */
export function validateSceneCutT0ImageContract(review: unknown, shot: unknown,
  options: { visualDetailsAdvisory?: boolean; uncertainManipulationAdvisory?: boolean } = {}) {
  const r = object(review), s = object(shot), pacing = object(s.pacing)
  const beats = Array.isArray(pacing.beats) ? pacing.beats as unknown[] : []
  const actionChecks = Array.isArray(r.requiredVisualActionChecks)
    ? r.requiredVisualActionChecks.map(object) : []
  const schedule = Array.isArray(pacing.schedule) ? pacing.schedule.map(object) : []
  const visualActions = beats.filter(sceneCutVisualChangeRequired)
  const byId = new Map(actionChecks.map(check => [String(check.beatId ?? ''), check]))
  if (r.passed !== true || visualActions.some(beat => !byId.has(String(object(beat).id ?? ''))))
    reject('逐节拍首帧审核不完整')
  for (const beat of visualActions) {
    const id = String(object(beat).id ?? ''), check = byId.get(id)
    if (!check) return reject(`缺少视觉动作 ${id} 的首帧审核`)
    if (!sceneCutManipulationStartRequired(beat)) continue
    if (check.approvedResetBeatId) {
      const reset = beats.find(item => object(item).id === check.approvedResetBeatId)
      const resetCompletion = object(object(reset).completion)
      const resetAt = Number(schedule.find(item => item.beatId === check.approvedResetBeatId)?.startSecond)
      const beatAt = Number(schedule.find(item => item.beatId === id)?.startSecond)
      if (!reset || !Array.isArray(resetCompletion.resetsBeatIds)
        || !resetCompletion.resetsBeatIds.includes(id)
        || !Number.isFinite(resetAt) || !Number.isFinite(beatAt) || resetAt >= beatAt)
        reject(`视觉动作 ${id} 的零秒复位依据无效`)
      continue
    }
    const start = object(check.manipulationStartCheck)
    const uncertain = options.uncertainManipulationAdvisory
      && start.uncertainStartAdvisory === true
      && check.terminalStateAlreadyPresent === false
      && check.actionStillPossible === true
      && start.slackOrGapVisible === true
      && start.operatorHandAndRopeEndsVisible === true
      && typeof start.visibilityEvidence === 'string' && start.visibilityEvidence.trim()
      && typeof start.pixelEvidence === 'string' && start.pixelEvidence.trim()
      && Array.isArray(r.advisoryIssues) && r.advisoryIssues.some(issue =>
        object(issue).beatId === id && /uncertain|not.verifiable|不明确/i.test(String(object(issue).code ?? '')))
    if (start.applicable !== true || start.slackOrGapVisible !== true
      || start.operatingEndUntensioned !== true || start.unfinishedFastenerVisible !== true
      || typeof start.pixelEvidence !== 'string' || !start.pixelEvidence.trim()) {
      if (uncertain) continue
      reject(`视觉动作 ${id} 缺少可见松量、未绷紧操作端或未完成结扣证据`)
    }
  }
  if (sceneCutReadableTextForbidden(s)) {
    const text = object(r.readableTextCheck)
    if (text.applicable !== true || text.backgroundInspected !== true
      || (options.visualDetailsAdvisory
        ? text.actualReadableTextPresent !== false
        : text.readableGlyphsPresent !== false)
      || typeof text.pixelEvidence !== 'string' || !text.pixelEvidence.trim()) {
      reject('分镜禁止可读文字，但背景文字审核未证明画面无字')
    }
  }
  const wardrobe = object(r.wardrobeHemCheck)
  const fullBodyRequested = /全身|中全景|远景|下半身|双脚|两脚|脚下|足部|腿部|下摆可见|衣摆可见/
    .test(`${String(s.visualPrompt ?? '')} ${String(s.camera ?? '')}`)
  if (fullBodyRequested && wardrobe.applicable !== true) reject('分镜需看下半身，但缺少衣摆鞋靴比对')
  if (wardrobe.applicable === true && ((!options.visualDetailsAdvisory && wardrobe.matches !== true)
    || typeof wardrobe.originalHemAndFootwear !== 'string' || !wardrobe.originalHemAndFootwear.trim()
    || typeof wardrobe.candidateHemAndFootwear !== 'string' || !wardrobe.candidateHemAndFootwear.trim())) {
    reject('首帧袍摆、裤腿或鞋靴与冻结人设不一致')
  }
  return true
}

type Node = { id: string; prompt?: string }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[]; edges: unknown[] }

/** Pure prompt-only migration. No UI hydration or runtime routing is enabled
 * until the in-flight schema-166 review has been resolved. */
export function upgradeSceneCutT0ImageContractWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || ![166, 167].includes(workflow.schemaVersion ?? 0)) return workflow
  const image = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-first-frame')
  const review = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-review')
  if (!image || !review
    || ![SCENE_CUT_FIRST_FRAME_PROMPT, SCENE_CUT_FIRST_FRAME_PROMPT_V167].includes(image.prompt ?? '')
    || ![SCENE_CUT_FRAME_REVIEW_PROMPT, SCENE_CUT_FRAME_REVIEW_PROMPT_V167].includes(review.prompt ?? '')) return workflow
  if (workflow.schemaVersion === 167 && image.prompt === SCENE_CUT_FIRST_FRAME_PROMPT_V167
    && review.prompt === SCENE_CUT_FRAME_REVIEW_PROMPT_V167) return workflow
  return { ...workflow, schemaVersion: 167, nodes: workflow.nodes.map(node => node.id === image.id
    ? { ...node, prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V167 } as N
    : node.id === review.id ? { ...node, prompt: SCENE_CUT_FRAME_REVIEW_PROMPT_V167 } as N : node) } as W
}
