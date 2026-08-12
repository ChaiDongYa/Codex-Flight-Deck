import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const testProject = "/Users/fangyuanzhonghe/code/Codex-Flight-Deck-Test";
const configuredPath = process.env.FLIGHT_DECK_PROJECT_PATH || testProject;

function git(args, cwd = configuredPath) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function getProject() {
  if (!existsSync(configuredPath)) throw new Error(`项目目录不存在：${configuredPath}`);
  const root = git(["rev-parse", "--show-toplevel"]);
  return {
    name: root.split("/").pop(),
    path: root,
    branch: git(["branch", "--show-current"], root),
    head: git(["rev-parse", "--short", "HEAD"], root),
  };
}

export function createTaskWorktree(task) {
  const project = getProject();
  const branch = `flight-deck/${task.id.toLowerCase()}`;
  const directory = `${project.path}/.flight-deck-worktrees/${task.id}`;
  try {
    const existing = git(["worktree", "list", "--porcelain"], project.path);
    if (!existing.includes(`worktree ${directory}\n`)) {
      execFileSync("git", ["worktree", "add", "-b", branch, directory, project.branch], { cwd: project.path, encoding: "utf8" });
    }
  } catch (error) {
    throw new Error(`无法创建 Git worktree：${error.stderr?.trim() || error.message}`);
  }
  return { ...project, branch, workspacePath: directory };
}
