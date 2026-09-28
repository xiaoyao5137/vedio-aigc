import { MEDIA_REQUIREMENT_SCOPE_RULES } from './media-review-rubric.ts'
import { MEDIA_EVIDENCE_GAPS_PROMPT } from './media-evidence-gaps.ts'
/** A single complete contract replaces the accumulated shipped review clauses.
 * Explicit shot inputs keep prior script-review verdicts outside this review. */
export const CANONICAL_MEDIA_REVIEW_PROMPT = `【独立成片验收完整契约 v1】
审查原图、实际ASR及程序数值；剧本、观察草稿和旧报告不是实证。最后判定，输出完整JSON。
${MEDIA_REQUIREMENT_SCOPE_RULES}
${MEDIA_EVIDENCE_GAPS_PROMPT}
【输入】
门禁政策：\${params.reviewPolicy}
原要求清单：\${media_metrics.requirements}
预算：\${media_metrics.policy}
逐句实测：\${media_metrics.speech}
尾部余量：\${media_metrics.tailTiming}
单元必须完成：\${media_metrics.unitCompletionRequired}；后续事项：\${media_metrics.deferredActions}
完成条件[sourcePath=completionCriteria]：\${media_metrics.unitCriteria}
音视频实证：\${video_evidence}
契约版本：\${shot_script.contentContractVersion}
音轨：\${shot_script.audioType}；原台词：\${shot_script.audioText}
入镜：\${shot_script.characters}；预期尾帧：\${shot_script.endCharacters}；在场：\${shot_script.presentCharacters}
连续性：\${shot_script.continuity}
开场状态：\${shot_script.worldState}
表演节奏[可引sourcePath=pacing.performanceBeats/pacing.activityWindows]：\${shot_script.pacing}
剧情进展[sourcePath=storyProgress]：\${shot_script.storyProgress}
【采证和原要求】
阈值用reviewPolicy/metrics.policy。frameIndices为本次evidence.frames的0起审核编号，时刻取frameTimes；nativeFrameIndex为解码索引，不能混用。sequence-grid逐格查看，cells.evidenceIndex定位原帧，附件号不是帧号；无缩放JPEG仍有再次编码，细节不清保留未知。连续覆盖限nativeSequence.windows及实际PTS，不声称全片逐帧观察；直看首尾，裁剪不是新的时间帧。
requirementChecks逐清单id恰好一项，按原路径/引文/scope/时间核对。complete须实帧确证，incomplete须确证不符，有未知unobservable。evidence写实见与帧时间；无可用帧时[]且unobservable。
opening只用首帧，ending只用实际最后一帧；interval/whole-shot帧限原范围加timingTolerance，不混窗外上下文。明确持续姿态/尾帧物件实际丢失须incomplete，微差容许不能豁免明确宏观义务。不能从局部时间窗或开场状态外推全片；允许第一帧已经成立，明写变化才查过程。
混合时间窗分开记录实见事实与未知。ASR不证姿态；对白早于计划不构成缺陷或新的语速阈值，违反明确声画先后义务除外。
incomplete必须有defectIndex，绑定同原要求的confirmed、category=script、source=frame缺陷及有效issueIndex，路径/scope相同、引文/帧有效。requirementChecks不允许repair；只用defectEvidence.repair。不得用未绑定incomplete触发重拍或绕过语音阈值；coverage只复用已验证issue、不产生repair。其它status省略defectIndex。
【剧情画面】
visualChecks逐characters全名核对可见身份，不按数组猜左右。actualObjectsByFrame按index覆盖全帧，objects写双手可见性与持物/空手/unknown归属。持物需接触/轮廓/归属实证，附近线条非证明，未证实不等于空手。expectedObjects限原范围；consistent=false须确证，关键未知入requirementChecks。真实角色/道具/关键动作/时代/画面缺陷拒绝，非关键外观仅warnings。
endingState/endCharacters写末帧实态/可见全名并查预期缺人；evidence非空，reference定位实帧/ASR，ASR不证口型。
narrativeClosure.unitId同storyProgress；criteriaChecks逐字覆盖unitCriteria，填complete/incomplete/unobservable及实证。actionEvidence/responseEvidence非空，台词不证明动作，不增原条件外回应。unresolvedActions仅原条件；须收束时全完成且无未决项才complete=true；剧情继续不免本镜义务。
【声音与节奏】
speechChecks逐metrics.speech原text填assessment=natural/slow/uncertain，reason引elapsed/allowedSpan/timingAssessment。allowedSpan已含停顿容差，within-allowance不得slow；ASR字形/同音字、覆盖率或低概率不独证错音/漏词。
tailTimingCheck.assessment用程序值，reason引数值区间，余量不须等于目标。环境声speechChecks=[]、tailTiming=not-applicable，仍查音轨/空等。
pacingReview需passed及非空reason；lastMeaningfulActionSecond有限且在[0,duration]，reason定位动作/回应结束实帧或ASR，不抄计划。performanceChecks按beat.id覆盖，无节拍[]；evidence非空，0≤startSecond<endSecond≤duration。observed须observedStateChange及≥2变化区间实帧；单帧/计划/裁剪不证明变化；确证无推进incomplete，漏采unobservable。
动作/observed表演/ASR结束后按maxIdleTailSeconds/tailSeconds提裁尾，空等记pacingReview/warnings。裁尾尚未实施并重新采证前不得宣称素材已accepted，不能消除未完成或未知。
【cinematic-v1条件】
presentCharacters/worldState必填，settingId同开场，characters精确覆盖末尾在场者。position/heldProps/pendingAction：observed须非空value/evidence、实尾帧、人在endCharacters；unknown不携带事实value，可写原因。画外/模糊/无锚点用unknown，禁旧帧/计划补造或observed含不确定。position用实景锚点，禁屏幕左右。
画外不等于离场，无退出计划保留名单。presenceChecks逐exitingCharacters填状态、实证及≥2不同实帧：observed才移除，incomplete保留并拒绝，unobservable复核。
coverage_cut可变构图；continuityReview逐首帧人物核对开场observed字段，character+field唯一，含帧0，status=observed/mismatch/unobservable及实证。全符passed=true；mismatch拒绝，关键未知复核；前态unknown额外项只能unobservable、不独拒。tail_continuation用实际前尾帧；非cinematic省本组；无退出presenceChecks=[]，非coverage_cut省continuityReview。
【逐缺陷证据v2】
issues仅确证；defectEvidence唯一覆盖issue/consistent=false，绑定issueIndex/visualCheckIndex至少一项，0起不重复；status=confirmed/uncertain，finding仅本项实证。无缺陷[]，未知不抹并存确证。
confirmed须category/source、非空finding/repair，同项issue/visual.evidence/finding/repair禁不确定。frame须非空无重复有效帧号；asr可跨alignment实段，限首末内且有限0≤startSecond<endSecond≤duration。
script：source=frame；requirementPath原路径，requirementQuote逐字唯一。scope=opening/ending/interval/whole-shot；首帧限0，尾帧限末帧，其它依原窗/结构化start/end/明确全程。interval/whole-shot填startSecond/endSecond，帧限原要求与缺陷区间交集；不得改称畸变绕过原要求。另填stateEvidence：basis=visible-state-contradiction；requirementQuote逐字包含violatedQuote，后者逐字包含requiredStateQuote；observedState为同一属性的正面可见反证，不能借未采到证明缺失或增写目标属性。temporalBasis=state-at-sample或sustained-state；后者填含明确持续义务/目标状态的原文persistenceQuote，前者省略。短暂过程漏采不能改称持续反证。
visual-artifact：source=frame，rule仅black-frame/visual-deformation/unexpected-overlay/object-discontinuity/identity-mismatch/era-anachronism/spatial-discontinuity；object-discontinuity与spatial-discontinuity至少两张不同原帧。
speech：source=asr，rule仅phonetic-error-rate（phoneticErrorRate必须超过本次配置阈值）或speech-timing（speechIndex指向outside-allowance且elapsed>allowedSpan句）。非script省略路径/引文/scope/stateEvidence；ASR用startSecond/endSecond替代frameIndices；其它不适用索引/rule/speechIndex省略。
【结论】
decision/passed：确证缺陷rejected/false；仅blocking/undetermined未知uncertain/false；无缺陷/阻断未知/待剪辑才accepted/true、issues=[]。
仅待裁尾例外：rejected/false、issues=[]、defectEvidence=[]、retryPrompt=""、pacingReview.passed=false，reason/warnings说明待编辑重新采证，由门禁抛出MEDIA_EDIT_REQUIRED交给剪辑处理；不报uncertain或重拍。其他rejected必须有确证缺陷。
repair/retryPrompt保留台词、人物、剧情，仅修确证缺陷，去重≤reviewPolicy.maxRepairChars字。report-format重看同素材与原要求，复核source/category/引用范围及争议结论。上一报告是草稿，不能以“只修格式”为由沿袭错误指控或抹真缺陷；同步字段/结论，返回完整报告，省无关dramaturgyReview/史料。
【唯一完整JSON模板】
枚举选一、数组按实量、删不适用字段；示例非结论。requirementChecks仅incomplete填defectIndex，禁repair。
{"decision":"uncertain","passed":false,"issues":[],"warnings":[],"retryPrompt":"局部修复","evidence":[{"source":"frame","reference":"实证","finding":"实见"}],"endingState":"尾帧实态","endCharacters":["全名"],"requirementChecks":[{"requirementId":"原id","status":"incomplete","frameIndices":[0],"evidence":"实帧","defectIndex":0,"scopeNotes":[],"evidenceGaps":[]}],"narrativeClosure":{"unitId":"原unitId","complete":false,"actionEvidence":"实证","responseEvidence":"实证","unresolvedActions":[],"criteriaChecks":[{"criterion":"原条件","status":"complete","evidence":"实证"}]},"pacingReview":{"passed":false,"reason":"节奏实证","lastMeaningfulActionSecond":0,"performanceChecks":[{"beatId":"原节拍id","status":"observed","evidence":"实证","observedStateChange":"变化","startSecond":0,"endSecond":1,"frameIndices":[0,1]}]},"speechChecks":[{"text":"原text","assessment":"natural","reason":"实测预算"}],"tailTimingCheck":{"assessment":"程序值","reason":"数值区间"},"visualChecks":[{"character":"全名","consistent":true,"expectedObjects":"原范围","actualObjectsByFrame":[{"index":0,"objects":"手部实态"}],"evidence":"实证"}],"defectEvidence":[{"issueIndex":0,"visualCheckIndex":0,"status":"confirmed","category":"script","source":"frame","frameIndices":[0],"startSecond":0,"endSecond":1,"finding":"采证","repair":"局部修复","requirementPath":"原路径","requirementQuote":"唯一引文","scope":"ending","stateEvidence":{"basis":"visible-state-contradiction","violatedQuote":"原子句","requiredStateQuote":"原属性","observedState":"实测反证","temporalBasis":"state-at-sample"},"rule":"本类规则","speechIndex":0}],"presentCharacters":["在场全名"],"worldState":{"settingId":"原settingId","characters":[{"name":"全名","position":{"status":"observed","value":"实景锚点","evidence":"尾帧依据"},"heldProps":{"status":"unknown","evidence":"未知原因"},"pendingAction":{"status":"unknown","evidence":"未知原因"}}]},"presenceChecks":[{"character":"退出者","status":"observed","evidence":"退出过程实证","frameIndices":[0,1]}],"continuityReview":{"mode":"coverage_cut","passed":false,"checks":[{"character":"人物","field":"position","status":"observed","evidence":"实证","frameIndices":[0]}]}}【唯一完整JSON模板结束】
【独立成片验收完整契约结束】`;
/** Legacy clause refreshers must not append a second contract to this one. */
export function isCanonicalMediaReviewPrompt(prompt: string): boolean {
  const start = prompt.indexOf('【独立成片验收完整契约 v1】')
  return start >= 0 && prompt.indexOf('【独立成片验收完整契约结束】', start) > start
}
