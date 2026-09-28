import { HISTORY_PACING_VERSION, historyTailSeconds, historyFrameTimes } from './history-pacing.ts'
import { crossingPositionIssue, expectedCrossingPositions } from './history-motion.ts'
import { appendLipSyncContract, normalizeStoryboardSpokenText } from './workflow-core.ts'
import { cleanStoryboardForValidation, storyboardCandidate, retryHistoricalText } from './storyboard-runtime.ts'
import { expectedEndPresentCharacters, isCinematicShot, validateCinematicOpeningReview, validateCinematicPresenceReview, validateObservedCinematicWorldState } from './history-cinema.ts'
import { isStaticIllustrationStyle } from './animation-shot.ts'

export const HISTORY_QUALITY_VERSION = '2026-09-27-no-subtitles-v62'

type RecordValue = Record<string, unknown>

export const CINEMATIC_WORLD_STATE_REVIEW_PROMPT = `cinematic-v1 的 characters/endCharacters 只列实际可见或行动者，presentCharacters 记录仍在现场的人；反打造成暂不入画不能声称离场。仅按当前图像能看到的实景锚点描述世界位置，不能把画面左/右或构图坐标写成世界位置；机位改变时屏幕左右变化本身不构成换位。实际尾帧必须附加 worldState:{settingId:"原 settingId",characters:[{name:"每个 presentCharacters 全名",position:{status:"observed",value:"相对门、案等实景锚点的位置",evidence:"实际帧证据"},heldProps:{status:"observed",value:"实际可见持物或明确空手",evidence:"实际帧证据"},pendingAction:{status:"unknown"}}]}。每项只能是带value/evidence的observed或只带status的unknown；看不清、画外或无法确认的当前状态写unknown，不以计划或此前画面补造实际尾帧。settingId是场所标识，不是机位。若continuity.exitingCharacters明确编排真实离场，不能只凭人物被裁切就认定离开；返回presentCharacters为实际末尾仍在场者（原presentCharacters减已完成真实离场者），worldState只覆盖此实际末尾名单。逐退出者返回presenceChecks:[{character:"退出者",status:"observed或incomplete或unobservable",evidence:"跨实际帧可见的离场过程",frameIndices:[至少两个不同实际帧编号0至5]}]；证据不足先复核，不要补造离场。没有真实退出则原场内名单继续保留。coverage_cut另返回continuityReview:{mode:"coverage_cut",passed:true或false,checks:[{character:"首帧可见人物",field:"position或heldProps或pendingAction",status:"observed或mismatch或unobservable",evidence:"首帧实际观察与继承事实的对照",frameIndices:[0]}]}，逐项核对开场worldState中已观察字段；画外人物不要求强行入镜。没有实景锚点时position是unknown，不能用屏幕左右充数。unobservable应补充采证或复核报告，不等于质量失败。`

export function validatePerformanceMediaReview(pacingReview: RecordValue, shot: RecordValue) {
  const beats = (shot.pacing as RecordValue)?.performanceBeats
  if (!Array.isArray(beats) || !beats.length) return
  const checks = pacingReview.performanceChecks
  if (!Array.isArray(checks) || checks.length !== beats.length
    || beats.some(beat => checks.filter(check => check?.beatId === beat.id).length !== 1)
    || checks.some(check => !check || !['observed', 'incomplete', 'unobservable'].includes(check.status)
      || typeof check.evidence !== 'string' || !check.evidence.trim()
      || typeof check.observedStateChange !== 'string' || !check.observedStateChange.trim()
      || !Number.isFinite(check.startSecond) || !Number.isFinite(check.endSecond) || check.startSecond < 0
      || check.endSecond <= check.startSecond || check.endSecond > Number(shot.duration)
      || !Array.isArray(check.frameIndices) || check.frameIndices.length < 2 || new Set(check.frameIndices).size < 2
      || check.frameIndices.some((index: unknown) => !Number.isInteger(index) || Number(index) < 0 || Number(index) > 5))) {
    throw new Error('VIDEO_REVIEW_INVALID: 表演留白必须逐节拍提供至少两个实际观察帧、可见状态变化和实际时间，不能复制计划证明表演完成')
  }
  if (checks.some(check => check.status === 'unobservable')) throw new Error('VIDEO_REVIEW_INVALID: 表演状态变化无法从采样证实，需要复核或补充采证，不能当作未发生而重拍')
  if (checks.some(check => check.status === 'incomplete')) throw new Error(`VIDEO_QUALITY_REJECTED: 表演节拍未完成 ${JSON.stringify(checks.filter(check => check.status === 'incomplete'))}`)
}

/** Review physical state transitions separately from long historical sources. */
export async function reviewStoryboardOpening(options: {
  candidate: RecordValue; previousTail: RecordValue
  generate: (prompt: string, frames: string[]) => Promise<unknown>
}) {
  const candidate = Array.isArray(options.candidate.__storyboardSegments) ? { segments: (options.candidate.__storyboardSegments as RecordValue[]).map(cleanStoryboardForValidation) } : cleanStoryboardForValidation(options.candidate)
  const prompt = `你只审核连续镜头的动作状态，不审史料或审美。附件是前镜实际尾帧。实际状态：${String(options.previousTail.endingState)}。从此状态按本镜时间轴逐步检查：已经垂下的手不能再次收回而没有先抬起，已经完成的递交不能重新递交，空手不能凭空有物，人物不能无动作换边或换手。表情审美不算错误。但本审核只判断原样执行是否成立：禁止替剧本省略、忽略、改写矛盾动作后判通过。如果手已垂下却写再次收回伸出的手，即使不影响主线，也必须canExecuteAsWritten=false，并给出局部修复，不能称轻微矛盾就放行。只能依据可见状态和明确动作，不能臆造缺失步骤。coverage_cut允许反打与重新构图，屏幕左右变化不代表人物世界位置变化；画外人物仍可在场，不能强制其入镜。开场worldState未知的关键持物或待完成动作不可由计划臆造；必须依赖时需先补充采证或调整拍法。当前第一段使用附件实际状态，若有后续预规划分段，按每段已写明的最后状态接着核对。只返回JSON {"passed":true或false,"issues":[{"problem":"具体状态矛盾","repair":"保留剧情的局部修复"}],"checks":[{"character":"人物全名","startingState":"实际开始状态","nextAction":"本镜后续动作","canExecuteAsWritten":true或false}]}。已采证世界状态：${JSON.stringify(options.previousTail.worldState ?? null)}。待审分镜：${JSON.stringify(candidate)}`
  const result = storyboardCandidate(await retryHistoricalText(() => options.generate(prompt, [String(options.previousTail.url)]))) as RecordValue
  if (typeof result.passed !== 'boolean' || !Array.isArray(result.issues) || !Array.isArray(result.checks)
    || !(options.previousTail.endCharacters as unknown[]).every(name => (result.checks as RecordValue[]).some(check => check.character === name && typeof check.startingState === 'string' && check.startingState.trim() && typeof check.nextAction === 'string' && check.nextAction.trim() && typeof check.canExecuteAsWritten === 'boolean'))) {
    throw new Error('HISTORY_REVIEW_INVALID: 缺少连续镜头逐人动作状态审核证据')
  }
  if (!result.passed || result.issues.length || (result.checks as RecordValue[]).some(check => check.canExecuteAsWritten !== true)) throw new Error(`HISTORY_CONTENT_REJECTED: 连续镜头动作状态矛盾 ${JSON.stringify({ issues: result.issues, checks: result.checks })}`)
  return { passed: true, checks: result.checks, previousTail: options.previousTail.url, scope: 'actual-tail-to-script-actions' }
}

/** A shot may contradict its own final hold even when it begins at a cut. */
export async function reviewStoryboardMotion(options: {
  candidate: RecordValue
  generate: (prompt: string) => Promise<unknown>
}) {
  const shots = (Array.isArray(options.candidate.__storyboardSegments) ? options.candidate.__storyboardSegments as RecordValue[] : [options.candidate]).map(cleanStoryboardForValidation)
  const endpoints = shots.map(shot => ({id:shot.id, actionEnd:Number(shot.duration)-historyTailSeconds(shot), duration:shot.duration, tailSeconds:historyTailSeconds(shot)}))
  const prompt = `只核对分镜内部的动作状态，不审史料、语速或审美。逐人从visualPrompt开始，只执行到每镜actionEnd之前的动作，先独立写下到达状态，再与最后保持段及lastFramePrompt比较。finalActionState禁止复制actionEnd之后尾帧要求，不能把待核对的目标当成已经执行过的动作。重点：已经收回的手不能在无重新抬手动作时仍指向对手；已经放下或交出的物件不能又持在手中；已经离场者不能无入场又出现。结尾仅留对应tailSeconds剪辑余量，不要求静止闭口；允许呼吸、回视、动作自然收束。普通叹息结束会自然闭口，禁止臆造必须显式编写闭口步骤。禁止替原文删除、忽略、改写矛盾后判通过。“收势”等歧义词若未明确收回手臂，不单凭该词断言矛盾；明确“收回手臂”后又“食指仍指向”则必须拒绝。自然表情、微小姿态差异不是硬错误。每个分镜的每个人物给出一项检查，仅返回JSON {"passed":true或false,"issues":[{"itemId":"分镜id","problem":"原文中冲突的动作及时间段","repair":"保留剧情和台词，仅统一动作结果与尾帧"}],"checks":[{"itemId":"分镜id","character":"全名","finalActionState":"按已写动作到达的状态","requestedEndState":"末段和尾帧要求的状态","canExecuteAsWritten":true或false}]}。时间预算：${JSON.stringify(endpoints)}。分镜：${JSON.stringify(shots)}`
  let correction = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = storyboardCandidate(await retryHistoricalText(() => options.generate(prompt + correction))) as RecordValue
  if (typeof result.passed !== 'boolean' || !Array.isArray(result.issues) || !Array.isArray(result.checks)
    || shots.some(shot => !Array.isArray(shot.characters) || shot.characters.some(name => !(result.checks as RecordValue[]).some(check => check.itemId === shot.id && check.character === name
      && typeof check.finalActionState === 'string' && check.finalActionState.trim() && typeof check.requestedEndState === 'string' && check.requestedEndState.trim() && typeof check.canExecuteAsWritten === 'boolean')))) {
    throw new Error('HISTORY_REVIEW_INVALID: 缺少逐镜逐人动作结果与尾帧核对证据')
  }
  const contradicted = (result.checks as RecordValue[]).every(check => check.canExecuteAsWritten === true) && (!result.passed || result.issues.length > 0)
  if (contradicted) {
    if (attempt === 0) { correction = '\n【只复核报告，不改写剧本】逐人检查全部canExecuteAsWritten=true却报告失败，结论自相矛盾。无实质矛盾时passed=true、issues=[]；有矛盾须给出对应false检查和具体冲突。上一报告：' + JSON.stringify(result); continue }
    throw new Error('HISTORY_REVIEW_INVALID: 动作审核报告自相矛盾，禁止让编剧为无需修复的问题重复改写')
  }
  if (attempt === 0 && (!result.passed || result.issues.length || (result.checks as RecordValue[]).some(check => check.canExecuteAsWritten !== true))) {
    correction = '\n【只复核失败报告，不改写剧本】逐项确认是否真有手已收回又伸出、物件换手无过程、人物未入场即出现等硬矛盾。自然叹息后闭口、轻微前倾或后仰、脸部表情变化不需要每一项都显式编排，不能据此拒绝；不能要求切点前静止。若只有这些微差应passed=true、issues=[]。真正不可执行的状态矛盾必须继续拒绝并提供false检查。上一报告：' + JSON.stringify(result)
    continue
  }
  if (!result.passed || result.issues.length || (result.checks as RecordValue[]).some(check => check.canExecuteAsWritten !== true)) throw new Error(`HISTORY_CONTENT_REJECTED: 分镜内部动作状态矛盾 ${JSON.stringify({ issues: result.issues, checks: result.checks })}`)
  return { passed: true, checks: result.checks, scope: 'script-actions-to-final-state' }
  }
  throw new Error('HISTORY_REVIEW_INVALID: 动作审核未完成')
}

export function characterAppearanceContext(assets: RecordValue[]) {
  const seen = new Set<string>()
  return assets.flatMap(asset => {
    const name = String(asset.characterName ?? '')
    if (!name || seen.has(name)) return []
    seen.add(name)
    const metadata = asset.metadata as RecordValue | undefined
    const profile = metadata?.visualProfile as RecordValue | undefined
    const appearance = profile?.appearance ? String(profile.appearance).trim().slice(0, 400)
      : String(metadata?.description ?? asset.description ?? '').split(/[。\n]/)[0].replace(/在画面[^，。；]*/g, '').trim().slice(0, 250)
    return [{ name, appearance, continuityKey: metadata?.continuityKey }]
  })
}

/** Shared by production and the real-media regression runner. The provider must
 * receive the validated ending as well as the opening and action timeline. */
export function historicalVideoPrompt(shot: RecordValue) {
  const audioText = String(normalizeStoryboardSpokenText(shot.audioType, shot.audioText))
  const staticIllustration = isStaticIllustrationStyle(shot.visualTreatment, shot.animationStyle)
  if (staticIllustration) return `【二维插画口播】${shot.visualPrompt}
【人物素材硬约束】人物插画内部姿态、表情、嘴部和衣物逐帧不变，不生成走路、转身、说话等肢体动画；只允许整个人物图层在历史背景上淡入、平移、缩放、淡出。历史场景插画只允许整幅画轻微二维移动或渐变。该路线不调用视频生成模型。
【独立画外旁白原文】${audioText}`
  const actionEnd = Number(shot.duration) - historyTailSeconds(shot)
  const crossing = expectedCrossingPositions(shot)
  const crossingPrompt = crossing.length ? `\n【必须完成的错身行走】${crossing.map(position => `${position.name}从画面${position.from}侧走到画面${position.to}侧`).join('；')}。两人在${actionEnd}秒前完成相向交错，各自走到对侧停住，目光朝各自离开方向，尾帧保留交换左右后的两人。` : ''
  return `【场景与开场实景】${shot.visualPrompt}
【场景真实性硬约束】生成有真实空间深度、自然光影的完整历史实景。人物附件仅定义身份与服装，忽略纯色底和三视图排版。
${appendLipSyncContract(String(shot.videoPrompt), String(shot.audioType), audioText, Array.isArray(shot.characters) ? shot.characters.map(String) : [], shot)}
${crossingPrompt}
【全片运镜】${shot.camera}
${isCinematicShot(shot) ? `【场内连续性】${(shot.continuity as RecordValue)?.mode === 'coverage_cut' ? '本镜为同场切镜，按本镜景别构图，允许人物在画外；屏幕左右变化不能擅自改变世界站位。' : ''}场内人物：${JSON.stringify(shot.presentCharacters)}。本镜可见或行动者：${JSON.stringify(shot.characters)}。只继承已观察的开场世界状态：${JSON.stringify(shot.worldState)}。未知状态不得自行补成已知；不重演已完成动作。` : ''}
【本镜结束时的自然动作结果】${String(shot.lastFramePrompt).split('【静态尾帧】')[0].trim()}
片尾必须保留上述人物、道具和空间关系，不能擅自切为单人脸部特写。动作有始有终，物件不凭空消失。最终构图不是定妆展示：人物保持剧本指定的对手视线与情绪，除非剧本明确要求看向镜头，不得在对白后转身面向观众摆拍。
人声类型：${shot.audioType}
${shot.audioType === '环境声' ? '【声音】仅生成剧本指定的环境声与动作声，全片没有对白或旁白；不能增加含糊人声。' : `【必须生成的同期人声原文】${audioText}`}`
}

export function historicalMediaReviewPrompt(shot: RecordValue) {
  return `附件依次为本片${historyFrameTimes(Number(shot.duration)).join("、")}秒。先从剧本visualPrompt提取每个姓名的服装与位置，再按可见服装辨认角色；绝不能按characters数组顺序从左到右猜姓名，也不能把两人的衣服互换后报告道具错位。依据可见证据审查：人物身份/服装、场景、剧情必需动作、道具归属和尾部构图是否符合剧本，有无凭空增减、拼贴、现代物件、明显肢体异常。尤其检查最后两帧是否保留全部 endCharacters 及 lastFramePrompt 所要求的关键道具和相互位置；单人特写丢失另一人或关键道具时不能作为规定的双人尾帧通过。无需逐像素相同，允许不影响剧情和续接的自然微差；青色可呈蓝绿范围，台阶高度、自然手指姿态等无关叙事细节只列warnings。不得宣称核对了未提供的声音或逐帧口型。
返回JSON {"passed":true或false,"issues":["具体不合格问题与对应帧"],"endingState":"以角色全名描述实际尾帧","endCharacters":["尾帧实际可见角色全名"]}。${isCinematicShot(shot) ? CINEMATIC_WORLD_STATE_REVIEW_PROMPT : ''}剧本：${JSON.stringify(cleanStoryboardForValidation(shot))}`
}

export function validateHistoricalMediaReview(review: RecordValue, shot: RecordValue) {
  if (typeof review.passed !== 'boolean' || !Array.isArray(review.issues) || !Array.isArray(review.endCharacters) || typeof review.endingState !== 'string' || !review.endingState.trim()) throw new Error('VIDEO_REVIEW_INVALID: 缺少实际尾帧审查证据')
  if (review.endCharacters.some(name => !Array.isArray(shot.characters) || !shot.characters.includes(name))) throw new Error('VIDEO_REVIEW_INVALID: endCharacters 只能列出角色汉字全名，不能用猜测或描述代替；额外陌生人放入 issues')
  const sameCast = Array.isArray(shot.endCharacters) && JSON.stringify([...shot.endCharacters].sort()) === JSON.stringify([...review.endCharacters].sort())
  if (review.issues.some(issue => /实际观察与.{0,25}完全一致|与剧本要求完全一致/.test(String(issue)))) throw new Error('VIDEO_REVIEW_INVALID: 审查将与剧本完全一致的观察列为错误，必须复核报告')
  if ((shot.pacing as RecordValue)?.version === HISTORY_PACING_VERSION) {
    const closure = review.narrativeClosure as RecordValue | undefined
    const progress = shot.storyProgress as RecordValue | undefined
    const pacing = review.pacingReview as RecordValue | undefined
    if (!closure || closure.unitId !== progress?.unitId || typeof closure.complete !== 'boolean'
      || typeof closure.actionEvidence !== 'string' || !closure.actionEvidence.trim()
      || typeof closure.responseEvidence !== 'string' || !closure.responseEvidence.trim() || !Array.isArray(closure.unresolvedActions)
      || !pacing || typeof pacing.passed !== 'boolean' || typeof pacing.reason !== 'string' || !pacing.reason.trim()
      || !Number.isFinite(pacing.lastMeaningfulActionSecond) || Number(pacing.lastMeaningfulActionSecond) > Number(shot.duration)) {
      throw new Error('VIDEO_REVIEW_INVALID: 缺少实际剧情完成及节奏审核证据')
    }
    const criteria = shot.completionCriteria
    const checks = closure.criteriaChecks
    if (!Array.isArray(criteria) || !criteria.length || !Array.isArray(checks) || checks.length !== criteria.length
      || criteria.some(criterion => checks.filter(check => check?.criterion === criterion).length !== 1)
      || checks.some(check => !check || !['complete', 'incomplete', 'unobservable'].includes(check.status)
        || typeof check.evidence !== 'string' || !check.evidence.trim())) {
      throw new Error('VIDEO_REVIEW_INVALID: 必须逐项核对原 completionCriteria，不能新增瞬间姿态作为剧情收束条件')
    }
    if (progress?.status === 'complete') {
      if (checks.some(check => check.status === 'unobservable')) throw new Error('VIDEO_REVIEW_INVALID: 剧情完成条件证据不足；补充观察，不能把未观察到当作实际未完成而购买重拍')
      const incomplete = checks.filter(check => check.status === 'incomplete')
      if (!incomplete.length && (closure.complete !== true || closure.unresolvedActions.length)) throw new Error('VIDEO_REVIEW_INVALID: 原剧情完成条件全部满足却报未收束，须复核报告')
      if (incomplete.length || closure.complete !== true || closure.unresolvedActions.length) throw new Error(`VIDEO_QUALITY_REJECTED: 动作或对手回应尚未完成，不能转场：${JSON.stringify(incomplete)}`)
    }
    validatePerformanceMediaReview(pacing, shot)
    if (!pacing.passed || Number(shot.duration) - Number(pacing.lastMeaningfulActionSecond) > 1.2) throw new Error('VIDEO_QUALITY_REJECTED: 拖慢语速或尾部空等，未达到自然紧凑节奏')
  }
  validateCinematicOpeningReview(shot, review)
  validateCinematicPresenceReview(shot, review)
  if (!review.passed || review.issues.length || !sameCast) throw new Error(`VIDEO_QUALITY_REJECTED: ${JSON.stringify({ ...review, ...(!sameCast ? { tailCastMismatch: true } : {}) })}`)
  return { ...review, scope: 'sampled-frames', lipSyncVerified: false }
}

export const FRAME_OBSERVATION_PROMPT = '只观察这唯一一张图片，不推测人物姓名、不猜剧情。按图片观众视角的左、右位置，逐人描述衣服主要颜色、帽子形状、手持物以及双手状态，并仔细观察领口与衣襟：交领还是圆领，有无成排扣襻与扣头、腰带或普通系带。只有看见才写，不能看清就说不清。只返回JSON {"people":[{"position":"画面左侧或右侧","clothing":"可见颜色与款式","headwear":"头部服饰","fastenings":"实际可见领口、衣襟、扣襻扣头或普通系带；不清楚就说不清","heldObject":"可见手持物或无","pose":"手臂和躯干姿态"}],"setting":"可见场景"}。'

/** Observe each image without the script first. Combining six images and the
 * desired story made the reviewer invent swapped identities and false failures. */
export async function reviewHistoricalMedia(options: {
  shot: RecordValue; frames: string[]; speechEvidence?: RecordValue
  generate: (prompt: string, frames: string[]) => Promise<unknown>
  observations?: RecordValue[]
}) {
  const observations: RecordValue[] = options.observations ? [...options.observations] : []
  // A six-request vision burst can exhaust a shared upstream pool. Finish each
  // pair before submitting more; an infrastructure failure must stop the batch.
  if (!options.observations) for (let start = 0; start < options.frames.length; start += 2) {
    const batch = await Promise.allSettled(options.frames.slice(start, start + 2).map(async (frame, offset) => {
      const value = storyboardCandidate(await retryHistoricalText(() => options.generate(FRAME_OBSERVATION_PROMPT, [frame]))) as RecordValue
      return { index: start + offset, frame, people: value.people, setting: value.setting }
    }))
    const failure = batch.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    observations.push(...batch.map(result => (result as PromiseFulfilledResult<RecordValue>).value))
  }
  if (observations.length !== options.frames.length || observations.some((row, index) => row.index !== index || !Array.isArray(row.people) || typeof row.setting !== 'string')) throw new Error('VIDEO_REVIEW_INVALID: 缺少完整逐帧观察，不能购买重拍来修复审查错误')
  // Judge the dramatic unit from its approved completion criteria and actual
  // evidence, without exposing incidental planned gestures as extra obligations.
  let narrativeEvidence: RecordValue = {}
  if ((options.shot.pacing as RecordValue)?.version === HISTORY_PACING_VERSION) {
    const closurePrompt = `【独立剧情收束与节奏检查】只核对下面列出的核心完成条件，不增加手指、点头或收手姿态条件。逐条保留条件原文，判断complete、incomplete或unobservable并写具体证据。口头回答条件可以由实际ASR证明；递交、接稳等物件动作必须有画面中物件归属变化的证据，不能用台词替代。未采样到瞬间点头不等于没有回应；不清楚是unobservable，不能当作incomplete。若全部原条件完成，complete=true且unresolvedActions=[]；否则列出原条件中尚未完成的事项。另判断是否拖腔或尾部超过1.2秒空等，最后必要动作或回应结束时间必须来自实际帧或ASR，不能由计划猜测。不核对逐帧口型。${Array.isArray((options.shot.pacing as RecordValue)?.performanceBeats) ? `本镜有无声表演义务：${JSON.stringify((options.shot.pacing as RecordValue).performanceBeats)}。仅凭purpose、stateChange计划不算已观察。pacingReview须增加performanceChecks:[{beatId:"原节拍id",status:"observed或incomplete或unobservable",evidence:"实际画面证据",observedStateChange:"从实际可见状态到后状态",startSecond:实际开始,endSecond:实际结束,frameIndices:[至少两个不同的实际观察帧编号0至5]}]，每项恰好一次；重复静帧没有状态变化不能称有意义留白。采样无法辨认时标unobservable，不能当作未发生购买重拍。` : ""}
只返回JSON {"narrativeClosure":{"unitId":"原单元id","complete":true或false,"actionEvidence":"实际动作证据","responseEvidence":"实际回应证据","unresolvedActions":[],"criteriaChecks":[{"criterion":"原条件","status":"complete或incomplete或unobservable","evidence":"实际证据"}]},"pacingReview":{"passed":true或false,"reason":"实际节奏依据","lastMeaningfulActionSecond":实际秒数}}。
单元id：${String((options.shot.storyProgress as RecordValue)?.unitId)}；原完成条件：${JSON.stringify(options.shot.completionCriteria)}；实际片长：${options.shot.duration}；抽帧时刻：${JSON.stringify(historyFrameTimes(Number(options.shot.duration)))}；身份与空间线索：${options.shot.visualPrompt}；原台词角色绑定：${options.shot.audioText}；实际ASR：${JSON.stringify(options.speechEvidence ?? null)}；无剧情独立观察：${JSON.stringify(observations)}`
    const assessed = storyboardCandidate(await retryHistoricalText(() => options.generate(closurePrompt, []))) as RecordValue
    narrativeEvidence = { narrativeClosure: assessed.narrativeClosure, pacingReview: assessed.pacingReview }
  }
  const prompt = `依据以下逐帧独立观察对照剧本，不再猜图片中不存在的信息。帧顺序为${historyFrameTimes(Number(options.shot.duration)).join("、")}秒。先以服装与站位将每个无名观察对象映射至角色汉字全名；不要按characters数组顺序猜左右。每条issues必须引用具体帧的观察证据且不能与证据自相矛盾。只拒绝影响剧情使用的明确错误（角色缺失、身份/道具归属错乱、动作缺失、尾帧丢失关键状态、明显现代场景）；蓝青灰等自然色差、手指微姿态、台阶高度微差列warnings。视线和微表情没有被观察到不等于没有发生，不能当作失败。道具的叙事用途由剧本定义：图像观察中的纸张、文书、书卷与剧本的拜帖是同类物件，不能因观察未使用“拜帖”这个功能名称就判失败。手持物“悬空/悬停”指手持伸出停留，不是要求物件自行漂浮；单帧观察中的“递出、前伸”是姿态描述，不能据此断言尾帧仍在运动。实际左右、服色、持物人与剧本相同时必须认定一致，不得把相符证据列为错误。东汉服装还要检查领襟：若观察明确显示清式/近代式成排盘扣（横向扣襻与扣头），属于时代错误，不能因脸与颜色一致就放行；普通腰带或两条系带打结不是盘扣，单纯圆领不能作为年代错误。明确的时代错误列issues并要求保留脸、服色和剧情，只修正扣襟。不得宣称已检验声音或逐帧口型。\n只返回JSON {"passed":true或false,"issues":["有证据的问题"],"endingState":"使用汉字全名描述实际尾帧","endCharacters":["实际尾帧可见的角色汉字全名"]}。\n${Object.keys(narrativeEvidence).length ? `剧情收束与节奏已经按原完成条件单独核对，报告为${JSON.stringify(narrativeEvidence)}。你仍独立检查角色、场景、道具、明确动作错乱和实际尾帧；不要将未拍到附带点头、不可见的一只手等未知微差升级成未完成核心剧情。无证据的微差放warnings，实际道具归属或身份错乱仍须拒绝。不得将“此前错误指控已经纠正”放入issues；issues仅保留当前有证据的真实问题。无需重写narrativeClosure或pacingReview。` : ""}\n实际语音转写证据：${JSON.stringify(options.speechEvidence ?? null)}。这是ASR结果，不是逐帧口型证明；时间偏移本身不是剧情错误，只有观察证明它导致对白/动作先后矛盾才列issues。仍严格检查角色、完整动作、道具和尾帧，不能因台词正确就放行画面错误。\n独立观察：${JSON.stringify(observations)}\n${isCinematicShot(options.shot) ? CINEMATIC_WORLD_STATE_REVIEW_PROMPT : ""}\n剧本：${JSON.stringify(cleanStoryboardForValidation(options.shot))}`
  let correction = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const value = storyboardCandidate(await retryHistoricalText(() => options.generate(prompt + correction, []))) as RecordValue
    try {
      const accepted: RecordValue = validateHistoricalMediaReview({ ...value, ...narrativeEvidence }, options.shot)
      // The comparison above sees the desired ending and can copy its pose into
      // its report. Extract continuation state separately, without that ending.
      const frame = options.frames.at(-1)!
      const tailPrompt = `【实际尾帧状态提取】只描述附件这一张实际尾帧，不评价是否符合剧情。根据服装匹配角色姓名；角色线索中的初始站位、姿态不得当作现在的事实。只写实际可见的位置、服装、双手、持物与身体朝向，不能看清的手不指定左右；背景路人不命名。不得补上看不见的举手、指向或道具。返回JSON {"endingState":"使用角色汉字全名描述实际画面","endCharacters":["实际可见角色全名"]}。角色名单：${JSON.stringify(options.shot.characters)}。身份匹配线索：${String(options.shot.visualPrompt)}。该帧独立观察：${JSON.stringify(observations.at(-1))}。${isCinematicShot(options.shot) ? `只需世界状态和尾帧，不重做continuityReview；末尾仍在场名单：${JSON.stringify(expectedEndPresentCharacters(options.shot))}，settingId=${String((options.shot.worldState as RecordValue)?.settingId)}。${CINEMATIC_WORLD_STATE_REVIEW_PROMPT}` : ""}`
      const tail = storyboardCandidate(await retryHistoricalText(() => options.generate(tailPrompt, [frame]))) as RecordValue
      const cast = tail.endCharacters
      if (typeof tail.endingState !== 'string' || !tail.endingState.trim() || !Array.isArray(cast)
        || JSON.stringify([...cast].sort()) !== JSON.stringify([...(accepted.endCharacters as string[])].sort())
        || cast.some(name => typeof name !== 'string' || !tail.endingState!.toString().includes(name))) throw new Error('VIDEO_REVIEW_INVALID: 实际尾帧状态提取缺少完整人物或可见状态')
      const crossingIssue = crossingPositionIssue(options.shot, tail.endingState.trim())
      if (crossingIssue) throw new Error(crossingIssue)
      const worldState = isCinematicShot(options.shot) ? validateObservedCinematicWorldState(tail.worldState, options.shot, cast) : undefined
      return { ...accepted, endingState: tail.endingState.trim(), endCharacters: cast, ...(worldState ? { worldState, presentCharacters: expectedEndPresentCharacters(options.shot) } : {}),
        endingStateEvidence: { method: 'actual-tail-image', frame }, observations, method: 'independent-frame-observation-then-script-comparison' }
    } catch (error) {
      if (!(error instanceof Error) || (!error.message.startsWith('VIDEO_REVIEW_INVALID:') && !error.message.startsWith('VIDEO_QUALITY_REJECTED:')) || attempt) throw error
      correction = `\n【独立复核失败判定，不要沿袭上一版结论】检查上一版每条指控是否确有观测与剧情之间的实质矛盾。相符的左右/服色不能判错误；文书与拜帖是同类道具；前伸是静态姿态，不证明尾帧在动；不可观测的微差不能充当不合格证据。若存在真实错乱仍须拒绝，不能为了通过忽略问题。返回完整修正报告。上一版：${JSON.stringify(value)}`
    }
  }
  throw new Error('VIDEO_REVIEW_INVALID: 审查报告未完成')
}

/** Retry only a completed, demonstrably rejected take. Transport, transcription
 * runtime and reviewer errors must not accidentally purchase another video. */
export async function generateAcceptedHistoricalVideo(options: {
  shot: RecordValue
  generate: (prompt: string, attempt: number) => Promise<RecordValue>
  inspect: (video: RecordValue, attempt: number) => Promise<RecordValue>
  review: (inspection: RecordValue, attempt: number) => Promise<RecordValue>
  onRejected?: (report: RecordValue) => Promise<void>
}) {
  const attempts: RecordValue[] = []
  let feedback = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = historicalVideoPrompt(options.shot) + feedback
    const video = await options.generate(prompt, attempt)
    try {
      const inspected = await options.inspect(video, attempt)
      const review = validateHistoricalMediaReview(await options.review(inspected, attempt), options.shot)
      return { ...inspected, visualReview: review, extractedLastFrameUrl: inspected.lastFrameUrl,
        audioEmbedded: inspected.hasAudio, raw: video, prompt, qualityAttempts: [...attempts, { attempt: attempt + 1, passed: true }] }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.startsWith('VIDEO_QUALITY_REJECTED:')) throw error
      const report = { attempt: attempt + 1, passed: false, error: message, providerResult: video }
      attempts.push(report)
      await options.onRejected?.(report)
      if (attempt === 1) throw new Error(`成片两次未通过实际验收，已停止后续镜头：${message}`, { cause: error })
      feedback = `\n【上次成片的具体失败，重新拍摄时修正】${message.slice(0, 550)}\n保留所有原剧情、台词、角色身份与首尾构图。严格遵守台词时间窗，不增加对白或抢先发声。不得删除困难动作来规避检查。`
    }
  }
  throw new Error('成片未通过验收')
}
