import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, "flight-deck.sqlite"));

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS dependencies (dependent_id TEXT NOT NULL, prerequisite_id TEXT NOT NULL, gate TEXT NOT NULL DEFAULT 'test', PRIMARY KEY (dependent_id, prerequisite_id));
`);

function parse(row) { return row ? JSON.parse(row.payload) : null; }
function save(task) { const now = new Date().toISOString(); db.prepare("UPDATE tasks SET payload = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(task), now, task.id); return task; }
function dependencyInfo(taskId) {
  return db.prepare("SELECT prerequisite_id, gate FROM dependencies WHERE dependent_id = ?").all(taskId).map((relation) => {
    const prerequisite = parse(db.prepare("SELECT payload FROM tasks WHERE id = ?").get(relation.prerequisite_id));
    const satisfied = relation.gate === "accept" ? prerequisite?.status === "已完成" : prerequisite?.testTone === "success" && ["待复核", "已完成"].includes(prerequisite?.status);
    return { ...relation, task: prerequisite && { id: prerequisite.id, title: prerequisite.title, status: prerequisite.status, test: prerequisite.test, testTone: prerequisite.testTone }, satisfied };
  });
}
function canRun(taskId) { return dependencyInfo(taskId).every((dependency) => dependency.satisfied); }
function shortText(value, limit = 220) {
  if (typeof value !== "string") return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}
function describeCodexEvent(event) {
  const params = event.params || {};
  const item = params.item || params;
  const type = `${event.method || ""} ${item.type || ""}`.toLowerCase();
  const command = shortText(item.command || item.commandLine || params.command || params.commandLine);
  const text = shortText(item.text || item.message || item.content || params.text || params.message);
  if (event.method === "turn/completed") return { kind: "completed", label: "Codex 已完成本轮执行", detail: "等待运行真实验证", phase: "等待验证" };
  if (event.method === "turn/started" || /turn.*started/.test(type)) return { kind: "started", label: "Codex 开始处理任务", detail: "正在读取任务上下文", phase: "读取与分析" };
  if (/command|terminal|shell/.test(type)) return { kind: "command", label: "Codex 正在运行命令", detail: command || text || "命令执行中", phase: "运行命令" };
  if (/file|patch|diff|edit/.test(type)) return { kind: "file", label: "Codex 正在修改文件", detail: text || "已收到文件变更事件", phase: "修改文件" };
  if (/agent|message|reasoning|analysis/.test(type)) return { kind: "analysis", label: "Codex 正在分析任务", detail: text || "正在处理任务上下文", phase: "读取与分析" };
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
  if (last && last.kind === update.kind && last.label === update.label && last.detail === update.detail) return { ...previous, updatedAt: now };
  return { phase: update.phase, updatedAt: now, events: [...previousEvents, { at: now, ...update }].slice(-40) };
}
function releaseDependents(prerequisiteId) {
  const dependents = db.prepare("SELECT dependent_id FROM dependencies WHERE prerequisite_id = ?").all(prerequisiteId);
  for (const { dependent_id } of dependents) {
    if (!canRun(dependent_id)) continue;
    const task = getTask(dependent_id);
    if (task?.status === "等待依赖") save({ ...task, status: "待开始", activity: "依赖已验证，可批准计划并启动" });
  }
}

export function getTask(id) { return parse(db.prepare("SELECT payload FROM tasks WHERE id = ?").get(id)); }
export function listTasks() { return db.prepare("SELECT payload FROM tasks ORDER BY updated_at DESC").all().map(parse).map((task) => ({ ...task, dependencies: dependencyInfo(task.id), canRun: canRun(task.id) })); }
export function createTask(input) {
  const id = `FD-${2200 + db.prepare("SELECT COUNT(*) as count FROM tasks").get().count}`;
  const title = input.title?.trim() || "新的 Codex 交付";
  const task = { id, title, description: input.goal?.trim() || "等待补充交付目标。", projectPath: input.projectPath || "", status: "待开始", worktree: `wt/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "new-delivery"}`, activity: "已根据目标生成实施计划", test: "未运行", testTone: "neutral", files: ["AGENTS.md", "README.md", "相关业务模块（待扫描）"], plan: ["阅读已选上下文与项目约定", "实施目标范围内的最小变更", "运行验收标准要求的验证"], approved: false, acceptance: input.acceptance || "" };
  const now = new Date().toISOString(); db.prepare("INSERT INTO tasks (id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)").run(task.id, JSON.stringify(task), now, now);
  for (const dependency of input.dependencies || []) db.prepare("INSERT OR IGNORE INTO dependencies (dependent_id, prerequisite_id, gate) VALUES (?, ?, ?)").run(task.id, dependency.id, dependency.gate === "accept" ? "accept" : "test");
  return task;
}
export function deleteTask(id) { const task = getTask(id); if (!task) throw new Error("Task not found"); db.prepare("DELETE FROM dependencies WHERE dependent_id = ? OR prerequisite_id = ?").run(id, id); db.prepare("DELETE FROM tasks WHERE id = ?").run(id); return task; }
export function approveTask(id) { const task = getTask(id); if (!task) throw new Error("Task not found"); if (!canRun(id)) throw new Error("任务依赖尚未满足：必须等待前置任务的验证门禁通过。"); return save({ ...task, approved: true, status: "执行中", activity: "Codex 已获准执行 · 正在准备工作目录", test: "等待执行", testTone: "neutral" }); }
export function recordCodexLaunch(id, launch) {
  const task = getTask(id); if (!task) throw new Error("Task not found");
  const now = new Date().toISOString();
  return save({ ...task, approved: true, status: "执行中", worktree: launch.workspacePath, activity: launch.isolated ? `Codex 已在 ${launch.branch} 中启动` : "Codex 已在共享工作目录中启动（未隔离）", test: "等待 Codex 完成", testTone: "neutral", codex: { ...launch, state: "running", startedAt: now }, execution: { phase: "会话已启动", updatedAt: now, events: [{ at: now, kind: "started", label: "Codex 会话已启动", detail: launch.workspacePath }] } });
}
export function recordCodexEvent(id, event) {
  const task = getTask(id); if (!task) return null;
  const execution = appendExecutionEvent(task, event);
  if (!execution) return task;
  if (event.method !== "turn/completed") return save({ ...task, activity: execution.events.at(-1).label, execution });
  return save({ ...task, activity: "Codex 本轮已完成 · 等待你运行/确认验证", test: "等待验证", testTone: "neutral", execution, codex: { ...task.codex, state: "completed", completedAt: new Date().toISOString() } });
}
export function recordWorkspaceEvidence(id, evidence) { const task = getTask(id); if (!task) throw new Error("Task not found"); return save({ ...task, evidence: { ...(task.evidence || {}), workspace: evidence, capturedAt: new Date().toISOString() }, files: evidence.changedFiles?.map((line) => line.slice(3)).filter(Boolean) || task.files }); }
export function recordVerification(id, verification) { const task = getTask(id); if (!task) throw new Error("Task not found"); const success = verification.available && verification.exitCode === 0; const updated = save({ ...task, status: success ? "待复核" : "已阻塞", activity: success ? "真实验证已通过，等待人工复核" : verification.missingDependency ? "worktree 缺少项目依赖，等待准备后重试" : "验证未通过或未配置，等待处理", test: success ? `${verification.command} 通过` : verification.missingDependency ? "依赖未准备，无法验证" : verification.available ? `${verification.command} 失败（退出码 ${verification.exitCode}）` : "没有可运行的验证命令", testTone: success ? "success" : "danger", evidence: { ...(task.evidence || {}), verification, verifiedAt: new Date().toISOString() } }); if (success) releaseDependents(id); return updated; }
export function acceptTask(id) { const task = getTask(id); if (!task) throw new Error("Task not found"); const updated = save({ ...task, status: "已完成", activity: "交付已接受", test: "验证通过", testTone: "success" }); releaseDependents(id); return updated; }
export function returnTask(id) { const task = getTask(id); if (!task) throw new Error("Task not found"); return save({ ...task, status: "计划中", approved: false, activity: "等待你补充修改意见" }); }
