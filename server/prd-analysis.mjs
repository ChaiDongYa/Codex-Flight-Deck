import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "questions", "risks", "proposals"],
  properties: {
    summary: { type: "string" },
    questions: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    proposals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "title", "goal", "role", "stage", "acceptance", "dependencies"],
        properties: {
          key: { type: "string" },
          title: { type: "string" },
          goal: { type: "string" },
          role: { type: "string" },
          stage: { type: "string" },
          acceptance: { type: "string" },
          dependencies: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const perspectiveRoles = {
  "前端开发": "前端专家",
  "后端开发": "后端专家",
  "UI/UX 设计": "UI/UX 专家",
  "测试": "测试专家",
  "产品": "产品专家",
};
const supportedRoles = new Set([
  "产品专家",
  "UI/UX 专家",
  "前端专家",
  "后端专家",
  "全栈工程师",
  "测试专家",
  "DevOps 专家",
  "安全专家",
  "数据工程师",
]);
const configuredTimeout = Number(process.env.FLIGHT_DECK_PRD_ANALYSIS_TIMEOUT_MS);
const analysisTimeoutMs = Number.isFinite(configuredTimeout)
  ? Math.min(600_000, Math.max(20_000, configuredTimeout))
  : 600_000;
const desktopCodexPath = "/Applications/ChatGPT.app/Contents/Resources/codex";
// The desktop-bundled CLI knows how to fall back from the Codex WebSocket to
// HTTPS. A separately installed global CLI can lag behind that recovery path.
// Keep a scoped override for other installations and a PATH fallback off macOS.
const codexCommand =
  process.env.FLIGHT_DECK_CODEX_CLI_PATH ||
  (existsSync(desktopCodexPath) ? desktopCodexPath : "codex");

function promptFor({ name, goal, prd, attachments, taskStages, perspectives = ["前端开发"], deliveryRoles = [], feedback = "", reviewContext = "" }) {
  const selectedPerspectives = [...new Set(perspectives)].filter((value) => perspectiveRoles[value]);
  const activePerspectives = selectedPerspectives.length ? selectedPerspectives : ["前端开发"];
  const inferredRoles = activePerspectives.map((value) => perspectiveRoles[value]).filter(Boolean);
  const allowedRoles = [...new Set(deliveryRoles.filter((value) => supportedRoles.has(value)))];
  const outputRoles = allowedRoles.length ? allowedRoles : inferredRoles;
  const scope = `从${activePerspectives.join("、")}视角共同分析需求`;
  const roleRule = `所有 proposals 的 role 必须严格从“${outputRoles.join("、")}”中选择；分析视角用于发现需求，不代表每个视角都要产出任务。`;
  return `你是资深软件交付负责人。请${scope}。\n\n版本：${name}\n版本目标：${goal || "未填写"}\n分析视角：${activePerspectives.join("、")}\n允许产出任务角色：${outputRoles.join("、")}\n附件上下文：${attachments || "无"}\n已确认的评审结论（必须作为任务拆分约束）：${reviewContext || "无"}\n可用任务阶段：${taskStages.join("、")}\n用户对上一版分析的补充意见：${feedback || "无；请直接根据 PRD 分析"}\n\nPRD：\n${prd}\n\n拆分要求：\n- ${roleRule}\n- 任务必须能被对应角色执行，目标引用 PRD 中的具体业务内容，不要凭空补需求。\n- 对前端开发视角，按可交付功能点拆分，而不是按 PRD 章节复述：列表/表格与查询筛选、详情、表单字段与校验、新增、编辑、删除/撤销、批量操作、状态流转、权限展示、接口联调、加载态/空态/错误态、分页/排序、响应式和验收验证；仅当 PRD 明确需要时才生成对应任务，不要为了凑数量强行拆分。\n- 每项任务应有清晰的页面或组件边界、用户动作、数据/接口边界和可观察验收结果；粒度以 0.5-2 个开发日为宜，过大的流程必须继续拆分。\n- acceptance 必须同时以“用户可见结果：”和“验证与边界：”两个小节写成。前者写用户可以直接看到或操作到的完成结果；后者写最小验证方式与必须覆盖的边界（例如空态、非法输入、权限、错误或状态切换；仅写与该任务相关的项）。不要只写“测试通过”“功能正常”或实现方案。\n- “验证与边界”必须明确一项可执行验证：已有脚本时写对应脚本及预期结果；没有自动化脚本时写清楚人工操作、输入与预期结果。PRD 已明确无需后端时，要明确“不发起后端请求”；不要凭空要求接口或测试环境。\n- 若有补充意见，必须按意见调整任务范围、合并或拆分方式，不保留与意见冲突的建议。\n- 已确认的评审结论必须落实到受影响任务的说明、验收标准或依赖中，不得忽略或与其冲突。\n- 明确前置依赖；没有依赖就返回空数组。\n- stage 必须从可用任务阶段中选择；若无法匹配使用“待开发”。\n- questions 只列影响当前分析视角实现、且 PRD 未明确的问题。\n- 返回严格 JSON，不要 Markdown。`;
}

function runCodex(prompt, schemaPath, outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexCommand, [
      "exec",
      "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check",
      "--output-schema", schemaPath, "--output-last-message", outputPath, prompt,
    ], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env } });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      // `codex exec` can leave child processes behind while tearing down a
      // stalled session. Do not let that keep the release API waiting.
      setTimeout(() => child.kill("SIGKILL"), 3_000).unref();
      reject(new Error(`Codex 分析超过 ${Math.round(analysisTimeoutMs / 1000)} 秒未返回。`));
    }, analysisTimeoutMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Codex 分析失败（退出码 ${code}）`));
    });
  });
}

export async function analysePrdWithCodex(input) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "flight-deck-prd-"));
  const schemaPath = path.join(tempDir, "schema.json");
  const outputPath = path.join(tempDir, "analysis.json");
  try {
    await writeFile(schemaPath, JSON.stringify(schema), "utf8");
    await runCodex(promptFor(input), schemaPath, outputPath);
    const result = JSON.parse(await readFile(outputPath, "utf8"));
    result.generatedAt = new Date().toISOString();
    // Distinguish an actual Codex response from legacy/local placeholder data.
    // Only a completed Codex analysis may surface AI-discovered questions.
    result.source = "codex";
    // Feedback guides this analysis run only. Keeping it in the saved draft
    // would repopulate the input and accidentally carry it into the next run.
    result.feedback = "";
    const perspectives = [...new Set(input.perspectives || ["前端开发"])]
      .filter((value) => perspectiveRoles[value]);
    const deliveryRoles = [...new Set(input.deliveryRoles || [])]
      .filter((value) => supportedRoles.has(value));
    result.perspectives = perspectives.length ? perspectives : ["前端开发"];
    result.perspective = result.perspectives.join("、");
    result.deliveryRoles = deliveryRoles.length
      ? deliveryRoles
      : result.perspectives.map((value) => perspectiveRoles[value]).filter(Boolean);
    result.proposals = result.proposals.map((item, index) => ({
      ...item,
      key: item.key || `ai-${index + 1}`,
      role: result.deliveryRoles.includes(item.role) ? item.role : result.deliveryRoles[0],
      selected: true,
      dependencies: Array.isArray(item.dependencies) ? item.dependencies : [],
    }));
    return result;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
