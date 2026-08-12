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
  const directory = `${project.path}/.flight-deck-worktrees/${task.id}`;
  try {
    const existing = git(["worktree", "list", "--porcelain"], project.path);
    if (!existing.includes(`worktree ${directory}\n`)) execFileSync("git", ["worktree", "add", "-b", branch, directory, project.branch], { cwd: project.path, encoding: "utf8" });
  } catch (error) { throw new Error(`无法创建 Git worktree：${error.stderr?.trim() || error.message}`); }
  return { ...project, branch, workspacePath: directory, isolated: true };
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
