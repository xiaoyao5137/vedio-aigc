# 短视频 AIGC 工作流

项目内置了“**三国原著史料短剧（分步生成）**”工作流。默认用本地联调模型完整跑通链路，不消耗外部模型额度；生产时可在节点属性中替换为 Anthropic、OpenAI / Qwen / Kling 图片、OpenAI 语音、Kling 视频等真实模型。

## 三国工作流

默认链路为：

1. 输入节点只选择集数（1—1000）。
2. “剧集上下文初始化”代码节点把内置策划 Excel 作为节点附件上传，并运行可编辑 JavaScript：从附件的“1000集总表”按“集数”匹配记录，将集名、时段、具体篇目、在线核查 URL 和改编边界合并到 `input` 上下文；不设置镜头数或整集时长。
3. “剧集上下文初始化”先把集名、史料名、篇目和互证建议合并成通用查询词，再把查询词、目标 URL 和结果上限交给通用“互联网检索节点”。检索节点在运行时联网，优先按 Excel 的在线核查 URL 抓取公开网页，并对维基文库 URL 通过 MediaWiki API 查找并取得原文。输出包含原文、最终 URL、抓取时间和失败记录；不读取 `knowledge_documents` 或 `knowledge_chunks`。
4. 剧情规划模型不声明业务入参字段，直接在提示词中引用 `${input.episode_title}`、`${historical_sources.citations}` 和 `${historical_sources.text}`，自主生成 JSON `scenes` 数组及每镜 5/10 秒时长；在不改变史实因果的前提下，通过短视频钩子、信息差、反差、悬念和人物性格碰撞强化网感、趣味感、剧情感与电视剧吸睛性，避免按时间顺序朴素直叙。每个具名角色的行动与表达须符合正史及可靠注本记载的性格和当时处境。模型无需输出 `count` 或 `totalDuration`。模型完成后，系统按实际 `scenes.length` 和各场景 `targetDuration` 之和确定性计算这两个统计值，不存在预设的镜头数或整集时长。
5. 按场景循环生成严格 JSON 短分镜。短分镜文本节点不声明“当前场景”“集名”“史料原文”等业务参数，而是在提示词中通过 `${scene}`、`${input.episode_title}`、`${historical_sources.text}` 直接引用上下文。人物检索、首帧分支、前镜尾帧复用和尾帧整理代码节点同样不声明入参字段，代码通过 `${变量路径}` 占位符直接读取上下文。短分镜以单一强动作或关系变化为核心；人物检索节点查询 PostgreSQL 人物资产库，并把缺失判断、补图提示词、尺寸和生成数量整理成标准图片请求。
6. 首帧分支代码节点按 `firstFrameMode` 决定生成新首帧或沿用前镜尾帧，并先合并已有与当次生成的人物参考图。图生视频节点使用与猫咪工作流兼容的 `referenceImage`、`duration` 参数名，并补齐常用的 `mode`、`sound`、`negativePrompt` 配置；镜头动作、运镜、环境声和台词统一进入提示词，`sound=on` 让视频模型原生生成同步声音，不再设置独立旁白/对白音频节点。视频输出后的代码节点只整理模型明确返回的尾帧；没有独立尾帧时，下一镜自动生成新首帧，不用角色资产节点或补生成图片冒充真实尾帧。
7. 汇总每轮输出，确定性检查史料编号、改编边界、5/10 秒时长，并校验短分镜数量与总时长均等于剧情规划当次实际产出的值，再生成整集时间线清单。

新工作流使用 `schemaVersion: 16`，启动时会自动迁移已保存的三国工作流并刷新系统默认节点契约：移除场景大纲与四个业务代码节点的入参字段，改用提示词或代码占位符；图生视频统一为兼容参数；独立音频节点继续移除；短分镜的 audioType 固定为“旁白”或“对白”，环境声和动作声保留在 audioText/videoPrompt。迁移会保留剧情规划驱动循环与校验、人物库优先检索、首尾帧连续性链路、自定义节点和自定义连线。

### 代码执行与 Excel

- 代码执行节点提供 JavaScript 编辑器，并支持上传单个 `.xlsx` 文件（最大 15MB）；附件随工作流配置保存，上传新文件会替换旧文件。
- 运行时可使用 `${变量路径}` 占位符、`context`、上下文顶层变量（例如 `input`）、`files`、`prompt`、`console` 和同步 `excel.parse(file, options)` API；占位符会以 JSON 字面量安全展开。
- 只有输入节点允许用户手工添加或删除入参字段；其他节点只展示其固定参数配置。
- `excel.parse` 只负责通用的工作簿读取，返回工作簿、工作表、表头、数据行、原始行号、总数与截断标记；按列匹配、字段转换、默认值和派生字段均由节点 JavaScript 配置。
- 节点代码 `return` 对象中的 `contextPatch` 会安全地深合并到流程实例上下文；其余返回值仍保存在节点结果变量下，便于复核。
- JavaScript 在 1.5 秒的受限同步运行环境中执行，不提供网络、文件系统、动态代码生成或模块加载能力；单次结果限制为 4MB。
- 默认附件位于 [public/data/三国历史短剧1000集策划总表.xlsx](./public/data/三国历史短剧1000集策划总表.xlsx)。

### 运行时互联网检索

- “互联网史料原文查询”节点使用通用 `internet.retrieve` 操作，`prompt` 为空；只读取预处理后的 `query`、`urls`、`maxSources` 和 `maxPassages`。`sourceDetail`、`sourceNames` 等三国业务字段不再出现在检索节点参数里。
- 只允许公开 `http/https` URL，拒绝 localhost、私网地址和非网页协议；每个请求有 8 秒超时与 1.5MB 正文上限。
- 对维基文库会通过其公开 MediaWiki API 搜索篇目并抓取页面正文；其他公开核查 URL 直接抓取 HTML 后提取可读正文。
- 不把当次抓取的原文写入 PostgreSQL。历史 `knowledge_documents`、`knowledge_chunks` 表可保留旧数据，但三国工作流不读取它们；数据库只继续用于模型配置、工作流配置、执行记录和人物资产。

示例：

```bash
curl -X POST http://127.0.0.1:5173/api/internet/search \
  -H 'Content-Type: application/json' \
  --data '{"query":"符水与饥民 后汉书 卷七十一 皇甫嵩朱儁列传","urls":["https://zh.wikisource.org/zh-hans/%E5%BE%8C%E6%BC%A2%E6%9B%B8"],"maxSources":3,"maxPassages":6}'
```

### 本地联调模型

以下模型是可重复、可离线验证节点协议的 dry-run 适配器：

- `local-history-llm`：场景大纲和短分镜结构化输出。
- `local-image-simulator`：生成可预览的 SVG 首帧/三视图占位资产。
- `local-video-simulator`：生成带原生音频标记的视频任务预演海报、尾帧和任务元数据。
- `local-audio-simulator`：生成可播放的 WAV 联调音频。

这些结果明确标记为 `simulated`，用于开发联调，不冒充真实生成视频。切换到真实模型时，节点变量契约和后续时间线无需改变。

### 真实图片模型

- `qwen-image-3-pro`：通过 Ofox OpenAI 兼容端点调用 `bailian/qwen-image-3.0-pro:free`，支持文生图及 1—3 张 `input_images` 参考图；服务端会把 `b64_json` 转换为工作流可直接使用的 Data URL。
- `kling-image-3`：调用 Kling Image 3.0 的 `kling-v3` 异步任务接口，自动轮询到成功、失败或超时，并向工作流返回生成图片 URL。
- Qwen 的 `apiKey` 与 `gpt-image-2` 双向同步；Kling 图片和视频模型的新版 `apiKey`、旧版 `accessKey` / `secretKey` 双向同步。保存任一模型时会一起持久化共享凭据。
- Kling 鉴权优先使用新版单 API Key；未配置时兼容原 Access Key / Secret Key JWT。真实接口可在“模型管理 → 测试 / 体验”中发起一次生成测试。
- 模型管理页只维护模型 ID、Endpoint、凭据和轮询超时等静态连接配置；Duration、Aspect Ratio、Mode、Quality、Voice 等单次生成参数统一在模型的“测试 / 体验”子页面填写。
- Kling Video 3.0 体验页支持本地上传或 URL/base64 首尾帧、3—15 秒时长、画幅、std/pro、原生音频、负向提示词、CFG、多镜头与自定义分镜、运镜、静态/动态蒙版、回调地址和外部任务 ID。所有单次调用字段都是用户选填，供应商必需参数由默认值补齐；服务端会根据是否存在首帧自动选择 `text2video` 或 `image2video` 路由。

模型配置和工作流配置已改为写入 PostgreSQL。开发环境默认读取：

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/video_aigc
```

如果需要自定义连接，复制 `.env.example` 为 `.env.local` 并修改 `DATABASE_URL`。

## 数据库初始化

应用启动时会自动创建表，也可以手动执行：

```bash
createdb video_aigc
psql "$DATABASE_URL" -f database/schema.sql
```

## 开发

```bash
npm install
npm run dev
```

也可以用脚本同时管理数据库和开发服务：

```bash
./start.sh start
./start.sh restart
./start.sh stop
./start.sh status
```

首次打开页面时，如果 PostgreSQL 中没有配置，前端会用内置示例初始化 `model_configs` 和 `workflow_configs`。之后：

- 工作流编辑会自动防抖同步到 PostgreSQL。
- 模型配置点击“保存配置”后写入 PostgreSQL。
- 模型管理页的“配置库诊断”会从 PostgreSQL 拉取并展示脱敏摘要。

## 构建

```bash
npm run build
```

## 测试与联调

```bash
# Excel 解析/匹配、上下文合并、结构化输出、循环兼容、检索排序、本地媒体协议
npm test

# 使用 PostgreSQL 中 GPT Image / Kling 视频的共享凭据做真实单图测试；可用 qwen 或 kling 单独运行
IMAGE_MODEL_SMOKE_TARGET=kling npm run test:image-models

# 需要先启动应用；可用 SMOKE_BASE_URL 指定地址
npm run test:smoke

npm run lint
npm run build
```

烟测会执行“符水与饥民”样例：从维基文库实时获取史料原文，动态生成场景数量和总时长，查询人物库并生成缺失人物参考图，验证部分连续镜头沿用前镜尾帧、全部视频启用原生音频，并要求史料引用、改编边界、动态镜头数和动态总时长检查通过后才成功退出。
