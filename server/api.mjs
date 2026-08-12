import {
  acceptTask,
  approveTask,
  createTask,
  createRelease,
  deleteTask,
  getTask,
  listAutoRunnableTasks,
  listTasks,
  listReleases,
  updateReleaseStage,
  recordCodexEvent,
  recordCodexLaunch,
  recordMergePreview,
  recordMergeResult,
  recordTaskPreview,
  retryTask,
  stopCodexTask,
  recordVerification,
  recordWorkspaceEvidence,
  recordAutomationFailure,
  recoverInterruptedAutoTasks,
  returnTask,
} from "./db.mjs";
import { launchCodexTask, stopCodexSession } from "./codex.mjs";
import {
  addProject,
  listProjects,
  setActiveProject,
  updateProjectPolicy,
  discoverProjectSetup,
} from "./project.mjs";
import {
  inspectWorkspace,
  mergeTaskWorktree,
  prepareTaskMerge,
  runProjectVerification,
  startTaskPreview,
} from "./project.mjs";
import { execFile } from "node:child_process";

const launchingAutomatically = new Set();
const events = new Set();
let queuePaused = false;
const queueConcurrency = 2;
const taskTimeouts = new Map();
const automaticTimeoutMs = 45 * 60 * 1000;

function publish(event, payload = {}) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const response of events) response.write(message);
}

async function verifyAutomatically(id) {
  const task = listTasks().find((item) => item.id === id);
  const trustedChain = task?.dependencies?.some(
    (dependency) => dependency.gate === "trust",
  );
  if (
    (!task?.automation?.autoVerify && !trustedChain) ||
    task.codex?.state !== "completed"
  )
    return;
  const verification = await runProjectVerification(
    task.codex.workspacePath,
    task.projectPolicy,
  );
  recordWorkspaceEvidence(task.id, inspectWorkspace(task.codex.workspacePath));
  recordVerification(task.id, verification, null);
  publish("tasks", { reason: "automatic-verification" });
}

async function launchTask(id, { automated = false } = {}) {
  const task = listTasks().find((item) => item.id === id);
  if (!task || !["待开始", "计划中"].includes(task.status) || !task.canRun)
    return null;
  if (launchingAutomatically.has(id)) return null;
  launchingAutomatically.add(id);
  try {
    const launch = await launchCodexTask(task, {
      onEvent: (event) => {
        recordCodexEvent(id, event);
        publish("tasks", { reason: "codex-event", id });
        if (event.method === "turn/completed") {
          const timer = taskTimeouts.get(id);
          if (timer) clearTimeout(timer);
          taskTimeouts.delete(id);
          void verifyAutomatically(id)
            .then(drainNightQueue)
            .catch(() => {});
        }
      },
    });
    const launched = recordCodexLaunch(id, launch);
    if (automated && launch.threadId) {
      taskTimeouts.set(
        id,
        setTimeout(() => {
          stopCodexSession(launch.threadId);
          recordAutomationFailure(
            id,
            new Error("夜间任务超过 45 分钟仍未结束，已安全停止。"),
          );
          publish("tasks", { reason: "automation-timeout", id });
        }, automaticTimeoutMs),
      );
    }
    publish("tasks", { reason: "launch", id });
    return launched;
  } catch (error) {
    if (automated) {
      recordAutomationFailure(id, error);
      publish("tasks", { reason: "automation-failed", id });
    }
    throw error;
  } finally {
    launchingAutomatically.delete(id);
  }
}

async function drainNightQueue() {
  if (queuePaused) return;
  const running = listTasks().filter(
    (task) => task.codex?.state === "running",
  ).length;
  const capacity = Math.max(0, queueConcurrency - running);
  const candidates = listAutoRunnableTasks().slice(0, capacity);
  await Promise.allSettled(
    candidates.map((task) => launchTask(task.id, { automated: true })),
  );
}

recoverInterruptedAutoTasks();
void drainNightQueue();

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

export async function api(request, response) {
  const url = new URL(request.url, "http://localhost");
  if (!url.pathname.startsWith("/api/")) return false;
  try {
    if (request.method === "GET" && url.pathname === "/api/tasks")
      return json(response, 200, { tasks: listTasks() });
    if (request.method === "GET" && url.pathname === "/api/releases")
      return json(response, 200, { releases: listReleases(url.searchParams.get("projectPath") || "") });
    if (request.method === "POST" && url.pathname === "/api/releases")
      return json(response, 201, { release: createRelease(await readBody(request)) });
    const releaseStageMatch = url.pathname.match(/^\/api\/releases\/([^/]+)\/stage$/);
    if (request.method === "PUT" && releaseStageMatch)
      return json(response, 200, { release: updateReleaseStage(releaseStageMatch[1], (await readBody(request)).stage) });
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
      return json(response, 200, {
        paused: queuePaused,
        concurrency: queueConcurrency,
        running: listTasks().filter((task) => task.codex?.state === "running")
          .length,
        queued: listAutoRunnableTasks().length,
      });
    if (request.method === "POST" && url.pathname === "/api/queue/toggle") {
      queuePaused = !queuePaused;
      if (!queuePaused) void drainNightQueue();
      publish("tasks", {
        reason: queuePaused ? "queue-paused" : "queue-resumed",
      });
      return json(response, 200, { paused: queuePaused });
    }
    if (request.method === "GET" && url.pathname === "/api/projects")
      return json(response, 200, listProjects());
    if (request.method === "GET" && url.pathname === "/api/projects/discover")
      return json(
        response,
        200,
        discoverProjectSetup(url.searchParams.get("path")),
      );
    if (request.method === "POST" && url.pathname === "/api/projects/pick")
      return json(response, 200, { path: await pickFolder() });
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
      if (task.automation?.autoRun) void drainNightQueue();
      return json(response, 201, { task });
    }
    const deleteMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (request.method === "DELETE" && deleteMatch) {
      deleteTask(deleteMatch[1]);
      return json(response, 200, { tasks: listTasks() });
    }
    const retryMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/retry$/);
    if (request.method === "POST" && retryMatch) {
      const task = retryTask(retryMatch[1]);
      void drainNightQueue();
      publish("tasks", { reason: "retry", id: task.id });
      return json(response, 200, { task, tasks: listTasks() });
    }
    const openWorktreeMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/open-worktree$/);
    if (request.method === "POST" && openWorktreeMatch) {
      const task = getTask(openWorktreeMatch[1]);
      const workspacePath = task?.codex?.workspacePath;
      if (!workspacePath) return json(response, 400, { error: "任务尚未创建独立 worktree。" });
      await new Promise((resolve, reject) => execFile("open", [workspacePath], (error) => error ? reject(error) : resolve()));
      return json(response, 200, { tasks: listTasks() });
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
      void drainNightQueue();
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
          prepareTaskMerge(task, { commit: true }),
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
      return json(response, 200, {
        task: recordMergeResult(task.id, mergeTaskWorktree(task)),
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
      return json(response, 200, { task: actionFn(id), tasks: listTasks() });
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
