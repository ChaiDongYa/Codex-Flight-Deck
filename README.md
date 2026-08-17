# Codex Flight Deck

面向 Codex 研发交付的本地优先控制台：把任务目标、依赖门禁、执行、验证和人工复核集中在同一工作流中。

## 本地运行

需要 Node.js 22.5 或更高版本。

```bash
npm install
npm run dev
```

打开 `http://127.0.0.1:48173/`。

## 嵌入 Codex

保持本地服务运行后，执行：

```bash
npm run codex:sidebar
```

它会启动一个带专用调试端口的 Codex 窗口，按 [Codex Taskboard](https://github.com/chuspeeism/dashi-taskboard) 的方式注入：连接页面 CDP、绕过 renderer CSP，在 Plugins 后加入 **Flight Deck** 入口，再用隔离 iframe + `Page.setDocumentContent` 载入本地页面。该命令会保持运行以监视 renderer 替换；用 `Ctrl-C` 结束。

默认端口为 `48173`（Flight Deck）和 `49233`（该独立 Codex 窗口的调试端口）；两者均可用 `FLIGHT_DECK_URL`、`FLIGHT_DECK_CDP_PORT` 覆盖。已有调试窗口时可用 `node scripts/codex-sidebar.mjs --no-launch --port 49233` 只做注入。

## 当前 MVP 能力

- SQLite 本地持久化任务、状态和依赖关系
- 前置任务的测试/验收门禁；满足后自动解锁后续任务
- Codex app-server 本地启动与会话记录
- 构建验证后进入人工复核队列
- Worktrees、复核和任务包 UI

## 首次启动与本地数据

首次启动时 Flight Deck 会自动创建本地数据目录、SQLite 表结构、知识库向量索引状态和空项目配置；不会创建示例任务或写入任何项目代码。知识库向量与原文都保存在同一 SQLite 数据库内，无需安装额外的向量数据库服务。

开发模式默认数据位于 `data/flight-deck.sqlite`。未来桌面应用启动器会传入用户数据目录（`FLIGHT_DECK_DATA_DIR`），例如 macOS 的 `~/Library/Application Support/Flight Deck`；安装包本身不会保存用户数据。

之后再次打开时会检测已有初始化状态，只会执行必要的数据库迁移或索引版本升级，绝不会清空任务、版本、项目规则、Apifox 配置或知识库。
