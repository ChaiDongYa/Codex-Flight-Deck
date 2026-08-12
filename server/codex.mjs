import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sessions = new Map();

function taskPrompt(task) {
  return `你正在处理 Flight Deck 交付任务 ${task.id}：${task.title}\n\n目标：${task.description}\n\n实施计划：\n${task.plan.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\n验收标准：${task.acceptance || "完成范围内最小实现，并运行相关测试。"}\n\n请在当前工作区中执行任务。先检查项目约定与相关代码；只进行任务范围内的最小改动；运行可用的验证命令；最后汇报改动、测试结果和剩余风险。不要绕过沙箱或请求网络访问。`;
}

function startServer(onNotification) {
  const child = spawn("codex", ["app-server", "--stdio"], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  let nextId = 1;
  const pending = new Map();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (message.id != null && pending.has(message.id)) {
          const { resolve, reject } = pending.get(message.id);
          pending.delete(message.id);
          message.error ? reject(new Error(message.error.message || "Codex app-server 请求失败")) : resolve(message.result);
        } else if (message.method) onNotification(message);
      } catch { /* Ignore non-protocol output. */ }
    }
  });
  child.on("error", (error) => { for (const { reject } of pending.values()) reject(error); pending.clear(); });
  child.on("exit", (code) => { for (const { reject } of pending.values()) reject(new Error(`Codex app-server 已退出（${code ?? "未知"}）`)); pending.clear(); });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  return { child, request };
}

export async function launchCodexTask(task, callbacks) {
  const server = startServer((event) => callbacks.onEvent?.(event));
  try {
    await server.request("initialize", { clientInfo: { name: "flight-deck", version: "0.1.0" } });
    const startedThread = await server.request("thread/start", {
      cwd: projectRoot,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      approvalsReviewer: "user",
    });
    const threadId = startedThread.thread.id;
    const startedTurn = await server.request("turn/start", {
      threadId,
      cwd: projectRoot,
      input: [{ type: "text", text: taskPrompt(task) }],
    });
    sessions.set(threadId, server);
    return { threadId, turnId: startedTurn.turn.id, workspacePath: projectRoot };
  } catch (error) {
    server.child.kill();
    throw error;
  }
}

export function activeSessionCount() { return sessions.size; }
