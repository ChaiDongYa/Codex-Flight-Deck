import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFile, execFileSync, spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configFile = path.join(root, "data", "projects.json");
const initialPath =
  process.env.FLIGHT_DECK_PROJECT_PATH ||
  "/Users/fangyuanzhonghe/code/Codex-Flight-Deck-Test";
const previews = new Map();
const defaultPolicy = () => ({
  rules: "先阅读 AGENTS.md、README.md 与相关模块；只修改任务范围内的文件。",
  standards: "保持现有代码风格；补充必要测试；避免无关重构。",
  skills: [],
  verificationCommand: "",
});

const projectContextFiles = [
  "AGENTS.md",
  "README.md",
  "package.json",
  "CONTRIBUTING.md",
];

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function tryGit(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return "";
  }
}
function readConfig() {
  try {
    return JSON.parse(readFileSync(configFile, "utf8"));
  } catch {
    return { activePath: initialPath, paths: [initialPath], policies: {} };
  }
}
function writeConfig(config) {
  mkdirSync(path.dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify(config, null, 2));
}

export function inspectProject(candidatePath) {
  const suppliedPath = candidatePath?.trim();
  if (!suppliedPath || !existsSync(suppliedPath))
    throw new Error(`项目目录不存在：${suppliedPath || "未提供路径"}`);
  const projectRoot =
    tryGit(["rev-parse", "--show-toplevel"], suppliedPath) ||
    path.resolve(suppliedPath);
  const hasGit = Boolean(
    tryGit(["rev-parse", "--is-inside-work-tree"], suppliedPath),
  );
  const head = hasGit
    ? tryGit(["rev-parse", "--short", "HEAD"], projectRoot)
    : "";
  const policy = readConfig().policies?.[projectRoot] || defaultPolicy();
  return {
    name: path.basename(projectRoot),
    path: projectRoot,
    branch: hasGit
      ? tryGit(["branch", "--show-current"], projectRoot) || "未提交"
      : "未启用 Git",
    head,
    executionMode: hasGit && head ? "worktree" : "shared",
    policy: { ...defaultPolicy(), ...policy },
  };
}

export function listProjects() {
  const config = readConfig();
  const projects = config.paths
    .map((item) => {
      try {
        return inspectProject(item);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const active =
    projects.find((project) => project.path === config.activePath) ||
    projects[0];
  return { projects, active };
}

export function addProject(candidatePath) {
  const project = inspectProject(candidatePath);
  const config = readConfig();
  const paths = [...new Set([...config.paths, project.path])];
  writeConfig({
    ...config,
    activePath: project.path,
    paths,
    policies: config.policies || {},
  });
  return project;
}

export function updateProjectPolicy(candidatePath, input = {}) {
  const project = inspectProject(candidatePath);
  const config = readConfig();
  if (!config.paths.includes(project.path))
    throw new Error("请先将该仓库添加为项目。");
  const skills = Array.isArray(input.skills)
    ? input.skills.filter((skill) => typeof skill === "string").slice(0, 12)
    : [];
  const verificationCommand = `${input.verificationCommand || ""}`.trim();
  if (
    verificationCommand &&
    !/^npm run [a-zA-Z0-9:_-]+$/.test(verificationCommand)
  )
    throw new Error("验证命令目前仅支持 npm run <script>，例如 npm run test。");
  const policy = {
    rules: `${input.rules || ""}`.trim().slice(0, 4000),
    standards: `${input.standards || ""}`.trim().slice(0, 4000),
    skills,
    verificationCommand,
  };
  writeConfig({
    ...config,
    policies: { ...(config.policies || {}), [project.path]: policy },
  });
  return inspectProject(project.path);
}

export function discoverProjectSetup(candidatePath) {
  const project = inspectProject(candidatePath);
  const contextFiles = projectContextFiles
    .filter((name) => existsSync(path.join(project.path, name)))
    .map((name) => name);
  let scripts = [];
  try {
    scripts = Object.keys(
      JSON.parse(readFileSync(path.join(project.path, "package.json"), "utf8"))
        .scripts || {},
    );
  } catch {
    /* Projects without package.json can still use Flight Deck. */
  }
  return { project, contextFiles, scripts, skills: listInstalledSkills() };
}

export function listInstalledSkills() {
  const roots = [
    path.join(process.env.HOME || "", ".codex", "skills"),
    path.join(process.env.HOME || "", ".agents", "skills"),
  ];
  const found = new Set();
  const walk = (directory, depth = 0) => {
    if (depth > 2 || !existsSync(directory)) return;
    for (const entry of readdirSync(directory)) {
      const entryPath = path.join(directory, entry);
      try {
        if (entry === "SKILL.md")
          found.add(path.basename(path.dirname(entryPath)));
        else if (statSync(entryPath).isDirectory()) walk(entryPath, depth + 1);
      } catch {
        /* A missing or inaccessible skill should not block project setup. */
      }
    }
  };
  roots.forEach((directory) => walk(directory));
  return [...found].sort();
}

export function setActiveProject(candidatePath) {
  const project = inspectProject(candidatePath);
  const config = readConfig();
  if (!config.paths.includes(project.path))
    throw new Error("请先将该仓库添加为项目。");
  writeConfig({ ...config, activePath: project.path });
  return project;
}

export function getProject(candidatePath) {
  return inspectProject(candidatePath || listProjects().active?.path);
}

export function createTaskWorktree(task) {
  const project = getProject(task.projectPath);
  if (project.executionMode === "shared")
    return {
      ...project,
      branch: "共享工作目录",
      workspacePath: project.path,
      isolated: false,
    };
  const branch = `flight-deck/${task.id.toLowerCase()}`;
  const targetBranch = task.merge?.targetBranch || project.branch;
  const directory = `${project.path}/.flight-deck-worktrees/${task.id}`;
  try {
    const existing = git(["worktree", "list", "--porcelain"], project.path);
    if (!existing.includes(`worktree ${directory}\n`))
      execFileSync(
        "git",
        ["worktree", "add", "-b", branch, directory, targetBranch],
        { cwd: project.path, encoding: "utf8" },
      );
  } catch (error) {
    throw new Error(
      `无法创建 Git worktree：${error.stderr?.trim() || error.message}`,
    );
  }
  return {
    ...project,
    branch,
    targetBranch,
    workspacePath: directory,
    isolated: true,
  };
}

function mergeError(error) {
  return (
    error.stderr?.trim() ||
    error.stdout?.trim() ||
    error.message ||
    "未知 Git 错误"
  );
}
function taskBranch(task) {
  return task.codex?.branch || `flight-deck/${task.id.toLowerCase()}`;
}
function mergeTarget(task, projectRoot) {
  return (
    task.merge?.targetBranch ||
    tryGit(["branch", "--show-current"], projectRoot)
  );
}
function targetWorkspaceDirty(projectRoot) {
  return git(["status", "--porcelain"], projectRoot)
    .split("\n")
    .filter(Boolean)
    .filter((line) => !line.slice(3).startsWith(".flight-deck-worktrees/"));
}
function ensureTaskCommit(task, workspacePath) {
  const dirty = git(["status", "--porcelain"], workspacePath);
  if (!dirty)
    return {
      committed: false,
      commit: git(["rev-parse", "HEAD"], workspacePath),
    };
  try {
    execFileSync("git", ["add", "-A"], {
      cwd: workspacePath,
      encoding: "utf8",
    });
    execFileSync(
      "git",
      ["commit", "-m", `Flight Deck ${task.id}: ${task.title}`],
      { cwd: workspacePath, encoding: "utf8" },
    );
  } catch (error) {
    throw new Error(`无法为任务变更创建 Git 提交：${mergeError(error)}`);
  }
  return { committed: true, commit: git(["rev-parse", "HEAD"], workspacePath) };
}

export function prepareTaskMerge(task, { commit = false } = {}) {
  if (!task.codex?.isolated || !task.codex?.workspacePath)
    throw new Error("此任务未在独立 Git worktree 中执行，不能安全合并。");
  const workspacePath = task.codex.workspacePath;
  // In a linked worktree, rev-parse points to the worktree itself. Merge operations
  // must happen in the original project checkout, where the target branch is checked out.
  const projectRoot = getProject(task.projectPath).path;
  const targetBranch = mergeTarget(task, projectRoot);
  const branch = taskBranch(task);
  if (!targetBranch) throw new Error("找不到任务创建时的目标分支，无法合并。");
  if (!tryGit(["rev-parse", "--verify", targetBranch], projectRoot))
    throw new Error(`目标分支不存在：${targetBranch}`);
  const commitResult = commit ? ensureTaskCommit(task, workspacePath) : null;
  const diffArgs = commit
    ? ["diff", "--no-ext-diff", "--unified=3", `${targetBranch}...${branch}`]
    : ["diff", "--no-ext-diff", "--unified=3", targetBranch, "--"];
  const statArgs = commit
    ? ["diff", "--stat", `${targetBranch}...${branch}`]
    : ["diff", "--stat", targetBranch, "--"];
  const diffStat = git(statArgs, workspacePath) || "没有可合并的代码变更。";
  // Store the complete local patch. A truncated patch can start or end in the
  // middle of a file, which breaks file grouping and line-number rendering.
  const diff = git(diffArgs, workspacePath);
  return {
    state: diff ? "ready" : "empty",
    targetBranch,
    branch,
    commit:
      commitResult?.commit || tryGit(["rev-parse", "HEAD"], workspacePath),
    committed: Boolean(commitResult?.committed),
    diffStat,
    diff,
    preparedAt: new Date().toISOString(),
  };
}

export function mergeTaskWorktree(task) {
  const prepared = prepareTaskMerge(task, { commit: true });
  if (prepared.state === "empty")
    return {
      ...prepared,
      state: "merged",
      mergedAt: new Date().toISOString(),
      message: "任务没有产生需要合并的 Git 变更。",
    };
  const projectRoot = getProject(task.projectPath).path;
  const currentBranch = git(["branch", "--show-current"], projectRoot);
  if (currentBranch !== prepared.targetBranch)
    throw new Error(
      `当前项目检出在 ${currentBranch || "分离 HEAD"}；请先切换回 ${prepared.targetBranch} 后再合并。`,
    );
  if (targetWorkspaceDirty(projectRoot).length)
    throw new Error(
      "目标分支存在未提交改动。为避免覆盖文件，请先提交、暂存或清理这些改动后再合并。",
    );
  try {
    execFileSync(
      "git",
      [
        "merge",
        "--no-ff",
        prepared.branch,
        "-m",
        `Merge Flight Deck ${task.id}: ${task.title}`,
      ],
      { cwd: projectRoot, encoding: "utf8" },
    );
  } catch (error) {
    try {
      execFileSync("git", ["merge", "--abort"], {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: "ignore",
      });
    } catch {
      /* Nothing to abort. */
    }
    throw new Error(
      `合并未完成，已保留任务 worktree 和目标分支：${mergeError(error)}`,
    );
  }
  return {
    ...prepared,
    state: "merged",
    mergedAt: new Date().toISOString(),
    targetHead: git(["rev-parse", "--short", "HEAD"], projectRoot),
  };
}

export function inspectWorkspace(workspacePath) {
  const project = inspectProject(workspacePath);
  const gitEnabled = project.executionMode === "worktree";
  if (!gitEnabled)
    return {
      ...project,
      changedFiles: [],
      diffStat: "未启用 Git，无法生成 diff",
      dirty: false,
    };
  const changedFiles = git(["status", "--short"], workspacePath)
    .split("\n")
    .filter(Boolean);
  const diffStat =
    git(["diff", "--stat"], workspacePath) || "没有未提交的 Git diff";
  return { ...project, changedFiles, diffStat, dirty: changedFiles.length > 0 };
}

export async function runProjectVerification(workspacePath, policy = {}) {
  const packagePath = path.join(workspacePath, "package.json");
  if (!existsSync(packagePath))
    return {
      available: false,
      command: "",
      exitCode: null,
      output: "项目未配置 package.json 测试脚本。",
    };
  let scripts;
  try {
    scripts = JSON.parse(readFileSync(packagePath, "utf8")).scripts || {};
  } catch {
    return {
      available: false,
      command: "",
      exitCode: null,
      output: "无法读取 package.json。",
    };
  }
  const configuredScript = policy.verificationCommand?.match(
    /^npm run ([a-zA-Z0-9:_-]+)$/,
  )?.[1];
  const scriptName =
    configuredScript ||
    ["test", "check", "build"].find((name) => scripts[name]);
  if (configuredScript && !scripts[configuredScript])
    return {
      available: false,
      command: policy.verificationCommand,
      exitCode: null,
      output: `项目规则指定了 ${policy.verificationCommand}，但 package.json 中没有该脚本。`,
    };
  if (!scriptName)
    return {
      available: false,
      command: "",
      exitCode: null,
      output: "未发现 package.json 中的 test、check 或 build 脚本。",
    };
  const command = `npm run ${scriptName}`;
  return new Promise((resolve) =>
    execFile(
      "npm",
      ["run", scriptName],
      { cwd: workspacePath, timeout: 120_000, maxBuffer: 512 * 1024 },
      (error, stdout, stderr) => {
        const exitCode =
          error?.code && Number.isInteger(error.code)
            ? error.code
            : error
              ? 1
              : 0;
        const output =
          `${stdout || ""}${stderr || ""}`.trim().slice(-8000) ||
          (exitCode === 0
            ? "命令执行成功，未产生输出。"
            : "命令执行失败，未产生输出。");
        const missingDependency =
          /failed to resolve import|cannot find module|module not found/i.test(
            output,
          ) && /react|node_modules|package/i.test(output);
        resolve({
          available: true,
          command,
          exitCode,
          output,
          missingDependency,
          guidance: missingDependency
            ? "当前 worktree 的项目依赖尚未准备。请在该 worktree 中执行 npm install（或使用锁文件对应的 npm ci），然后重新运行验证。"
            : "",
        });
      },
    ),
  );
}

function availablePort(start = 48300) {
  return new Promise((resolve, reject) => {
    const attempt = (port) => {
      const server = net.createServer();
      server.once("error", () => attempt(port + 1));
      server.once("listening", () => server.close(() => resolve(port)));
      server.listen(port, "127.0.0.1");
    };
    try {
      attempt(start);
    } catch (error) {
      reject(error);
    }
  });
}

export async function startTaskPreview(task) {
  if (!task.codex?.workspacePath)
    throw new Error("请先完成一次 Codex 执行，才能预览任务 worktree。");
  if (task.codex.state === "running")
    throw new Error("Codex 正在修改文件；请等待本轮完成后再启动预览。");
  const existing = previews.get(task.id);
  if (existing && !existing.process.killed) return existing.info;
  const packagePath = path.join(task.codex.workspacePath, "package.json");
  if (!existsSync(packagePath))
    throw new Error("该任务 worktree 没有 package.json，无法启动 Web 预览。");
  let scripts;
  try {
    scripts = JSON.parse(readFileSync(packagePath, "utf8")).scripts || {};
  } catch {
    throw new Error("无法读取任务 worktree 的 package.json。");
  }
  const script = scripts.dev ? "dev" : scripts.start ? "start" : "";
  if (!script)
    throw new Error(
      "未发现 package.json 的 dev 或 start 脚本；此任务不能启动页面预览。",
    );
  const port = await availablePort();
  const commandArgs =
    script === "dev"
      ? ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port)]
      : ["run", "start", "--", "--host", "127.0.0.1", "--port", String(port)];
  const process = spawn("npm", commandArgs, {
    cwd: task.codex.workspacePath,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  let output = "";
  const capture = (chunk) => {
    output = `${output}${chunk}`.slice(-3000);
  };
  process.stdout.on("data", capture);
  process.stderr.on("data", capture);
  const info = {
    url: `http://127.0.0.1:${port}`,
    port,
    command: `npm ${commandArgs.join(" ")}`,
    workspacePath: task.codex.workspacePath,
    startedAt: new Date().toISOString(),
    output,
  };
  previews.set(task.id, { process, info });
  process.on("exit", () => previews.delete(task.id));
  await new Promise((resolve) => setTimeout(resolve, 900));
  const current = previews.get(task.id);
  if (!current)
    throw new Error(`预览进程未能启动：${output || "请检查项目脚本和依赖。"}`);
  current.info.output = output;
  return current.info;
}
