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

它会启动一个带专用调试端口的 Codex 窗口，并在左侧栏新增 **Flight Deck**。点击入口即可在 Codex 主工作区中打开面板。

默认端口为 `48173`（Flight Deck）和 `49232`（该独立 Codex 窗口的调试端口）；两者均可用 `FLIGHT_DECK_URL`、`FLIGHT_DECK_CDP_PORT` 覆盖。

## 当前 MVP 能力

- SQLite 本地持久化任务、状态和依赖关系
- 前置任务的测试/验收门禁；满足后自动解锁后续任务
- Codex app-server 本地启动与会话记录
- 构建验证后进入人工复核队列
- Worktrees、复核和任务包 UI

本地数据库位于 `data/flight-deck.sqlite`，不会提交到仓库。
