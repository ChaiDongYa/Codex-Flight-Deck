import { DatabaseSync } from "node:sqlite";
import { availableParallelism } from "node:os";
import {
  completeInitialization,
  databaseFile,
  initializeAppStorage,
  storageStatus,
} from "./storage.mjs";

const boot = initializeAppStorage();
const db = new DatabaseSync(databaseFile);
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

function normaliseReviewTitle(value = "") {
  return `${value}`
    .toLowerCase()
    .replace(/[\s，。、“”"'‘’：:；;？?！!（）()【】\[\]_-]/g, "");
}
function reviewTitleSimilarity(left, right) {
  const leftText = normaliseReviewTitle(left);
  const rightText = normaliseReviewTitle(right);
  if (!leftText || !rightText) return 0;
  if (leftText === rightText) return 1;
  const grams = (text) =>
    new Set(
      Array.from({ length: Math.max(0, text.length - 1) }, (_, index) =>
        text.slice(index, index + 2),
      ),
    );
  const leftGrams = grams(leftText);
  const rightGrams = grams(rightText);
  const common = [...leftGrams].filter((gram) => rightGrams.has(gram)).length;
  return common / Math.max(1, Math.min(leftGrams.size, rightGrams.size));
}

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS dependencies (dependent_id TEXT NOT NULL, prerequisite_id TEXT NOT NULL, gate TEXT NOT NULL DEFAULT 'test', PRIMARY KEY (dependent_id, prerequisite_id));
  CREATE TABLE IF NOT EXISTS releases (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS release_stage_settings (project_path TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS task_stage_settings (project_path TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS queue_settings (key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS knowledge_docs (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS knowledge_doc_versions (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(document_id, version));
`);

function ensureKnowledgeVectors() {
  const documents = db
    .prepare("SELECT payload FROM knowledge_docs")
    .all()
    .map(parse)
    .filter(Boolean);
  let rebuilt = 0;
  for (const document of documents) {
    if (Array.isArray(document.vector) && document.vector.length === 192)
      continue;
    const updated = {
      ...document,
      vector: vectorize(`${document.title || ""}\n${document.content || ""}`),
      updatedAt: document.updatedAt || new Date().toISOString(),
    };
    db.prepare(
      "UPDATE knowledge_docs SET payload = ?, updated_at = ? WHERE id = ?",
    ).run(JSON.stringify(updated), updated.updatedAt, updated.id);
    rebuilt += 1;
  }
  return { documents: documents.length, rebuilt };
}

const knowledgeInitialization = boot.needsKnowledgeIndex
  ? ensureKnowledgeVectors()
  : { documents: 0, rebuilt: 0 };
const initialization = completeInitialization({ firstRun: boot.firstRun });

export function getInitializationStatus() {
  return {
    ...storageStatus(),
    firstRun: boot.firstRun,
    knowledge: knowledgeInitialization,
    schemaVersion: initialization.schemaVersion,
  };
}

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
const queueMaxConcurrency = Math.min(8, Math.max(1, availableParallelism()));
const defaultQueueSettings = Object.freeze({ paused: false, concurrency: queueMaxConcurrency });
export function getQueueMaxConcurrency() {
  return queueMaxConcurrency;
}
export function getQueueSettings() {
  const stored = parse(
    db.prepare("SELECT payload FROM queue_settings WHERE key = 'default'").get(),
  );
  return {
    paused: Boolean(stored?.paused),
    // Older records did not store a mode and used the old fixed default of 2.
    // Treat them as device-max defaults; explicit changes remain custom.
    concurrency: stored?.mode === "custom"
      ? Math.min(queueMaxConcurrency, Math.max(1, Number(stored.concurrency) || defaultQueueSettings.concurrency))
      : defaultQueueSettings.concurrency,
    mode: stored?.mode === "custom" ? "custom" : "device-max",
  };
}
export function updateQueueSettings(input = {}) {
  const current = getQueueSettings();
  const next = {
    paused: typeof input.paused === "boolean" ? input.paused : current.paused,
    concurrency: Number.isFinite(Number(input.concurrency))
      ? Math.min(queueMaxConcurrency, Math.max(1, Math.floor(Number(input.concurrency))))
      : current.concurrency,
    mode: Number.isFinite(Number(input.concurrency)) ? "custom" : current.mode,
  };
  db.prepare(
    "INSERT INTO queue_settings (key, payload, updated_at) VALUES ('default', ?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
  ).run(JSON.stringify(next), new Date().toISOString());
  return next;
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
  const task = getTask(taskId);
  return (
    dependencyInfo(taskId).every((dependency) => dependency.satisfied) &&
    !hasBlockingReviewItem(task)
  );
}
function hasBlockingReviewItem(task) {
  if (!task?.versionId) return false;
  const release = getRelease(task.versionId);
  return Boolean(
    release?.reviewItems?.some(
      (item) => item.status === "待确认" && item.impact === "阻塞",
    ),
  );
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
        activity: "依赖已验证，可批准计划并启动",
      });
  }
}

export function listScheduledRunnableTasks(today = new Date().toISOString().slice(0, 10)) {
  return listTasks().filter(
    (task) =>
      task.canRun &&
      ["待开始", "计划中"].includes(task.status) &&
      task.codex?.state !== "running" &&
      task.startDate &&
      task.startDate <= today,
  );
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
      reviewBlocked: hasBlockingReviewItem(task),
      canRun: canRun(task.id),
      summary: deliverySummary(task),
    }));
}

// Earlier versions could persist a successful automatic verification without
// advancing the status. This strictly repairs that completed, proven state.
export function reconcileCompletedVerificationStates() {
  let repaired = 0;
  for (const task of listTasks()) {
    // Earlier release tasks could be accepted immediately after their changes
    // were committed to the release branch. That is not a merge into main;
    // return the task to the final-merge gate until the release is merged.
    if (
      task.codex?.deliveryMode === "release" &&
      task.merge?.state === "release-committed" &&
      getRelease(task.versionId)?.merge?.state !== "merged" &&
      task.taskStage !== "待合并"
    ) {
      save({
        ...task,
        status: "待复核",
        taskStage: "待合并",
        activity: "已提交到版本分支，等待版本最终合并到目标分支",
        test: "验证通过 · 等待版本合并",
        testTone: "success",
      });
      repaired += 1;
      continue;
    }
    const requiresCodeEvidence = ["前端专家", "后端专家", "全栈工程师"].includes(task.role);
    const hasCapturedCode = (task.evidence?.workspace?.changedFiles || []).some(
      (line) => !/(^|\/)(\.DS_Store|Thumbs\.db)$/i.test(`${line}`.slice(3)),
    );
    // Repair legacy tasks that were allowed into review solely because a
    // verification command passed. A development delivery with an inspected
    // empty workspace has no code for the user to review or merge.
    if (
      task.status === "执行中" &&
      task.codex?.state === "completed" &&
      !task.evidence?.verification
    ) {
      save({
        ...task,
        status: "待验证",
        taskStage: "待自测",
        activity: "Codex 本轮已完成，等待运行验证",
        test: "等待验证",
        testTone: "neutral",
      });
      repaired += 1;
      continue;
    }
    if (
      task.status === "执行中" &&
      task.codex?.state === "completed" &&
      task.evidence?.verification &&
      (!task.evidence.verification.available || task.evidence.verification.exitCode !== 0)
    ) {
      const verification = task.evidence.verification;
      save({
        ...task,
        status: "已阻塞",
        taskStage: "已阻塞",
        activity: verification.missingDependency
          ? "worktree 缺少项目依赖，等待准备后重试"
          : "验证未通过，等待处理",
        test: verification.missingDependency
          ? "依赖未准备，无法验证"
          : `${verification.command || "项目验证"} 失败`,
        testTone: "danger",
      });
      repaired += 1;
      continue;
    }
    if (
      task.status === "待复核" &&
      task.codex?.state === "completed" &&
      requiresCodeEvidence &&
      task.evidence?.workspace &&
      !hasCapturedCode &&
      task.merge?.state !== "merged"
    ) {
      save({
        ...task,
        status: "已阻塞",
        taskStage: "已阻塞",
        activity: "未检测到可审阅的代码变更，已阻塞等待补充",
        test: "未检测到可审阅的代码变更",
        testTone: "danger",
      });
      repaired += 1;
      continue;
    }
    if (
      task.status === "待复核" &&
      task.taskStage === "待合并" &&
      task.merge?.state === "ready" &&
      !hasReviewableMergeDiff(task.merge?.diff)
    ) {
      save({
        ...task,
        taskStage: "待复核",
        activity: "未发现可合并的代码变更，等待退回补充或定点修改",
      });
      repaired += 1;
      continue;
    }
    const verification = task.evidence?.verification;
    if (
      task.status !== "执行中" ||
      task.codex?.state !== "completed" ||
      !verification?.available ||
      verification.exitCode !== 0
    )
      continue;
    save({
      ...task,
      status: "待复核",
      taskStage: "待复核",
      activity: "真实验证已通过，等待查看变更并确认合并",
      test: `${verification.command || "项目验证"} 通过`,
      testTone: "success",
    });
    repaired += 1;
  }
  return repaired;
}
// This is a deliberately broad default, not a mandatory process. Each project
// stores its own ordered stage list and can hide any stage it does not use.
const defaultReleaseStages = [
  "需求澄清 / 评审",
  "UI / UX 设计",
  "UI / UX 评审",
  "技术方案 / 架构评审",
  "开发阶段",
  "代码评审",
  "提测准备",
  "测试阶段",
  "UAT / 业务验收",
  "发布准备 / 变更评审",
  "已上线 / 复盘",
];
const defaultTaskStages = [
  "待澄清", "待设计", "待开发", "Codex 执行中", "待自测",
  "待复核", "待合并", "已完成", "已阻塞",
];
const systemTaskStages = new Set([
  "待澄清",
  "待设计",
  "待开发",
  "Codex 执行中",
  "待自测",
  "待复核",
  "待合并",
  "已完成",
  "已阻塞",
]);
function normaliseReleaseStages(stages) {
  const seen = new Set();
  const value = Array.isArray(stages) ? stages : [];
  const normalised = value
    .map((stage) => ({
      name: `${stage?.name || ""}`.trim(),
      visible: stage?.visible !== false,
    }))
    .filter(
      (stage) => stage.name && !seen.has(stage.name) && seen.add(stage.name),
    );
  return normalised.length
    ? normalised
    : defaultReleaseStages.map((name) => ({ name, visible: true }));
}

function stagesForProject(projectPath = "") {
  const row = db
    .prepare(
      "SELECT payload FROM release_stage_settings WHERE project_path = ?",
    )
    .get(projectPath || "");
  return row
    ? normaliseReleaseStages(parse(row))
    : defaultReleaseStages.map((name) => ({ name, visible: true }));
}

export function listReleaseStages(projectPath = "") {
  return stagesForProject(projectPath);
}

export function updateReleaseStages(projectPath = "", stages = []) {
  const normalised = normaliseReleaseStages(stages);
  if (!normalised.some((stage) => stage.visible))
    throw new Error("请至少展示一个研发阶段。");
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO release_stage_settings (project_path, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_path) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
  ).run(projectPath || "", JSON.stringify(normalised), now);
  return normalised;
}
function normaliseTaskStages(stages) {
  const seen = new Set();
  const normalised = (Array.isArray(stages) ? stages : [])
    .map((stage) => `${stage || ""}`.trim())
    .filter((stage) => stage && !seen.has(stage) && seen.add(stage));
  const value = normalised.length ? normalised : [...defaultTaskStages];
  const customStages = value.filter((stage) => !systemTaskStages.has(stage));
  // System stages are written by task execution and must always remain ordered.
  return defaultTaskStages.filter((stage) => systemTaskStages.has(stage))
    .map((stage) => stage)
    .concat(customStages.filter((stage) => !defaultTaskStages.includes(stage)));
}
export function isSystemTaskStage(stage) {
  return systemTaskStages.has(stage);
}
export function listTaskStages(projectPath = "") {
  const row = db.prepare("SELECT payload FROM task_stage_settings WHERE project_path = ?").get(projectPath || "");
  return row ? normaliseTaskStages(parse(row)) : [...defaultTaskStages];
}
export function updateTaskStages(projectPath = "", stages = []) {
  const normalised = normaliseTaskStages(stages);
  db.prepare(
    "INSERT INTO task_stage_settings (project_path, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_path) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
  ).run(projectPath || "", JSON.stringify(normalised), new Date().toISOString());
  return normalised;
}

function enrichRelease(release) {
  const stages = stagesForProject(release.projectPath);
  const currentIndex = stages.findIndex((item) => item.name === release.stage);
  return {
    ...release,
    // Keep an old stage value intact when an admin hides or removes it, so a
    // historical release is never silently moved to a different process step.
    stages: stages.map((item, index) => ({
      ...item,
      done: currentIndex >= 0 && index <= currentIndex,
    })),
  };
}
export function listReleases(projectPath = "") {
  return db
    .prepare("SELECT payload FROM releases ORDER BY updated_at DESC")
    .all()
    .map(parse)
    .filter((release) => !projectPath || release.projectPath === projectPath)
    .map((release) => {
      release = enrichRelease(release);
      const linked = listTasks().filter(
        (task) => task.versionId === release.id,
      );
      const blocked = linked.filter((task) => task.status === "已阻塞").length;
      const complete = linked.filter((task) => task.status === "已完成").length;
      const overdue =
        release.releaseDate &&
        new Date(release.releaseDate) < new Date() &&
        release.stage !== "已上线 / 复盘";
      return {
        ...release,
        tasks: { total: linked.length, complete, blocked },
        health: blocked || overdue ? "有风险" : "正常",
      };
    });
}
export function createRelease(input = {}) {
  const name = `${input.name || ""}`.trim();
  if (!name) throw new Error("请填写版本名称。");
  const id = `REL-${Date.now().toString(36)}`;
  const now = new Date().toISOString();
  const stages = stagesForProject(input.projectPath || "");
  const initialStage =
    stages.find((stage) => stage.visible)?.name || stages[0].name;
  const release = {
    id,
    name,
    goal: `${input.goal || ""}`.trim(),
    projectPath: input.projectPath || "",
    startDate: input.startDate || now.slice(0, 10),
    releaseDate: input.releaseDate || "",
    stage: initialStage,
    stages: stages.map((stage) => ({ ...stage, done: false })),
    createdAt: now,
    prd: "",
    attachments: [],
    reviewItems: [],
    prdAnalysis: null,
    apifox: { url: "", status: "未配置", syncedAt: "", definitions: [] },
  };
  db.prepare(
    "INSERT INTO releases (id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run(id, JSON.stringify(release), now, now);
  return release;
}
export function getRelease(id) {
  const row = db.prepare("SELECT payload FROM releases WHERE id = ?").get(id);
  const release = parse(row);
  return release ? enrichRelease(release) : null;
}
function saveRelease(release) {
  db.prepare(
    "UPDATE releases SET payload = ?, updated_at = ? WHERE id = ?",
  ).run(JSON.stringify(release), new Date().toISOString(), release.id);
  return enrichRelease(release);
}
function vectorize(text, dimensions = 192) {
  const vector = Array(dimensions).fill(0);
  const source = `${text || ""}`.toLowerCase().replace(/\s+/g, " ");
  const grams = [];
  for (let index = 0; index < source.length; index += 1) {
    grams.push(source.slice(index, index + 1));
    if (index < source.length - 1) grams.push(source.slice(index, index + 2));
  }
  for (const gram of grams) {
    let hash = 2166136261;
    for (const char of gram)
      hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    vector[(hash >>> 0) % dimensions] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => Number((value / norm).toFixed(6)));
}
function cosine(left = [], right = []) {
  return left.reduce(
    (sum, value, index) => sum + value * (right[index] || 0),
    0,
  );
}
export function listKnowledgeDocs(projectPath = "") {
  return db
    .prepare("SELECT payload FROM knowledge_docs ORDER BY updated_at DESC")
    .all()
    .map(parse)
    .filter((document) => !projectPath || document.projectPath === projectPath)
    .map(({ vector, content, ...document }) => ({
      ...document,
      excerpt: shortText(content, 260),
      size: content.length,
    }));
}
function saveKnowledgeSnapshot(document, version, createdAt) {
  db.prepare(
    "INSERT OR REPLACE INTO knowledge_doc_versions (id, document_id, version, payload, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    `${document.id}:v${version}`,
    document.id,
    version,
    JSON.stringify({ ...document, version }),
    createdAt,
  );
}
function publicKnowledge(document, limit = 260) {
  const { vector, content, ...rest } = document;
  return { ...rest, excerpt: shortText(content, limit), size: content.length };
}
function currentKnowledge(id) {
  const document = parse(
    db.prepare("SELECT payload FROM knowledge_docs WHERE id = ?").get(id),
  );
  if (!document) throw new Error("知识条目不存在。");
  if (!document.version) {
    document.version = 1;
    saveKnowledgeSnapshot(
      document,
      1,
      document.createdAt || new Date().toISOString(),
    );
    db.prepare(
      "UPDATE knowledge_docs SET payload = ?, updated_at = ? WHERE id = ?",
    ).run(
      JSON.stringify(document),
      document.updatedAt || new Date().toISOString(),
      id,
    );
  }
  return document;
}
export function createKnowledgeDoc(input = {}) {
  const title = `${input.title || ""}`.trim();
  const content = `${input.content || ""}`.trim();
  const projectPath = `${input.projectPath || ""}`.trim();
  if (!title || !content || !projectPath)
    throw new Error("请填写知识标题、内容和所属项目。");
  const now = new Date().toISOString();
  const document = {
    id: `KB-${Date.now().toString(36)}`,
    projectPath,
    title: title.slice(0, 180),
    content: content.slice(0, 120000),
    source: `${input.source || "手动输入"}`.slice(0, 80),
    tags: Array.isArray(input.tags)
      ? input.tags
          .map((tag) => `${tag}`.trim())
          .filter(Boolean)
          .slice(0, 12)
      : [],
    version: 1,
    vector: vectorize(`${title}\n${content}`),
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    "INSERT INTO knowledge_docs (id, project_path, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(document.id, document.projectPath, JSON.stringify(document), now, now);
  saveKnowledgeSnapshot(document, 1, now);
  return document;
}
export function updateKnowledgeDoc(id, input = {}) {
  const document = currentKnowledge(id);
  const title = `${input.title ?? document.title}`.trim();
  const content = `${input.content ?? document.content}`.trim();
  if (!title || !content) throw new Error("知识标题和内容不能为空。");
  const updated = {
    ...document,
    title: title.slice(0, 180),
    content: content.slice(0, 120000),
    tags: Array.isArray(input.tags)
      ? input.tags
          .map((tag) => `${tag}`.trim())
          .filter(Boolean)
          .slice(0, 12)
      : document.tags,
    vector: vectorize(`${title}\n${content}`),
    version: document.version + 1,
    updatedAt: new Date().toISOString(),
  };
  db.prepare(
    "UPDATE knowledge_docs SET payload = ?, updated_at = ? WHERE id = ?",
  ).run(JSON.stringify(updated), updated.updatedAt, id);
  saveKnowledgeSnapshot(updated, updated.version, updated.updatedAt);
  return updated;
}
export function deleteKnowledgeDoc(id) {
  db.prepare("DELETE FROM knowledge_doc_versions WHERE document_id = ?").run(
    id,
  );
  db.prepare("DELETE FROM knowledge_docs WHERE id = ?").run(id);
}
export function listKnowledgeVersions(id) {
  currentKnowledge(id);
  return db
    .prepare(
      "SELECT payload FROM knowledge_doc_versions WHERE document_id = ? ORDER BY version DESC",
    )
    .all(id)
    .map(parse)
    .map((item) => publicKnowledge(item, 600));
}
export function getKnowledgeDoc(id) {
  return currentKnowledge(id);
}
export function deleteKnowledgeVersion(id, version) {
  const document = currentKnowledge(id);
  if (Number(version) === document.version)
    throw new Error("不能删除当前版本。请先保存新版本，或删除整个知识条目。");
  const result = db
    .prepare(
      "DELETE FROM knowledge_doc_versions WHERE document_id = ? AND version = ?",
    )
    .run(id, Number(version));
  if (!result.changes) throw new Error("知识版本不存在。");
}
export function compareKnowledgeVersions(id, from, to) {
  const get = (version) =>
    parse(
      db
        .prepare(
          "SELECT payload FROM knowledge_doc_versions WHERE document_id = ? AND version = ?",
        )
        .get(id, Number(version)),
    );
  const left = get(from);
  const right = get(to);
  if (!left || !right) throw new Error("知识版本不存在。");
  const leftLines = left.content.split("\n");
  const rightLines = right.content.split("\n");
  return {
    from: publicKnowledge(left, 120000),
    to: publicKnowledge(right, 120000),
    added: rightLines.filter((line) => !leftLines.includes(line)),
    removed: leftLines.filter((line) => !rightLines.includes(line)),
  };
}
export function searchKnowledgeDocs(projectPath, query, limit = 6) {
  const needle = `${query || ""}`.trim();
  if (!needle) return [];
  const queryVector = vectorize(needle);
  return db
    .prepare("SELECT payload FROM knowledge_docs WHERE project_path = ?")
    .all(projectPath)
    .map(parse)
    .map((document) => ({
      ...document,
      score: cosine(queryVector, document.vector || []),
    }))
    .filter((document) => document.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, Math.min(Number(limit) || 6, 12)))
    .map(({ vector, content, ...document }) => ({
      ...document,
      excerpt: shortText(content, 700),
    }));
}
export function saveApifoxDefinitions(id, input = {}) {
  const release = getRelease(id);
  if (!release) throw new Error("版本不存在。");
  const definitions = Array.isArray(input.definitions)
    ? input.definitions.slice(0, 1000)
    : [];
  return saveRelease({
    ...release,
    apifox: {
      ...(release.apifox || {}),
      projectId: `${input.projectId || release.apifox?.projectId || ""}`,
      status: "已同步",
      syncedAt: new Date().toISOString(),
      title: `${input.title || "Apifox 接口定义"}`.slice(0, 200),
      version: `${input.version || ""}`.slice(0, 80),
      definitions,
    },
  });
}
export function updateReleaseWorkspace(id, input = {}) {
  const release = getRelease(id);
  if (!release) throw new Error("版本不存在。");
  const attachments = Array.isArray(input.attachments)
    ? input.attachments
        .map((item) => ({
          id: item.id || `ATT-${Date.now().toString(36)}`,
          name: `${item.name || "未命名上下文"}`.trim().slice(0, 160),
          type: `${item.type || "文档"}`.trim(),
          url: `${item.url || ""}`.trim(),
          note: `${item.note || ""}`.trim().slice(0, 2000),
          content: `${item.content || ""}`.slice(0, 30000),
          extension: `${item.extension || ""}`.trim().slice(0, 20),
          truncated: Boolean(item.truncated),
          previewable: Boolean(item.previewable),
        }))
        .filter((item) => item.name)
        .slice(0, 30)
    : release.attachments || [];
  return saveRelease({
    ...release,
    prd: `${input.prd ?? release.prd ?? ""}`.trim().slice(0, 30000),
    attachments,
    apifox: { ...(release.apifox || {}), ...(input.apifox || {}) },
  });
}
export function createReleaseReviewItem(id, input = {}) {
  const release = getRelease(id);
  if (!release) throw new Error("版本不存在。");
  const title = `${input.title || ""}`.trim();
  if (!title) throw new Error("请填写待确认问题。");
  const sameItem = (release.reviewItems || []).find(
    (item) => reviewTitleSimilarity(item.title, title) >= 0.62,
  );
  if (sameItem) {
    const sources = [...new Set([...(sameItem.mergedTitles || []), title])];
    return saveRelease({
      ...release,
      reviewItems: release.reviewItems.map((item) =>
        item.id === sameItem.id
          ? { ...item, mergedTitles: sources, mergedCount: sources.length }
          : item,
      ),
    });
  }
  const item = {
    id: `Q-${Date.now().toString(36)}`,
    title,
    type: input.type || "业务规则",
    owner: `${input.owner || ""}`.trim(),
    dueDate: `${input.dueDate || ""}`.trim(),
    impact: input.impact || "普通",
    status: "待确认",
    conclusion: "",
    mergedTitles: [title],
    mergedCount: 1,
    createdAt: new Date().toISOString(),
  };
  return saveRelease({
    ...release,
    reviewItems: [...(release.reviewItems || []), item],
  });
}
export function mergeSimilarReleaseReviewItems(id) {
  const release = getRelease(id);
  if (!release) throw new Error("版本不存在。");
  const groups = [];
  for (const item of release.reviewItems || []) {
    const group = groups.find((entry) =>
      reviewTitleSimilarity(entry.primary.title, item.title) >= 0.62,
    );
    if (group) group.items.push(item);
    else groups.push({ primary: item, items: [item] });
  }
  const reviewItems = groups.map(({ primary, items }) => {
    const mergedTitles = [
      ...new Set(items.flatMap((item) => item.mergedTitles || [item.title])),
    ];
    const confirmed = items.find((item) => item.status === "已确认");
    return {
      ...primary,
      status: confirmed?.status || primary.status,
      conclusion: confirmed?.conclusion || primary.conclusion,
      mergedTitles,
      mergedCount: mergedTitles.length,
    };
  });
  return saveRelease({ ...release, reviewItems });
}
export function updateReleaseReviewItem(id, itemId, input = {}) {
  const release = getRelease(id);
  if (!release) throw new Error("版本不存在。");
  const current = (release.reviewItems || []).find((item) => item.id === itemId);
  const nextStatus = input.status ?? current?.status;
  const nextConclusion = `${input.conclusion ?? current?.conclusion ?? ""}`.trim();
  if (nextStatus === "已确认" && !nextConclusion)
    throw new Error("确认评审问题前，请填写具体结论。");
  return saveRelease({
    ...release,
    reviewItems: (release.reviewItems || []).map((item) =>
      item.id === itemId
        ? {
            ...item,
            ...input,
            title: `${input.title ?? item.title}`.trim().slice(0, 500),
            conclusion: nextConclusion.slice(0, 3000),
          }
        : item,
    ),
  });
}
export function deleteReleaseReviewItem(id, itemId) {
  const release = getRelease(id);
  if (!release) throw new Error("版本不存在。");
  const items = release.reviewItems || [];
  if (!items.some((item) => item.id === itemId))
    throw new Error("待确认项不存在。");
  return saveRelease({
    ...release,
    reviewItems: items.filter((item) => item.id !== itemId),
  });
}
export function getReleasePrdAnalysisInput(id) {
  const release = getRelease(id);
  if (!release) throw new Error("版本不存在。");
  const source = `${release.prd || ""}\n${release.goal || ""}`.trim();
  if (!source) throw new Error("请先填写 PRD 或版本目标。");
  return {
    release,
    source,
    attachments: (release.attachments || [])
      .map((item) => {
        const reference = `${item.type}：${item.name}${item.url ? ` ${item.url}` : ""}`;
        return item.content ? `${reference}\n文件内容：\n${item.content}` : reference;
      })
      .join("\n\n")
      .slice(0, 60000),
    taskStages: listTaskStages(release.projectPath),
    // Only confirmed decisions are requirements. Open questions must never be
    // silently treated as conclusions during task decomposition.
    reviewContext: (release.reviewItems || [])
      .filter((item) => item.status === "已确认" && item.conclusion)
      .map((item) => `${item.impact}｜问题：${item.title}｜确认结论：${item.conclusion}`)
      .join("\n"),
  };
}
export function saveReleasePrdAnalysis(id, analysis) {
  const release = getRelease(id);
  if (!release) throw new Error("版本不存在。");
  return saveRelease({ ...release, prdAnalysis: analysis });
}
export function updateReleasePrdAnalysis(id, input = {}) {
  const release = getRelease(id);
  if (!release?.prdAnalysis) throw new Error("请先生成 PRD 分析草稿。");
  const proposals = Array.isArray(input.proposals)
    ? input.proposals.map((proposal) => ({
        ...proposal,
        title: `${proposal.title || ""}`.trim().slice(0, 300),
        role: roles.has(proposal.role) ? proposal.role : "全栈工程师",
        stage: `${proposal.stage || "待开发"}`.trim().slice(0, 80),
        startDate: `${proposal.startDate || ""}`.trim().slice(0, 10),
        endDate: `${proposal.endDate || ""}`.trim().slice(0, 10),
        apiKeys: Array.isArray(proposal.apiKeys)
          ? [...new Set(proposal.apiKeys.map((key) => `${key}`.trim()).filter(Boolean))].slice(0, 50)
          : [],
        apiNotes: `${proposal.apiNotes || ""}`.trim().slice(0, 4000),
      }))
    : release.prdAnalysis.proposals;
  return saveRelease({
    ...release,
    prdAnalysis: { ...release.prdAnalysis, proposals },
  });
}
export function analyseReleasePrd(id) {
  const { release, source } = getReleasePrdAnalysisInput(id);
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const meaningful = [];
  let section = "";
  let paragraph = [];
  const flush = () => {
    const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
    paragraph = [];
    if (text.length < 18) return;
    meaningful.push(section ? `${section}：${text}` : text);
  };
  for (const line of lines) {
    if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(line)) continue;
    if (/^#{1,6}\s+/.test(line)) {
      flush();
      section = line.replace(/^#{1,6}\s+/, "").replace(/[*_`]/g, "").trim();
      continue;
    }
    if (/^\|/.test(line)) {
      const cells = line
        .split("|")
        .map((cell) => cell.replace(/[*_`]/g, "").trim())
        .filter(Boolean);
      if (cells.length >= 2 && !/^(名称|字段|版本|编号|编写日期|对象|角色)$/i.test(cells[0]))
        paragraph.push(cells.filter((cell) => !/^[-:]+$/.test(cell)).join("："));
      continue;
    }
    const cleaned = line
      .replace(/^\s*[-*+]\s+/, "")
      .replace(/^\s*\d+[.)、]\s*/, "")
      .replace(/[*_`]/g, "")
      .trim();
    if (cleaned.length >= 8) paragraph.push(cleaned);
    if (/[。！？；]$/.test(cleaned)) flush();
  }
  flush();
  const seed = [...new Set(meaningful)].slice(0, 8);
  if (!seed.length) seed.push(`${release.name || "本版本"}：明确需求范围、实现边界与验收标准`);
  const roles = ["产品专家", "UI/UX 专家", "前端专家", "后端专家", "测试专家"];
  const proposals = seed.slice(0, 8).map((goal, index) => ({
    key: `draft-${index + 1}`,
    title: goal.length > 34 ? goal.slice(0, 34) + "…" : goal,
    goal,
    role: roles[index % roles.length],
    stage: index === 0 ? "待澄清" : index === 1 ? "待设计" : "待开发",
    acceptance: "用户可见结果：完成任务说明中的用户可观察结果。\n验证与边界：按任务范围完成一次最小验证并记录预期结果；补充空态、异常或状态切换等实际相关边界。",
    selected: true,
    dependencies: index > 2 ? [`draft-${index}`] : [],
  }));
  const questions =
    source.includes("待定") || source.includes("确认")
      ? ["PRD 中存在待确认描述：请明确边界、异常处理与验收口径。"]
      : ["是否已有明确的验收环境、负责人和计划上线窗口？"];
  const analysis = {
    generatedAt: new Date().toISOString(),
    summary: `已根据 PRD 生成 ${proposals.length} 项建议任务。请确认范围后再创建，任务不会自动执行。`,
    proposals,
    questions,
    risks: [
      "接口契约、权限与异常场景需要在开发前确认。",
      "拆分任务前应标记前置依赖，避免并行修改同一模块。",
    ],
  };
  return saveRelease({ ...release, prdAnalysis: analysis });
}
export function createTasksFromReleaseAnalysis(id, input = {}) {
  const release = getRelease(id);
  if (!release?.prdAnalysis?.proposals?.length)
    throw new Error("请先生成 PRD 分析草稿。");
  const proposals =
    Array.isArray(input.proposals) && input.proposals.length
      ? input.proposals
      : release.prdAnalysis.proposals;
  const allowedStages = new Set(listTaskStages(release.projectPath));
  const existingTaskIds = new Set(listTasks().map((task) => task.id));
  const normalizedProposals = proposals.map((proposal) => ({
    ...proposal,
    // A task can be intentionally deleted from the task board. Its old ID is
    // audit metadata, not a permanent lock on the corresponding PRD item.
    createdTaskId: existingTaskIds.has(proposal.createdTaskId)
      ? proposal.createdTaskId
      : null,
    role: roles.has(proposal.role) ? proposal.role : "全栈工程师",
    stage: allowedStages.has(proposal.stage) ? proposal.stage : "待开发",
    startDate: `${proposal.startDate || ""}`.trim().slice(0, 10),
    endDate: `${proposal.endDate || ""}`.trim().slice(0, 10),
  }));
  const selectedKeys = new Set(
    Array.isArray(input.selectedKeys)
      ? input.selectedKeys
      : normalizedProposals.map((item) => item.key),
  );
  const selected = normalizedProposals.filter(
    (item) => selectedKeys.has(item.key) && !item.createdTaskId,
  );
  if (!selected.length)
    throw new Error("所选建议任务已全部创建。请重新分析或勾选尚未创建的建议。");
  const persistedRelease = {
    ...release,
    prdAnalysis: { ...release.prdAnalysis, proposals: normalizedProposals },
  };
  const mapping = new Map();
  const created = selected.map((proposal) => {
    const availableApis = new Map(
      (release.apifox?.definitions || []).map((api) => [`${api.method} ${api.path}`, api]),
    );
    const task = createTask({
      title: proposal.title,
      goal: proposal.goal,
      role: proposal.role,
      acceptance: proposal.acceptance,
      versionId: release.id,
      deliveryMode: "direct",
      projectPath: release.projectPath,
      projectPolicy: input.projectPolicy || {},
      taskStage: proposal.stage,
      startDate: proposal.startDate,
      endDate: proposal.endDate,
      apiLinks: (proposal.apiKeys || [])
        .map((key) => availableApis.get(`${key}`))
        .filter(Boolean),
      apiNotes: proposal.apiNotes,
      context: (release.attachments || [])
        .map(
          (item) =>
            `${item.type}：${item.name}${item.url ? ` ${item.url}` : ""}`,
        )
        .join("\n"),
    });
    mapping.set(proposal.key, task);
    return task;
  });
  for (const proposal of selected)
    for (const dependencyKey of proposal.dependencies || []) {
      const dependent = mapping.get(proposal.key);
      const prerequisite = mapping.get(dependencyKey);
      if (dependent && prerequisite)
        db.prepare(
          "INSERT OR IGNORE INTO dependencies (dependent_id, prerequisite_id, gate) VALUES (?, ?, 'test')",
        ).run(dependent.id, prerequisite.id);
    }
  const createdByKey = new Map(
    created.map((task, index) => [selected[index].key, task.id]),
  );
  saveRelease({
    ...persistedRelease,
    prdAnalysis: {
      ...persistedRelease.prdAnalysis,
      proposals: persistedRelease.prdAnalysis.proposals.map((proposal) =>
        createdByKey.has(proposal.key)
          ? { ...proposal, createdTaskId: createdByKey.get(proposal.key) }
          : proposal,
      ),
    },
  });
  return created;
}
export function deleteReleaseAnalysisTasks(id) {
  const release = getRelease(id);
  if (!release?.prdAnalysis?.proposals?.length)
    throw new Error("该版本没有可删除的 AI 分析任务。");
  const createdTaskIds = release.prdAnalysis.proposals
    .map((proposal) => proposal.createdTaskId)
    .filter(Boolean);
  if (!createdTaskIds.length)
    throw new Error("该版本尚未从分析草稿创建任务。");

  const protectedTasks = createdTaskIds
    .map((taskId) => getTask(taskId))
    .filter((task) => task && !["待开始", "计划中"].includes(task.status));
  if (protectedTasks.length)
    throw new Error("仅可批量删除尚未启动的任务；已执行、复核、阻塞或完成的任务会保留为交付记录。");

  const deletedTaskIds = new Set();
  for (const taskId of createdTaskIds) {
    if (!getTask(taskId)) continue;
    deleteTask(taskId);
    deletedTaskIds.add(taskId);
  }
  saveRelease({
    ...release,
    prdAnalysis: {
      ...release.prdAnalysis,
      proposals: release.prdAnalysis.proposals.map((proposal) =>
        deletedTaskIds.has(proposal.createdTaskId)
          ? { ...proposal, createdTaskId: null }
          : proposal,
      ),
    },
  });
  return { deletedCount: deletedTaskIds.size };
}
export function updateTaskBoardStage(id, taskStage) {
  const task = getTask(id);
  if (!task) throw new Error("任务不存在。");
  if (["执行中", "待复核", "已完成", "已阻塞"].includes(task.status))
    throw new Error(
      "此任务阶段由 Codex 执行、验证或验收状态自动推进，不能手动覆盖。",
    );
  const nextStage = `${taskStage || "待开发"}`.trim().slice(0, 80);
  if (!listTaskStages(task.projectPath).includes(nextStage))
    throw new Error("请选择项目任务阶段中的有效阶段。");
  return save({
    ...task,
    taskStage: nextStage,
    activity: `研发阶段已更新为：${nextStage}`,
  });
}
export function updateReleaseStage(id, stage) {
  const row = db.prepare("SELECT payload FROM releases WHERE id = ?").get(id);
  const release = parse(row);
  if (!release) throw new Error("版本不存在。");
  const stages = stagesForProject(release.projectPath);
  const currentIndex = stages.findIndex((item) => item.name === stage);
  if (currentIndex < 0) throw new Error("未知的版本阶段。");
  const updated = {
    ...release,
    stage,
    stages: stages.map((item, index) => ({
      ...item,
      done: index <= currentIndex,
    })),
  };
  db.prepare(
    "UPDATE releases SET payload = ?, updated_at = ? WHERE id = ?",
  ).run(JSON.stringify(updated), new Date().toISOString(), id);
  return updated;
}
export function updateRelease(id, input = {}) {
  const row = db.prepare("SELECT payload FROM releases WHERE id = ?").get(id);
  const release = parse(row);
  if (!release) throw new Error("版本不存在。");
  const name = `${input.name ?? release.name}`.trim();
  if (!name) throw new Error("请填写版本名称。");
  const updated = {
    ...release,
    name,
    goal: `${input.goal ?? release.goal ?? ""}`.trim(),
    startDate: `${input.startDate ?? release.startDate ?? ""}`.trim(),
    releaseDate: `${input.releaseDate ?? release.releaseDate ?? ""}`.trim(),
  };
  db.prepare(
    "UPDATE releases SET payload = ?, updated_at = ? WHERE id = ?",
  ).run(JSON.stringify(updated), new Date().toISOString(), id);
  return enrichRelease(updated);
}
export function deleteRelease(id) {
  const release = getRelease(id);
  if (!release) throw new Error("版本不存在。");
  const linked = listTasks().filter((task) => task.versionId === id);
  if (linked.length)
    throw new Error(`版本已关联 ${linked.length} 个任务，请先处理关联任务后再删除。`);
  db.prepare("DELETE FROM releases WHERE id = ?").run(id);
  return release;
}
export function recordReleaseMergePreview(id, preview) {
  const release = getRelease(id);
  if (!release) throw new Error("版本不存在。");
  return saveRelease({ ...release, merge: { ...(release.merge || {}), ...preview, previewedAt: new Date().toISOString() } });
}
export function recordReleaseMergeResult(id, result) {
  const release = getRelease(id);
  if (!release) throw new Error("版本不存在。");
  const updated = saveRelease({ ...release, merge: { ...(release.merge || {}), ...result, mergedAt: result.mergedAt || new Date().toISOString() } });
  if (result.state === "merged") {
    for (const task of listTasks().filter(
      (item) => item.versionId === id && item.merge?.state === "release-committed",
    )) {
      save({
        ...task,
        status: "待复核",
        taskStage: "待复核",
        activity: `版本已合并到 ${result.targetBranch}，等待最终验收`,
        test: "验证通过 · 已合并",
        testTone: "success",
        merge: { ...task.merge, state: "merged", targetBranch: result.targetBranch, mergedAt: result.mergedAt || new Date().toISOString() },
      });
    }
  }
  return updated;
}
export function createTask(input) {
  const id = `FD-${2200 + db.prepare("SELECT COUNT(*) as count FROM tasks").get().count}`;
  const title = input.title?.trim() || "新的 Codex 交付";
  const role = roles.has(input.role) ? input.role : "全栈工程师";
  const knowledge = input.projectPath
    ? searchKnowledgeDocs(input.projectPath, `${title}\n${input.goal || ""}`, 3)
    : [];
  const knowledgeContext = knowledge.length
    ? `\n\n本地知识检索（仅与本任务相关）：\n${knowledge.map((document) => `- ${document.title}：${document.excerpt}`).join("\n")}`
    : "";
  const release = input.versionId ? getRelease(input.versionId) : null;
  if (release && release.projectPath !== input.projectPath)
    throw new Error("所属版本必须属于当前项目。");
  const requestedDeliveryMode = ["direct", "task", "release", "no-code"].includes(input.deliveryMode)
    ? input.deliveryMode
    : "";
  if (requestedDeliveryMode === "release" && !release)
    throw new Error("版本统一合并需要先关联一个版本。");
  // Versions are planning metadata. Their tasks are edited and saved on the
  // project's current target branch so the task ID is visible in its commit.
  const deliveryMode = requestedDeliveryMode || (release ? "direct" : "task");
  const noCodeReason = `${input.noCodeReason || ""}`.trim().slice(0, 2000);
  if (deliveryMode === "no-code" && !noCodeReason)
    throw new Error("请选择“无需代码交付”时，请填写不开发的原因。");
  const noCode = deliveryMode === "no-code";
  const task = {
    id,
    createdAt: new Date().toISOString(),
    title,
    role,
    description: input.goal?.trim() || "等待补充交付目标。",
    projectPath: input.projectPath || "",
    projectPolicy: input.projectPolicy || {},
    status: noCode ? "待复核" : "待开始",
    worktree: `wt/${
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "") || "new-delivery"
    }`,
    activity: noCode ? "无需代码交付，等待人工确认" : `等待 ${role} 启动`,
    test: noCode ? "无需代码交付 · 待确认" : "未运行",
    testTone: noCode ? "success" : "neutral",
    files: ["AGENTS.md", "README.md", "相关业务模块（待扫描）"],
    plan: [
      "阅读已选上下文与项目约定",
      "实施目标范围内的最小变更",
      "运行验收标准要求的验证",
    ],
    approved: false,
    automation: {
      autoRun: false,
      autoVerify: false,
    },
    acceptance: input.acceptance || "",
    versionId: input.versionId || "",
    releaseName: release?.name || "",
    deliveryMode,
    noCodeReason,
    taskStage: noCode ? "待复核" : input.taskStage || "待开发",
    startDate: `${input.startDate || ""}`.trim().slice(0, 10),
    endDate: `${input.endDate || ""}`.trim().slice(0, 10),
    context: `${input.context || ""}${knowledgeContext}`.trim().slice(0, 12000),
    apiLinks: Array.isArray(input.apiLinks)
      ? input.apiLinks.map((api) => ({
          key: `${api.method} ${api.path}`,
          method: api.method,
          path: api.path,
          summary: api.summary || "",
          description: api.description || "",
        }))
      : [],
    apiNotes: `${input.apiNotes || ""}`.trim().slice(0, 4000),
    knowledgeRefs: knowledge.map((document) => ({
      id: document.id,
      title: document.title,
      version: document.version || 1,
      score: Number(document.score.toFixed(3)),
    })),
    merge: {
      mode: input.mergeMode === "auto" ? "auto" : "manual",
      targetBranch: input.targetBranch || "",
      state: noCode ? "not-required" : "pending",
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
export function updateTaskInterfaces(id, input = {}) {
  const task = getTask(id);
  if (!task) throw new Error("任务不存在。");
  if (task.status === "执行中")
    throw new Error("Codex 执行中，请停止后再修改接口上下文。");
  const release = task.versionId ? getRelease(task.versionId) : null;
  const available = new Map(
    (release?.apifox?.definitions || []).map((api) => [`${api.method} ${api.path}`, api]),
  );
  const apiLinks = [...new Set(Array.isArray(input.apiKeys) ? input.apiKeys : [])]
    .map((key) => available.get(`${key}`))
    .filter(Boolean)
    .map((api) => ({ key: `${api.method} ${api.path}`, method: api.method, path: api.path, summary: api.summary || "", description: api.description || "" }));
  return save({
    ...task,
    apiLinks,
    apiNotes: `${input.apiNotes || ""}`.trim().slice(0, 4000),
    activity: "接口与联调上下文已更新",
  });
}
export function updateTaskPlan(id, input = {}) {
  const task = getTask(id);
  if (!task) throw new Error("任务不存在。");
  if (task.codex?.workspacePath || ["执行中", "已完成"].includes(task.status))
    throw new Error("任务已开始执行，请使用增量修改，不能覆盖原计划。");
  const release = task.versionId ? getRelease(task.versionId) : null;
  const availableApis = new Map(
    (release?.apifox?.definitions || []).map((api) => [`${api.method} ${api.path}`, api]),
  );
  const taskStage = `${input.taskStage || task.taskStage || "待开发"}`.trim().slice(0, 80);
  if (!listTaskStages(task.projectPath).includes(taskStage))
    throw new Error("请选择项目任务阶段中的有效阶段。");
  const apiLinks = [...new Set(Array.isArray(input.apiKeys) ? input.apiKeys : [])]
    .map((key) => availableApis.get(`${key}`))
    .filter(Boolean)
    .map((api) => ({ key: `${api.method} ${api.path}`, method: api.method, path: api.path, summary: api.summary || "", description: api.description || "" }));
  const versionId = `${input.versionId ?? task.versionId ?? ""}`.trim();
  const selectedRelease = versionId ? getRelease(versionId) : null;
  if (versionId && (!selectedRelease || selectedRelease.projectPath !== task.projectPath))
    throw new Error("请选择当前项目中的有效版本。");
  const requestedDeliveryMode = ["direct", "task", "release", "no-code"].includes(input.deliveryMode)
    ? input.deliveryMode
    : task.deliveryMode || "task";
  if (requestedDeliveryMode === "release" && !versionId)
    throw new Error("版本统一合并需要先关联一个版本。");
  const noCodeReason = `${input.noCodeReason ?? task.noCodeReason ?? ""}`.trim().slice(0, 2000);
  if (requestedDeliveryMode === "no-code" && !noCodeReason)
    throw new Error("请选择“无需代码交付”时，请填写不开发的原因。");
  const deliveryMode = versionId && requestedDeliveryMode !== "no-code"
    ? "direct"
    : requestedDeliveryMode;
  const noCode = deliveryMode === "no-code";
  return save({
    ...task,
    title: `${input.title || ""}`.trim().slice(0, 300) || task.title,
    role: roles.has(input.role) ? input.role : task.role,
    description: `${input.description || ""}`.trim().slice(0, 12000) || task.description,
    acceptance: `${input.acceptance || ""}`.trim().slice(0, 12000),
    taskStage: noCode ? "待复核" : taskStage,
    versionId,
    releaseName: selectedRelease?.name || "",
    deliveryMode,
    noCodeReason,
    priority: ["低", "普通", "高", "紧急"].includes(input.priority)
      ? input.priority
      : task.priority || "普通",
    startDate: `${input.startDate || ""}`.trim().slice(0, 10),
    endDate: `${input.endDate || ""}`.trim().slice(0, 10),
    apiLinks,
    apiNotes: `${input.apiNotes || ""}`.trim().slice(0, 4000),
    status: noCode ? "待复核" : task.deliveryMode === "no-code" ? "待开始" : task.status,
    test: noCode ? "无需代码交付 · 待确认" : task.deliveryMode === "no-code" ? "未运行" : task.test,
    testTone: noCode ? "success" : task.deliveryMode === "no-code" ? "neutral" : task.testTone,
    merge: noCode ? { ...(task.merge || {}), state: "not-required" } : task.deliveryMode === "no-code" ? { ...(task.merge || {}), state: "pending" } : task.merge,
    pendingFeedback: "",
    activity: noCode ? "无需代码交付，等待人工确认" : "任务计划已更新，等待启动",
  });
}
export function updateTaskProperties(id, input = {}) {
  const task = getTask(id);
  if (!task) throw new Error("任务不存在。");
  if (task.codex?.workspacePath || ["执行中", "已完成"].includes(task.status))
    throw new Error("任务已开始执行，请通过增量修改保留已有交付记录。");
  const taskStage = `${input.taskStage ?? task.taskStage ?? "待开发"}`.trim().slice(0, 80);
  if (!listTaskStages(task.projectPath).includes(taskStage))
    throw new Error("请选择项目任务阶段中的有效阶段。");
  const versionId = `${input.versionId ?? task.versionId ?? ""}`.trim();
  if (versionId) {
    const release = getRelease(versionId);
    if (!release || release.projectPath !== task.projectPath)
      throw new Error("请选择当前项目中的有效版本。");
  }
  const startDate = `${input.startDate ?? task.startDate ?? ""}`.trim().slice(0, 10);
  const endDate = `${input.endDate ?? task.endDate ?? ""}`.trim().slice(0, 10);
  if (startDate && endDate && endDate < startDate)
    throw new Error("计划结束日期不能早于开始日期。");
  return save({
    ...task,
    role: roles.has(input.role) ? input.role : task.role,
    taskStage,
    versionId,
    startDate,
    endDate,
    priority: ["低", "普通", "高", "紧急"].includes(input.priority)
      ? input.priority
      : task.priority || "普通",
    activity: "任务属性已更新，等待启动",
  });
}
export function addTaskComment(id, input = {}) {
  const task = getTask(id);
  if (!task) throw new Error("任务不存在。");
  const body = `${input.body || ""}`.trim().slice(0, 8000);
  if (!body) throw new Error("请填写讨论内容。");
  const attachment = input.attachment?.path
    ? {
        name: `${input.attachment.name || "附件"}`.slice(0, 300),
        path: `${input.attachment.path}`.slice(0, 4000),
        type: `${input.attachment.type || "文件"}`.slice(0, 80),
        content: `${input.attachment.content || ""}`.slice(0, 30000),
        previewable: Boolean(input.attachment.previewable),
      }
    : null;
  const comment = {
    id: `comment-${Date.now().toString(36)}`,
    body,
    attachment,
    createdAt: new Date().toISOString(),
  };
  return save({
    ...task,
    comments: [...(task.comments || []), comment].slice(-100),
    activity: "已补充任务讨论与决策",
  });
}
export function deleteTaskComment(id, commentId) {
  const task = getTask(id);
  if (!task) throw new Error("任务不存在。");
  const comments = task.comments || [];
  if (!comments.some((comment) => comment.id === commentId))
    throw new Error("讨论不存在或已删除。");
  return save({
    ...task,
    comments: comments.filter((comment) => comment.id !== commentId),
    activity: "已删除任务讨论",
  });
}
export function deleteTask(id, { force = false } = {}) {
  const task = getTask(id);
  if (!task) throw new Error("Task not found");
  if (!force && (
    task.codex?.workspacePath ||
    task.codex?.threadId ||
    (task.execution?.events || []).length > 0 ||
    ["执行中", "已完成"].includes(task.status)
  ))
    throw new Error("任务已有执行或 worktree 记录，会保留为交付记录，不能删除。");
  db.prepare(
    "DELETE FROM dependencies WHERE dependent_id = ? OR prerequisite_id = ?",
  ).run(id, id);
  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  return task;
}
export function recordWorktreeCleanup(id) {
  const task = getTask(id);
  if (!task) throw new Error("Task not found");
  if (task.status !== "已完成" || task.merge?.state !== "merged")
    throw new Error("仅已合并且已完成的任务可以清理 worktree。");
  return save({
    ...task,
    activity: "已清理已合并的任务 worktree",
    codex: { ...task.codex, workspacePath: "", worktreeCleanedAt: new Date().toISOString() },
  });
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
  // Verification belongs to one Codex turn. A restarted task must never show
  // an earlier result as evidence for the new code.
  const { verification: _previousVerification, verifiedAt: _previousVerifiedAt, ...priorEvidence } =
    task.evidence || {};
  return save({
    ...task,
    approved: true,
    status: "执行中",
    taskStage: "Codex 执行中",
    worktree: launch.workspacePath,
    activity: launch.isolated
      ? `Codex 已在 ${launch.branch} 中启动`
      : "Codex 已在共享工作目录中启动（未隔离）",
    test: "等待 Codex 完成",
    testTone: "neutral",
    codex: { ...launch, state: "running", startedAt: now },
    evidence: Object.keys(priorEvidence).length ? priorEvidence : undefined,
    pendingFeedback: "",
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

export function recordRevisionLaunch(id, launch, feedback) {
  const task = getTask(id);
  if (!task) throw new Error("Task not found");
  if (!task.codex?.workspacePath)
    throw new Error("任务尚未创建 worktree，无法进行增量修改。");
  if (["执行中", "已完成"].includes(task.status))
    throw new Error("当前状态不能启动增量修改。");
  if (task.merge?.state === "merged")
    throw new Error(
      "交付已合并到目标分支。请新建后续交付，避免修改已验收的历史记录。",
    );
  const note = `${feedback || ""}`.trim();
  if (!note) throw new Error("请先描述需要修改的问题。");
  const now = new Date().toISOString();
  const { verification: _previousVerification, verifiedAt: _previousVerifiedAt, ...priorEvidence } =
    task.evidence || {};
  const revisions = [
    ...(task.revisions || []),
    {
      at: now,
      feedback: note,
      threadId: launch.threadId,
      turnId: launch.turnId,
      state: "running",
    },
  ].slice(-12);
  return save({
    ...task,
    approved: true,
    status: "执行中",
    taskStage: "Codex 执行中",
    activity: `正在增量修改：${note.slice(0, 48)}`,
    test: "等待增量修改完成",
    testTone: "neutral",
    // A previous diff is no longer a valid merge basis after code changes.
    // Keep the audit trail, but require the user to inspect a fresh diff.
    merge: task.merge
      ? { ...task.merge, state: "stale", staleAt: now }
      : undefined,
    codex: {
      ...task.codex,
      ...launch,
      state: "running",
      startedAt: now,
      revision: true,
    },
    evidence: Object.keys(priorEvidence).length ? priorEvidence : undefined,
    revisions,
    execution: {
      phase: "正在按修改意见增量修订",
      updatedAt: now,
      events: [
        ...(task.execution?.events || []),
        {
          at: now,
          kind: "revision-started",
          label: "Codex 开始增量修改",
          detail: note,
        },
      ].slice(-40),
    },
  });
}
export function recordCodexEvent(id, event, workspaceEvidence = null) {
  const task = getTask(id);
  if (!task) return null;
  if (!task.codex?.state) return task;
  // app-server can flush buffered notifications after its process is stopped.
  // They describe the old turn and must never overwrite the explicit pause.
  if (task.codex.state !== "running") return task;
  const execution = appendExecutionEvent(task, event);
  if (!execution) return task;
  if (event.method !== "turn/completed")
    return save({
      ...task,
      activity: execution.events.at(-1).label,
      execution,
    });
  const requiresCodeEvidence = ["前端专家", "后端专家", "全栈工程师"].includes(task.role);
  const changedFiles = workspaceEvidence?.changedFiles || [];
  const hasReviewableChange = changedFiles.some(
    (line) => !/(^|\/)(\.DS_Store|Thumbs\.db)$/i.test(`${line}`.slice(3)),
  );
  const noCodeChange = requiresCodeEvidence && workspaceEvidence && !hasReviewableChange;
  const evidence = workspaceEvidence
    ? {
        ...(task.evidence || {}),
        workspace: workspaceEvidence,
        capturedAt: new Date().toISOString(),
      }
    : task.evidence;
  return save({
    ...task,
    activity: noCodeChange
      ? "Codex 本轮未产生可审阅代码，已阻塞等待补充"
      : "Codex 本轮已完成 · 等待你运行/确认验证",
    status: noCodeChange ? "已阻塞" : "待验证",
    taskStage: noCodeChange ? "已阻塞" : "待自测",
    test: noCodeChange ? "未检测到可审阅的代码变更" : "等待验证",
    testTone: noCodeChange ? "danger" : "neutral",
    execution,
    evidence,
    files: workspaceEvidence
      ? changedFiles.map((line) => `${line}`.slice(3)).filter(Boolean)
      : task.files,
    codex: {
      ...task.codex,
      state: "completed",
      completedAt: new Date().toISOString(),
    },
    revisions: (task.revisions || []).map((revision, index, list) =>
      index === list.length - 1 && revision.state === "running"
        ? {
            ...revision,
            state: "completed",
            completedAt: new Date().toISOString(),
          }
        : revision,
    ),
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
    revisions: (task.revisions || []).map((revision, index, list) =>
      index === list.length - 1 && revision.state === "running"
        ? { ...revision, state: "stopped", stoppedAt: now }
        : revision,
    ),
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
function hasReviewableMergeDiff(diff = "") {
  return [...`${diff}`.matchAll(/^diff --git a\/.+? b\/(.+)$/gm)].some(
    (match) => !/(^|\/)(\.DS_Store|Thumbs\.db)$/i.test(match[1]),
  );
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
    // A workspace-only file (for example .DS_Store) must not make a task look
    // ready to merge. It remains a review decision: request a focused fix or
    // return it for a real code change.
    taskStage:
      task.status === "待复核" && preview.state === "ready" && hasReviewableMergeDiff(preview.diff)
        ? "待合并"
        : task.taskStage,
  });
}
export function recordMergeResult(id, result) {
  const task = getTask(id);
  if (!task) throw new Error("Task not found");
  if (task.status !== "待复核" || task.testTone !== "success")
    throw new Error("只有真实验证通过、等待复核的任务可以合并。");
  return save({
    ...task,
    activity:
      result.state === "conflict"
        ? "合并发现冲突，主分支未修改，等待人工处理"
        : result.state === "release-committed"
          ? "本任务变更已提交到版本分支，等待版本整体合并"
        : `已合并到 ${result.targetBranch}，等待人工确认交付`,
    taskStage: result.state === "release-committed" ? "待合并" : result.state === "merged" ? "待复核" : task.taskStage,
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
    taskStage: success ? "待复核" : "已阻塞",
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
      // Tie evidence to the exact completed turn so a subsequent revision
      // cannot accidentally hide the next "运行验证" action.
      verification: { ...verification, turnId: task.codex?.turnId || null },
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
    throw new Error(
      task.codex?.deliveryMode === "release"
        ? "任务已提交到版本分支；请先在版本页确认最终合并到目标分支，再接受交付。"
        : "请先查看变更并确认合并到主项目，再接受交付。",
    );
  if (!["待复核"].includes(task.status))
    throw new Error("当前状态不能接受交付。");
  const updated = save({
    ...task,
    status: "已完成",
    taskStage: "已完成",
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
export function returnTask(id, input = {}) {
  const task = getTask(id);
  if (!task) throw new Error("Task not found");
  if (["执行中", "已完成"].includes(task.status))
    throw new Error("运行中或已完成的任务不能退回计划。");
  const feedback = `${input.feedback || ""}`.trim().slice(0, 4000);
  return save({
    ...task,
    status: "计划中",
    approved: false,
    pendingFeedback: feedback || task.pendingFeedback || "",
    activity: feedback ? "已记录修改意见，等待你启动任务" : "等待你补充修改意见",
  });
}
