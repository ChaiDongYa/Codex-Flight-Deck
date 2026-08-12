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

const seedTasks = [
  { id: "FD-2187", title: "增加支付幂等键支持", description: "防止重试请求导致重复扣款。", status: "待开始", worktree: "wt/idempotency-key", activity: "已生成实施计划", test: "未运行", testTone: "neutral", files: ["server/api/charges/create.ts", "server/services/idempotency.ts", "migrations/20240514_idempotency.sql", "tests/idempotency.test.ts"], plan: ["新增幂等键的持久化与过期清理", "把校验接入支付与退款请求链路", "补充单元测试、集成测试与结构化日志"], approved: false },
  { id: "FD-2191", title: "重构 Webhook 签名校验", description: "抽取校验策略并补充审计测试。", status: "计划中", worktree: "wt/webhook-refactor", activity: "正在分析代码库 · 12 个文件", test: "未运行", testTone: "neutral", files: ["server/webhooks/verify.ts", "tests/webhooks.test.ts"], plan: ["梳理现有签名入口", "提取可复用策略", "覆盖边界条件"], approved: false },
  { id: "FD-2193", title: "增加退款原因码", description: "在 API 和控制台中暴露退款原因。", status: "等待依赖", worktree: "wt/refund-reasons", activity: "等待 FD-2187 的测试通过", test: "未运行", testTone: "neutral", files: ["server/refunds/reasons.ts", "web/refunds/form.tsx"], plan: ["扩展退款模型", "更新 API 与界面", "运行退款测试"], approved: false },
  { id: "FD-2184", title: "更新 VAT 计算规则", description: "应用 2024 年欧盟税率调整。", status: "待复核", worktree: "wt/vat-rules-2024", activity: "变更已完成，等待人工复核", test: "42 项通过", testTone: "success", files: ["server/tax/vat.ts", "tests/vat.test.ts"], plan: ["更新税率表", "校验地区规则", "执行全量税务测试"], approved: true },
  { id: "FD-2189", title: "修复 Apple Pay 3DS 流程", description: "处理 3DS 验证超时场景。", status: "已阻塞", worktree: "wt/applepay-3ds", activity: "等待支付网关依赖更新", test: "3 项失败", testTone: "danger", files: ["server/payments/apple-pay.ts"], plan: ["复现超时", "等待网关补丁", "增加降级路径"], approved: true },
];

if (db.prepare("SELECT COUNT(*) as count FROM tasks").get().count === 0) {
  const insert = db.prepare("INSERT INTO tasks (id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)");
  const now = new Date().toISOString();
  for (const task of seedTasks) insert.run(task.id, JSON.stringify(task), now, now);
  db.prepare("INSERT INTO dependencies (dependent_id, prerequisite_id, gate) VALUES (?, ?, ?)").run("FD-2193", "FD-2187", "test");
}

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
  const task = { id, title, description: input.goal?.trim() || "等待补充交付目标。", status: "待开始", worktree: `wt/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "new-delivery"}`, activity: "已根据目标生成实施计划", test: "未运行", testTone: "neutral", files: ["AGENTS.md", "README.md", "相关业务模块（待扫描）"], plan: ["阅读已选上下文与项目约定", "实施目标范围内的最小变更", "运行验收标准要求的验证"], approved: false, acceptance: input.acceptance || "" };
  const now = new Date().toISOString(); db.prepare("INSERT INTO tasks (id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)").run(task.id, JSON.stringify(task), now, now);
  for (const dependency of input.dependencies || []) db.prepare("INSERT OR IGNORE INTO dependencies (dependent_id, prerequisite_id, gate) VALUES (?, ?, ?)").run(task.id, dependency.id, dependency.gate === "accept" ? "accept" : "test");
  return task;
}
export function approveTask(id) { const task = getTask(id); if (!task) throw new Error("Task not found"); if (!canRun(id)) throw new Error("任务依赖尚未满足：必须等待前置任务的验证门禁通过。"); return save({ ...task, approved: true, status: "执行中", activity: "Codex 已获准执行 · 正在准备独立 worktree", test: "等待执行", testTone: "neutral" }); }
export function recordCodexLaunch(id, launch) {
  const task = getTask(id); if (!task) throw new Error("Task not found");
  return save({ ...task, approved: true, status: "执行中", activity: "Codex 已启动 · 正在执行任务", test: "等待 Codex 完成", testTone: "neutral", codex: { ...launch, state: "running", startedAt: new Date().toISOString() } });
}
export function recordCodexEvent(id, event) {
  const task = getTask(id); if (!task) return null;
  if (event.method !== "turn/completed") return task;
  return save({ ...task, activity: "Codex 本轮已完成 · 等待你运行/确认验证", test: "等待验证", testTone: "neutral", codex: { ...task.codex, state: "completed", completedAt: new Date().toISOString() } });
}
export function passTests(id) { const task = getTask(id); if (!task) throw new Error("Task not found"); const updated = save({ ...task, status: "待复核", activity: "验证完成，等待人工复核", test: "42 项通过", testTone: "success" }); releaseDependents(id); return updated; }
export function acceptTask(id) { const task = getTask(id); if (!task) throw new Error("Task not found"); const updated = save({ ...task, status: "已完成", activity: "交付已接受", test: "验证通过", testTone: "success" }); releaseDependents(id); return updated; }
export function returnTask(id) { const task = getTask(id); if (!task) throw new Error("Task not found"); return save({ ...task, status: "计划中", approved: false, activity: "等待你补充修改意见" }); }
