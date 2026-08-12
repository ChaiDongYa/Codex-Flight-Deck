import { acceptTask, approveTask, createTask, getTask, listTasks, passTests, recordCodexEvent, recordCodexLaunch, returnTask } from "./db.mjs";
import { launchCodexTask } from "./codex.mjs";
import { getProject } from "./project.mjs";

const json = (response, status, payload) => { response.statusCode = status; response.setHeader("Content-Type", "application/json; charset=utf-8"); response.end(JSON.stringify(payload)); return true; };
const readBody = (request) => new Promise((resolve, reject) => { let data = ""; request.on("data", (chunk) => data += chunk); request.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (error) { reject(error); } }); request.on("error", reject); });

export async function api(request, response) {
  const url = new URL(request.url, "http://localhost");
  if (!url.pathname.startsWith("/api/")) return false;
  try {
    if (request.method === "GET" && url.pathname === "/api/tasks") return json(response, 200, { tasks: listTasks() });
    if (request.method === "GET" && url.pathname === "/api/project") return json(response, 200, { project: getProject() });
    if (request.method === "POST" && url.pathname === "/api/tasks") return json(response, 201, { task: createTask(await readBody(request)) });
    const launchMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/launch$/);
    if (request.method === "POST" && launchMatch) {
      const id = launchMatch[1];
      const task = listTasks().find((item) => item.id === id);
      if (!task) return json(response, 404, { error: "Task not found" });
      if (!task.canRun) return json(response, 400, { error: "任务依赖尚未满足：必须等待前置任务的验证门禁通过。" });
      if (task.codex?.state === "running") return json(response, 400, { error: "这个任务已有正在执行的 Codex 会话。" });
      const launch = await launchCodexTask(task, { onEvent: (event) => recordCodexEvent(id, event) });
      return json(response, 200, { task: recordCodexLaunch(id, launch), tasks: listTasks() });
    }
    const match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(approve|pass-tests|accept|return)$/);
    if (request.method === "POST" && match) {
      const [, id, action] = match;
      const actionFn = { approve: approveTask, "pass-tests": passTests, accept: acceptTask, return: returnTask }[action];
      return json(response, 200, { task: actionFn(id), tasks: listTasks() });
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/tasks/")) return json(response, 200, { task: getTask(url.pathname.split("/").pop()) });
    return json(response, 404, { error: "Not found" });
  } catch (error) { return json(response, 400, { error: error.message || "Request failed" }); }
}
