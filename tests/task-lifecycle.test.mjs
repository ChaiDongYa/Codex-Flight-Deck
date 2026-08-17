import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);

test("task lifecycle keeps execution explicit and preserves planning, dependencies, discussion, and deletion", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "flight-deck-lifecycle-"));
  const script = `
    import assert from "node:assert/strict";
    import {
      addTaskComment,
      acceptTask,
      createTask,
      deleteTask,
      listTasks,
      recordCodexEvent,
      recordCodexLaunch,
      stopCodexTask,
      updateTaskPlan,
    } from "./server/db.mjs";

    const prerequisite = createTask({ title: "前置任务", goal: "先完成依赖", projectPath: "/tmp/project" });
    const delivery = createTask({
      title: "受依赖任务",
      goal: "完成明确交付",
      projectPath: "/tmp/project",
      dependencies: [{ id: prerequisite.id, gate: "test" }],
      automation: { autoRun: true, autoVerify: true },
    });
    assert.equal(delivery.automation.autoRun, false);
    assert.equal(delivery.automation.autoVerify, false);
    assert.equal(listTasks().find((task) => task.id === delivery.id).canRun, false);

    const planned = updateTaskPlan(delivery.id, {
      title: "已排期的受依赖任务",
      description: "完成明确交付并保留验收条件",
      acceptance: "验证通过后才能进入复核",
      taskStage: "待开发",
      priority: "高",
      startDate: "2026-08-15",
      endDate: "2026-08-16",
    });
    assert.equal(planned.title, "已排期的受依赖任务");
    assert.equal(planned.priority, "高");
    assert.equal(planned.startDate, "2026-08-15");

    const discussed = addTaskComment(delivery.id, { body: "仅保存的讨论不会启动 Codex。" });
    assert.equal(discussed.comments.length, 1);
    assert.equal(discussed.comments[0].body, "仅保存的讨论不会启动 Codex。");

    const implementation = createTask({
      title: "前端实现任务",
      goal: "实现可见页面功能",
      role: "前端专家",
      projectPath: "/tmp/project",
    });
    recordCodexLaunch(implementation.id, {
      threadId: "thread-test",
      turnId: "turn-test",
      workspacePath: "/tmp/project/.flight-deck-worktrees/FD-test",
      branch: "flight-deck/fd-test",
      isolated: true,
    });
    const withoutCode = recordCodexEvent(
      implementation.id,
      { method: "turn/completed", params: {} },
      { changedFiles: [], diffStat: "没有未提交的 Git diff" },
    );
    assert.equal(withoutCode.status, "已阻塞");
    assert.equal(withoutCode.test, "未检测到可审阅的代码变更");

    const noCode = createTask({
      title: "本版本不开发的说明任务",
      goal: "保留人工确认记录",
      projectPath: "/tmp/project",
      deliveryMode: "no-code",
      noCodeReason: "本版本不纳入开发范围。",
    });
    assert.equal(noCode.status, "待复核");
    assert.equal(noCode.merge.state, "not-required");
    assert.equal(acceptTask(noCode.id).status, "已完成");

    const paused = createTask({ title: "暂停任务", goal: "验证暂停状态", projectPath: "/tmp/project" });
    recordCodexLaunch(paused.id, { threadId: "thread-paused", turnId: "turn-paused", workspacePath: "/tmp/project/worktree", branch: "flight-deck/paused", isolated: true });
    stopCodexTask(paused.id);
    const lateEvent = recordCodexEvent(paused.id, { method: "item/started", params: { item: { type: "analysis", text: "迟到事件" } } });
    assert.equal(lateEvent.codex.state, "stopped");
    assert.equal(lateEvent.activity, "已停止 Codex，本轮变更仍保留在任务 worktree 中");

    deleteTask(delivery.id);
    deleteTask(prerequisite.id);
    deleteTask(implementation.id, { force: true });
    deleteTask(noCode.id, { force: true });
    deleteTask(paused.id, { force: true });
    assert.equal(listTasks().length, 0);
  `;

  try {
    await execFile(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, FLIGHT_DECK_DATA_DIR: dataDir },
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
