type Value = Record<string, unknown>
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}

/** Compile the approved upstream boundary before buying a candidate. A writer
 * may repair its own fields, never rewrite approved scenes or completed media. */
export function storyboardContinuityContract(scene: Value, previous?: Value, options: { qualityDisposition?: unknown; warnings?: string[] } = {}) {
  const continuous = scene.continuityFromPrevious === true
  const requested = scene.continuityMode
  const conflict = (reason: string): never => { throw new Error(`STORYBOARD_INPUT_CONFLICT: ${reason}；scope=upstream；scene.id=${String(scene.id)}；请检查批准场景与前镜输入的一致性，当前分镜重生成不能修复锁定输入；不得改写已完成成片。`) }
  if (requested !== undefined && !['scene_cut', 'coverage_cut', 'tail_continuation'].includes(String(requested))) conflict(`scene.continuityMode=${String(requested)} 无效`)
  if (requested !== undefined && (continuous ? requested === 'scene_cut' : requested !== 'scene_cut')) conflict(`scene.continuityMode=${String(requested)} 与 scene.continuityFromPrevious=${String(scene.continuityFromPrevious)} 冲突`)
  if (continuous && !previous?.id) conflict('连续场景缺少 previousShot.id')
  const priorUnit = object(previous?.storyProgress).unitId
  const contentConflict = (reason: string) => {
    if (options.qualityDisposition === 'manual-review-v1') options.warnings?.push('STORYBOARD_INPUT_CONFLICT: ' + reason)
    else conflict(reason)
  }
  if (continuous && scene.dramaticUnitId && priorUnit && scene.dramaticUnitId !== priorUnit) contentConflict('连续场景与 previousShot.storyProgress.unitId 不同')
  if (continuous && scene.settingId && object(previous?.worldState).settingId && scene.settingId !== object(previous?.worldState).settingId) contentConflict('连续场景与前镜 worldState.settingId 不同')
  return {
    source: { sceneId: scene.id, continuityFromPrevious: continuous, requestedMode: requested,
      dramaticUnitId: scene.dramaticUnitId, settingId: scene.settingId, previousShotId: previous?.id ?? '' },
    allowedModes: continuous ? ['tail_continuation', 'coverage_cut'] : ['scene_cut'],
    firstFrameModes: continuous ? { tail_continuation: 'reuse_previous_tail', coverage_cut: 'reference' } : { scene_cut: 'reference' },
    bridgeTypes: continuous ? { tail_continuation: 'same_frame', coverage_cut: 'cut' } : { scene_cut: previous?.id ? 'cut' : 'opening' },
    openingEvidence: continuous ? 'inherit-verified-tail-or-unknown' : 'unknown-only',
    bridgeAnchorRule: previous?.id ? 'required-for-cut' : 'opening',
    repairScope: 'current-candidate',
  }
}

export function storyboardContinuityInstruction(scene: Value, previous?: Value, options: { qualityDisposition?: unknown; warnings?: string[] } = {}) {
  const contract = storyboardContinuityContract(scene, previous, options)
  return `\n【本次权威连续性契约】${JSON.stringify(contract)}\n以上源字段来自批准输入，不是要求你修改scene.continuityFromPrevious。当前候选continuity.mode只能取allowedModes内的值，按对应firstFrameModes与bridgeTypes同时修改firstFrameMode和bridgeType；previousShotId使用source.previousShotId。有前镜的cut必须在bridgeAnchor说明两镜具体剧情联系，不能留空；首镜使用opening。scene_cut必须使用reference，本镜开场worldState全部为unknown且不填事实value；上一镜人物、对白、尾帧仅作剧情背景，不能据此强行改成续拍或反打，也不能继承为本镜observed。连续模式按已有可信状态投影继承，未知保持未知。若需拆段，本契约仅适用于首段；其余段继承前一分段并按既有分段规则校验。修复范围包含候选continuity、firstFrameMode及开场状态，不限于pacing.beats；不得修改批准大纲、已完成前镜或删除本镜台词动作来过关。`
}

export function storyboardContinuityModeError(shot: Value, scene: Value, previous?: Value) {
  const contract = storyboardContinuityContract(scene, previous)
  const continuity = object(shot.continuity)
  if (contract.allowedModes.includes(String(continuity.mode))) return undefined
  return `STORYBOARD_CONTINUITY_INVALID: scope=current-candidate；field=continuity.mode；expected=${JSON.stringify(contract.allowedModes)}；candidate=${JSON.stringify(continuity.mode)}；source=scene.continuityFromPrevious=${String(scene.continuityFromPrevious)}；不要将批准输入改为true或false，修复当前候选的mode及对应firstFrameMode/bridgeType。`
}
