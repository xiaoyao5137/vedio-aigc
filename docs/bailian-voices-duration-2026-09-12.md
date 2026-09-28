# TTS 完整音色选择、试听与时长控制

2026-09-12 已更新正式服务 http://127.0.0.1:5173/。

## 音色

两款模型中性命名为「百炼 Qwen Audio TTS Flash」「百炼 Qwen Audio TTS Plus」，清除了上次配置的默认男女声指令。音色是可选参数，不再把某个性别当成模型能力。

详情页支持搜索、真正的下拉选择、系统/基础音色分组、官方样音播放器，以及自定义音色 ID。Flash 包含 12 个系统音色和 597 个基础音色（609 个）；Plus 包含 2 个系统音色和 597 个基础音色（599 个）。列表按模型隔离，不混用其他模型音色。

清单来自[阿里云音色列表](https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list)与其中两份官方 Excel，快照日期 2026-09-12。每个基础音色对应的官方样音均已安装。官方原表有一行性别为「不能」，页面显示「未注明」，原值保留在 sourceGender，未自行推断性别。

系统样音使用官方公开地址；基础样音使用官方音频包的本地副本，无需发起付费合成。样音不应用当前语速、音调或声音指令；实际效果以生成的台词音频为准。用户私有定制音色保留手动 ID 入口，无公开样音时可生成短台词试听。

新环境安装基础样音：`python3 scripts/setup-bailian-voice-previews.py`。公开样音包不会进入 Git；音色目录在 `src/bailian-voice-catalog.json`，597 个共享 WAV 位于 `public/tts-previews/`。

## 时长

[官方客户端参数](https://help.aliyun.com/zh/model-studio/cosyvoice-client-events)没有目标秒数参数。实际长度受台词、停顿、音色、语速与声音指令共同影响；rate 范围为 0.5–2。

按用户要求已移除「期望时长」、自动语速建议及应用按钮。保留供应商原生语速参数，并在生成结果中显示实际音频时长。通过台词长度、停顿和语速间接调整长度，不保证精确秒数。

## 定制音色能力边界

阿里云[声音设计](https://help.aliyun.com/zh/model-studio/voice-design-user-guide)支持根据文字描述创建定制音色，北京地域的 Qwen Audio Flash 与 Plus 均在支持范围。当前应用仅接入预设音色选择、自定义 ID 合成；尚未接入创建、试听确认、保存和绑定角色的声音设计流程。声音指令不能等同于创建独立音色。

## 验证

- 音色目录和体验参数定向测试通过，包括模型音色隔离、ID 合法性、数量和全部 597 个本地官方 WAV 文件。移除时长建议后重新通过构建和定向测试，日志为 remove-duration-build.log、remove-duration-tests.log。
- TypeScript/Vite 构建和新增模块定向 lint 通过。日志在 `.runtime/tts-catalog-20260912/`。
- Chrome 验证 Plus 搜索与下拉选择基础音色「龙璨竹月」，点击官方试听，播放器显示暂停；Flash 的「龙安风悦」系统样音也已实际播放。
- Plus 基础音色真实合成成功：任务 `d27c7fea-33fc-488b-a7fa-c69ec1409d34`，音色 `qwen-audio-3.0-tts-plus-longcanzhuyue`，语速 1，实际 4.85 秒；证据 `live-generation.json`。
