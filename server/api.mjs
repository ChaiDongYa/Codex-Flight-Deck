import {
  acceptTask,
  approveTask,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  recordCodexEvent,
  recordCodexLaunch,
  recordMergePreview,
  recordMergeResult,
  recordTaskPreview,
  recordVerification,
  recordWorkspaceEvidence,
  returnTask,
} from "./db.mjs";
import { launchCodexTask } from "./codex.mjs";
import { addProject, listProjects, setActiveProject } from "./project.mjs";
import {
  inspectWorkspace,
  mergeTaskWorktree,
  prepareTaskMerge,
  runProjectVerification,
  startTaskPreview,
} from "./project.mjs";
import { execFile } from "node:child_process";

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
    if (request.method === "GET" && url.pathname === "/api/projects")
      return json(response, 200, listProjects());
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
    if (request.method === "POST" && url.pathname === "/api/tasks")
      return json(response, 201, { task: createTask(await readBody(request)) });
    const deleteMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (request.method === "DELETE" && deleteMatch) {
      deleteTask(deleteMatch[1]);
      return json(response, 200, { tasks: listTasks() });
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
      const launch = await launchCodexTask(task, {
        onEvent: (event) => recordCodexEvent(id, event),
      });
      return json(response, 200, {
        task: recordCodexLaunch(id, launch),
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
      );
      recordWorkspaceEvidence(
        task.id,
        inspectWorkspace(task.codex.workspacePath),
      );
      return json(response, 200, {
        // Verification only moves the task into review. Preparing a merge can
        // create a task-worktree commit, so it must be an explicit, visible
        // "查看真实 diff" action by the user.
        task: recordVerification(task.id, verification, null),
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
