import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, "flight-deck.sqlite"));
const roles = new Set([
  "产品专家",
  "前端专家",
  "后端专家",
  "UI/UX 专家",
  "全栈工程师",
  "测试专家",
  "DevOps 专家",
  "安全专家",
  "数据工程师",
]);

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS dependencies (dependent_id TEXT NOT NULL, prerequisite_id TEXT NOT NULL, gate TEXT NOT NULL DEFAULT 'test', PRIMARY KEY (dependent_id, prerequisite_id));
  CREATE TABLE IF NOT EXISTS releases (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
`);

function parse(row) {
  return row ? JSON.parse(row.payload) : null;
}
function save(task) {
  const now = new Date().toISOString();
  db.prepare("UPDATE tasks SET payload = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(task),
    now,
    task.id,
  );
  return task;
}
function dependencyInfo(taskId) {
  return db
    .prepare(
      "SELECT prerequisite_id, gate FROM dependencies WHERE dependent_id = ?",
    )
    .all(taskId)
    .map((relation) => {
      const prerequisite = parse(
        db
          .prepare("SELECT payload FROM tasks WHERE id = ?")
          .get(relation.prerequisite_id),
      );
      const satisfied =
        relation.gate === "accept"
          ? prerequisite?.status === "已完成"
          : prerequisite?.testTone === "success" &&
            ["待复核", "已完成"].includes(prerequisite?.status);
      return {
        ...relation,
        task: prerequisite && {
          id: prerequisite.id,
          title: prerequisite.title,
          status: prerequisite.status,
          test: prerequisite.test,
          testTone: prerequisite.testTone,
        },
        satisfied,
      };
    });
}
function canRun(taskId) {
  return dependencyInfo(taskId).every((dependency) => dependency.satisfied);
}
function hasTrustedDependency(taskId) {
  return dependencyInfo(taskId).some(
    (dependency) => dependency.gate === "trust" && dependency.satisfied,
  );
}
function deliverySummary(task) {
  const verification = task.evidence?.verification;
  const changedFiles = task.evidence?.workspace?.changedFiles || [];
  const diffStat = task.merge?.diffStat || task.evidence?.workspace?.diffStat;
  const parts = [];
  if (verification?.exitCode === 0)
    parts.push(`验证通过：${verification.command}`);
  else if (verification)
    parts.push(`验证未通过：${verification.command || "未配置命令"}`);
  else parts.push("尚未运行验证");
  if (changedFiles.length) parts.push(`变更 ${changedFiles.length} 个文件`);
  if (diffStat) parts.push(diffStat.replace(/\n/g, " · "));
  if (task.preview?.url) parts.push(`预览：${task.preview.url}`);
  if (task.merge?.state === "merged")
    parts.push(`已合并到 ${task.merge.targetBranch}`);
  return {
    headline: parts[0],
    details: parts.slice(1),
    ready: task.status === "待复核",
  };
}
function shortText(value, limit = 220) {
  if (typeof value !== "string") return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}
function describeCodexEvent(event) {
  const params = event.params || {};
  const item = params.item || params;
  const type = `${event.method || ""} ${item.type || ""}`.toLowerCase();
  const command = shortText(
    item.command || item.commandLine || params.command || params.commandLine,
  );
  const text = shortText(
    item.text || item.message || item.content || params.text || params.message,
  );
  if (event.method === "turn/completed")
    return {
      kind: "completed",
      label: "Codex 已完成本轮执行",
      detail: "等待运行真实验证",
      phase: "等待验证",
    };
  if (event.method === "turn/started" || /turn.*started/.test(type))
    return {
      kind: "started",
      label: "Codex 开始处理任务",
      detail: "正在读取任务上下文",
      phase: "读取与分析",
    };
  if (/command|terminal|shell/.test(type))
    return {
      kind: "command",
      label: "Codex 正在运行命令",
      detail: command || text || "命令执行中",
      phase: "运行命令",
    };
  if (/file|patch|diff|edit/.test(type))
    return {
      kind: "file",
      label: "Codex 正在修改文件",
      detail: text || "已收到文件变更事件",
      phase: "修改文件",
    };
  if (/agent|message|reasoning|analysis/.test(type))
    return {
      kind: "analysis",
      label: "Codex 正在分析任务",
      detail: text || "正在处理任务上下文",
      phase: "读取与分析",
    };
  return null;
}
function appendExecutionEvent(task, event) {
  const update = describeCodexEvent(event);
  if (!update) return null;
  const now = new Date().toISOString();
  const previous = task.execution || {};
  const previousEvents = previous.events || [];
  const last = previousEvents.at(-1);
  // app-server may stream many deltas for one action. Keep the activity log useful.
  if (
    last &&
    last.kind === update.kind &&
    last.label === update.label &&
    last.detail === update.detail
  )
    return { ...previous, updatedAt: now };
  return {
    phase: update.phase,
    updatedAt: now,
    events: [...previousEvents, { at: now, ...update }].slice(-40),
  };
}
function releaseDependents(prerequisiteId) {
  const dependents = db
    .prepare("SELECT dependent_id FROM dependencies WHERE prerequisite_id = ?")
    .all(prerequisiteId);
  for (const { dependent_id } of dependents) {
    if (!canRun(dependent_id)) continue;
    const task = getTask(dependent_id);
    if (task?.status === "等待依赖")
      save({
        ...task,
        status: "待开始",
        activity: task.automation?.autoRun
          ? "依赖已满足，夜间自动队列准备启动"
          : "依赖已验证，可批准计划并启动",
      });
  }
}

export function listAutoRunnableTasks() {
  return listTasks().filter(
    (task) =>
      (task.automation?.autoRun || hasTrustedDependency(task.id)) &&
      task.canRun &&
      ["待开始", "计划中"].includes(task.status) &&
      task.codex?.state !== "running",
  );
}

export function recoverInterruptedAutoTasks() {
  for (const task of listTasks()) {
    if (task.status !== "执行中" || task.codex?.state !== "running") continue;
    if (!task.automation?.autoRun && !hasTrustedDependency(task.id)) continue;
    save({
      ...task,
      status: "计划中",
      activity: "Flight Deck 重启后恢复夜间队列，等待重新启动",
      codex: {
        ...task.codex,
        state: "stopped",
        recoveredAt: new Date().toISOString(),
      },
    });
  }
}

export function recordAutomationFailure(id, error) {
  const task = getTask(id);
  if (!task) return null;
  return save({
    ...task,
    status: "已阻塞",
    activity: "夜间自动队列已停止：启动或验证失败",
    test: "自动化失败",
    testTone: "danger",
    automation: {
      ...(task.automation || {}),
      retries: (task.automation?.retries || 0) + 1,
      lastError: `${error?.message || error}`.slice(0, 1200),
      failedAt: new Date().toISOString(),
    },
  });
}

export function retryTask(id) {
  const task = getTask(id);
  if (!task) throw new Error("Task not found");
  if (["执行中", "已完成"].includes(task.status))
    throw new Error("运行中或已完成任务不能重试。");
  return save({
    ...task,
    status: canRun(id) ? "待开始" : "等待依赖",
    activity: canRun(id)
      ? "已加入重试队列，等待启动"
      : "已请求重试，仍等待前置依赖",
    test: "等待重新执行",
    testTone: "neutral",
    automation: {
      ...(task.automation || {}),
      lastError: "",
      retriedAt: new Date().toISOString(),
    },
  });
}

export function getTask(id) {
  return parse(db.prepare("SELECT payload FROM tasks WHERE id = ?").get(id));
}
export function listTasks() {
  return db
    .prepare("SELECT payload FROM tasks ORDER BY updated_at DESC")
    .all()
    .map(parse)
    .map((task) => ({
      ...task,
      dependencies: dependencyInfo(task.id),
      canRun: canRun(task.id),
      summary: deliverySummary(task),
    }));
}
const releaseStages = ["需求评审", "需求反讲", "技术方案", "开发阶段", "提测阶段", "UAT 阶段", "上线准备", "已上线 / 复盘"];
export function listReleases(projectPath = "") {
  return db.prepare("SELECT payload FROM releases ORDER BY updated_at DESC").all().map(parse)
    .filter((release) => !projectPath || release.projectPath === projectPath)
    .map((release) => {
      const linked = listTasks().filter((task) => task.versionId === release.id);
      const blocked = linked.filter((task) => task.status === "已阻塞").length;
      const complete = linked.filter((task) => task.status === "已完成").length;
      const overdue = release.releaseDate && new Date(release.releaseDate) < new Date() && release.stage !== "已上线 / 复盘";
      return { ...release, tasks: { total: linked.length, complete, blocked }, health: blocked || overdue ? "有风险" : "正常" };
    });
}
export function createRelease(input = {}) {
  const name = `${input.name || ""}`.trim();
  if (!name) throw new Error("请填写版本名称。");
  const id = `REL-${Date.now().toString(36)}`;
  const now = new Date().toISOString();
  const release = { id, name, goal: `${input.goal || ""}`.trim(), projectPath: input.projectPath || "", startDate: input.startDate || now.slice(0, 10), releaseDate: input.releaseDate || "", stage: "需求评审", stages: releaseStages.map((name) => ({ name, done: false })), createdAt: now };
  db.prepare("INSERT INTO releases (id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, JSON.stringify(release), now, now);
  return release;
}
export function updateReleaseStage(id, stage) {
  const row = db.prepare("SELECT payload FROM releases WHERE id = ?").get(id);
  const release = parse(row);
  if (!release) throw new Error("版本不存在。");
  const currentIndex = releaseStages.indexOf(stage);
  if (currentIndex < 0) throw new Error("未知的版本阶段。");
  const updated = { ...release, stage, stages: releaseStages.map((name, index) => ({ name, done: index <= currentIndex })) };
  db.prepare("UPDATE releases SET payload = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(updated), new Date().toISOString(), id);
  return updated;
}
export function createTask(input) {
  const id = `FD-${2200 + db.prepare("SELECT COUNT(*) as count FROM tasks").get().count}`;
  const title = input.title?.trim() || "新的 Codex 交付";
  const role = roles.has(input.role) ? input.role : "全栈工程师";
  const task = {
    id,
    createdAt: new Date().toISOString(),
    title,
    role,
    description: input.goal?.trim() || "等待补充交付目标。",
    projectPath: input.projectPath || "",
    projectPolicy: input.projectPolicy || {},
    status: "待开始",
    worktree: `wt/${
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "") || "new-delivery"
    }`,
    activity: `等待 ${role} 启动`,
    test: "未运行",
    testTone: "neutral",
    files: ["AGENTS.md", "README.md", "相关业务模块（待扫描）"],
    plan: [
      "阅读已选上下文与项目约定",
      "实施目标范围内的最小变更",
      "运行验收标准要求的验证",
    ],
    approved: false,
    automation: {
      autoRun: Boolean(input.automation?.autoRun),
      autoVerify: Boolean(input.automation?.autoVerify),
    },
    acceptance: input.acceptance || "",
    versionId: input.versionId || "",
    merge: {
      mode: input.mergeMode === "auto" ? "auto" : "manual",
      targetBranch: input.targetBranch || "",
      state: "pending",
    },
  };
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO tasks (id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run(task.id, JSON.stringify(task), now, now);
  for (const dependency of input.dependencies || [])
    db.prepare(
      "INSERT OR IGNORE INTO dependencies (dependent_id, prerequisite_id, gate) VALUES (?, ?, ?)",
    ).run(
      task.id,
      dependency.id,
      ["accept", "test", "trust"].includes(dependency.gate)
        ? dependency.gate
        : "test",
    );
  return task;
}
export function deleteTask(id) {
  const task = getTask(id);
  if (!task) throw new Error("Task not found");
  if (["执行中", "已完成"].includes(task.status))
    throw new Error("运行中或已完成的任务会保留为交付记录，不能删除。");
  db.prepare(
    "DELETE FROM dependencies WHERE dependent_id = ? OR prerequisite_id = ?",
  ).run(id, id);
  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  return task;
}
export function approveTask(id) {
  const task = getTask(id);
  if (!task) throw new Error("Task not found");
  if (!["待开始", "计划中"].includes(task.status))
    throw new Error("当前状态不能启动 Codex。");
  if (!canRun(id))
    throw new Error("任务依赖尚未满足：必须等待前置任务的验证门禁通过。");
  return save({
    ...task,
    approved: true,
    status: "计划中",
    activity: "计划已确认，等待启动 Codex",
    test: "等待执行",
    testTone: "neutral",
  });
}
export function recordCodexLaunch(id, launch) {
  const task = getTask(id);
  if (!task) throw new Error("Task not found");
  if (!["待开始", "计划中"].includes(task.status))
    throw new Error("当前状态不能再次启动 Codex。");
  const now = new Date().toISOString();
  return save({
    ...task,
    approved: true,
    status: "执行中",
    worktree: launch.workspacePath,
    activity: launch.isolated
      ? `Codex 已在 ${launch.branch} 中启动`
      : "Codex 已在共享工作目录中启动（未隔离）",
    test: "等待 Codex 完成",
    testTone: "neutral",
    codex: { ...launch, state: "running", startedAt: now },
    execution: {
      phase: "会话已启动",
      updatedAt: now,
      events: [
        {
          at: now,
          kind: "started",
          label: "Codex 会话已启动",
          detail: launch.workspacePath,
        },
      ],
    },
  });
}
export function recordCodexEvent(id, event) {
  const task = getTask(id);
  if (!task) return null;
  if (!task.codex?.state) return task;
  const execution = appendExecutionEvent(task, event);
  if (!execution) return task;
  if (event.method !== "turn/completed")
    return save({
      ...task,
      activity: execution.events.at(-1).label,
      execution,
    });
  return save({
    ...task,
    activity: "Codex 本轮已完成 · 等待你运行/确认验证",
    test: "等待验证",
    testTone: "neutral",
    execution,
    codex: {
      ...task.codex,
      state: "completed",
      completedAt: new Date().toISOString(),
    },
  });
}
export function stopCodexTask(id) {
  const task = getTask(id);
  if (!task) throw new Error("Task not found");
  if (task.status !== "执行中" || task.codex?.state !== "running")
    throw new Error("当前没有可停止的 Codex 会话。");
  const now = new Date().toISOString();
  return save({
    ...task,
    status: "计划中",
    approved: false,
    activity: "已停止 Codex，本轮变更仍保留在任务 worktree 中",
    codex: { ...task.codex, state: "stopped", stoppedAt: now },
    execution: {
      ...(task.execution || {}),
      phase: "已停止",
      updatedAt: now,
      events: [
        ...(task.execution?.events || []),
        {
          at: now,
          kind: "stopped",
          label: "已停止 Codex 执行",
          detail: "未自动删除 worktree 或任何代码变更",
        },
      ].slice(-40),
    },
  });
}
export function recordWorkspaceEvidence(id, evidence) {
  const task = getTask(id);
  if (!task) throw new Error("Task not found");
  return save({
    ...task,
    evidence: {
      ...(task.evidence || {}),
      workspace: evidence,
      capturedAt: new Date().toISOString(),
    },
    files:
      evidence.changedFiles?.map((line) => line.slice(3)).filter(Boolean) ||
      task.files,
  });
}
export function recordTaskPreview(id, preview) {
  const task = getTask(id);
  if (!task) throw new Error("Task not found");
  return save({ ...task, preview, activity: `任务预览已启动：${preview.url}` });
}
export function recordMergePreview(id, preview) {
  const task = getTask(id);
  if (!task) throw new Error("Task not found");
  return save({
    ...task,
    merge: {
      ...(task.merge || {}),
      ...preview,
      state: preview.state,
      previewedAt: new Date().toISOString(),
    },
  });
}
export function recordMergeResult(id, result) {
  const task = getTask(id);
  if (!task) throw new Error("Task not found");
  if (task.status !== "待复核" || task.testTone !== "success")
    throw new Error("只有真实验证通过、等待复核的任务可以合并。");
  return save({
    ...task,
    activity: result.state === "conflict" ? "合并发现冲突，主分支未修改，等待人工处理" : `已合并到 ${result.targetBranch}，等待人工确认交付`,
    merge: { ...(task.merge || {}), ...result, state: result.state },
  });
}
export function recordVerification(id, verification, mergePreview = null) {
  const task = getTask(id);
  if (!task) throw new Error("Task not found");
  if (task.codex?.state !== "completed")
    throw new Error("请等待 Codex 本轮执行完成后再运行验证。");
  const success = verification.available && verification.exitCode === 0;
  const automatic =
    success && task.merge?.mode === "auto" && mergePreview?.state === "merged";
  const updated = save({
    ...task,
    status: success ? "待复核" : "已阻塞",
    activity: success
      ? automatic
        ? `真实验证通过，已自动合并到 ${mergePreview.targetBranch}`
        : "真实验证已通过，等待查看变更并确认合并"
      : verification.missingDependency
        ? "worktree 缺少项目依赖，等待准备后重试"
        : "验证未通过或未配置，等待处理",
    test: success
      ? `${verification.command} 通过`
      : verification.missingDependency
        ? "依赖未准备，无法验证"
        : verification.available
          ? `${verification.command} 失败（退出码 ${verification.exitCode}）`
          : "没有可运行的验证命令",
    testTone: success ? "success" : "danger",
    merge: mergePreview
      ? { ...(task.merge || {}), ...mergePreview, state: mergePreview.state }
      : task.merge,
    evidence: {
      ...(task.evidence || {}),
      verification,
      verifiedAt: new Date().toISOString(),
    },
  });
  if (success) releaseDependents(id);
  return updated;
}
export function acceptTask(id) {
  const task = getTask(id);
  if (!task) throw new Error("Task not found");
  if (
    task.codex?.isolated &&
    task.testTone === "success" &&
    task.merge?.state !== "merged"
  )
    throw new Error("请先查看变更并确认合并到主项目，再接受交付。");
  if (!["待复核"].includes(task.status))
    throw new Error("当前状态不能接受交付。");
  const updated = save({
    ...task,
    status: "已完成",
    activity:
      task.merge?.state === "merged"
        ? `交付已接受 · 已合并到 ${task.merge.targetBranch}`
        : "交付已接受",
    test: "验证通过",
    testTone: "success",
  });
  releaseDependents(id);
  return updated;
}
export function returnTask(id) {
  const task = getTask(id);
  if (!task) throw new Error("Task not found");
  if (["执行中", "已完成"].includes(task.status))
    throw new Error("运行中或已完成的任务不能退回计划。");
  return save({
    ...task,
    status: "计划中",
    approved: false,
    activity: "等待你补充修改意见",
  });
}
