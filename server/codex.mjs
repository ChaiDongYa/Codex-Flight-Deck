import { spawn } from "node:child_process";
import { createTaskWorktree } from "./project.mjs";
const sessions = new Map();

function taskPrompt(task, isolated) {
  const workspaceNotice = isolated
    ? "当前目录是此任务的独立 Git worktree。"
    : "当前目录是项目的共享工作目录：该项目尚无 Git 提交或未启用 Git。执行前检查现有改动，不要覆盖无关文件；完成后明确说明改动文件。";
  const policy = task.projectPolicy || {};
  const skills = policy.skills?.length
    ? `\n项目启用的 Codex Skills：${policy.skills.map((skill) => `$${skill}`).join("、")}。如已安装且任务匹配，请遵循其工作流。`
    : "";
  return `你正在以“${task.role || "全栈工程师"}”角色处理 Flight Deck 交付任务 ${task.id}：${task.title}\n\n目标：${task.description}\n\n实施计划：\n${task.plan.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\n验收标准：${task.acceptance || "完成范围内最小实现，并运行相关测试。"}\n\n项目规则：${policy.rules || "先检查项目约定与相关代码；只进行任务范围内的最小改动。"}\n\n工程规范：${policy.standards || "保持现有代码风格；补充必要测试；避免无关重构。"}${skills}\n\n${workspaceNotice}\n若任务创建或修改了 package.json，必须先确认依赖已安装（优先使用项目锁文件对应的 install/ci 命令），再运行 build/test；不得把缺少 node_modules 导致的模块解析失败当作业务验证结果。最后汇报改动、依赖准备、测试结果和剩余风险。不要绕过沙箱或请求网络访问。`;
}

function startServer(cwd, onNotification) {
  const child = spawn("codex", ["app-server", "--stdio"], {
    cwd,
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
          message.error
            ? reject(
                new Error(message.error.message || "Codex app-server 请求失败"),
              )
            : resolve(message.result);
        } else if (message.method) onNotification(message);
      } catch {
        /* Ignore non-protocol output. */
      }
    }
  });
  child.on("error", (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  });
  child.on("exit", (code) => {
    for (const { reject } of pending.values())
      reject(new Error(`Codex app-server 已退出（${code ?? "未知"}）`));
    pending.clear();
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  return { child, request };
}

export async function launchCodexTask(task, callbacks) {
  const workspace = createTaskWorktree(task);
  const server = startServer(workspace.workspacePath, (event) =>
    callbacks.onEvent?.(event),
  );
  try {
    await server.request("initialize", {
      clientInfo: { name: "flight-deck", version: "0.1.0" },
    });
    const startedThread = await server.request("thread/start", {
      cwd: workspace.workspacePath,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      approvalsReviewer: "user",
    });
    const threadId = startedThread.thread.id;
    const startedTurn = await server.request("turn/start", {
      threadId,
      cwd: workspace.workspacePath,
      input: [{ type: "text", text: taskPrompt(task, workspace.isolated) }],
    });
    sessions.set(threadId, server);
    return {
      threadId,
      turnId: startedTurn.turn.id,
      workspacePath: workspace.workspacePath,
      branch: workspace.branch,
      project: workspace.name,
      head: workspace.head,
      isolated: workspace.isolated,
    };
  } catch (error) {
    server.child.kill();
    throw error;
  }
}

export function activeSessionCount() {
  return sessions.size;
}

export function stopCodexSession(threadId) {
  const server = sessions.get(threadId);
  if (!server) return false;
  server.child.kill();
  sessions.delete(threadId);
  return true;
}
