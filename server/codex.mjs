import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createTaskWorktree } from "./project.mjs";
const sessions = new Map();
const desktopCodexPath = "/Applications/ChatGPT.app/Contents/Resources/codex";
// Keep task execution on the same maintained desktop CLI as PRD analysis.
// Older globally-installed CLIs have been observed to stall or lose recovery
// behavior during streamed app-server sessions.
const codexCommand =
  process.env.FLIGHT_DECK_CODEX_CLI_PATH ||
  (existsSync(desktopCodexPath) ? desktopCodexPath : "codex");

function taskPrompt(task, isolated) {
  const workspaceNotice = isolated
    ? "当前目录是此任务的独立 Git worktree。"
    : task.deliveryMode === "direct"
      ? `当前目录是项目当前分支的直接交付工作目录。本任务的 Git 提交说明必须保留 ${task.id}；Flight Deck 会在你确认保存后创建该提交。执行前检查现有改动，不要覆盖无关文件；完成后明确说明改动文件。`
      : "当前目录是项目的共享工作目录：该项目尚无 Git 提交或未启用 Git。执行前检查现有改动，不要覆盖无关文件；完成后明确说明改动文件。";
  const policy = task.projectPolicy || {};
  const skills = policy.skills?.length
    ? `\n项目启用的 Codex Skills：${policy.skills.map((skill) => `$${skill}`).join("、")}。如已安装且任务匹配，请遵循其工作流。`
    : "";
  const pendingFeedback = task.pendingFeedback
    ? `\n\n启动前补充的修改意见：\n${task.pendingFeedback}\n请将其纳入本次实现范围，并优先确认它不会与原任务目标冲突。`
    : "";
  const interfaceContext = task.apiLinks?.length || task.apiNotes
    ? `\n\n接口与联调上下文：\n${task.apiLinks?.length ? task.apiLinks.map((api) => `- ${api.method} ${api.path}${api.summary ? `：${api.summary}` : ""}${api.description ? `\n  ${api.description}` : ""}`).join("\n") : "- 未选择已同步接口"}${task.apiNotes ? `\n补充约定：${task.apiNotes}` : ""}`
    : "";
  return `你正在以“${task.role || "全栈工程师"}”角色处理 Flight Deck 交付任务 ${task.id}：${task.title}\n\n目标：${task.description}\n\n实施计划：\n${task.plan.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\n验收标准：${task.acceptance || "完成范围内最小实现，并运行相关测试。"}\n\n项目规则：${policy.rules || "先检查项目约定与相关代码；只进行任务范围内的最小改动。"}\n\n工程规范：${policy.standards || "保持现有代码风格；补充必要测试；避免无关重构。"}${skills}${pendingFeedback}${interfaceContext}\n\n${workspaceNotice}\n这是一个“开发交付”任务：先阅读仓库和相关实现，然后直接修改代码完成目标。不要调用 taskctl、e-taskboard 或任何任务编排命令；它们不是本项目的运行依赖。不要只输出分析、计划或建议。不要自行创建 Git 提交；保留本轮文件改动，以便 Flight Deck 展示真实 diff 和由用户确认合并。若无法写出符合验收的代码，明确说明阻塞原因和已检查的文件。\n若任务创建或修改了 package.json，必须先确认依赖已安装（优先使用项目锁文件对应的 install/ci 命令），再运行 build/test；不得把缺少 node_modules 导致的模块解析失败当作业务验证结果。最后汇报改动、依赖准备、测试结果和剩余风险。不要绕过沙箱或请求网络访问。`;
}

function revisionPrompt(task, feedback) {
  const policy = task.projectPolicy || {};
  const recentEvidence = task.evidence?.workspace?.changedFiles?.slice(0, 12) || task.files?.slice(0, 12) || [];
  const priorVerification = task.evidence?.verification?.command
    ? `上一轮验证：${task.evidence.verification.command}（${task.evidence.verification.exitCode === 0 ? "通过" : "未通过"}）。`
    : "上一轮尚未记录可复用的验证结果。";
  return `你正在对 Flight Deck 交付任务 ${task.id} 做一次“增量修改”，不是重新实现任务。\n\n用户新反馈：\n${feedback}\n\n工作目录保留了上一轮已完成的代码。先检查现有 diff 和与反馈直接相关的文件，只修改解决该问题所必需的最小范围。不要重新生成已正确的功能，不要重置、删除或覆盖既有改动，也不要重复进行与本次修改无关的大范围分析。\n\n上一轮已涉及的文件：\n${recentEvidence.length ? recentEvidence.map((file) => `- ${file}`).join("\n") : "- 暂无文件清单，请先用 git diff 或 rg 精确定位"}\n\n${priorVerification}\n\n项目规则：${policy.rules || "遵守现有项目约定，只做最小改动。"}\n工程规范：${policy.standards || "保持代码风格；仅运行与修改相关的最小验证。"}\n\n完成后请明确说明：1. 本次修改了什么；2. 哪些既有实现被保留；3. 实际运行的最小验证命令及结果；4. 是否还存在风险。不要重复原任务的完整实现计划。`;
}

function startServer(cwd, onNotification) {
  const child = spawn(codexCommand, ["app-server", "--stdio"], {
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
    server.child.once("exit", () => sessions.delete(threadId));
    return {
      threadId,
      turnId: startedTurn.turn.id,
      workspacePath: workspace.workspacePath,
      branch: workspace.branch,
      project: workspace.name,
      head: workspace.head,
      isolated: workspace.isolated,
      deliveryMode: workspace.deliveryMode || "task",
      releaseShared: Boolean(workspace.releaseShared),
    };
  } catch (error) {
    server.child.kill();
    throw error;
  }
}

export async function launchCodexRevision(task, feedback, callbacks) {
  if (!task.codex?.workspacePath)
    throw new Error("任务尚未创建 worktree，无法进行增量修改。");
  const server = startServer(task.codex.workspacePath, (event) =>
    callbacks.onEvent?.(event),
  );
  try {
    await server.request("initialize", {
      clientInfo: { name: "flight-deck", version: "0.1.0" },
    });
    const startedThread = await server.request("thread/start", {
      cwd: task.codex.workspacePath,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      approvalsReviewer: "user",
    });
    const threadId = startedThread.thread.id;
    const startedTurn = await server.request("turn/start", {
      threadId,
      cwd: task.codex.workspacePath,
      input: [{ type: "text", text: revisionPrompt(task, feedback) }],
    });
    sessions.set(threadId, server);
    server.child.once("exit", () => sessions.delete(threadId));
    return {
      threadId,
      turnId: startedTurn.turn.id,
      workspacePath: task.codex.workspacePath,
      branch: task.codex.branch,
      project: task.codex.project,
      head: task.codex.head,
      isolated: task.codex.isolated,
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
