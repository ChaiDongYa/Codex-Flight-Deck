import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configFile = path.join(root, "data", "projects.json");
const initialPath = process.env.FLIGHT_DECK_PROJECT_PATH || "/Users/fangyuanzhonghe/code/Codex-Flight-Deck-Test";

function git(args, cwd) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function readConfig() {
  try { return JSON.parse(readFileSync(configFile, "utf8")); }
  catch { return { activePath: initialPath, paths: [initialPath] }; }
}
function writeConfig(config) { mkdirSync(path.dirname(configFile), { recursive: true }); writeFileSync(configFile, JSON.stringify(config, null, 2)); }

export function inspectProject(candidatePath) {
  const suppliedPath = candidatePath?.trim();
  if (!suppliedPath || !existsSync(suppliedPath)) throw new Error(`项目目录不存在：${suppliedPath || "未提供路径"}`);
  let projectRoot;
  try { projectRoot = git(["rev-parse", "--show-toplevel"], suppliedPath); }
  catch { throw new Error("该目录不是 Git 仓库；请先执行 git init 并至少提交一次。"); }
  return { name: path.basename(projectRoot), path: projectRoot, branch: git(["branch", "--show-current"], projectRoot) || "detached HEAD", head: git(["rev-parse", "--short", "HEAD"], projectRoot) };
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
  const branch = `flight-deck/${task.id.toLowerCase()}`;
  const directory = `${project.path}/.flight-deck-worktrees/${task.id}`;
  try {
    const existing = git(["worktree", "list", "--porcelain"], project.path);
    if (!existing.includes(`worktree ${directory}\n`)) execFileSync("git", ["worktree", "add", "-b", branch, directory, project.branch], { cwd: project.path, encoding: "utf8" });
  } catch (error) { throw new Error(`无法创建 Git worktree：${error.stderr?.trim() || error.message}`); }
  return { ...project, branch, workspacePath: directory };
}
