# 音色创建与归档分离：实施中

用户要求（当前验收依据）：创建和归档是两个独立节点；音频模型推理内不得有入库逻辑；两节点均在人物资产归档之前；音色随人物资产关联存入人物库；参考生视频显式引用人物音色资产；必须通过真实循环分镜第一轮视频效果验证才交付。

本轮已实现、未接运行节点：
- server/voice-design-inference.ts：纯模型推理，无 pg、SQL 或人物资产归档依赖。输入稳定人物身份和召回的已有音色，输出 voice-candidate-v2。供应商请求回执使用本地传输日志恢复，不写人物/音色数据库。已有音色输入直接复用，不发创建请求。
- server/voice-asset-archive.ts：独立归档操作，建立稳定逻辑人物身份并写 original_character_voices。不要求人物图片已归档，满足先音色归档再人物资产归档。旧音色冲突拒绝覆盖。
- tests/voice-node-separation.test.ts：推理不写数据库、归档前数据为空、归档后可召回、重复推理不重复创建、冲突拒绝；两项通过。构建通过。

尚未完成，不得交付：
1. 移除 builtin-nodes 中 character.voice-design 混合路径，音频节点经正常模型调用入口执行 inferCharacterVoices。普通执行记录日志由运行器负责，模型模块不包含入库操作。
2. 人物检索输出添加 lookupArchivedVoices 查询结果（只读），并在 SANGUO_CHARACTER_LOOKUP_CODE 结果中保留现有音色，作为创建节点 existingVoices 参数。需要考虑现有人物的连续性标识与新人物一致。
3. 增加独立 character.voice-archive asset 节点，调用 archiveVoiceCandidates；拓扑为图片生成/验收 -> 音色创建 -> 音色归档 -> 人物资产归档 -> 参考视频。必须处理图片已存在时跳过生成，声音仍需检查/归档的路径。
4. 人物归档消费音色归档输出并关联存入 metadata；归档后的可灵自定义声音/主体映射移出创建模型节点，在资产阶段完成。新人物不依赖预先入库图片。旧人物不应重画图片或覆盖原资产。
5. 视频节点添加显式人物音色资产参数并在服务端解析校验：当前可灵 Omni 用 element_list 参数及 Prompt 的 <<<element_n>>> 引用，主体绑定固定可灵声音 ID，保留 originalVoiceId 到百炼原创声音的映射。不要将百炼 ID 当作可灵 ID。
6. 工作流迁移幂等、安全保留自定义参数及原执行，更新默认配置与数据库生产工作流。旧混合节点要迁移/移除。
7. 运行服务、浏览器检查拓扑与节点职责，然后用真实循环分镜第一轮（非独立脚本两段样片）执行到视频完成，保存对应执行/节点/参数/供应商任务/解码与效果证据。

之前样片和实现仅为参考，不可替代新的第一轮循环验收。主服务 5173 上一版会话 37618；本轮新增模块尚未重启服务。之前用户的已确认听审保留，不要求重复确认。新目标 active，尚无阻塞。

## 第二轮进度：运行接线与拓扑迁移已完成

- builtin-nodes 已移除 character.voice-design 混合实现；/api/node-run 的模型推理入口调用 inferCharacterVoices；只有通用执行日志由运行器记录，音色推理模块不含数据库操作。
- 新增 character.voice-archive 独立资产节点；character.archive 消费归档音色，关联 metadata.originalVoice，并在资产阶段完成可灵声音/主体映射。
- character.lookup 可通过 includeVoices 只读查询已归档音色，既有图片匹配后取其稳定 continuityKey。SANGUO lookup code 与保存的生产节点已增加 existingVoices 输出。
- 生产节点顺序已迁移为音色创建 -> 音色资产归档 -> 人物资产归档 -> 首帧参考整理 -> 视频；两音色节点无图片缺失 runIf，已有图片也会处理声音；原人物归档允许复用既有图片。
- 视频新增 voiceAssets 显式参考参数，bindVideoVoices 比较其供应商声音/主体/版本/账户与不可变执行声音快照，错配阻断。
- 真实分离 API 验证通过：推理调用前后音色资产表 MD5 完全相同；音色归档、人物归档各自成功，人物归档输出正确视频声音引用。证据 .runtime/voice-separation-20260912/api-evidence.json。
- 全量回归 1118 项：1116 通过，0 失败，2 条环境跳过；构建、分离模块 lint 通过。主服务 5173 已加载当前代码，会话 84432。

真实首轮验收尚未完成：
- 最新真实执行 record-ully7g，第一轮 loopIndex=0 是郭泰立于李膺宅院门外，郭泰为画面人物，所有有词声音为画外旁白。已批准 shot_script 时长为 13 秒（不能用之前单人6秒小样代替）。完整源上下文和上游已通过输出必须保留。
- 当前设计只为画面人物创建声音，必须扩展旁白独立身份的创建/归档/召回，但不能把旁白送入人物图片生成。
- Omni 当前映射通过 element_list + <<<element_n>>>；旁白不能伪装画内主体。要用真实TTS旁白及正确视频音频路径（原声音排除/环境音保留、实际时长反馈/混音），或找到并实测支持画外旁白的供应商接口。当前已有 collectVideoEvidence / ffmpeg / callBailianTts 可用。
- 下一轮先实现旁白独立声音引用，再从真实源执行创建保留上游与原输入的新验收分支；用真实浏览器循环引擎走第一轮到视频完成。禁止运行 scripts/drive-workflow-ui.mjs 的 CDP UI 自动化；UI 操作只用 cua_repl。
- 不得标记完成。不要再用“缺TTS配置/缺旧样片听审”阻塞；用户已提供配置与旧样片通过意见。

## 第三轮：真实首轮旁白链路与恢复记录
- 新增 src/voice-character-input.ts：画面人物与声音角色分开，旁白使用 workflow + __narrator__，不进入人物图片生成。lookup 与代码节点输出 voiceCharacters；迁移支持已拆分工作流幂等升级。character.archive 传递已经独立归档的旁白音色，不创建可灵人物主体。
- 新增 server/narration-projection.ts、server/independent-narration.ts；视频供应商投影保留动作和环境音，移除旁白原文；独立 TTS 按原时间窗合成，最多 1.25 倍不变调适配且检查语速，超出则报冲突而不截断；ffmpeg 保留环境音混入旁白。尚待真实媒体验证环境音是否出现多余人声。
- execution_original_voice_manifests 锁定原创旁白身份；视频声资产与数据库严格比对。vite 视频返回替换为合成 URL，同时保留原供应商 pictureUrl 与独立音轨证据。成功的付费画面有本地回执，混音失败重试不重新购买画面。
- 全量 1121 项：1119 通过、0失败、2跳过；构建通过。新增旁白身份、投影、节奏与数据库锁定测试通过。
- 已创建真实源执行的验收恢复记录 record-voice-separation-first-loop-20260912，原 record-ully7g MD5=03bad49ce92bbaa06a1cc867986cf54d 保持；原输入及已通过分镜输出保留，从第一轮人物检索 index15 重跑。605 runs；拓扑校验通过。脚本与证据 .runtime/voice-separation-20260912/prepare-first-loop.mjs / first-loop-applied.json。
- 生产工作流已更新 voiceCharacters，备份 narrator-workflow-before.json。Vite 5173 自动重启已加载，当前监听 PID42452（会话84432归属，后续可能自动变化）。CUA 浏览器1/页5已reload，最后状态正在加载配置。绑定 voiceLoopUi；恢复浏览器 docs 已读取。
- 下一步：进入执行并打开“音色分离 · 真实首轮视频验收”，用实际浏览器单步依次执行到首轮视频与采证，停止在第二轮之前。当前首轮尚无新视频任务，不得标记完成。合成后需要实际 ASR/解码/视觉嘴型检查，环境音保留只是实现行为，尚未证明无多余人声。混合画内对白+旁白路径当前显式阻断，不能声称全类型支持。

## 真实首轮已提交视频（当前关键恢复点）
- 前述“Vite 自动加载”判断不准确：scripts/dev-server.mjs 禁用 HMR；已停止旧会话84432并明确重启。当前会话91504，监听PID66739，5173。之后只改过前端输出契约及缓存计数，前端已reload；服务未加载最后 cached:!claimed 计数修正，不能在视频处理中重启。
- 原恢复记录第一次实跑发现通用音频输出只留下 URL，丢失 items。修复 App.tsx character.voice-design 专用输出，新增 voiceCandidateOutput 验证候选对象。真实UI“从此节点重试”自动创建 record-n6rb04，仍保持 requestScopeId=record-voice-separation-first-loop-20260912、strict。旧失败恢复记录保留。不要继续查询旧记录判断当前状态。
- record-n6rb04 第一轮：创建恢复491ms（复用本地供应商创建回执）、独立归档420ms、人物归档23696ms、首帧参考435ms均已成功。郭泰原音色 qwen-audio-3.0-tts-plus-vd-v034467ffe-972f81a3491b4f7bbcc8753e440560a3；旁白 qwen-audio-3.0-tts-plus-vd-ve32e20357-c7c98e6bb91548ac8146ec47f6757cdc。郭泰Kling声音927658533746245665；custom job927658500158296109、element job927658555460182024均成功。旁白不创建画内element。
- 第一轮 sanguo-video 已通过真实浏览器“下一步”提交，模型执行 model-run-mty39xtf-owxma0p，Kling task_id=927658982310281272，status=processing。原生画面+环境音；TTS已经执行成功（可查.runtime/narration-tracks），旁白原始声音被锁定到 execution_original_voice_manifests。
- 当前浏览器1/tab5，voiceLoopUi绑定；正在首轮第29/605步视频生成，禁止重启服务/刷新页面/再次提交。等待这一个供应商任务完成并检查合成输出，再经UI继续到媒体采证。切勿运行到后续19轮，首轮后停。
- 混音真ffmpeg测试（3秒画面+1秒音轨）通过，验证画面时长保留、旁白结束后环境音仍在。候选输出2测试、锁定4测试、最新构建通过。cached计数发现本地回执恢复被错误标为generated，已修正源代码并增加断言，尚待空闲后加载。

## 验收完成
- record-n6rb04 首轮完整完成到 sanguo-last-frame；media review decision=pass，media accept passed=true、issues=[]。第二轮未启动，临时尾帧断点已移除。
- 首轮视频任务927658982310281272已成功；成片13.05秒1280x720，原创旁白10.13秒未加速。最终语音采证通过；背景独立ASR无文本；采样画面检查完成。明确保留精确口型未测、历史来源未重新核实、同镜混合对白与旁白暂未支持等边界。
- 交付文档 docs/character-voice-node-separation-delivery-2026-09-12.md。全部证据在当前.runtime目录，库召回2复用0新建。
- 全量1123测试：1121通过、0失败、2跳过；构建和新增模块lint通过。最终重启主服务以加载回执缓存计数修正，旧会话91504已停止，新会话59835运行5173。重启后库召回API验证成功。
