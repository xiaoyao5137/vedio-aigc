import { createHash } from 'node:crypto'
import { sceneCutActionAnchor, sceneCutApproachStartRequired,
  sceneCutBindingFromUnboundRequired, sceneCutFeetInspectionRequired,
  sceneCutGestureClosureStartRequired, sceneCutManipulationStartRequired,
  sceneCutStanceStartRequired, sceneCutMovementStartRequired } from '../src/scene-cut-t0-image-contract.ts'
import { sceneCutVisualChangeRequired } from '../src/scene-cut-visual-change.ts'

type Value = Record<string, unknown>
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value ?? null)
}

const actionSection = /(?:连续(?:实拍)?动作|镜头内(?:连续)?动作|后续(?:实拍)?动作(?:锚点)?|后续表演|动作过程|动作执行|表演过程)\s*[：:]/u
const temporalOrAction = /随后|之后|末尾|最终|期间|起步后|收紧|系结|拉紧|押送|步行|迈步|行走|抵达|到达|跨过|跨入|走向|走去|踏稳|挺直|交接|举起|放下/u
const movingCamera = /期间|随后|之后|完成.{0,16}后|起步后|跟移|跟拍|跟摇|摇移|推进|推近|拉近|转向|越过轴线|走近|走到|俯身/u

/** Lossless shot binding remains in the plan hash. This projection sends only
 * static setup to image generation, never future beat prose or final states. */
function imageOnlyOpeningProjection(staticScene: string, shot: Value, beats: Value[], contractVersion: 3 | 4 = 3) {
  let projected = staticScene
  // A clause such as “the rope has been wrapped, the knot awaits tightening”
  // is a process description, not a reliably visible static pose. The approved
  // text and its hash stay intact; the beat-derived opening plan supplies the
  // precise loose structure to the still-image model instead.
  if (beats.some(sceneCutManipulationStartRequired)) {
    projected = projected.replace(/(?:[，,])[^，,；;。]{0,64}(?:绳|带|扣|结|绑|捆|缚|束)[^，,；;。]{0,64}已(?:经)?(?:绕|缠|系|扣|绑)[^，,；;。]{0,64}(?:尚待|尚未|待)[^，,；;。]{0,32}(?:收紧|拉紧|系紧|闭合)[^，,；;。]*/gu, '')
    // “双腕已缚” reads as a finished tight binding to image models even when
    // a later beat explicitly tightens an open loop. Keep the approved shot and
    // hash; project only the neutral placement into the image-only setup.
    if (beats.some(beat => sceneCutManipulationStartRequired(beat)
      && /腕|手/.test(sceneCutActionAnchor(beat)))) {
      projected = projected.replace(/双腕已(?:被)?(?:绳|绳索)?(?:缚|绑|捆)(?:于|在)身前/gu,
        '双腕并置于身前')
      if (contractVersion === 4) projected = projected.replace(
        /双腕在身前已有(?:绳|绳索|绳带)(?:束缚|捆绑|绑缚)/gu,
        '双腕并置于身前，绳圈尚宽松敞开')
    }
  }
  // Keep the approved location while avoiding a finished erect stance in the
  // image model's static setup. The actual shot text remains unchanged.
  if (beats.some(sceneCutStanceStartRequired)) {
    const names = Array.isArray(shot.characters) ? shot.characters : []
    for (const name of names) {
      if (typeof name !== 'string' || !name.trim()) continue
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      projected = projected.replace(new RegExp(`${escaped}(?:站在|站于|立于)`, 'gu'),
        `${name}位于`)
    }
  }
  return projected.replace(/[，,]{2,}/gu, '，').replace(/[，,](?=[；;。])/gu, '').trim()
}

export function sceneCutOpeningVisualContext(shot: unknown, contractVersion: 2 | 3 | 4 = 2) {
  const s = object(shot), pacing = object(s.pacing)
  const visual = typeof s.visualPrompt === 'string' ? s.visualPrompt.trim() : ''
  const marker = actionSection.exec(visual)
  let staticScene = marker ? visual.slice(0, marker.index).trim() : ''
  if (!marker) {
    const beats = Array.isArray(pacing.beats) ? pacing.beats.map(object) : []
    const anchors = beats.filter(beat => object(beat.completion).requiredThisClip === true)
      .map(sceneCutActionAnchor).filter(anchor => anchor.length >= 4)
    const anchorAt = anchors.map(anchor => visual.indexOf(anchor)).filter(at => at >= 0)
    const safePrefix = visual.slice(0, anchorAt.length ? Math.min(...anchorAt) : visual.length)
    const clauses = safePrefix.split(/(?<=[。；])/u)
    const firstActionClause = clauses.findIndex(clause => temporalOrAction.test(clause))
    staticScene = clauses.slice(0, firstActionClause < 0 ? clauses.length : firstActionClause).join('').trim()
  }
  const camera = typeof s.camera === 'string' ? s.camera.trim() : ''
  const staticCamera: string[] = []
  for (const clause of camera.split(/(?<=[。；])/u)) {
    if (movingCamera.test(clause)) break
    staticCamera.push(clause)
  }
  const openingCamera = staticCamera.join('').trim()
  if (!staticScene || !openingCamera) throw Error('SCENE_CUT_OPENING_PLAN_INVALID: 缺少可安全提取的静态场景或初始机位')
  const beats = Array.isArray(pacing.beats) ? pacing.beats.map(object) : []
  return { staticScene: contractVersion >= 3
    ? imageOnlyOpeningProjection(staticScene, s, beats, contractVersion === 4 ? 4 : 3) : staticScene, openingCamera,
    namedCharacters: Array.isArray(s.characters) ? s.characters : [],
    characterEquipment: s.characterEquipment ?? [] }
}

/** Deterministic, shot-bound image directions. This describes only the
 * approved action's visible starting state and never adds a new beat. */
export function deriveSceneCutOpeningPlan(shot: unknown, contractVersion: 1 | 2 | 3 | 4 = 1) {
  const s = object(shot), pacing = object(s.pacing)
  const beats = Array.isArray(pacing.beats) ? pacing.beats.map(object) : []
  const schedule = Array.isArray(pacing.schedule) ? pacing.schedule.map(object) : []
  if (object(s.continuity).mode !== 'scene_cut' || s.visualTreatment !== 'live_action'
    || typeof s.id !== 'string' || !s.id || !Array.isArray(pacing.beats))
    throw Error('SCENE_CUT_OPENING_PLAN_INVALID: 缺少已批准真人换场分镜')
  const actions = beats.filter(sceneCutVisualChangeRequired)
    .map(beat => ({ beat, at: Number(schedule.find(item => item.beatId === beat.id)?.startSecond ?? 0) }))
    .sort((a, b) => a.at - b.at)
  const feetInspectionRequired = sceneCutFeetInspectionRequired(s)
  const requirements = actions.map(({ beat, at }) => {
    const categories: string[] = [], visibleT0: string[] = []
    const reset = actions.find(item => item.at < at && Array.isArray(object(item.beat.completion).resetsBeatIds)
      && (object(item.beat.completion).resetsBeatIds as unknown[]).includes(beat.id))
    if (reset) {
      return { beatId: beat.id, approvedAction: beat.textOrVocalization ?? '',
        approvedFinalState: object(beat.completion).finalState ?? '',
        categories: ['approved_prior_reset'], visibleT0: [], approvedResetBeatId: reset.beat.id }
    }
    const bindingFromUnbound = contractVersion >= 3 && sceneCutBindingFromUnboundRequired(beat)
    if (bindingFromUnbound) {
      categories.push('binding_from_unbound')
      visibleT0.push('待缚的双腕或肢体尚未被绳带围住，彼此仍可辨出分开的轮廓；绳索在操作者手里且与肢体分离，绕绳和结绳都有清楚可拍的余地')
      visibleT0.push('操作端自然松垂，未牵紧、未闭结；保持批准的双腕和操作者位置，不把后续并腕、绕绳、收紧提前画进首帧')
    } else if (sceneCutManipulationStartRequired(beat)) {
      categories.push('fastener_tightening')
      if (contractVersion >= 3) {
        const anchor = sceneCutActionAnchor(beat)
        const rope = /绳|捆|绑|缚/.test(anchor)
        const wrist = /腕|手/.test(anchor)
        visibleT0.push(rope
          ? wrist
            ? '一条绳在双腕外侧形成一个宽大而敞开的圈，双腕已经在圈内；圈的主体离腕有清楚可见、至少两指宽的空隙，圈口与未完成的结形同框可见'
            : '一条绳在待束部位外侧形成宽大而敞开的圈；圈的主体离待束表面有清楚可见的空隙，圈口与未完成的结形同框可见'
          : '待收紧的带或扣在目标表面外侧保持敞开，扣眼、穿入口与表面间的空隙同框可见')
        visibleT0.push('操作端由手握住但未牵紧，自由端未穿回、结扣未闭合；束缚处本体的可见空隙不能用外段下垂代替')
      } else if (contractVersion === 2) {
        visibleT0.push('束缚处本体与皮肤或道具表面之间有清楚可见的松圈空隙；若为腕绳，绳圈离腕且未多圈贴紧')
        visibleT0.push('尚未闭合的活结、扣眼或收口与未穿回的自由端一起可见，操作人仍握住未牵紧端')
        visibleT0.push('束缚处本体的松圈、敞开的结口与未穿回自由端同处可见，绳圈与表面仍有空隙')
      } else {
        visibleT0.push('束缚物或结扣与目标表面之间留有镜头可见的空隙或松圈，不能贴紧')
        visibleT0.push('操作人握住尚未牵紧的自由端，操作端呈自然下垂的弧线，不是一条拉直的受力线')
        visibleT0.push('活结、扣眼或收口仍敞开，留出可拍到的穿入、拉紧或锁合步骤；仅外段垂弧而腕圈已紧不合格')
      }
    }
    if (contractVersion >= 3 && sceneCutGestureClosureStartRequired(beat)) {
      categories.push('gesture_gap_closure')
      visibleT0.push('发出封堵指令的人手臂仍在低位，抬手示意尚未开始；守卫停在批准的起始两侧位置，待封堵的缺口仍清楚敞开，后续合拢动作有画面空间')
    }
    if (sceneCutStanceStartRequired(beat)) {
      categories.push('stance_straightening')
      const source = sceneCutActionAnchor(beat)
      if (/脚|足|腿|膝|踏|站稳|站实/.test(source))
        visibleT0.push(contractVersion >= 2
          ? feetInspectionRequired
            ? contractVersion >= 3
              ? '双脚脚掌与脚跟全落地，双膝均明显屈曲、臀部略低且重心偏移，人物在原地不迈步；膝部与足部完整处于画幅内'
              : '双脚脚掌与脚跟都仍接地，至少一膝微屈且重心偏移，身体仍在原地'
            : '在已批准画幅内表现未稳重心或肩胯偏移；镜头外双脚仍原地，不扩大画幅去强拍脚部，也不表现已迈步'
          : '至少一膝明显微屈，双足受力尚不均衡或一脚尚在调整，重心没有完全站稳')
      if (/背|脊|躯|身|腰|挺直|直起/.test(source))
        visibleT0.push(contractVersion >= 3
          ? '头与双肩明显前倾、背脊尚未伸直，脸与衣甲可见；躯干留有清楚可拍的挺直幅度'
          : '上身明显前倾或背脊尚未伸直，脸与衣甲仍可见，后续有可拍到的挺直幅度')
      visibleT0.push(contractVersion >= 2
        ? '屈膝与前倾保持原地静止，双足承重且不呈行走步态'
        : '不得把双腿伸直、双足站定、背脊垂直的终态当作踏稳挺直动作起点')
    }
    if (sceneCutMovementStartRequired(beat)
      || contractVersion >= 3 && sceneCutApproachStartRequired(beat)) {
      categories.push('travel_to_target')
      if (contractVersion >= 2) {
        visibleT0.push(feetInspectionRequired
          ? '所有参与移动者静止在批准的出发位置，双脚脚掌与脚跟均接地，牵引人与被牵引人都尚未起步'
          : '所有参与这段移动的人仍静止在批准的出发位置；从已批准画幅中的肩胯、牵引物和站位可见尚未迈步或牵行，不为看脚而改变构图')
        visibleT0.push('目的地尚未到达，出发位置与目标之间留有可转身或行走的开放空间，起始朝向可背对目的地')
        if (contractVersion >= 3 && sceneCutApproachStartRequired(beat)) {
          const separation = String(s.visualPrompt ?? '').match(/相距[^，；。]{1,18}/u)?.[0]
          visibleT0.push(separation
            ? `走近动作尚未开始，移动者和目标保持批准的起始间距“${separation}”，未在目标面前站定`
            : '走近动作尚未开始，移动者与目标保持批准的起始距离，未在目标面前站定')
        }
      } else {
        visibleT0.push('人物仍在本节拍出发位置，目的地与现站位之间留有画面可辨的地面路径和距离')
        visibleT0.push('若终点是门、台阶或交接点，起点须在其外且未到达；后续连续行走仍可被拍到')
      }
    }
    return { beatId: beat.id, approvedAction: beat.textOrVocalization ?? '',
      approvedFinalState: object(beat.completion).finalState ?? '', categories, visibleT0,
      approvedResetBeatId: '' }
  })
  return { version: `scene-cut-opening-plan-v${contractVersion}`, shotId: s.id,
    shotSha256: createHash('sha256').update(canonical(shot)).digest('hex'),
    scheduleHash: typeof pacing.scheduleHash === 'string' && pacing.scheduleHash
      ? pacing.scheduleHash : createHash('sha256').update(canonical(schedule)).digest('hex'),
    ...(contractVersion >= 2 ? { openingVisualContext: sceneCutOpeningVisualContext(s,
      contractVersion === 4 ? 4 : contractVersion === 3 ? 3 : 2) } : {}),
    positiveOpeningDescription: requirements.flatMap(item => item.visibleT0).join('；'),
    requiredVisualActions: requirements }
}
