import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configFile = path.join(root, "data", "projects.json");
const initialPath = process.env.FLIGHT_DECK_PROJECT_PATH || "/Users/fangyuanzhonghe/code/Codex-Flight-Deck-Test";

function git(args, cwd) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function tryGit(args, cwd) { try { return git(args, cwd); } catch { return ""; } }
function readConfig() {
  try { return JSON.parse(readFileSync(configFile, "utf8")); }
  catch { return { activePath: initialPath, paths: [initialPath] }; }
}
function writeConfig(config) { mkdirSync(path.dirname(configFile), { recursive: true }); writeFileSync(configFile, JSON.stringify(config, null, 2)); }

export function inspectProject(candidatePath) {
  const suppliedPath = candidatePath?.trim();
  if (!suppliedPath || !existsSync(suppliedPath)) throw new Error(`项目目录不存在：${suppliedPath || "未提供路径"}`);
  const projectRoot = tryGit(["rev-parse", "--show-toplevel"], suppliedPath) || path.resolve(suppliedPath);
  const hasGit = Boolean(tryGit(["rev-parse", "--is-inside-work-tree"], suppliedPath));
  const head = hasGit ? tryGit(["rev-parse", "--short", "HEAD"], projectRoot) : "";
  return {
    name: path.basename(projectRoot), path: projectRoot,
    branch: hasGit ? (tryGit(["branch", "--show-current"], projectRoot) || "未提交") : "未启用 Git",
    head, executionMode: hasGit && head ? "worktree" : "shared",
  };
}

export function listProjects() {
  const config = readConfig();
  const projects = config.paths.map((item) => { try { return inspectProject(item); } catch { return null; } }).filter(Boolean);
  const active = projects.find((project) => project.path === config.activePath) || projects[0];
  return { projects, active };
}

export function addProject(candidatePath) {
  const project = inspectProject(candidatePath);
  const config = readConfig();
  const paths = [...new Set([...config.paths, project.path])];
  writeConfig({ activePath: project.path, paths });
  return project;
}

export function setActiveProject(candidatePath) {
  const project = inspectProject(candidatePath);
  const config = readConfig();
  if (!config.paths.includes(project.path)) throw new Error("请先将该仓库添加为项目。");
  writeConfig({ ...config, activePath: project.path });
  return project;
}

export function getProject(candidatePath) { return inspectProject(candidatePath || listProjects().active?.path); }

export function createTaskWorktree(task) {
  const project = getProject(task.projectPath);
  if (project.executionMode === "shared") return { ...project, branch: "共享工作目录", workspacePath: project.path, isolated: false };
  const branch = `flight-deck/${task.id.toLowerCase()}`;
  const targetBranch = task.merge?.targetBranch || project.branch;
  const directory = `${project.path}/.flight-deck-worktrees/${task.id}`;
  try {
    const existing = git(["worktree", "list", "--porcelain"], project.path);
    if (!existing.includes(`worktree ${directory}\n`)) execFileSync("git", ["worktree", "add", "-b", branch, directory, targetBranch], { cwd: project.path, encoding: "utf8" });
  } catch (error) { throw new Error(`无法创建 Git worktree：${error.stderr?.trim() || error.message}`); }
  return { ...project, branch, targetBranch, workspacePath: directory, isolated: true };
}

function mergeError(error) { return error.stderr?.trim() || error.stdout?.trim() || error.message || "未知 Git 错误"; }
function taskBranch(task) { return task.codex?.branch || `flight-deck/${task.id.toLowerCase()}`; }
function mergeTarget(task, projectRoot) { return task.merge?.targetBranch || tryGit(["branch", "--show-current"], projectRoot); }
function targetWorkspaceDirty(projectRoot) {
  return git(["status", "--porcelain"], projectRoot).split("\n").filter(Boolean).filter((line) => !line.slice(3).startsWith(".flight-deck-worktrees/"));
}
function ensureTaskCommit(task, workspacePath) {
  const dirty = git(["status", "--porcelain"], workspacePath);
  if (!dirty) return { committed: false, commit: git(["rev-parse", "HEAD"], workspacePath) };
  try {
    execFileSync("git", ["add", "-A"], { cwd: workspacePath, encoding: "utf8" });
    execFileSync("git", ["commit", "-m", `Flight Deck ${task.id}: ${task.title}`], { cwd: workspacePath, encoding: "utf8" });
  } catch (error) { throw new Error(`无法为任务变更创建 Git 提交：${mergeError(error)}`); }
  return { committed: true, commit: git(["rev-parse", "HEAD"], workspacePath) };
}

export function prepareTaskMerge(task, { commit = false } = {}) {
  if (!task.codex?.isolated || !task.codex?.workspacePath) throw new Error("此任务未在独立 Git worktree 中执行，不能安全合并。");
  const workspacePath = task.codex.workspacePath;
  // In a linked worktree, rev-parse points to the worktree itself. Merge operations
  // must happen in the original project checkout, where the target branch is checked out.
  const projectRoot = getProject(task.projectPath).path;
  const targetBranch = mergeTarget(task, projectRoot);
  const branch = taskBranch(task);
  if (!targetBranch) throw new Error("找不到任务创建时的目标分支，无法合并。");
  if (!tryGit(["rev-parse", "--verify", targetBranch], projectRoot)) throw new Error(`目标分支不存在：${targetBranch}`);
  const commitResult = commit ? ensureTaskCommit(task, workspacePath) : null;
  const diffArgs = commit ? ["diff", "--no-ext-diff", "--unified=3", `${targetBranch}...${branch}`] : ["diff", "--no-ext-diff", "--unified=3", targetBranch, "--"];
  const statArgs = commit ? ["diff", "--stat", `${targetBranch}...${branch}`] : ["diff", "--stat", targetBranch, "--"];
  const diffStat = git(statArgs, workspacePath) || "没有可合并的代码变更。";
  const diff = git(diffArgs, workspacePath).slice(-24000);
  return { state: diff ? "ready" : "empty", targetBranch, branch, commit: commitResult?.commit || tryGit(["rev-parse", "HEAD"], workspacePath), committed: Boolean(commitResult?.committed), diffStat, diff, preparedAt: new Date().toISOString() };
}

export function mergeTaskWorktree(task) {
  const prepared = prepareTaskMerge(task, { commit: true });
  if (prepared.state === "empty") return { ...prepared, state: "merged", mergedAt: new Date().toISOString(), message: "任务没有产生需要合并的 Git 变更。" };
  const projectRoot = getProject(task.projectPath).path;
  const currentBranch = git(["branch", "--show-current"], projectRoot);
  if (currentBranch !== prepared.targetBranch) throw new Error(`当前项目检出在 ${currentBranch || "分离 HEAD"}；请先切换回 ${prepared.targetBranch} 后再合并。`);
  if (targetWorkspaceDirty(projectRoot).length) throw new Error("目标分支存在未提交改动。为避免覆盖文件，请先提交、暂存或清理这些改动后再合并。");
  try {
    execFileSync("git", ["merge", "--no-ff", prepared.branch, "-m", `Merge Flight Deck ${task.id}: ${task.title}`], { cwd: projectRoot, encoding: "utf8" });
  } catch (error) {
    try { execFileSync("git", ["merge", "--abort"], { cwd: projectRoot, encoding: "utf8", stdio: "ignore" }); } catch { /* Nothing to abort. */ }
    throw new Error(`合并未完成，已保留任务 worktree 和目标分支：${mergeError(error)}`);
  }
  return { ...prepared, state: "merged", mergedAt: new Date().toISOString(), targetHead: git(["rev-parse", "--short", "HEAD"], projectRoot) };
}

export function inspectWorkspace(workspacePath) {
  const project = inspectProject(workspacePath);
  const gitEnabled = project.executionMode === "worktree";
  if (!gitEnabled) return { ...project, changedFiles: [], diffStat: "未启用 Git，无法生成 diff", dirty: false };
  const changedFiles = git(["status", "--short"], workspacePath).split("\n").filter(Boolean);
  const diffStat = git(["diff", "--stat"], workspacePath) || "没有未提交的 Git diff";
  return { ...project, changedFiles, diffStat, dirty: changedFiles.length > 0 };
}

export async function runProjectVerification(workspacePath) {
  const packagePath = path.join(workspacePath, "package.json");
  if (!existsSync(packagePath)) return { available: false, command: "", exitCode: null, output: "项目未配置 package.json 测试脚本。" };
  let scripts;
  try { scripts = JSON.parse(readFileSync(packagePath, "utf8")).scripts || {}; } catch { return { available: false, command: "", exitCode: null, output: "无法读取 package.json。" }; }
  const scriptName = ["test", "check", "build"].find((name) => scripts[name]);
  if (!scriptName) return { available: false, command: "", exitCode: null, output: "未发现 package.json 中的 test、check 或 build 脚本。" };
  const command = `npm run ${scriptName}`;
  return new Promise((resolve) => execFile("npm", ["run", scriptName], { cwd: workspacePath, timeout: 120_000, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
    const exitCode = error?.code && Number.isInteger(error.code) ? error.code : error ? 1 : 0;
    const output = `${stdout || ""}${stderr || ""}`.trim().slice(-8000) || (exitCode === 0 ? "命令执行成功，未产生输出。" : "命令执行失败，未产生输出。");
    const missingDependency = /failed to resolve import|cannot find module|module not found/i.test(output) && /react|node_modules|package/i.test(output);
    resolve({ available: true, command, exitCode, output, missingDependency, guidance: missingDependency ? "当前 worktree 的项目依赖尚未准备。请在该 worktree 中执行 npm install（或使用锁文件对应的 npm ci），然后重新运行验证。" : "" });
  }));
}
