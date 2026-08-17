import {
  acceptTask,
  approveTask,
  createTask,
  deleteReleaseAnalysisTasks,
  createRelease,
  createReleaseReviewItem,
  mergeSimilarReleaseReviewItems,
  createTasksFromReleaseAnalysis,
  deleteTask,
  getTask,
  listScheduledRunnableTasks,
  listTasks,
  listReleases,
  listKnowledgeDocs,
  createKnowledgeDoc,
  updateKnowledgeDoc,
  deleteKnowledgeDoc,
  listKnowledgeVersions,
  getKnowledgeDoc,
  deleteKnowledgeVersion,
  compareKnowledgeVersions,
  searchKnowledgeDocs,
  saveApifoxDefinitions,
  listReleaseStages,
  listTaskStages,
  updateReleaseStages,
  updateTaskStages,
  updateReleaseStage,
  updateRelease,
  updateReleaseReviewItem,
  updateReleasePrdAnalysis,
  deleteReleaseReviewItem,
  updateReleaseWorkspace,
  analyseReleasePrd,
  updateTaskBoardStage,
  updateTaskInterfaces,
  updateTaskPlan,
  updateTaskProperties,
  addTaskComment,
  deleteTaskComment,
  recordCodexEvent,
  recordCodexLaunch,
  recordMergePreview,
  recordMergeResult,
  recordTaskPreview,
  retryTask,
  stopCodexTask,
  recordVerification,
  recordWorkspaceEvidence,
  recordWorktreeCleanup,
  recordRevisionLaunch,
  reconcileCompletedVerificationStates,
  getInitializationStatus,
  getQueueSettings,
  getQueueMaxConcurrency,
  updateQueueSettings,
  returnTask,
  deleteRelease,
  getReleasePrdAnalysisInput,
  saveReleasePrdAnalysis,
  recordReleaseMergePreview,
  recordReleaseMergeResult,
} from "./db.mjs";
import { analysePrdWithCodex } from "./prd-analysis.mjs";
import {
  launchCodexRevision,
  launchCodexTask,
  stopCodexSession,
} from "./codex.mjs";
import {
  addProject,
  listProjects,
  setActiveProject,
  updateProjectPolicy,
  discoverProjectSetup,
  getProjectApifoxConfig,
  updateProjectApifoxConfig,
  getProjectApifoxToken,
} from "./project.mjs";
import {
  inspectWorkspace,
  inspectTaskDiff,
  mergeTaskWorktree,
  prepareReleaseMerge,
  mergeReleaseBranch,
  prepareTaskMerge,
  commitDirectTask,
  runProjectVerification,
  startTaskPreview,
  removeMergedTaskWorktree,
} from "./project.mjs";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const launchingTasks = new Set();
const events = new Set();
const taskTimeouts = new Map();

const editorEntryFiles = {
  "前端专家": ["package.json", "vite.config.ts", "vite.config.js", "src/main.tsx", "src/main.jsx", "src/index.tsx", "src/index.jsx"],
  "后端专家": ["pom.xml", "build.gradle.kts", "build.gradle", "settings.gradle", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "package.json"],
  "全栈工程师": ["package.json", "pom.xml", "build.gradle.kts", "build.gradle", "pyproject.toml", "go.mod", "Cargo.toml"],
};

async function projectEditorEntry(workspacePath, role) {
  const candidates = [
    ...(editorEntryFiles[role] || []),
    "package.json",
    "README.md",
  ].filter((file, index, files) => files.indexOf(file) === index);
  for (const file of candidates) {
    const candidate = path.join(workspacePath, file);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next project marker; a task worktree can legitimately omit it.
    }
  }
  return "";
}

function openNative(target) {
  return new Promise((resolve) =>
    execFile("open", [target], (error) => resolve(!error)),
  );
}

function apifoxProjectId(value) {
  const found = `${value || ""}`.match(/project\/(\d+)/);
  return found?.[1] || `${value || ""}`.trim();
}
async function syncApifoxDefinitions(releaseId, input = {}) {
  const projectId = apifoxProjectId(input.projectId || input.url);
  const token =
    `${input.token || getProjectApifoxToken(input.projectPath) || ""}`.trim();
  if (!/^\d+$/.test(projectId))
    throw new Error("请输入有效的 Apifox 项目地址或项目 ID。");
  if (!token)
    throw new Error("请输入 Apifox 访问令牌；令牌只用于本次同步，不会保存。");
  const response = await fetch(
    `https://api.apifox.com/v1/projects/${projectId}/export-openapi?locale=zh-CN`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Apifox-Api-Version": "2024-03-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        scope: { type: "ALL" },
        options: {
          includeApifoxExtensionProperties: false,
          addFoldersToTags: true,
        },
        oasVersion: "3.1",
        exportFormat: "JSON",
      }),
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      payload.message ||
        payload.error ||
        `Apifox 同步失败（${response.status}）。`,
    );
  const methods = new Set([
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "head",
    "options",
  ]);
  const definitions = Object.entries(payload.paths || {})
    .flatMap(([path, operations]) =>
      Object.entries(operations || {})
        .filter(([method]) => methods.has(method.toLowerCase()))
        .map(([method, operation]) => ({
          method: method.toUpperCase(),
          path,
          summary:
            `${operation.summary || operation.operationId || "未命名接口"}`.slice(
              0,
              300,
            ),
          tags: (operation.tags || []).slice(0, 5),
          description: `${operation.description || ""}`.slice(0, 1200),
        })),
    )
    .slice(0, 1000);
  return saveApifoxDefinitions(releaseId, {
    projectId,
    title: payload.info?.title,
    version: payload.info?.version,
    definitions,
  });
}

function publish(event, payload = {}) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const response of events) response.write(message);
}

function notifyTaskCompletion(task) {
  const title = "Flight Deck";
  const message = task.status === "已阻塞"
    ? `任务“${task.title}”需要处理：${task.test}`
    : `任务“${task.title}”已完成，等待你查看变更与验证。`;
  // Native macOS notification is best-effort; it must never affect task state.
  execFile("osascript", ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`], () => {});
}

function recordTaskCodexEvent(id, event, reason) {
  let workspaceEvidence = null;
  if (event.method === "turn/completed") {
    const task = getTask(id);
    if (task?.codex?.workspacePath) {
      try {
        workspaceEvidence = inspectWorkspace(task.codex.workspacePath);
      } catch {
        // The turn result remains visible even if the worktree cannot be
        // inspected (for example, a manually removed directory).
      }
    }
  }
  const updated = recordCodexEvent(id, event, workspaceEvidence);
  if (event.method === "turn/completed" && updated) notifyTaskCompletion(updated);
  publish("tasks", { reason, id });
}

async function launchTask(id) {
  const task = listTasks().find((item) => item.id === id);
  if (task?.deliveryMode === "no-code")
    throw new Error("该任务已标记为无需代码交付；请直接人工确认或编辑任务改为开发交付。");
  if (!task || !["待开始", "计划中"].includes(task.status) || !task.canRun)
    return null;
  if (launchingTasks.has(id)) return null;
  launchingTasks.add(id);
  try {
    const reuseWorkspace = Boolean(task.codex?.workspacePath);
    const continuationFeedback =
      task.status === "已阻塞"
        ? `请只修复上一轮失败或阻塞的问题：${task.test || task.automation?.lastError || "检查上一轮执行与验证记录后继续。"}`
        : "请继续原任务：先检查当前 worktree、已有 diff 和未完成验收项，只完成尚未完成或受影响的最小范围。";
    const launch = await (reuseWorkspace
      ? launchCodexRevision(task, continuationFeedback, {
        onEvent: (event) => {
            recordTaskCodexEvent(id, event, "codex-continuation-event");
          },
        })
      : launchCodexTask(task, {
        onEvent: (event) => {
            recordTaskCodexEvent(id, event, "codex-event");
          },
        }));
    const launched = reuseWorkspace
      ? recordRevisionLaunch(id, launch, continuationFeedback)
      : recordCodexLaunch(id, launch);
    publish("tasks", { reason: "launch", id });
    return launched;
  } finally {
    launchingTasks.delete(id);
  }
}

function queueSnapshot() {
  const settings = getQueueSettings();
  const tasks = listTasks();
  const today = new Date().toISOString().slice(0, 10);
  const pendingTasks = tasks.filter(
    (task) => ["待开始", "计划中"].includes(task.status) && task.codex?.state !== "running",
  );
  const blockedCount = pendingTasks.filter((task) => !task.canRun).length;
  const unscheduledCount = pendingTasks.filter((task) => task.canRun && !task.startDate).length;
  const futureCount = pendingTasks.filter((task) => task.canRun && task.startDate > today).length;
  const scheduleNotice = listScheduledRunnableTasks(today).length
    ? "已到期且满足依赖的任务可以从这里显式启动。"
    : blockedCount
      ? `${blockedCount} 项任务仍等待前置依赖；依赖满足后再设置或检查计划开始日期。`
      : unscheduledCount
        ? `${unscheduledCount} 项可执行任务尚未设置计划开始日期；在“编辑任务”中排期后即可从这里启动。`
        : futureCount
          ? `${futureCount} 项任务尚未到计划开始日期。`
          : "当前没有可按计划启动的任务。";
  const runningTasks = tasks
    .filter((task) => task.codex?.state === "running")
    .map((task) => ({ id: task.id, title: task.title, role: task.role, activity: task.activity }));
  const pausedTasks = tasks
    .filter((task) => task.codex?.state === "stopped" && task.status === "计划中")
    .map((task) => ({ id: task.id, title: task.title, role: task.role, activity: task.activity, canRun: task.canRun }));
  return {
    ...settings,
    maxConcurrency: getQueueMaxConcurrency(),
    running: runningTasks.length,
    capacity: Math.max(0, settings.concurrency - runningTasks.length),
    queued: 0,
    scheduled: listScheduledRunnableTasks().length,
    scheduleNotice,
    runningTasks,
    pausedTasks,
  };
}

reconcileCompletedVerificationStates();

const json = (response, status, payload) => {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
  return true;
};
const readBody = (request) =>
  new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => (data += chunk));
    request.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
const pickFolder = () =>
  new Promise((resolve, reject) =>
    execFile(
      "osascript",
      [
        "-e",
        'POSIX path of (choose folder with prompt "选择要接入 Flight Deck 的项目文件夹")',
      ],
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    ),
  );
const pickContextFile = () =>
  new Promise((resolve, reject) =>
    execFile(
      "osascript",
      [
        "-e",
        'POSIX path of (choose file with prompt "选择 PRD、Markdown、排期 CSV 或上下文文件")',
      ],
      // macOS reports a cancelled native picker as AppleScript error -128.
      // Cancellation is expected user intent, not an application error.
      (error, stdout) => (error?.code === 1 && /-128/.test(error.message) ? resolve("") : error ? reject(error) : resolve(stdout.trim())),
    ),
  );
const contextFileType = (extension) => {
  if ([".md", ".markdown", ".txt"].includes(extension)) return "PRD 文档";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(extension))
    return "图片 / 设计稿";
  if ([".json", ".yaml", ".yml", ".openapi"].includes(extension)) return "接口文档";
  return "PRD 文档";
};
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const imageMimeTypes = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
};
async function selectedContextFile() {
  const filePath = await pickContextFile();
  if (!filePath) return null;
  const extension = path.extname(filePath).toLowerCase();
  const fileStat = await stat(filePath);
  const textFile = [".md", ".markdown", ".txt", ".csv"].includes(extension);
  return {
    path: filePath,
    name: path.basename(filePath),
    extension,
    type: contextFileType(extension),
    previewable: imageExtensions.has(extension),
    // Only text documents are read. Binary documents remain local references.
    content: textFile ? (await readFile(filePath, "utf8")).slice(0, 30000) : "",
    truncated: textFile && fileStat.size > 30000,
  };
}

export async function api(request, response) {
  const url = new URL(request.url, "http://localhost");
  if (!url.pathname.startsWith("/api/")) return false;
  // Keep persisted tasks from older app-server turns aligned before exposing
  // them to the board. This is idempotent and only repairs impossible states.
  reconcileCompletedVerificationStates();
  // The dedicated Codex host renders Flight Deck from an app:// frame. Vite's
  // static-file CORS middleware does not run for this API middleware, so the
  // API itself must explicitly allow that local, opaque origin.
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Private-Network", "true");
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return true;
  }
  try {
    if (request.method === "GET" && url.pathname === "/api/health")
      return json(response, 200, {
        ok: true,
        storage: getInitializationStatus(),
      });
    if (request.method === "GET" && url.pathname === "/api/tasks")
      return json(response, 200, { tasks: listTasks() });
    if (request.method === "GET" && url.pathname === "/api/knowledge")
      return json(response, 200, {
        documents: listKnowledgeDocs(url.searchParams.get("projectPath") || ""),
      });
    if (request.method === "GET" && url.pathname === "/api/knowledge/search")
      return json(response, 200, {
        documents: searchKnowledgeDocs(
          url.searchParams.get("projectPath") || "",
          url.searchParams.get("q") || "",
          url.searchParams.get("limit"),
        ),
      });
    if (request.method === "POST" && url.pathname === "/api/knowledge")
      return json(response, 201, {
        document: createKnowledgeDoc(await readBody(request)),
      });
    const knowledgeVersionsMatch = url.pathname.match(
      /^\/api\/knowledge\/([^/]+)\/versions$/,
    );
    if (request.method === "GET" && knowledgeVersionsMatch)
      return json(response, 200, {
        versions: listKnowledgeVersions(knowledgeVersionsMatch[1]),
      });
    const knowledgeVersionMatch = url.pathname.match(
      /^\/api\/knowledge\/([^/]+)\/versions\/(\d+)$/,
    );
    if (request.method === "DELETE" && knowledgeVersionMatch) {
      deleteKnowledgeVersion(
        knowledgeVersionMatch[1],
        knowledgeVersionMatch[2],
      );
      return json(response, 204, {});
    }
    const knowledgeCompareMatch = url.pathname.match(
      /^\/api\/knowledge\/([^/]+)\/compare$/,
    );
    if (request.method === "GET" && knowledgeCompareMatch)
      return json(response, 200, {
        comparison: compareKnowledgeVersions(
          knowledgeCompareMatch[1],
          url.searchParams.get("from"),
          url.searchParams.get("to"),
        ),
      });
    const knowledgeMatch = url.pathname.match(/^\/api\/knowledge\/([^/]+)$/);
    if (request.method === "GET" && knowledgeMatch)
      return json(response, 200, {
        document: getKnowledgeDoc(knowledgeMatch[1]),
      });
    if (request.method === "PUT" && knowledgeMatch)
      return json(response, 200, {
        document: updateKnowledgeDoc(
          knowledgeMatch[1],
          await readBody(request),
        ),
      });
    if (request.method === "DELETE" && knowledgeMatch) {
      deleteKnowledgeDoc(knowledgeMatch[1]);
      return json(response, 204, {});
    }
    if (request.method === "GET" && url.pathname === "/api/releases")
      return json(response, 200, {
        releases: listReleases(url.searchParams.get("projectPath") || ""),
      });
    if (request.method === "GET" && url.pathname === "/api/release-stages")
      return json(response, 200, {
        stages: listReleaseStages(url.searchParams.get("projectPath") || ""),
      });
    if (request.method === "PUT" && url.pathname === "/api/release-stages") {
      const body = await readBody(request);
      return json(response, 200, {
        stages: updateReleaseStages(body.projectPath || "", body.stages),
      });
    }
    if (request.method === "GET" && url.pathname === "/api/task-stages")
      return json(response, 200, {
        stages: listTaskStages(url.searchParams.get("projectPath") || ""),
      });
    if (request.method === "PUT" && url.pathname === "/api/task-stages") {
      const body = await readBody(request);
      return json(response, 200, {
        stages: updateTaskStages(body.projectPath || "", body.stages),
      });
    }
    if (request.method === "POST" && url.pathname === "/api/releases")
      return json(response, 201, {
        release: createRelease(await readBody(request)),
      });
    const releaseDeleteMatch = url.pathname.match(/^\/api\/releases\/([^/]+)$/);
    if (request.method === "DELETE" && releaseDeleteMatch) {
      const release = deleteRelease(releaseDeleteMatch[1]);
      publish("tasks", { reason: "release-deleted", id: release.id });
      return json(response, 200, { release });
    }
    const releaseAnalyseMatch = url.pathname.match(
      /^\/api\/releases\/([^/]+)\/analyse-prd$/,
    );
    const releaseApifoxMatch = url.pathname.match(
      /^\/api\/releases\/([^/]+)\/apifox\/sync$/,
    );
    if (request.method === "POST" && releaseApifoxMatch)
      return json(response, 200, {
        release: await syncApifoxDefinitions(
          releaseApifoxMatch[1],
          await readBody(request),
        ),
      });
    if (request.method === "POST" && releaseAnalyseMatch) {
      const body = await readBody(request);
      const perspectiveOptions = ["前端开发", "后端开发", "UI/UX 设计", "测试", "产品"];
      const roleOptions = ["产品专家", "UI/UX 专家", "前端专家", "后端专家", "全栈工程师", "测试专家", "DevOps 专家", "安全专家", "数据工程师"];
      const requestedPerspectives = Array.isArray(body.perspectives)
        ? body.perspectives
        : [body.perspective];
      const perspectives = [...new Set(requestedPerspectives.filter((value) => perspectiveOptions.includes(value)))];
      const activePerspectives = perspectives.length ? perspectives : ["前端开发"];
      const deliveryRoles = [...new Set((Array.isArray(body.deliveryRoles) ? body.deliveryRoles : []).filter((value) => roleOptions.includes(value)))];
      const activeDeliveryRoles = deliveryRoles.length
        ? deliveryRoles
        : activePerspectives.map((value) => ({
            "前端开发": "前端专家",
            "后端开发": "后端专家",
            "UI/UX 设计": "UI/UX 专家",
            测试: "测试专家",
            产品: "产品专家",
          })[value]).filter(Boolean);
      const releaseInput = getReleasePrdAnalysisInput(releaseAnalyseMatch[1]);
      // Version analysis inherits the project's Apifox connection. A failed
      // optional sync must never prevent PRD analysis or task creation.
      const projectApifox = releaseInput.release.projectPath
        ? getProjectApifoxConfig(releaseInput.release.projectPath)
        : null;
      if (projectApifox?.projectId && projectApifox.configured) {
        try {
          await syncApifoxDefinitions(releaseAnalyseMatch[1], {
            projectId: projectApifox.projectId,
            projectPath: releaseInput.release.projectPath,
          });
        } catch {
          // Keep the last synced definitions, if any, and continue analysis.
        }
      }
      const input = getReleasePrdAnalysisInput(releaseAnalyseMatch[1]);
      let analysis;
      let degraded = false;
      let warning = "";
      try {
        analysis = await analysePrdWithCodex({
          name: input.release.name,
          goal: input.release.goal,
          prd: input.source,
          attachments: input.attachments,
          taskStages: input.taskStages,
          perspectives: activePerspectives,
          deliveryRoles: activeDeliveryRoles,
          feedback: body.feedback,
          reviewContext: input.reviewContext,
        });
      } catch (error) {
        // A missing Codex login or a stalled CLI must not leave the version
        // workspace unusable. Generate an explicitly-labelled local draft so
        // the user can still review, edit and create non-running tasks.
        const fallbackRelease = analyseReleasePrd(releaseAnalyseMatch[1]);
        analysis = {
          ...fallbackRelease.prdAnalysis,
          source: "fallback",
          perspectives: activePerspectives,
          perspective: activePerspectives.join("、"),
          deliveryRoles: activeDeliveryRoles,
          proposals: fallbackRelease.prdAnalysis.proposals.map((proposal, index) => ({
            ...proposal,
            role: activeDeliveryRoles[index % activeDeliveryRoles.length] || proposal.role,
          })),
          feedback: "",
          warning: error?.message || "Codex 暂时不可用。",
        };
        degraded = true;
        warning = `Codex 未返回，已生成可编辑的本地任务草稿：${analysis.warning}`;
      }
      return json(response, 200, {
        release: saveReleasePrdAnalysis(releaseAnalyseMatch[1], analysis),
        degraded,
        warning,
      });
    }
    const releaseAnalysisMatch = url.pathname.match(
      /^\/api\/releases\/([^/]+)\/prd-analysis$/,
    );
    if (request.method === "PUT" && releaseAnalysisMatch)
      return json(response, 200, {
        release: updateReleasePrdAnalysis(
          releaseAnalysisMatch[1],
          await readBody(request),
        ),
      });
    const releaseTasksMatch = url.pathname.match(
      /^\/api\/releases\/([^/]+)\/create-tasks$/,
    );
    if (request.method === "POST" && releaseTasksMatch) {
      const input = await readBody(request);
      const project = listProjects().projects.find(
        (item) => item.path === input.projectPath,
      );
      const tasks = createTasksFromReleaseAnalysis(releaseTasksMatch[1], {
        ...input,
        projectPolicy: project?.policy || {},
      });
      publish("tasks", { reason: "release-analysis-tasks" });
      return json(response, 201, { tasks });
    }
    const releaseAnalysisTasksMatch = url.pathname.match(
      /^\/api\/releases\/([^/]+)\/analysis-tasks$/,
    );
    if (request.method === "DELETE" && releaseAnalysisTasksMatch) {
      const result = deleteReleaseAnalysisTasks(releaseAnalysisTasksMatch[1]);
      publish("tasks", { reason: "release-analysis-tasks-deleted" });
      return json(response, 200, { ...result, tasks: listTasks() });
    }
    const releaseReviewMatch = url.pathname.match(
      /^\/api\/releases\/([^/]+)\/review-items$/,
    );
    if (request.method === "POST" && releaseReviewMatch)
      return json(response, 201, {
        release: createReleaseReviewItem(
          releaseReviewMatch[1],
          await readBody(request),
        ),
      });
    const releaseReviewMergeMatch = url.pathname.match(
      /^\/api\/releases\/([^/]+)\/review-items\/merge-similar$/,
    );
    if (request.method === "POST" && releaseReviewMergeMatch)
      return json(response, 200, {
        release: mergeSimilarReleaseReviewItems(releaseReviewMergeMatch[1]),
      });
    const releaseReviewItemMatch = url.pathname.match(
      /^\/api\/releases\/([^/]+)\/review-items\/([^/]+)$/,
    );
    if (request.method === "PUT" && releaseReviewItemMatch)
      return json(response, 200, {
        release: updateReleaseReviewItem(
          releaseReviewItemMatch[1],
          releaseReviewItemMatch[2],
          await readBody(request),
        ),
      });
    if (request.method === "DELETE" && releaseReviewItemMatch) {
      return json(response, 200, {
        release: deleteReleaseReviewItem(
          releaseReviewItemMatch[1],
          releaseReviewItemMatch[2],
        ),
      });
    }
    const releaseMatch = url.pathname.match(/^\/api\/releases\/([^/]+)$/);
    if (request.method === "PUT" && releaseMatch) {
      const body = await readBody(request);
      return json(response, 200, {
        release: body.workspace
          ? updateReleaseWorkspace(releaseMatch[1], body.workspace)
          : updateRelease(releaseMatch[1], body),
      });
    }
    const releaseStageMatch = url.pathname.match(
      /^\/api\/releases\/([^/]+)\/stage$/,
    );
    if (request.method === "PUT" && releaseStageMatch)
      return json(response, 200, {
        release: updateReleaseStage(
          releaseStageMatch[1],
          (await readBody(request)).stage,
        ),
      });
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      response.write("event: connected\ndata: {}\n\n");
      events.add(response);
      request.on("close", () => events.delete(response));
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/queue")
      return json(response, 200, queueSnapshot());
    if (request.method === "POST" && url.pathname === "/api/queue/toggle") {
      const settings = getQueueSettings();
      const next = updateQueueSettings({ paused: !settings.paused });
      publish("tasks", {
        reason: next.paused ? "queue-paused" : "queue-resumed",
      });
      return json(response, 200, queueSnapshot());
    }
    if (request.method === "PUT" && url.pathname === "/api/queue") {
      const settings = updateQueueSettings(await readBody(request));
      publish("tasks", { reason: "queue-settings" });
      return json(response, 200, queueSnapshot());
    }
    if (request.method === "POST" && url.pathname === "/api/queue/pause-running") {
      updateQueueSettings({ paused: true });
      const running = listTasks().filter((task) => task.codex?.state === "running");
      const stoppedIds = [];
      for (const task of running) {
        const timer = taskTimeouts.get(task.id);
        if (timer) clearTimeout(timer);
        taskTimeouts.delete(task.id);
        stopCodexSession(task.codex?.threadId);
        stopCodexTask(task.id);
        stoppedIds.push(task.id);
      }
      publish("tasks", { reason: "queue-paused-and-running-stopped", stoppedIds });
      return json(response, 200, { stoppedIds, queue: queueSnapshot(), tasks: listTasks() });
    }
    if (request.method === "POST" && url.pathname === "/api/queue/run-schedule") {
      const settings = getQueueSettings();
      if (settings.paused)
        return json(response, 409, { error: "队列已暂停，请先恢复队列。" });
      const running = listTasks().filter((task) => task.codex?.state === "running").length;
      const capacity = Math.max(0, settings.concurrency - running);
      const candidates = listScheduledRunnableTasks().slice(0, capacity);
      const started = (await Promise.allSettled(
        candidates.map((task) => launchTask(task.id)),
      )).filter((result) => result.status === "fulfilled" && result.value).length;
      publish("tasks", { reason: "scheduled-run" });
      return json(response, 200, {
        started,
        eligible: listScheduledRunnableTasks().length + started,
        capacity,
        queue: queueSnapshot(),
        tasks: listTasks(),
      });
    }
    if (request.method === "GET" && url.pathname === "/api/projects")
      return json(response, 200, listProjects());
    if (request.method === "GET" && url.pathname === "/api/projects/discover")
      return json(
        response,
        200,
        discoverProjectSetup(url.searchParams.get("path")),
      );
    if (request.method === "GET" && url.pathname === "/api/projects/apifox")
      return json(
        response,
        200,
        getProjectApifoxConfig(url.searchParams.get("path")),
      );
    if (request.method === "PUT" && url.pathname === "/api/projects/apifox") {
      const body = await readBody(request);
      return json(response, 200, updateProjectApifoxConfig(body.path, body));
    }
    if (request.method === "POST" && url.pathname === "/api/projects/pick")
      return json(response, 200, { path: await pickFolder() });
    if (request.method === "POST" && url.pathname === "/api/context-files/pick")
      return json(response, 200, { file: await selectedContextFile() });
    if (request.method === "GET" && url.pathname === "/api/context-files/preview") {
      const filePath = url.searchParams.get("path") || "";
      const extension = path.extname(filePath).toLowerCase();
      if (!imageExtensions.has(extension)) throw new Error("该文件不支持图片预览。");
      const file = await readFile(filePath);
      if (file.length > 5 * 1024 * 1024) throw new Error("图片超过 5 MB，无法在此预览。");
      response.statusCode = 200;
      response.setHeader("Content-Type", imageMimeTypes[extension]);
      response.setHeader("Cache-Control", "no-store");
      response.end(file);
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/projects")
      return json(response, 201, {
        project: addProject((await readBody(request)).path),
      });
    if (request.method === "POST" && url.pathname === "/api/projects/active")
      return json(response, 200, {
        project: setActiveProject((await readBody(request)).path),
      });
    if (request.method === "PUT" && url.pathname === "/api/projects/policy")
      return json(response, 200, {
        project: updateProjectPolicy(await readBody(request)),
      });
    if (request.method === "POST" && url.pathname === "/api/tasks") {
      const input = await readBody(request);
      const project = listProjects().projects.find(
        (item) => item.path === input.projectPath,
      );
      const task = createTask({
        ...input,
        projectPolicy: project?.policy || {},
      });
      return json(response, 201, { task });
    }
    const taskStageMatch = url.pathname.match(
      /^\/api\/tasks\/([^/]+)\/board-stage$/,
    );
    if (request.method === "PUT" && taskStageMatch) {
      const task = updateTaskBoardStage(
        taskStageMatch[1],
        (await readBody(request)).taskStage,
      );
      publish("tasks", { reason: "task-board-stage", id: task.id });
      return json(response, 200, { task, tasks: listTasks() });
    }
    const taskInterfacesMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/interfaces$/);
    if (request.method === "PUT" && taskInterfacesMatch) {
      const task = updateTaskInterfaces(taskInterfacesMatch[1], await readBody(request));
      publish("tasks", { reason: "task-interfaces", id: task.id });
      return json(response, 200, { task, tasks: listTasks() });
    }
    const taskPlanMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/plan$/);
    if (request.method === "PUT" && taskPlanMatch) {
      const task = updateTaskPlan(taskPlanMatch[1], await readBody(request));
      publish("tasks", { reason: "task-plan", id: task.id });
      return json(response, 200, { task, tasks: listTasks() });
    }
    const taskPropertiesMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/properties$/);
    if (request.method === "PUT" && taskPropertiesMatch) {
      const task = updateTaskProperties(taskPropertiesMatch[1], await readBody(request));
      publish("tasks", { reason: "task-properties", id: task.id });
      return json(response, 200, { task, tasks: listTasks() });
    }
    const taskCommentsMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/comments$/);
    if (request.method === "POST" && taskCommentsMatch) {
      const task = addTaskComment(taskCommentsMatch[1], await readBody(request));
      publish("tasks", { reason: "task-comment", id: task.id });
      return json(response, 201, { task, tasks: listTasks() });
    }
    const taskCommentMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/comments\/([^/]+)$/);
    if (request.method === "DELETE" && taskCommentMatch) {
      const task = deleteTaskComment(taskCommentMatch[1], taskCommentMatch[2]);
      publish("tasks", { reason: "task-comment-delete", id: task.id });
      return json(response, 200, { task, tasks: listTasks() });
    }
    const cleanupWorktreeMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/worktree\/cleanup$/);
    if (request.method === "POST" && cleanupWorktreeMatch) {
      const task = getTask(cleanupWorktreeMatch[1]);
      if (!task) return json(response, 404, { error: "任务不存在。" });
      if (task.status !== "已完成" || task.merge?.state !== "merged")
        return json(response, 409, { error: "仅已合并且已完成的任务可以清理 worktree。" });
      removeMergedTaskWorktree(task);
      const updated = recordWorktreeCleanup(task.id);
      publish("tasks", { reason: "worktree-cleanup", id: task.id });
      return json(response, 200, { task: updated, tasks: listTasks() });
    }
    const deleteMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (request.method === "DELETE" && deleteMatch) {
      const deleted = deleteTask(deleteMatch[1], {
        force: url.searchParams.get("force") === "true",
      });
      publish("tasks", { reason: "task-delete", id: deleted.id });
      return json(response, 200, { tasks: listTasks() });
    }
    const retryMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/retry$/);
    if (request.method === "POST" && retryMatch) {
      const task = retryTask(retryMatch[1]);
      publish("tasks", { reason: "retry", id: task.id });
      return json(response, 200, { task, tasks: listTasks() });
    }
    const openWorktreeMatch = url.pathname.match(
      /^\/api\/tasks\/([^/]+)\/open-worktree$/,
    );
    if (request.method === "POST" && openWorktreeMatch) {
      const task = getTask(openWorktreeMatch[1]);
      const workspacePath = task?.codex?.workspacePath;
      if (!workspacePath)
        return json(response, 400, { error: "任务尚未创建独立 worktree。" });
      // Let macOS choose the editor from the user's own file association:
      // package.json may open in VS Code/Cursor, pom.xml in IDEA, etc.  We do
      // not hard-code an editor because tasks can span different stacks.
      const entry = await projectEditorEntry(workspacePath, task.role);
      const openedWithDefaultEditor = entry && await openNative(entry);
      if (!openedWithDefaultEditor) await openNative(workspacePath);
      return json(response, 200, {
        tasks: listTasks(),
        message: openedWithDefaultEditor
          ? `已用系统默认编辑器打开 ${path.basename(entry)}。`
          : "未找到可用的默认编辑器，已在 Finder 打开工作区目录。",
      });
    }
    const stopMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/stop$/);
    if (request.method === "POST" && stopMatch) {
      const task = getTask(stopMatch[1]);
      if (!task) return json(response, 404, { error: "Task not found" });
      const timer = taskTimeouts.get(task.id);
      if (timer) clearTimeout(timer);
      taskTimeouts.delete(task.id);
      const sessionStopped = stopCodexSession(task.codex?.threadId);
      const stoppedTask = stopCodexTask(task.id);
      publish("tasks", { reason: "codex-stopped", id: task.id });
      return json(response, 200, {
        task: stoppedTask,
        tasks: listTasks(),
        sessionStopped,
      });
    }
    const launchMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/launch$/);
    if (request.method === "POST" && launchMatch) {
      const id = launchMatch[1];
      const task = listTasks().find((item) => item.id === id);
      if (!task) return json(response, 404, { error: "Task not found" });
      if (!task.canRun)
        return json(response, 400, {
          error: "任务依赖尚未满足：必须等待前置任务的验证门禁通过。",
        });
      if (task.codex?.state === "running")
        return json(response, 400, {
          error: "这个任务已有正在执行的 Codex 会话。",
        });
      const queue = getQueueSettings();
      if (queue.paused)
        return json(response, 409, { error: "执行队列已暂停，请先恢复队列后再启动任务。" });
      const running = listTasks().filter((item) => item.codex?.state === "running").length;
      if (running >= queue.concurrency)
        return json(response, 409, {
          error: `执行队列已达到 ${queue.concurrency} 项并发上限；请等待完成或暂停一个运行中的任务。`,
        });
      const launch = await launchTask(id);
      if (!launch)
        return json(response, 400, {
          error: "当前任务尚不能启动；请检查状态与前置依赖。",
        });
      return json(response, 200, {
        task: launch,
        tasks: listTasks(),
      });
    }
    const reviseMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/revise$/);
    if (request.method === "POST" && reviseMatch) {
      const id = reviseMatch[1];
      const task = getTask(id);
      const body = await readBody(request);
      const feedback = `${body.feedback || ""}`.trim();
      if (!task) return json(response, 404, { error: "Task not found" });
      if (!feedback)
        return json(response, 400, { error: "请填写需要修改的问题。" });
      if (!task.codex?.workspacePath)
        return json(response, 400, {
          error: "此任务尚未执行过，请先完善计划后启动。",
        });
      if (task.codex?.state === "running")
        return json(response, 400, {
          error: "这个任务已有正在执行的 Codex 会话。",
        });
      if (task.status === "已完成")
        return json(response, 400, {
          error: "已完成任务请新建后续交付，避免改动已验收记录。",
        });
      if (task.merge?.state === "merged")
        return json(response, 400, {
          error:
            "交付已合并到目标分支。请新建后续交付，避免修改已验收的历史记录。",
        });
      const queue = getQueueSettings();
      if (queue.paused)
        return json(response, 409, { error: "执行队列已暂停，请先恢复队列后再启动任务。" });
      const running = listTasks().filter((item) => item.codex?.state === "running").length;
      if (running >= queue.concurrency)
        return json(response, 409, {
          error: `执行队列已达到 ${queue.concurrency} 项并发上限；请等待完成或暂停一个运行中的任务。`,
        });
      const launch = await launchCodexRevision(task, feedback, {
        onEvent: (event) => {
          recordTaskCodexEvent(id, event, "codex-revision-event");
        },
      });
      const revised = recordRevisionLaunch(id, launch, feedback);
      publish("tasks", { reason: "revision-launch", id });
      return json(response, 200, { task: revised, tasks: listTasks() });
    }
    const verifyMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/verify$/);
    if (request.method === "POST" && verifyMatch) {
      const task = getTask(verifyMatch[1]);
      if (!task?.codex?.workspacePath)
        return json(response, 400, {
          error: "请先完成一次 Codex 执行，才能运行真实验证。",
        });
      if (task.codex.state !== "completed")
        return json(response, 400, {
          error: "Codex 仍在执行或已停止；只有本轮完成后才能运行验证。",
        });
      const verification = await runProjectVerification(
        task.codex.workspacePath,
        task.projectPolicy,
      );
      recordWorkspaceEvidence(
        task.id,
        inspectWorkspace(task.codex.workspacePath),
      );
      const verifiedTask = recordVerification(task.id, verification, null);
      return json(response, 200, {
        // Verification only moves the task into review. Preparing a merge can
        // create a task-worktree commit, so it must be an explicit, visible
        // "查看真实 diff" action by the user.
        task: verifiedTask,
        tasks: listTasks(),
      });
    }
    const previewRunMatch = url.pathname.match(
      /^\/api\/tasks\/([^/]+)\/preview$/,
    );
    if (request.method === "POST" && previewRunMatch) {
      const task = getTask(previewRunMatch[1]);
      if (!task) return json(response, 404, { error: "Task not found" });
      return json(response, 200, {
        task: recordTaskPreview(task.id, await startTaskPreview(task)),
        tasks: listTasks(),
      });
    }
    const previewMatch = url.pathname.match(
      /^\/api\/tasks\/([^/]+)\/merge-preview$/,
    );
    const taskDiffMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/diff$/);
    if (request.method === "POST" && taskDiffMatch) {
      const task = getTask(taskDiffMatch[1]);
      if (!task) return json(response, 404, { error: "任务不存在。" });
      const updated = recordMergePreview(task.id, inspectTaskDiff(task));
      return json(response, 200, { task: updated, tasks: listTasks() });
    }
    const releasePreviewMatch = url.pathname.match(/^\/api\/releases\/([^/]+)\/merge-preview$/);
    if (request.method === "POST" && releasePreviewMatch) {
      const release = listReleases().find((item) => item.id === releasePreviewMatch[1]);
      if (!release) return json(response, 404, { error: "版本不存在。" });
      const updated = recordReleaseMergePreview(release.id, prepareReleaseMerge(release, listTasks().filter((task) => task.versionId === release.id)));
      publish("releases", { reason: "release-merge-preview", id: release.id });
      return json(response, 200, { release: updated, releases: listReleases() });
    }
    const releaseMergeMatch = url.pathname.match(/^\/api\/releases\/([^/]+)\/merge$/);
    if (request.method === "POST" && releaseMergeMatch) {
      const release = listReleases().find((item) => item.id === releaseMergeMatch[1]);
      if (!release) return json(response, 404, { error: "版本不存在。" });
      if (release.merge?.state !== "ready") return json(response, 400, { error: "请先查看版本最终 diff，再确认合并。" });
      const updated = recordReleaseMergeResult(release.id, mergeReleaseBranch(release, listTasks().filter((task) => task.versionId === release.id)));
      publish("releases", { reason: "release-merged", id: release.id });
      // A version merge also advances every included task.  Notify task-board
      // clients explicitly; otherwise an already-open board can keep showing
      // the stale "待合并 / 待复核" card until a manual page refresh.
      publish("tasks", { reason: "release-merged", releaseId: release.id });
      return json(response, 200, {
        release: updated,
        releases: listReleases(),
        tasks: listTasks(),
      });
    }
    if (request.method === "POST" && previewMatch) {
      const task = getTask(previewMatch[1]);
      if (!task) return json(response, 404, { error: "Task not found" });
      if (task.status !== "待复核" || task.testTone !== "success")
        return json(response, 400, {
          error: "只有真实验证通过、等待复核的任务可以查看可合并变更。",
        });
      return json(response, 200, {
        task: recordMergePreview(
          task.id,
          // Reviewing must be read-only. The task commit is created only
          // after the user has inspected the diff and explicitly confirms
          // the merge/submit action.
          prepareTaskMerge(task),
        ),
        tasks: listTasks(),
      });
    }
    const mergeMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/merge$/);
    if (request.method === "POST" && mergeMatch) {
      const task = getTask(mergeMatch[1]);
      if (!task) return json(response, 404, { error: "Task not found" });
      if (task.status !== "待复核" || task.testTone !== "success")
        return json(response, 400, {
          error: "只有真实验证通过、等待复核的任务可以合并代码。",
        });
      if (task.merge?.state !== "ready")
        return json(response, 400, {
          error: "请先查看真实 diff，再确认合并到目标分支。",
        });
      const result = task.codex?.deliveryMode === "direct"
        ? commitDirectTask(task)
        : mergeTaskWorktree(task);
      return json(response, 200, {
        task: recordMergeResult(task.id, result),
        tasks: listTasks(),
      });
    }
    const match = url.pathname.match(
      /^\/api\/tasks\/([^/]+)\/(approve|accept|return)$/,
    );
    if (request.method === "POST" && match) {
      const [, id, action] = match;
      const actionFn = {
        approve: approveTask,
        accept: acceptTask,
        return: returnTask,
      }[action];
      return json(response, 200, { task: actionFn(id, await readBody(request)), tasks: listTasks() });
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/tasks/"))
      return json(response, 200, {
        task: getTask(url.pathname.split("/").pop()),
      });
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    return json(response, 400, { error: error.message || "Request failed" });
  }
}
