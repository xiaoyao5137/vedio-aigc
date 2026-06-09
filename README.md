# 短视频 AIGC 工作流

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
