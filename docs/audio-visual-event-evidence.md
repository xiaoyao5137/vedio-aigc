# 声画事件与已报告缺陷

`assessAudioVisualEventEvidence(media, reports, targetedAssessment?)` 是纯校验函数；它不播放、不听音，不把 ASR、VAD、响度或静态口型推断为实际听审。`media` 必须有 `{url, sha256, duration}`；`collectVideoEvidence` 保存实际已解码文件的 SHA-256。旧证据缺少哈希时，先对同一文件计算并绑定，不能使用请求 URL 的哈希。

媒体验收从 `context.audio_visual_review`（单个报告或数组）、`context.targeted_repair_assessment` 接收输入。输出保留 `audioVisualEventReviews`、`targetedRepairAssessment` 和 `audioVisualEvidenceAssessment`。`enforce-evidenced-v1` 阻断可信确认事件和仍未解决的明确用户目标；普通未知仅提醒。

## 用户报告：不是独立确认

```json
{
  "version": "audio-visual-event-review-v1",
  "id": "report-identifier",
  "videoUrl": "同一用户观看的视频URL",
  "sha256": "该文件实际64位SHA256",
  "duration": 10,
  "method": "user-report",
  "reviewer": {"kind": "user", "id": "实际用户标识"},
  "reviewedAt": "实际报告时间ISO",
  "userReport": {"reference": "原用户消息或归档引用", "quote": "用户原话"},
  "events": [{
    "id": "defect-1", "code": "unvoiced_visible_speech", "status": "reported",
    "actorId": "张角", "startSecond": 2, "endSecond": 6,
    "finding": "用户报告该区间动嘴无配音，尚未独立确认"
  }]
}
```

时间均相对报告所绑定的视频。用户观看的是拼接版时先绑定拼接文件及其时间；定位到原片应另保存源拼接、源哈希及时间映射证据，不把拼接时间直接当原片时间。无实际听音能力的代理应使用真实用户报告，不能填写 `audioListened:true`。

## 独立连续复核

报告使用 `method:'agent-continuous-review'`、`reviewer.kind:'agent'`，或真实用户连续复核的 `method:'user-continuous-review'`、`reviewer.kind:'user'` 和 `userConfirmationRef`。必须有实际 `evidenceRefs`，事件含以下结构；只有确实完成播放才可填写真值：

```js
{
  id, code: 'unvoiced_visible_speech', status: 'confirmed', actorId,
  startSecond, endSecond, finding, repair,
  playback: {mode: 'continuous-audio-video', startSecond, endSecond,
    videoWatched: true, audioListened: true},
  visual: {basis: 'continuous-video', languageMouthMotion: 'observed', finding},
  audio: {basis: 'direct-listening', speech: 'absent', finding}
}
```

ASR 为空、VAD 未检出、低响度、单帧张口都不满足此证明。复核未知用 `status:'uncertain'`。同片同角色复核消除缺陷时可用 `status:'not-observed'`：实际连续观看没有语言口型，且实际听审给出声音状态；或语言口型仍在、实际人声存在且 `audio.actorMatches:true`、`synchrony:'matched'`。这只解除对应缺陷，不证明整体画面、声纹或全片通过。

## 替换素材必须继续携带用户目标

```js
{
  version: 'targeted-audio-visual-repair-v1',
  videoUrl: newMedia.url, sha256: newMedia.sha256, duration: newMedia.duration,
  targets: [{
    id: 'target-1', status: 'unresolved',
    sourceDefect: {code: 'unvoiced_visible_speech', videoUrl: oldMedia.url,
      sha256: oldMedia.sha256, actorId, startSecond, endSecond},
    userReport: {reference, quote},
    requiredInterval: {startSecond: 0, endSecond: newMedia.duration},
    resolution: {reviewId, eventId}
  }]
}
```

`requiredInterval` 缺省为整条替换片。同一新素材、同一角色、完整覆盖该范围的可信 `not-observed` 连续复核可解除目标；下面的技术路径只能解除其中“所需配音不存在”的范围。换 URL、新 ASR 无词、`accepted.passed:true`、手写 `status:'resolved'` 都不能解除目标。普通制作可保留未知；修复采纳流程必须检查 `targetResults` 和 `issues`，不得把“已替换”命名为“缺陷已解决”。

## 所需台词音轨存在：有限技术解除

`buildRequiredSpeechPresenceEvidence({video_evidence, video_take, shot_script}, visualReview)` 只提取原采证的必要字段（不复制声线资产中的音频 base64），没有验证副作用。只有明确要修复缺配音的 `target.repairScope:'required-speech-present'` 才能将结果放入 `target.resolution = {scope:'required-speech-present', evidence}`；未指定范围或 `precise-visible-speech-coverage` 目标不能据此降格解除。校验要求新片的实际 URL/SHA/时长、真实解码和非静音音轨、置信充分的逐词 ASR、所需声部与实测句子的对应及首尾边界，以及 take、manifest、请求资产三处一致的冻结声音绑定。

少量句中音素识别不确定可证明“有这段所需人声”，但不能证明原词完整正确。仅允许边界问题为 `partial-phonetic-alignment`、首末词已匹配且词音错误率不大于 0.2、逐句覆盖率不小于 0.8；原 `speechValidation` 和验收策略不变，内容警告保留。目标结果另存 `exactSpeechVerified`、`speechValidationIssues` 和 `lineCoverage`，不升级 `speechVerified`。

视觉输入必须来自实际连续复核，不能由 ASR 时间自动合成：

```js
const visualReview = {
  videoUrl: newMedia.url, sha256: newMedia.sha256, duration: newMedia.duration,
  method: 'agent-continuous-visual-review', reviewer: {kind:'agent', id: actualReviewer},
  reviewedAt, evidenceRefs, actorId,
  completeness: 'all-visible-speech-intervals', finding: actualFinding,
  coverage: {method:'continuous-frame-sequence', startSecond:0,
    endSecond:newMedia.duration, maxFrameGapSeconds:1/24},
  speakingIntervals: actuallyObservedSpeakingIntervals
};
```

也可使用实际连续播放的 `coverage:{method:'continuous-video',videoWatched:true,startSecond,endSecond}`。覆盖必须包含目标完整区间，列出该角色所有可见讲话区间。对于此“人声存在”范围，每段与实际可信词区间须至少重叠 80%，两端未覆盖时长各不得超过 0.25 秒；这是有限的表演边缘不确定度策略，不是口型同步合格阈值。原视觉区间和词时间保持原样，`visualSpeechCoverage` 输出实际首尾差与覆盖率，有差异就保留 `speech_presence_edge_timing_uncertain` 警告。词之间超过 0.3 秒的间隙会拆开，不能以整句首末时间掩盖长空白。全片只有一句话、抽样静帧、声音存在但角色绑定不明、词尾缺失或新片哈希不符均不能解除。实际连续听审路径仍保持原覆盖要求。

该路径的 `status:'resolved'` 仅适用于其明确的缺配音范围，始终记录 `resolutionScope:'required-speech-present'`、`fullAudioVisualRepairVerified:false`、`remainingVerification`，以及 `speakerIdentityVerified:false`、`lipSyncVerified:false`、`audioListened:false`。`edgeUncoveredIntervals` 保留可见表演超出词时间的具体区间；若另有实测低响度或同步偏差须如实披露，不能把它解释成已听到的尾音。技术声线绑定不等于实听声纹，视觉时间覆盖不等于逐字口型同步。当前同片同角色范围内已有可信 `confirmed` 无声讲话反证时，技术路径不能解除目标，反证仍阻断拼接。整片人工听审仍未完成。

## 普通重试的局部传递

自动分支、旧式验收重试、手动从节点重试均从实际受影响的同一循环轮次收集用户目标，放入 `retry.feedback.repairContext.targetedMediaRepair`。未增加常驻全局 context 字段，也不扫描历史 attempts 或 branchHistory。新验收将其绑定当前新片的 URL/SHA，旧素材的解决证明不会自动迁移；没有新证据时仍是 `unresolved`。下一轮只会保留其自己原有的目标，不继承上一轮的问题。
