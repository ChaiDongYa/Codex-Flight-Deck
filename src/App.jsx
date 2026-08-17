import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Button,
  Badge,
  Checkbox,
  ConfigProvider,
  DatePicker,
  Dropdown,
  Input,
  Modal,
  Select,
  Table,
  Tabs,
  Tag,
  theme as antdTheme,
} from "antd";
import dayjs from "dayjs";
import "./styles.css";

// Mermaid pulls in every diagram grammar. Keep it out of the task board's
// startup path and load it only when a Markdown block actually needs a chart.
let mermaidLoader;
function loadMermaid() {
  mermaidLoader ??= import("mermaid").then((module) => module.default);
  return mermaidLoader;
}

const statusClass = {
  待开始: "ready",
  计划中: "planning",
  待验证: "planning",
  执行中: "running",
  待复核: "review",
  已阻塞: "blocked",
  等待依赖: "blocked",
  已完成: "done",
};

function EmptyStageToggle({ pressed, onToggle }) {
  return (
    <div className="board-stage-toolbar">
      <button
        type="button"
        className={`empty-stage-toggle ${pressed ? "on" : ""}`}
        aria-pressed={pressed}
        title={pressed ? "隐藏没有任务的阶段" : "显示没有任务的阶段"}
        onClick={() => onToggle((value) => !value)}
      >
        <span className="empty-stage-toggle-switch" aria-hidden="true" />
        空阶段
      </button>
    </div>
  );
}

// Execution events can contain shell commands and machine-specific paths. Keep
// the workstream readable, while retaining the complete evidence on demand.
function compactExecutionDetail(detail = "", label = "") {
  const source = `${detail}`.replace(/\s+/g, " ").trim();
  if (!source) return "Codex 已记录此执行步骤。";
  if (/正在运行命令|运行命令|执行命令/.test(label)) {
    const command = source.match(/(?:npm|pnpm|yarn)\s+(?:run\s+)?[\w:-]+/i)?.[0];
    return command ? `正在运行 ${command}` : "正在运行项目命令";
  }
  if (/\/Users\/|\\\\Users\\\\|\/private\//.test(source)) return "正在处理任务工作目录中的文件。";
  return source.length > 116 ? `${source.slice(0, 116)}...` : source;
}

// App-server emits several progress notifications for one CLI action. Keep the
// audit trail readable by coalescing consecutive, user-identical updates.
function summarizeExecutionEvents(events = []) {
  return events.reduce((summary, event) => {
    const detail = compactExecutionDetail(event.detail, event.label);
    const key = `${event.kind || ""}|${event.label || ""}|${detail}`;
    const previous = summary.at(-1);
    if (previous?.key === key) {
      previous.count += 1;
      previous.at = event.at;
      return summary;
    }
    summary.push({ ...event, detail, key, count: 1 });
    return summary;
  }, []);
}

function verificationSummary(verification) {
  if (!verification) return { title: "尚未运行验证", detail: "完成执行后可在此查看验证结论。", tone: "pending" };
  if (verification.exitCode === 0) return { title: "验证通过", detail: "本轮项目脚本已正常结束。", tone: "success" };
  const errorLine = `${verification.output || ""}`
    .split("\n")
    .find((line) => /error|failed|无法|未找到|cannot/i.test(line))
    ?.replace(/\/Users\/[^\s'\"]+/g, "本地文件")
    .trim();
  return {
    title: "验证未通过",
    detail: errorLine || "项目脚本返回了错误，可展开查看原始日志。",
    tone: "failed",
  };
}

function AcceptanceGuidance() {
  return (
    <div className="acceptance-guidance">
      <b>按两部分写</b>
      <span><strong>用户可见结果：</strong>用户完成什么操作、看到什么结果。</span>
      <span><strong>验证与边界：</strong>写验证方式、预期结果，以及与本任务相关的空态、异常、权限或状态切换。</span>
    </div>
  );
}

// A verification result is only actionable for the Codex turn that produced
// the currently inspected code. Older records remain in the activity history,
// but must not suppress the next verification action after a retry/revision.
function currentVerification(task) {
  const verification = task?.evidence?.verification;
  if (!verification) return null;
  if (verification.turnId && verification.turnId !== task.codex?.turnId) return null;
  // Evidence saved before turn IDs existed is stale whenever the task is
  // explicitly awaiting a fresh verification.
  if (!verification.turnId && task.status === "待验证") return null;
  return verification;
}

// The detail view should explain the decision the user can make now, rather
// than exposing the underlying execution machinery as its primary content.
function taskConclusion(task, verification) {
  if (task.deliveryMode === "no-code" && task.status === "待复核")
    return {
      title: "无需代码交付，等待你确认",
      detail: task.noCodeReason || "该任务已明确无需开发；确认范围无误后即可接受交付。",
    };
  if (task.status === "已完成")
    return {
      title: "交付已完成",
      detail: task.codex?.isolated
        ? "变更已合并并完成验收。"
        : "共享目录交付已验收，无需合并。",
    };
  if (task.codex?.state === "completed" && verification?.exitCode === 0)
    return {
      title: task.codex?.isolated
        ? "验证已通过，等待你复核"
        : "验证已通过，等待你验收",
      detail: task.codex?.isolated
        ? "先查看真实变更；确认无误后再合并并接受本次交付。"
        : "该任务在共享目录中交付，无需合并；确认无误后即可接受交付。",
    };
  if (task.codex?.state === "running")
    return {
      title: "Codex 正在执行",
      detail: "本轮完成后，请运行项目验证；你可以暂停执行，已有改动会保留。",
    };
  if (task.codex?.state === "stopped")
    return {
      title: "Codex 已暂停",
      detail: "执行队列已停止本次会话；已有代码和日志已保留，可在原工作区继续执行。",
    };
  if (task.status === "待复核" && verification?.exitCode === 0)
    return {
      title: task.codex?.isolated
        ? "验证已通过，等待你复核"
        : "验证已通过，等待你验收",
      detail: task.codex?.isolated
        ? "先查看真实变更；确认无误后再合并并接受本次交付。"
        : "该任务在共享目录中交付，无需合并；确认无误后即可接受交付。",
    };
  if (task.status === "已阻塞")
    return {
      title: "本轮需要处理",
      detail: "验证尚未通过。查看结论或补充修改意见后，再让 Codex 继续处理。",
    };
  if (task.codex?.state === "completed")
    return {
      title: "Codex 已完成，等待验证",
      detail: "运行项目验证后，系统会根据真实结果进入复核或阻塞状态。",
    };
  if (task.canRun === false)
    return {
      title: "等待前置任务",
      detail: "前置任务完成验证或验收后，这项任务会自动变为可启动。",
    };
  return task.codex?.workspacePath
    ? {
        title: "可继续处理",
        detail: "会复用当前 worktree，只处理未完成或受影响的内容。",
      }
    : {
        title: "等待启动",
        detail: "确认任务定义无误后，即可在独立 worktree 中启动 Codex。",
      };
}

function splitDiffFiles(diff = "") {
  const starts = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  return starts.map((match, index) => {
    const start = match.index ?? 0;
    const end = starts[index + 1]?.index ?? diff.length;
    return {
      id: `${match[2] || match[1] || index}-${index}`,
      path: match[2] || match[1] || `未命名变更 ${index + 1}`,
      // Slice by the next file header rather than using `$` in a multiline
      // regex: `$` can match at the end of the first header line.
      lines: diff.slice(start, end).replace(/\n$/, "").split("\n"),
    };
  });
}

function isWorkspaceNoiseFile(path = "") {
  return /(^|\/)(\.DS_Store|Thumbs\.db)$/i.test(path);
}

function hasReviewableTaskDiff(task) {
  return splitDiffFiles(task?.merge?.diff).some(
    (file) => !isWorkspaceNoiseFile(file.path),
  );
}

function canAcceptReviewedTask(task) {
  return !task?.codex?.isolated || task?.merge?.state === "merged";
}

function parseCsvRows(source = "") {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"' && quoted && source[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      value = "";
    } else value += character;
  }
  row.push(value);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function MarkdownInline({ text }) {
  return `${text || ""}`.split(/(!?\[[^\]]*\]\([^\s)]+\)|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|`[^`]+`|\*[^*]+\*|_[^_]+_)/g).map((part, index) => {
    const image = part.match(/^!\[([^\]]*)\]\(([^\s)]+)\)$/);
    if (image && /^https?:\/\//i.test(image[2])) return <img className="markdown-inline-image" key={index} src={image[2]} alt={image[1]} />;
    const link = part.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/);
    if (link && /^https?:\/\//i.test(link[2])) return <a key={index} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    if ((part.startsWith("**") && part.endsWith("**")) || (part.startsWith("__") && part.endsWith("__"))) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("~~") && part.endsWith("~~")) return <del key={index}>{part.slice(2, -2)}</del>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    if ((part.startsWith("*") && part.endsWith("*")) || (part.startsWith("_") && part.endsWith("_"))) return <em key={index}>{part.slice(1, -1)}</em>;
    return part;
  });
}

function MermaidDiagram({ chart }) {
  const containerRef = useRef(null);
  const diagramId = `flight-deck-mermaid-${useId().replaceAll(":", "-")}`;
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setError("");
    loadMermaid()
      .then((mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          themeVariables: {
            primaryColor: "#eaf2ff",
            primaryBorderColor: "#2f6feb",
            primaryTextColor: "#1f2937",
            lineColor: "#64748b",
            tertiaryColor: "#f8fafc",
          },
        });
        return mermaid.render(diagramId, chart);
      })
      .then(({ svg }) => {
        if (active && containerRef.current) containerRef.current.innerHTML = svg;
      })
      .catch((renderError) => {
        if (active) setError(renderError?.message || "流程图语法无法渲染。");
      });
    return () => { active = false; };
  }, [chart, diagramId]);

  if (error) return <pre className="mermaid-fallback"><code>{chart}</code><small>流程图渲染失败：{error}</small></pre>;
  return <div className="mermaid-diagram" ref={containerRef} aria-label="Mermaid 流程图" />;
}

function MarkdownPreview({ content, expanded = false }) {
  const lines = `${content || ""}`.replace(/\r/g, "").split("\n");
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim().toLowerCase();
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) code.push(lines[index++]);
      index += 1;
      const source = code.join("\n");
      blocks.push(language === "mermaid"
        ? <MermaidDiagram key={`diagram-${index}`} chart={source} />
        : <pre key={`code-${index}`}><code>{source}</code></pre>);
      continue;
    }
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push(<hr key={`rule-${index}`} />);
      index += 1;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const Tag = `h${heading[1].length}`;
      blocks.push(<Tag key={`heading-${index}`}><MarkdownInline text={heading[2]} /></Tag>);
      index += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={`quote-${index}`}><MarkdownInline text={quote.join("\n")} /></blockquote>);
      continue;
    }
    if (/^\|.+\|\s*$/.test(line) && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] || "")) {
      const cells = (value) => value.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
      const headers = cells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && /^\|.+\|\s*$/.test(lines[index])) rows.push(cells(lines[index++]));
      blocks.push(
        <div className="markdown-table-wrap" key={`table-${index}`}>
          <table>
            <thead><tr>{headers.map((cell, cellIndex) => <th key={cellIndex}><MarkdownInline text={cell} /></th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}><MarkdownInline text={row[cellIndex] || ""} /></td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^[-*+]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^[-*+]\s+/.test(lines[index])) items.push(lines[index++].replace(/^[-*+]\s+/, ""));
      blocks.push(<ul key={`list-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}><MarkdownInline text={item} /></li>)}</ul>);
      continue;
    }
    if (/^\d+[.)]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\d+[.)]\s+/.test(lines[index])) items.push(lines[index++].replace(/^\d+[.)]\s+/, ""));
      blocks.push(<ol key={`ordered-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}><MarkdownInline text={item} /></li>)}</ol>);
      continue;
    }
    blocks.push(<p key={`paragraph-${index}`}><MarkdownInline text={line} /></p>);
    index += 1;
  }
  return <article className={`markdown-preview${expanded ? " markdown-preview-expanded" : ""}`}>{blocks}</article>;
}

function looksLikeMarkdown(value = "") {
  return /(^|\n)#{1,6}\s|(^|\n)[-*+]\s|(^|\n)```|\[[^\]]+\]\([^\s)]+\)/m.test(value);
}

function parseUnifiedDiff(lines = []) {
  let oldLine = null;
  let newLine = null;

  return lines.map((line, index) => {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { id: index, type: "hunk", oldLine: "", newLine: "", text: line };
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      const row = {
        id: index,
        type: "addition",
        oldLine: "",
        newLine: newLine ?? "",
        text: line.slice(1),
      };
      if (newLine !== null) newLine += 1;
      return row;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      const row = {
        id: index,
        type: "deletion",
        oldLine: oldLine ?? "",
        newLine: "",
        text: line.slice(1),
      };
      if (oldLine !== null) oldLine += 1;
      return row;
    }

    if (line.startsWith(" ")) {
      const row = {
        id: index,
        type: "context",
        oldLine: oldLine ?? "",
        newLine: newLine ?? "",
        text: line.slice(1),
      };
      if (oldLine !== null) oldLine += 1;
      if (newLine !== null) newLine += 1;
      return row;
    }

    return { id: index, type: "meta", oldLine: "", newLine: "", text: line };
  });
}

function summarizeDiffFile(file) {
  const lines = file?.lines || [];
  const additions = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  const binary = lines.some((line) => /^Binary files .+ differ$/.test(line));
  const added = lines.some((line) => /^new file mode /.test(line));
  const removed = lines.some((line) => /^deleted file mode /.test(line));
  const renamed = lines.some((line) => /^rename (from|to) /.test(line));
  return {
    ...file,
    additions,
    deletions,
    binary,
    noise: isWorkspaceNoiseFile(file?.path),
    change: added ? "新增文件" : removed ? "删除文件" : renamed ? "重命名" : "修改文件",
  };
}

function ReleaseScheduleFields({ value, onChange }) {
  const setStartDate = (startDate) =>
    onChange({
      ...value,
      startDate,
      releaseDate:
        value.releaseDate && startDate && value.releaseDate < startDate
          ? startDate
          : value.releaseDate,
    });
  const setReleaseDate = (releaseDate) => onChange({ ...value, releaseDate });
  return (
    <div className="release-schedule">
      <div className="release-date-grid">
        <label>
          计划开始日期
          <DatePicker
            allowClear
            placement="bottomLeft"
            getPopupContainer={() => document.body}
            value={value.startDate ? dayjs(value.startDate) : null}
            onChange={(date) =>
              setStartDate(date ? date.format("YYYY-MM-DD") : "")
            }
            format="YYYY/MM/DD"
            placeholder="选择开始日期"
          />
        </label>
        <label>
          计划上线日期
          <DatePicker
            allowClear
            placement="bottomLeft"
            getPopupContainer={() => document.body}
            disabledDate={(date) =>
              Boolean(value.startDate) &&
              date.startOf("day").isBefore(dayjs(value.startDate), "day")
            }
            value={value.releaseDate ? dayjs(value.releaseDate) : null}
            onChange={(date) =>
              setReleaseDate(date ? date.format("YYYY-MM-DD") : "")
            }
            format="YYYY/MM/DD"
            placeholder="选择上线日期"
          />
        </label>
      </div>
    </div>
  );
}

export function App() {
  const [tasks, setTasks] = useState([]);
  const [releases, setReleases] = useState([]);
  const [releaseStages, setReleaseStages] = useState([]);
  const [taskStages, setTaskStages] = useState([]);
  const [releaseStageSettingsOpen, setReleaseStageSettingsOpen] =
    useState(false);
  const [taskStageSettingsOpen, setTaskStageSettingsOpen] = useState(false);
  const [releaseStageDraft, setReleaseStageDraft] = useState([]);
  const [newReleaseStage, setNewReleaseStage] = useState("");
  const [taskStageDraft, setTaskStageDraft] = useState([]);
  const [newTaskStage, setNewTaskStage] = useState("");
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releaseDraft, setReleaseDraft] = useState({
    name: "",
    goal: "",
    startDate: "",
    releaseDate: "",
  });
  const [editingRelease, setEditingRelease] = useState(null);
  const [releaseWorkspaceOpen, setReleaseWorkspaceOpen] = useState(null);
  const [releaseWorkspaceDraft, setReleaseWorkspaceDraft] = useState({
    prd: "",
    attachments: [],
    taskStages: [],
  });
  const [attachmentPreview, setAttachmentPreview] = useState(null);
  const [prdViewMode, setPrdViewMode] = useState("edit");
  const [editingAnalysisTask, setEditingAnalysisTask] = useState(null);
  const [reviewItemDraft, setReviewItemDraft] = useState({
    title: "",
    type: "业务规则",
    owner: "",
    dueDate: "",
    impact: "普通",
  });
  const [expandedReviewConclusionId, setExpandedReviewConclusionId] =
    useState(null);
  const [apifoxToken, setApifoxToken] = useState("");
  const [apifoxSyncing, setApifoxSyncing] = useState(false);
  const [analysingPrd, setAnalysingPrd] = useState(false);
  const [analysisPerspectives, setAnalysisPerspectives] = useState(["前端开发"]);
  const [analysisDeliveryRoles, setAnalysisDeliveryRoles] = useState(["前端专家"]);
  const [analysisFeedback, setAnalysisFeedback] = useState("");
  const [analysisDraftDirty, setAnalysisDraftDirty] = useState(false);
  const [apifoxConfigOpen, setApifoxConfigOpen] = useState(false);
  const [apifoxConfig, setApifoxConfig] = useState({
    projectId: "",
    configured: false,
    token: "",
  });
  const confirmAction = ({ title, content, danger = false, onOk }) =>
    Modal.confirm({
      title,
      content,
      centered: true,
      getContainer: () => document.body,
      okText: "确定",
      cancelText: "取消",
      okButtonProps: danger ? { danger: true } : undefined,
      onOk,
    });
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [knowledgeDocs, setKnowledgeDocs] = useState([]);
  const [knowledgeDraft, setKnowledgeDraft] = useState({
    title: "",
    content: "",
    source: "手动输入",
    tags: "",
  });
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [knowledgeResults, setKnowledgeResults] = useState([]);
  const [knowledgeVersions, setKnowledgeVersions] = useState([]);
  const [knowledgeVersionDoc, setKnowledgeVersionDoc] = useState(null);
  const [knowledgeComparison, setKnowledgeComparison] = useState(null);
  const [knowledgeCompareFrom, setKnowledgeCompareFrom] = useState("");
  const [knowledgeCompareTo, setKnowledgeCompareTo] = useState("");
  const [releaseEditDraft, setReleaseEditDraft] = useState({
    name: "",
    goal: "",
    startDate: "",
    releaseDate: "",
  });
  const [releaseLayout, setReleaseLayout] = useState("board");
  const [showEmptyReleaseStages, setShowEmptyReleaseStages] = useState(false);
  const [ganttScale, setGanttScale] = useState("month");
  const [draggedReleaseId, setDraggedReleaseId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [filter, setFilter] = useState("全部");
  const [filterOpen, setFilterOpen] = useState(false);
  const [project, setProject] = useState(null);
  const [projects, setProjects] = useState([]);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policyDraft, setPolicyDraft] = useState({
    rules: "",
    standards: "",
    skills: [],
    verificationCommand: "",
  });
  const [projectPath, setProjectPath] = useState("");
  const [projectPicking, setProjectPicking] = useState(false);
  const [allProjects, setAllProjects] = useState(false);
  const [view, setView] = useState("tasks");
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerStep, setComposerStep] = useState(1);
  const [quickMode, setQuickMode] = useState(false);
  const [draft, setDraft] = useState({
    title: "",
    goal: "",
    role: "全栈工程师",
    acceptance: "",
    context: "支付 API、现有测试与项目约定",
    dependencies: [],
    mergeMode: "manual",
    versionId: "",
    deliveryMode: "task",
    noCodeReason: "",
  });
  const [diffReviewOpen, setDiffReviewOpen] = useState(false);
  const [activeDiffFile, setActiveDiffFile] = useState(0);
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [taskPlanEditorOpen, setTaskPlanEditorOpen] = useState(false);
  const [taskPlanDraft, setTaskPlanDraft] = useState(null);
  const [taskApiNotes, setTaskApiNotes] = useState("");
  const [savingTaskInterfaces, setSavingTaskInterfaces] = useState(false);
  const [revisionFeedback, setRevisionFeedback] = useState("");
  const [revising, setRevising] = useState(false);
  const [toast, setToast] = useState("");
  const [launching, setLaunching] = useState(false);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [initialDataUnavailable, setInitialDataUnavailable] = useState(false);
  const [initialDataRetry, setInitialDataRetry] = useState(0);
  const [inspectorWidth, setInspectorWidth] = useState(760);
  const [resizingInspector, setResizingInspector] = useState(false);
  const [detailTab, setDetailTab] = useState("overview");
  const [detailComment, setDetailComment] = useState("");
  const [detailCommentAttachment, setDetailCommentAttachment] = useState(null);
  const [savingDetail, setSavingDetail] = useState(false);
  const [detailMoreOpen, setDetailMoreOpen] = useState(false);
  const [taskDeletion, setTaskDeletion] = useState(null);
  const [deletingTask, setDeletingTask] = useState(false);
  const [queue, setQueue] = useState({ paused: false, concurrency: 2, maxConcurrency: 2, running: 0, queued: 0, scheduled: 0, capacity: 2, runningTasks: [], pausedTasks: [] });
  const [queueControlOpen, setQueueControlOpen] = useState(false);
  const [queueUpdating, setQueueUpdating] = useState(false);
  const [taskViewMode, setTaskViewMode] = useState("board");
  const [showEmptyTaskStages, setShowEmptyTaskStages] = useState(false);
  const [draggedTaskId, setDraggedTaskId] = useState(null);
  const [kanbanDropStage, setKanbanDropStage] = useState(null);
  const taskKanbanRef = useRef(null);
  const releaseRequestRef = useRef(0);
  const releaseStageRequestRef = useRef(0);
  const taskStageRequestRef = useRef(0);
  const [discovery, setDiscovery] = useState({
    contextFiles: [],
    scripts: [],
    skills: [],
  });
  const visibleTasks = useMemo(
    () =>
      tasks.filter(
        (task) =>
          (allProjects || task.projectPath === project?.path) &&
          (filter === "全部" || task.status === filter),
      ),
    [tasks, filter, allProjects, project],
  );
  const selected = visibleTasks.find((task) => task.id === selectedId) ?? null;
  const dependencyBlockedTasks = useMemo(
    () => visibleTasks.filter((task) => task.canRun === false),
    [visibleTasks],
  );
  useEffect(() => {
    setDetailTab("overview");
    setDetailComment("");
    setDetailCommentAttachment(null);
    setDetailMoreOpen(false);
  }, [selectedId]);
  const diffFiles = useMemo(
    () => splitDiffFiles(selected?.merge?.diff),
    [selected?.merge?.diff],
  );
  const reviewableDiffFiles = useMemo(
    () => diffFiles.filter((file) => !isWorkspaceNoiseFile(file.path)),
    [diffFiles],
  );
  const hasOnlyWorkspaceNoise =
    selected?.merge?.state === "ready" &&
    diffFiles.length > 0 &&
    reviewableDiffFiles.length === 0;
  const reviewedEmptyDiff =
    selected?.merge?.state === "empty" &&
    selected?.merge?.source === "merge-preview";
  const diffFileSummaries = useMemo(
    () => diffFiles.map(summarizeDiffFile),
    [diffFiles],
  );
  const activeDiff = diffFileSummaries[activeDiffFile] ?? diffFileSummaries[0];
  const activeDiffRows = useMemo(
    () => parseUnifiedDiff(activeDiff?.lines),
    [activeDiff],
  );
  const diffTotals = useMemo(
    () => diffFileSummaries.reduce((total, file) => ({
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
      reviewable: total.reviewable + (file.noise ? 0 : 1),
    }), { additions: 0, deletions: 0, reviewable: 0 }),
    [diffFileSummaries],
  );
  useEffect(() => {
    setActiveDiffFile(0);
  }, [selected?.id, selected?.merge?.diff]);
  const hasRunningTask = tasks.some((task) => task.codex?.state === "running");
  const executionEvents = selected?.execution?.events || [];
  const summarizedExecutionEvents = useMemo(
    () => summarizeExecutionEvents(executionEvents),
    [executionEvents],
  );
  const activityItems = useMemo(
    () => {
      const items = (selected?.comments || []).map((comment) => ({ type: "comment", at: comment.createdAt, comment }));
      const verification = currentVerification(selected);
      if (verification)
        items.push({ type: "verification", at: selected?.evidence?.verifiedAt, verification });
      if (["release-committed", "merged"].includes(selected?.merge?.state))
        items.push({ type: "merge", at: selected?.merge?.committedAt || selected?.merge?.mergedAt || selected?.merge?.preparedAt, merge: selected.merge });
      return items
        .filter((item) => item.at)
        .sort((left, right) => `${right.at}`.localeCompare(`${left.at}`))
        .slice(0, 4);
    },
    [selected?.comments, selected?.evidence?.verifiedAt, selected?.evidence?.verification, selected?.merge],
  );
  const selectedRelease = selected?.versionId
    ? releases.find((release) => release.id === selected.versionId)
    : null;
  const selectedApiOptions = (selectedRelease?.apifox?.definitions || []).map((api) => ({
    value: `${api.method} ${api.path}`,
    label: `${api.method} ${api.path}${api.summary ? ` · ${api.summary}` : ""}`,
  }));

  useEffect(() => {
    setTaskApiNotes(selected?.apiNotes || "");
  }, [selected?.id, selected?.apiNotes]);

  const refreshTasks = async () => {
    const response = await fetch("/api/tasks");
    const data = await response.json();
    setTasks(data.tasks);
    setTasksLoaded(true);
    if (selectedId && !data.tasks.some((task) => task.id === selectedId))
      setSelectedId(null);
  };
  const refreshProjects = async () => {
    const response = await fetch("/api/projects");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    setProjects(data.projects);
    setProject(data.active);
  };
  const refreshReleases = async (projectPath = project?.path) => {
    const requestId = ++releaseRequestRef.current;
    const response = await fetch(
      `/api/releases?projectPath=${encodeURIComponent(projectPath || "")}`,
    );
    const data = await response.json();
    if (requestId === releaseRequestRef.current)
      setReleases(data.releases || []);
  };
  const refreshReleaseStages = async (projectPath = project?.path) => {
    const requestId = ++releaseStageRequestRef.current;
    const response = await fetch(
      `/api/release-stages?projectPath=${encodeURIComponent(projectPath || "")}`,
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取研发阶段失败");
    if (requestId === releaseStageRequestRef.current)
      setReleaseStages(data.stages || []);
  };
  const refreshTaskStages = async (projectPath = project?.path) => {
    const requestId = ++taskStageRequestRef.current;
    const response = await fetch(
      `/api/task-stages?projectPath=${encodeURIComponent(projectPath || "")}`,
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取任务阶段失败");
    if (requestId === taskStageRequestRef.current)
      setTaskStages(data.stages || []);
  };
  const refreshQueue = async () => {
    const response = await fetch("/api/queue");
    if (response.ok) setQueue(await response.json());
  };
  useEffect(() => {
    let disposed = false;
    let retryTimer;
    const loadTasks = async () => {
      try {
        await refreshTasks();
        if (!disposed) setInitialDataUnavailable(false);
      } catch {
        if (disposed) return;
        setInitialDataUnavailable(true);
        retryTimer = window.setTimeout(loadTasks, 3_000);
      }
    };
    loadTasks();
    refreshProjects().catch(() => setToast("无法读取真实 Git 项目。"));
    refreshQueue().catch(() => {});
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
    };
  }, [initialDataRetry]);
  useEffect(() => {
    if (project?.path && !allProjects) {
      refreshReleases(project.path).catch(() => {});
      refreshReleaseStages(project.path).catch(() => {});
      refreshTaskStages(project.path).catch(() => {});
    }
  }, [project?.path, allProjects]);
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("tasks", () => {
      refreshTasks().catch(() => {});
      refreshQueue().catch(() => {});
    });
    return () => source.close();
  }, []);
  useEffect(() => {
    if (!resizingInspector) return undefined;
    const move = (event) =>
      setInspectorWidth(
        Math.min(900, Math.max(560, window.innerWidth - event.clientX)),
      );
    const stop = () => setResizingInspector(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [resizingInspector]);
  const runAction = async (id, action, success) => {
    const response = await fetch(`/api/tasks/${id}/${action}`, {
      method: "POST",
    });
    const data = await response.json();
    if (!response.ok) {
      setToast(data.error);
      return false;
    }
    setTasks(data.tasks);
    setToast(success);
    return true;
  };
  const openDiffReview = async (task) => {
    const response = await fetch(`/api/tasks/${task.id}/merge-preview`, {
      method: "POST",
    });
    const data = await response.json();
    if (!response.ok) return setToast(data.error || "无法生成真实 diff");
    setTasks(data.tasks);
    setSelectedId(task.id);
    setActiveDiffFile(0);
    setDiffReviewOpen(true);
  };
  const openWorktree = async (task) => {
    const response = await fetch(`/api/tasks/${task.id}/open-worktree`, { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return setToast(data.error || "打开分支工作区失败。");
    setTasks(data.tasks || []);
    setToast(data.message || "已打开分支工作区。");
  };
  const updateReleaseStage = async (id, stage) => {
    const response = await fetch(`/api/releases/${id}/stage`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage }),
    });
    const data = await response.json();
    if (!response.ok) return setToast(data.error || "更新阶段失败");
    await refreshReleases();
    setToast(`版本已推进到「${stage}」`);
  };
  const createRelease = async () => {
    const response = await fetch("/api/releases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...releaseDraft, projectPath: project?.path }),
    });
    const data = await response.json();
    if (!response.ok) return setToast(data.error || "创建版本失败");
    setReleaseOpen(false);
    setReleaseDraft({
      name: "",
      goal: "",
      startDate: "",
      releaseDate: "",
    });
    await refreshReleases();
    setToast(`已创建版本 ${data.release.name}`);
  };
  const openReleaseEditor = (release) => {
    setReleaseEditDraft({
      name: release.name,
      goal: release.goal || "",
      startDate: release.startDate || "",
      releaseDate: release.releaseDate || "",
    });
    setEditingRelease(release);
  };
  const openReleaseWorkspace = (release) => {
    setReleaseWorkspaceOpen(release);
    setAnalysisDraftDirty(false);
    const savedPerspectives = Array.isArray(release.prdAnalysis?.perspectives)
      ? release.prdAnalysis.perspectives
      : `${release.prdAnalysis?.perspective || "前端开发"}`.split("、").filter(Boolean);
    setAnalysisPerspectives(savedPerspectives.length ? savedPerspectives : ["前端开发"]);
    const savedRoles = Array.isArray(release.prdAnalysis?.deliveryRoles)
      ? release.prdAnalysis.deliveryRoles
      : savedPerspectives.includes("后端开发")
        ? ["前端专家", "后端专家"]
        : ["前端专家"];
    setAnalysisDeliveryRoles(savedRoles.length ? savedRoles : ["前端专家"]);
    setAnalysisFeedback(release.prdAnalysis?.feedback || "");
    setPrdViewMode("edit");
    setAttachmentPreview(null);
    setReleaseWorkspaceDraft({
      prd: release.prd || "",
      attachments: release.attachments || [],
      taskStages: taskStages.length ? taskStages : ["待澄清", "待设计", "待开发", "Codex 执行中", "待自测", "待复核", "待合并", "已完成", "已阻塞"],
      apifox: {
        ...(release.apifox || {}),
        useProjectConfig: release.apifox?.useProjectConfig !== false,
      },
    });
    setReviewItemDraft({
      title: "",
      type: "业务规则",
      owner: "",
      dueDate: "",
      impact: "普通",
    });
    setExpandedReviewConclusionId(null);
    if (project?.path) {
      fetch(`/api/projects/apifox?path=${encodeURIComponent(project.path)}`)
        .then((response) => response.json())
        .then((data) => {
          if (data && !data.error)
            setApifoxConfig((current) => ({ ...current, ...data, token: "" }));
        })
        .catch(() => {});
    }
  };
  const previewReleaseMerge = async () => {
    if (!releaseWorkspaceOpen) return;
    const response = await fetch(`/api/releases/${releaseWorkspaceOpen.id}/merge-preview`, { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return setToast(data.error || "生成版本变更审阅失败");
    setReleaseWorkspaceOpen(data.release);
    await refreshReleases();
    setToast(`已生成版本最终 diff：${data.release.merge?.diffStat || ""}`);
  };
  const mergeReleaseDelivery = () => confirmAction({
    title: `合并版本“${releaseWorkspaceOpen?.name || ""}”？`,
    content: `将版本分支 ${releaseWorkspaceOpen?.merge?.branch || ""} 合并到 ${releaseWorkspaceOpen?.merge?.targetBranch || "目标分支"}。`,
    onOk: async () => {
      const response = await fetch(`/api/releases/${releaseWorkspaceOpen.id}/merge`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return setToast(data.error || "版本合并失败");
      setReleaseWorkspaceOpen(data.release);
      // Keep the already-open task board in sync even when EventSource is
      // unavailable (for example inside the dedicated Codex iframe).
      if (data.tasks) {
        setTasks(data.tasks);
        setTasksLoaded(true);
      } else {
        await refreshTasks();
      }
      await refreshReleases();
      setToast("版本分支已合并到目标分支。");
    },
  });
  const refreshReleaseWorkspace = async (id) => {
    await refreshReleases();
    const response = await fetch(
      `/api/releases?projectPath=${encodeURIComponent(project?.path || "")}`,
    );
    const data = await response.json();
    const release = data.releases?.find((item) => item.id === id);
    if (release) openReleaseWorkspace(release);
  };
  const saveReleaseWorkspace = async () => {
    if (!releaseWorkspaceOpen) return;
    const response = await fetch(`/api/releases/${releaseWorkspaceOpen.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: releaseWorkspaceDraft }),
    });
    const data = await response.json();
    if (!response.ok) return setToast(data.error || "保存需求上下文失败");
    await refreshReleaseWorkspace(releaseWorkspaceOpen.id);
    setToast("版本需求与附件已保存；任务阶段统一使用项目配置。");
  };
  const pickReleaseAttachment = async (index) => {
    const response = await fetch("/api/context-files/pick", { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return setToast(data.error || "选择文件失败");
    const file = data.file;
    if (!file) return;
    setReleaseWorkspaceDraft((current) => ({
      ...current,
      attachments: current.attachments.map((item, itemIndex) =>
        itemIndex === index
          ? { ...item, name: file.name, url: file.path, type: file.type, content: file.content, extension: file.extension, truncated: file.truncated, previewable: file.previewable }
          : item,
      ),
    }));
  };
  const importAttachmentToPrd = (item) => {
    if (!item.content) return;
    setReleaseWorkspaceDraft((current) => ({
      ...current,
      prd: current.prd ? `${current.prd}\n\n${item.content}` : item.content,
    }));
    setToast(`已导入「${item.name}」到 PRD 编辑区。`);
  };
  const analysePrd = async () => {
    if (!releaseWorkspaceOpen) return;
    if (analysingPrd) return;
    setAnalysingPrd(true);
    setToast(`正在调用 Codex 从${analysisPerspectives.join("、")}视角分析，请稍候…`);
    try {
      await saveReleaseWorkspace();
      const response = await fetch(
        `/api/releases/${releaseWorkspaceOpen.id}/analyse-prd`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ perspectives: analysisPerspectives, deliveryRoles: analysisDeliveryRoles, feedback: analysisFeedback }),
          // Long Codex reasoning is valid for a full PRD. The browser waits
          // slightly longer than the server so it receives the final result
          // or the explicit 10-minute fallback instead of aborting early.
          signal: AbortSignal.timeout(615_000),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return setToast(data.error || "PRD 分析失败");
      await refreshReleaseWorkspace(releaseWorkspaceOpen.id);
      setAnalysisFeedback("");
      setAnalysisDraftDirty(false);
      setToast(
        data.degraded
          ? data.warning || "Codex 未返回，已生成可编辑的本地任务草稿。"
          : `已完成 Codex 分析；任务将只分配给${analysisDeliveryRoles.join("、")}。`,
      );
    } catch (error) {
      setToast(error?.name === "TimeoutError" ? "PRD 分析请求超时，请检查 Flight Deck 本地服务后重试。" : `PRD 分析失败：${error.message || error}`);
    } finally {
      setAnalysingPrd(false);
    }
  };
  const createTasksFromAnalysis = async () => {
    if (!releaseWorkspaceOpen?.prdAnalysis) return;
    if (analysisDraftDirty) {
      setToast("请先保存任务草稿，再创建任务。");
      return;
    }
    const selectedKeys = releaseWorkspaceOpen.prdAnalysis.proposals
      .filter((item) => item.selected !== false)
      .map((item) => item.key);
    if (!selectedKeys.length) return setToast("请至少选择一项任务草稿。");
    const createSelectedTasks = () =>
      confirmAction({
        title: `创建 ${selectedKeys.length} 项任务？`,
        content: "将创建当前已勾选的任务，并加入版本看板；任务不会自动启动。创建后可在本版本看板中批量删除未启动的 AI 分析任务。",
        onOk: async () => {
        const response = await fetch(
          `/api/releases/${releaseWorkspaceOpen.id}/create-tasks`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              selectedKeys,
              proposals: releaseWorkspaceOpen.prdAnalysis.proposals,
              projectPath: project?.path,
            }),
          },
        );
        const data = await response.json();
        if (!response.ok) return setToast(data.error || "创建任务失败");
        await refreshTasks();
        setReleaseWorkspaceOpen(null);
        setView("tasks");
        setToast(`已创建 ${data.tasks?.length || 0} 项任务；任务默认不会自动启动。`);
        },
      });
    const pendingReviewItems = (releaseWorkspaceOpen.reviewItems || []).filter(
      (item) => item.status === "待确认",
    );
    if (!pendingReviewItems.length) return createSelectedTasks();
    confirmAction({
      title: `仍有 ${pendingReviewItems.length} 项待确认问题`,
      content: `这些问题的结论可能影响任务范围、接口或验收标准。确认继续后，还会再次确认本次要创建的 ${selectedKeys.length} 项任务。`,
      onOk: createSelectedTasks,
    });
  };
  const openSelectedReleaseMerge = () => {
    if (!selectedRelease) return setToast("该任务没有关联版本，无法进行版本合并。");
    setView("releases");
    openReleaseWorkspace(selectedRelease);
  };
  const deleteReleaseAnalysisTasks = () => {
    if (!releaseWorkspaceOpen) return;
    const generatedTasks = tasksForRelease(releaseWorkspaceOpen.id).filter((task) =>
      releaseWorkspaceOpen.prdAnalysis?.proposals?.some((proposal) => proposal.createdTaskId === task.id),
    );
    if (!generatedTasks.length) return setToast("本版本没有可删除的 AI 分析任务。");
    confirmAction({
      title: `删除 ${generatedTasks.length} 项 AI 分析任务？`,
      content: "仅删除本次 PRD 分析创建且尚未启动的 Flight Deck 本地任务记录，不会删除项目文件、Git 分支或 worktree。",
      danger: true,
      onOk: async () => {
        const response = await fetch(
          `/api/releases/${releaseWorkspaceOpen.id}/analysis-tasks`,
          { method: "DELETE" },
        );
        const data = await response.json();
        if (!response.ok) return setToast(data.error || "删除任务失败");
        setTasks(data.tasks || []);
        await refreshReleaseWorkspace(releaseWorkspaceOpen.id);
        setToast(`已删除 ${data.deletedCount || 0} 项 AI 分析任务，草稿仍会保留。`);
      },
    });
  };
  const savePrdAnalysisDraft = async () => {
    if (!releaseWorkspaceOpen?.prdAnalysis) return;
    const hasChanges = analysisDraftDirty;
    const response = await fetch(
      `/api/releases/${releaseWorkspaceOpen.id}/prd-analysis`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposals: releaseWorkspaceOpen.prdAnalysis.proposals,
        }),
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return setToast(data.error || "保存任务草稿失败");
    setAnalysisDraftDirty(false);
    await refreshReleaseWorkspace(releaseWorkspaceOpen.id);
    setToast(hasChanges ? "任务草稿已保存。" : "任务草稿已是最新，已重新保存。 ");
  };
  const patchAnalysisProposal = (key, patch) => {
    setAnalysisDraftDirty(true);
    setReleaseWorkspaceOpen((current) => ({
      ...current,
      prdAnalysis: {
        ...current.prdAnalysis,
        proposals: current.prdAnalysis.proposals.map((item) =>
          item.key === key ? { ...item, ...patch } : item,
        ),
      },
    }));
  };
  const exportReleaseSchedule = () => {
    const release = releaseWorkspaceOpen;
    const proposals = release?.prdAnalysis?.proposals || [];
    if (!release || !proposals.length) return setToast("请先生成任务草稿，再导出排期。");
    const cell = (value) => `"${`${value || ""}`.replaceAll('"', '""')}"`;
    const rows = [
      ["版本", "任务", "是否纳入", "角色", "阶段", "计划开始", "计划结束", "任务说明", "验收标准"],
      ...proposals.map((item) => [release.name, item.title, item.selected === false ? "否" : "是", item.role, item.stage, item.startDate, item.endDate, item.goal, item.acceptance]),
    ];
    const blob = new Blob([`\uFEFF${rows.map((row) => row.map(cell).join(",")).join("\n")}`], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${release.name}-排期.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    setToast("版本排期已导出为 CSV。");
  };
  const importReleaseSchedule = async () => {
    if (!releaseWorkspaceOpen?.prdAnalysis) return;
    const response = await fetch("/api/context-files/pick", { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return setToast(data.error || "选择排期文件失败。");
    if (data.file?.extension !== ".csv")
      return setToast("请选择由“导出版本排期”生成的 CSV 文件。");
    const [header, ...rows] = parseCsvRows(data.file.content?.replace(/^\uFEFF/, "") || "");
    const requiredColumns = ["任务", "是否纳入", "角色", "阶段", "计划开始", "计划结束", "任务说明", "验收标准"];
    if (!header || requiredColumns.some((column) => !header.includes(column)))
      return setToast("排期文件表头不正确，请先使用“导出版本排期”生成模板。");
    const column = Object.fromEntries(header.map((name, index) => [name, index]));
    const importedByTitle = new Map(rows.map((row) => [row[column.任务]?.trim(), row]));
    let matched = 0;
    let unmatched = 0;
    setReleaseWorkspaceOpen((current) => ({
      ...current,
      prdAnalysis: {
        ...current.prdAnalysis,
        proposals: current.prdAnalysis.proposals.map((proposal) => {
          const row = importedByTitle.get(proposal.title);
          if (!row) {
            unmatched += 1;
            return proposal;
          }
          matched += 1;
          return {
            ...proposal,
            selected: row[column.是否纳入]?.trim() !== "否",
            role: row[column.角色]?.trim() || proposal.role,
            stage: row[column.阶段]?.trim() || proposal.stage,
            startDate: row[column.计划开始]?.trim() || "",
            endDate: row[column.计划结束]?.trim() || "",
            goal: row[column.任务说明]?.trim() || proposal.goal,
            acceptance: row[column.验收标准]?.trim() || proposal.acceptance,
          };
        }),
      },
    }));
    setAnalysisDraftDirty(true);
    setToast(`已导入排期：更新 ${matched} 项${unmatched ? `，${unmatched} 项未在文件中找到，保持原草稿` : ""}。请检查后保存任务草稿。`);
  };
  const addReviewItem = async () => {
    if (!releaseWorkspaceOpen) return;
    const response = await fetch(
      `/api/releases/${releaseWorkspaceOpen.id}/review-items`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reviewItemDraft),
      },
    );
    const data = await response.json();
    if (!response.ok) return setToast(data.error || "添加待确认项失败");
    await refreshReleaseWorkspace(releaseWorkspaceOpen.id);
  };
  const addAiReviewSuggestion = async (title) => {
    if (!releaseWorkspaceOpen) return;
    const exists = (releaseWorkspaceOpen.reviewItems || []).some(
      (item) => item.title === title,
    );
    if (exists) return setToast("该建议已在评审问题中。");
    const response = await fetch(
      `/api/releases/${releaseWorkspaceOpen.id}/review-items`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          type: "业务规则",
          impact: "普通",
        }),
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return setToast(data.error || "添加评审问题失败");
    await refreshReleaseWorkspace(releaseWorkspaceOpen.id);
    setToast("已转为待确认项。");
  };
  const updateReviewItem = async (item, patch) => {
    if (!releaseWorkspaceOpen) return;
    const response = await fetch(
      `/api/releases/${releaseWorkspaceOpen.id}/review-items/${item.id}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    if (!response.ok) return setToast("更新待确认项失败");
    await refreshReleaseWorkspace(releaseWorkspaceOpen.id);
  };
  const deleteReviewItem = async (item) => {
    if (!releaseWorkspaceOpen) return;
    confirmAction({
      title: "删除待确认项？",
      content: `将删除“${item.title}”，此操作不可撤销。`,
      danger: true,
      onOk: async () => {
        const response = await fetch(
          `/api/releases/${releaseWorkspaceOpen.id}/review-items/${item.id}`,
          { method: "DELETE" },
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return setToast(data.error || "删除待确认项失败");
        await refreshReleaseWorkspace(releaseWorkspaceOpen.id);
        setToast("待确认项已删除。");
      },
    });
  };
  const mergeSimilarReviewItems = async () => {
    if (!releaseWorkspaceOpen) return;
    const before = releaseWorkspaceOpen.reviewItems?.length || 0;
    const response = await fetch(
      `/api/releases/${releaseWorkspaceOpen.id}/review-items/merge-similar`,
      { method: "POST" },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return setToast(data.error || "合并相似问题失败");
    const after = data.release?.reviewItems?.length || before;
    await refreshReleaseWorkspace(releaseWorkspaceOpen.id);
    setToast(
      after < before ? `已合并 ${before - after} 条相似问题。` : "没有可合并的相似问题。",
    );
  };
  const updateTaskStage = async (task, taskStage) => {
    const response = await fetch(`/api/tasks/${task.id}/board-stage`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskStage }),
    });
    const data = await response.json();
    if (!response.ok) return setToast(data.error || "更新任务阶段失败");
    setTasks(data.tasks || []);
  };
  const syncApifox = async () => {
    if (!releaseWorkspaceOpen) return;
    const useProjectConfig =
      releaseWorkspaceDraft.apifox?.useProjectConfig !== false;
    const source = useProjectConfig
      ? apifoxConfig.projectId
      : releaseWorkspaceDraft.apifox?.url;
    if (!source) {
      setToast(
        useProjectConfig
          ? "当前项目还没有配置 Apifox，请先到项目设置完成配置。"
          : "请输入本版本要使用的 Apifox 项目或 OpenAPI 导出地址。",
      );
      return;
    }
    if (!apifoxToken && !apifoxConfig.configured) {
      setToast("请先配置项目级 Apifox Token，或粘贴仅用于本次同步的 Token。");
      return;
    }
    setApifoxSyncing(true);
    try {
      const response = await fetch(
        `/api/releases/${releaseWorkspaceOpen.id}/apifox/sync`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: source,
            token: apifoxToken,
            projectPath: project?.path,
          }),
        },
      );
      const data = await response.json();
      if (!response.ok) return setToast(data.error || "Apifox 同步失败");
      setApifoxToken("");
      await refreshReleaseWorkspace(releaseWorkspaceOpen.id);
      setToast(
        `已只读同步 ${data.release.apifox?.definitions?.length || 0} 个接口定义。`,
      );
    } finally {
      setApifoxSyncing(false);
    }
  };
  const openApifoxConfig = async () => {
    if (!project?.path) return;
    const response = await fetch(
      `/api/projects/apifox?path=${encodeURIComponent(project.path)}`,
    );
    const data = await response.json();
    if (!response.ok) return setToast(data.error || "读取 Apifox 配置失败");
    setApifoxConfig({ ...data, token: "" });
    setApifoxConfigOpen(true);
  };
  const saveApifoxConfig = async () => {
    const response = await fetch("/api/projects/apifox", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: project?.path,
        projectId: apifoxConfig.projectId,
        token: apifoxConfig.token,
      }),
    });
    const data = await response.json();
    if (!response.ok) return setToast(data.error || "保存 Apifox 配置失败");
    setApifoxConfig({ ...data, token: "" });
    setApifoxConfigOpen(false);
    setToast(
      data.configured
        ? "Apifox 配置已保存；Token 已安全写入本机钥匙串。"
        : "Project ID 已保存；同步前仍需配置 Token。",
    );
  };
  const loadKnowledge = async () => {
    if (!project?.path) return;
    const response = await fetch(
      `/api/knowledge?projectPath=${encodeURIComponent(project.path)}`,
    );
    const data = await response.json();
    setKnowledgeDocs(data.documents || []);
  };
  const openKnowledge = () => {
    setKnowledgeOpen(true);
    void loadKnowledge();
  };
  const saveKnowledge = async () => {
    const response = await fetch("/api/knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...knowledgeDraft,
        projectPath: project?.path,
        tags: knowledgeDraft.tags
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      }),
    });
    const data = await response.json();
    if (!response.ok) return setToast(data.error || "保存知识失败");
    setKnowledgeDraft({ title: "", content: "", source: "手动输入", tags: "" });
    await loadKnowledge();
    setToast("已本地向量化并保存知识条目。");
  };
  const saveKnowledgeRevision = async () => {
    if (!knowledgeVersionDoc) return;
    const response = await fetch(`/api/knowledge/${knowledgeVersionDoc.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: knowledgeVersionDoc.title,
        content: knowledgeVersionDoc.content,
        source: knowledgeVersionDoc.source,
        tags: knowledgeVersionDoc.tags,
      }),
    });
    const data = await response.json();
    if (!response.ok) return setToast(data.error || "保存新版本失败");
    await openKnowledgeVersions(data.document);
    await loadKnowledge();
    setToast(`已保存 ${data.document.title} v${data.document.version}`);
  };
  const searchKnowledge = async () => {
    if (!knowledgeQuery.trim()) return setKnowledgeResults([]);
    const response = await fetch(
      `/api/knowledge/search?projectPath=${encodeURIComponent(project?.path || "")}&q=${encodeURIComponent(knowledgeQuery)}`,
    );
    const data = await response.json();
    setKnowledgeResults(data.documents || []);
  };
  const removeKnowledge = async (id) => {
    await fetch(`/api/knowledge/${id}`, { method: "DELETE" });
    await loadKnowledge();
    setKnowledgeResults((items) => items.filter((item) => item.id !== id));
  };
  const openKnowledgeVersions = async (document) => {
    const [versionsResponse, documentResponse] = await Promise.all([
      fetch(`/api/knowledge/${document.id}/versions`),
      fetch(`/api/knowledge/${document.id}`),
    ]);
    const data = await versionsResponse.json();
    const documentData = await documentResponse.json();
    if (!versionsResponse.ok || !documentResponse.ok)
      return setToast(data.error || documentData.error || "无法读取知识版本");
    setKnowledgeVersionDoc(documentData.document);
    setKnowledgeVersions(data.versions || []);
    setKnowledgeComparison(null);
    setKnowledgeCompareFrom(`${data.versions?.[1]?.version || ""}`);
    setKnowledgeCompareTo(`${data.versions?.[0]?.version || ""}`);
  };
  const compareKnowledgeVersions = async (from, to) => {
    if (!knowledgeVersionDoc || !from || !to || from === to) return;
    const response = await fetch(
      `/api/knowledge/${knowledgeVersionDoc.id}/compare?from=${from}&to=${to}`,
    );
    const data = await response.json();
    if (!response.ok) return setToast(data.error || "无法比较知识版本");
    setKnowledgeComparison(data.comparison);
  };
  const removeKnowledgeVersion = async (version) => {
    if (!knowledgeVersionDoc) return;
    const response = await fetch(
      `/api/knowledge/${knowledgeVersionDoc.id}/versions/${version}`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      const data = await response.json();
      return setToast(data.error || "删除版本失败");
    }
    await openKnowledgeVersions(knowledgeVersionDoc);
    await loadKnowledge();
    setToast(`已删除 v${version}`);
  };
  const saveReleaseEdit = async () => {
    if (!editingRelease) return;
    const response = await fetch(`/api/releases/${editingRelease.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(releaseEditDraft),
    });
    const data = await response.json();
    if (!response.ok) return setToast(data.error || "保存版本失败");
    setEditingRelease(null);
    await refreshReleases();
    setToast(`已更新版本 ${data.release.name}`);
  };
  const deleteRelease = async (release) => {
    confirmAction({
      title: `删除版本“${release.name}”？`,
      content: "仅无关联任务的版本可删除。",
      danger: true,
      onOk: async () => {
        const response = await fetch(`/api/releases/${release.id}`, { method: "DELETE" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return setToast(data.error || "删除版本失败");
        if (releaseWorkspaceOpen?.id === release.id) setReleaseWorkspaceOpen(null);
        if (editingRelease?.id === release.id) setEditingRelease(null);
        await refreshReleases();
        setToast(`已删除版本 ${release.name}`);
      },
    });
  };
  const visibleReleaseStages = releaseStages.filter((stage) => stage.visible);
  const boardReleaseStages = useMemo(() => {
    if (showEmptyReleaseStages) return visibleReleaseStages;
    const populated = visibleReleaseStages.filter((stage) =>
      releases.some((release) => release.stage === stage.name),
    );
    return populated.length ? populated : [visibleReleaseStages[0]].filter(Boolean);
  }, [releases, showEmptyReleaseStages, visibleReleaseStages]);
  const visibleTaskStages = taskStages.length
    ? taskStages
    : ["待澄清", "待设计", "待开发", "待复核", "已完成", "已阻塞"];
  const boardTaskStages = useMemo(() => {
    if (showEmptyTaskStages) return visibleTaskStages;
    const populated = visibleTaskStages.filter((stage) =>
      visibleTasks.some((task) => (task.taskStage || "待开发") === stage),
    );
    return populated.length ? populated : [visibleTaskStages[0] || "待开发"];
  }, [showEmptyTaskStages, visibleTaskStages, visibleTasks]);
  const openReleaseStageSettings = () => {
    setReleaseStageDraft(releaseStages.map((stage) => ({ ...stage })));
    setNewReleaseStage("");
    setReleaseStageSettingsOpen(true);
  };
  const openTaskStageSettings = () => {
    setTaskStageDraft([...visibleTaskStages]);
    setNewTaskStage("");
    setTaskStageSettingsOpen(true);
  };
  const isSystemTaskStage = (stage) => [
    "Codex 执行中", "待自测", "待复核", "待合并", "已完成", "已阻塞",
  ].includes(stage);
  const saveTaskStages = async () => {
    const response = await fetch("/api/task-stages", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: project?.path || "", stages: taskStageDraft }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return setToast(data.error || "保存任务阶段失败");
    setTaskStages(data.stages || []);
    setTaskStageSettingsOpen(false);
    if (releaseWorkspaceOpen) {
      setReleaseWorkspaceDraft((draft) => ({ ...draft, taskStages: data.stages || [] }));
    }
    setToast("项目任务阶段已保存。");
  };
  const moveReleaseStage = (index, direction) => {
    const target = index + direction;
    if (target < 0 || target >= releaseStageDraft.length) return;
    setReleaseStageDraft((stages) => {
      const next = [...stages];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };
  const saveReleaseStages = async () => {
    const response = await fetch("/api/release-stages", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: project?.path || "",
        stages: releaseStageDraft,
      }),
    });
    const data = await response.json();
    if (!response.ok) return setToast(data.error || "保存研发阶段失败");
    setReleaseStages(data.stages || []);
    setReleaseStageSettingsOpen(false);
    await refreshReleases();
    setToast("研发阶段已更新：看板、列表和甘特图已同步。");
  };
  const tasksForRelease = (releaseId) =>
    tasks.filter((task) => task.versionId === releaseId);
  const releaseRange = useMemo(() => {
    const today = new Date();
    const dated = releases
      .flatMap((release) => [release.startDate, release.releaseDate])
      .filter(Boolean)
      .map((value) => new Date(`${value}T00:00:00`));
    const start = new Date(
      Math.min(...(dated.length ? dated.map(Number) : [today.getTime()])),
    );
    start.setDate(1);
    const end = new Date(
      Math.max(...(dated.length ? dated.map(Number) : [today.getTime()])),
    );
    end.setMonth(
      end.getMonth() +
        (ganttScale === "day" ? 1 : ganttScale === "week" ? 2 : 3),
      1,
    );
    return {
      start,
      end,
      days: Math.max(1, Math.ceil((end - start) / 86400000)),
    };
  }, [releases, ganttScale]);
  const releaseBarStyle = (release) => {
    const start = new Date(
      `${release.startDate || release.createdAt?.slice(0, 10) || new Date().toISOString().slice(0, 10)}T00:00:00`,
    );
    const end = new Date(
      `${release.releaseDate || release.startDate || new Date().toISOString().slice(0, 10)}T00:00:00`,
    );
    const left = Math.max(
      0,
      ((start - releaseRange.start) / 86400000 / releaseRange.days) * 100,
    );
    const width = Math.max(
      3,
      Math.min(
        100 - left,
        (Math.max(1, (end - start) / 86400000 + 1) / releaseRange.days) * 100,
      ),
    );
    return { left: `${left}%`, width: `${width}%` };
  };
  const approvePlan = () =>
    runAction(
      selected.id,
      "approve",
      project?.executionMode === "worktree"
        ? "计划已批准，任务将在独立 worktree 中执行。"
        : "计划已批准，任务会在共享工作目录中执行。请先确认本地改动。 ",
    );
  const launchTask = async () => {
    setLaunching(true);
    const response = await fetch(`/api/tasks/${selected.id}/launch`, {
      method: "POST",
    });
    const data = await response.json();
    setLaunching(false);
    if (!response.ok) return setToast(data.error);
    setTasks(data.tasks);
    setToast(`Codex 已启动 · 会话 ${data.task.codex.threadId.slice(0, 8)}`);
  };
  const requestChanges = () => {
    if (selected.codex?.workspacePath) {
      setRevisionFeedback("");
      setRevisionOpen(true);
      return;
    }
    setTaskPlanDraft({
      title: selected.title,
      role: selected.role,
      taskStage: selected.taskStage || "待开发",
      versionId: selected.versionId || "",
      deliveryMode: selected.deliveryMode || "task",
      noCodeReason: selected.noCodeReason || "",
      priority: selected.priority || "普通",
      startDate: selected.startDate || "",
      endDate: selected.endDate || "",
      description: selected.description || "",
      acceptance: selected.acceptance || "",
      apiKeys: (selected.apiLinks || []).map((api) => api.key),
      apiNotes: selected.apiNotes || "",
    });
    setTaskPlanEditorOpen(true);
  };
  const saveTaskPlan = async () => {
    if (!selected || !taskPlanDraft?.title.trim() || !taskPlanDraft.description.trim())
      return setToast("请填写任务名称和任务目标。");
    setRevising(true);
    const response = await fetch(`/api/tasks/${selected.id}/plan`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(taskPlanDraft),
    });
    const data = await response.json();
    setRevising(false);
    if (!response.ok) return setToast(data.error || "保存任务计划失败。");
    setTasks(data.tasks);
    setTaskPlanEditorOpen(false);
    setTaskPlanDraft(null);
    setToast("任务计划已更新；启动时 Codex 会使用这份最新定义。 ");
  };
  const saveTaskProperties = async (changes) => {
    if (!selected) return;
    setSavingDetail(true);
    const response = await fetch(`/api/tasks/${selected.id}/properties`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: selected.role,
        taskStage: selected.taskStage,
        versionId: selected.versionId,
        startDate: selected.startDate,
        endDate: selected.endDate,
        priority: selected.priority || "普通",
        ...changes,
      }),
    });
    const data = await response.json().catch(() => ({}));
    setSavingDetail(false);
    if (!response.ok) return setToast(data.error || "保存任务属性失败。");
    setTasks(data.tasks || []);
    setToast("任务属性已保存。");
  };
  const pickDetailCommentAttachment = async () => {
    const response = await fetch("/api/context-files/pick", { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return setToast(data.error || "选择附件失败。");
    if (data.file) setDetailCommentAttachment(data.file);
  };
  const submitDetailComment = async (requestRevision = false) => {
    if (!selected || !detailComment.trim()) return;
    const comment = detailComment.trim();
    const canRevise = requestRevision && Boolean(selected.codex?.workspacePath);
    setSavingDetail(true);
    const response = await fetch(`/api/tasks/${selected.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: comment, attachment: detailCommentAttachment }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setSavingDetail(false);
      return setToast(data.error || "发布讨论失败。");
    }
    setTasks(data.tasks || []);
    setDetailComment("");
    setDetailCommentAttachment(null);
    if (canRevise) {
      const revisionResponse = await fetch(`/api/tasks/${selected.id}/revise`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: comment }),
      });
      const revisionData = await revisionResponse.json().catch(() => ({}));
      if (!revisionResponse.ok) {
        setSavingDetail(false);
        return setToast(`讨论已发布；未能启动修改：${revisionData.error || "请稍后重试。"}`);
      }
      setTasks(revisionData.tasks || []);
      setToast("讨论已发布，Codex 正在按这条意见增量修改。");
      setSavingDetail(false);
      return;
    }
    setToast("讨论已发布。");
    setSavingDetail(false);
  };
  const deleteDetailComment = async (commentId) => {
    if (!selected) return;
    const response = await fetch(`/api/tasks/${selected.id}/comments/${commentId}`, { method: "DELETE" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return setToast(data.error || "删除讨论失败。");
    setTasks(data.tasks || []);
    setToast("讨论已删除。");
  };
  const runScheduledTasks = () => {
    const today = dayjs().format("YYYY-MM-DD");
    const eligible = tasks.filter(
      (task) => task.canRun && ["待开始", "计划中"].includes(task.status) && task.startDate && task.startDate <= today && task.codex?.state !== "running",
    );
    if (!eligible.length)
      return setToast("当前没有到计划开始日期且依赖已满足的任务。未排期或依赖未满足的任务会跳过。");
    confirmAction({
      title: `按计划启动 ${eligible.length} 项任务？`,
      content: `只会启动已到开始日期、依赖已满足且尚未执行的任务；当前并发上限为 ${queue.concurrency}，剩余可启动 ${queue.capacity} 项。未排期、未到期或等待依赖的任务会保留。`,
      onOk: async () => {
        const response = await fetch("/api/queue/run-schedule", { method: "POST" });
        const data = await response.json();
        if (!response.ok) return setToast(data.error || "按计划启动失败。");
        setTasks(data.tasks || []);
        if (data.queue) setQueue(data.queue);
        setToast(data.started ? `已按计划启动 ${data.started} 项任务。` : "当前并行额度已满，未启动新的任务。");
      },
    });
  };
  const submitRevision = async () => {
    const feedback = revisionFeedback.trim();
    if (!feedback) return setToast("请描述需要修改的问题。");
    setRevising(true);
    const response = await fetch(`/api/tasks/${selected.id}/revise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback }),
    });
    const data = await response.json();
    setRevising(false);
    if (!response.ok) return setToast(data.error || "无法启动增量修改。");
    setTasks(data.tasks);
    setRevisionOpen(false);
    setToast("已在原 worktree 启动增量修改，已有代码和验证记录会保留。");
  };
  const acceptDelivery = () =>
    runAction(
      selected.id,
      "accept",
      "交付已接受；所有依赖它的任务会重新检查门禁。",
    );
  const openFirstDependencyBlocker = () => {
    const firstBlockedTask = dependencyBlockedTasks[0];
    if (!firstBlockedTask) return;
    setQueueControlOpen(false);
    setView("tasks");
    setTaskViewMode("list");
    setSelectedId(firstBlockedTask.id);
  };
  const runVerification = () =>
    runAction(
      selected.id,
      "verify",
      "已运行项目的真实验证命令，结果已写入交付证据。",
    );
  const saveTaskInterfaces = async (apiKeys, apiNotes = taskApiNotes) => {
    if (!selected) return;
    setSavingTaskInterfaces(true);
    const response = await fetch(`/api/tasks/${selected.id}/interfaces`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKeys, apiNotes }),
    });
    const data = await response.json().catch(() => ({}));
    setSavingTaskInterfaces(false);
    if (!response.ok) return setToast(data.error || "保存接口上下文失败。");
    setTasks(data.tasks || []);
    setToast("接口与联调上下文已保存，启动 Codex 时会一并带入。 ");
  };
  const retryTask = () =>
    runAction(
      selected.id,
      "retry",
      "已加入重试队列；会沿用原任务规则与 worktree。 ",
    );
  const stopCodexTask = async () => {
    confirmAction({
      title: "停止当前 Codex 执行？",
      content: "已写入任务 worktree 的代码变更和执行日志会保留，不会自动合并到主项目。",
      onOk: () => runAction(
        selected.id,
        "stop",
        "Codex 已停止；已有 worktree 变更已保留，可修改计划后重新执行。",
      ),
    });
  };
  const launchPreview = async () => {
    const response = await fetch(`/api/tasks/${selected.id}/preview`, {
      method: "POST",
    });
    const data = await response.json();
    if (!response.ok) return setToast(data.error);
    setTasks(data.tasks);
    window.open(data.task.preview.url, "_blank", "noopener,noreferrer");
    setToast("任务预览已启动，可点击“打开当前预览”。");
  };
  const previewMerge = async () => {
    const success = await runAction(
      selected.id,
      "merge-preview",
      "已生成真实 Git diff；确认后可合并到目标分支。",
    );
    if (success) {
      setActiveDiffFile(0);
      setDiffReviewOpen(true);
    }
  };
  const inspectTaskDiff = async () => {
    const response = await fetch(`/api/tasks/${selected.id}/diff`, { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return setToast(data.error || "读取代码变更失败");
    setTasks(data.tasks || []);
    setActiveDiffFile(0);
    setDiffReviewOpen(true);
  };
  const mergeDelivery = () =>
    runAction(
      selected.id,
      "merge",
      `已安全合并到 ${selected.merge?.targetBranch || "目标分支"}，任务 worktree 已保留。`,
    );
  const cleanupMergedWorktree = () => {
    if (!selected) return;
    confirmAction({
      title: "清理已合并的 worktree？",
      content: "将移除这个任务的独立 worktree 目录并清理 Git 注册记录。不会删除 main、已合并代码、任务分支或交付记录；若 worktree 仍有未提交改动，系统会拒绝清理。",
      danger: true,
      onOk: async () => {
        const response = await fetch(`/api/tasks/${selected.id}/worktree/cleanup`, { method: "POST" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return setToast(data.error || "清理 worktree 失败。");
        setTasks(data.tasks || []);
        setToast("已清理该任务的 worktree；交付记录仍保留。");
      },
    });
  };
  const deleteSelectedTask = () => {
    if (!selected) return;
    const hasExecutionHistory = Boolean(
      selected.codex?.workspacePath ||
      selected.codex?.threadId ||
      (selected.execution?.events || []).length > 0 ||
      ["执行中", "已完成"].includes(selected.status),
    );
    // Snapshot the target before the confirmation opens. A task event or a
    // project switch must not make the confirm button operate on stale detail.
    setTaskDeletion({
      id: selected.id,
      title: selected.title,
      hasExecutionHistory,
    });
  };
  const confirmTaskDeletion = async () => {
    if (!taskDeletion || deletingTask) return;
    setDeletingTask(true);
    try {
      const response = await fetch(
        `/api/tasks/${taskDeletion.id}${taskDeletion.hasExecutionHistory ? "?force=true" : ""}`,
        { method: "DELETE" },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setToast(data.error || "删除任务失败，请稍后重试。");
        return;
      }
      setTasks(data.tasks || []);
      setSelectedId(null);
      setTaskDeletion(null);
      setToast("任务已从 Flight Deck 本地记录中删除。");
    } catch {
      setToast("删除请求未完成，请检查本地 Flight Deck 服务后重试。");
    } finally {
      setDeletingTask(false);
    }
  };
  const createDelivery = async () => {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...draft,
        deliveryMode: quickMode ? "direct" : draft.deliveryMode,
        projectPath: project?.path,
        targetBranch: project?.branch,
      }),
    });
    const data = await response.json();
    if (!response.ok) return setToast(data.error);
    await refreshTasks();
    setSelectedId(data.task.id);
    setView("tasks");
    setComposerOpen(false);
    setComposerStep(1);
    setDraft({
      title: "",
      goal: "",
      role: "全栈工程师",
      acceptance: "",
      context: "支付 API、现有测试与项目约定",
      dependencies: [],
      mergeMode: "manual",
      versionId: "",
      deliveryMode: "task",
      noCodeReason: "",
    });
    setQuickMode(false);
    setToast(`已创建 ${data.task.role} 任务，等待你确认计划。`);
  };
  const openPolicy = () => {
    setPolicyDraft(
      project?.policy || {
        rules: "",
        standards: "",
        skills: [],
        verificationCommand: "",
      },
    );
    setPolicyOpen(true);
    if (project?.path)
      fetch(`/api/projects/discover?path=${encodeURIComponent(project.path)}`)
        .then((response) => response.json())
        .then(setDiscovery)
        .catch(() => {});
  };
  const toggleQueue = async () => {
    setQueueUpdating(true);
    const response = await fetch("/api/queue/toggle", { method: "POST" });
    const data = await response.json();
    setQueueUpdating(false);
    if (!response.ok) return setToast(data.error);
    setQueue(data);
    setToast(
      data.paused
        ? "执行队列已暂停；运行中任务不会被中断。"
        : "执行队列已恢复。",
    );
  };
  const updateQueueConcurrency = async (concurrency) => {
    setQueueUpdating(true);
    const response = await fetch("/api/queue", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ concurrency }),
    });
    const data = await response.json();
    setQueueUpdating(false);
    if (!response.ok) return setToast(data.error || "更新并发设置失败。");
    setQueue(data);
    setToast(`并发上限已调整为 ${data.concurrency} 项。`);
  };
  const pauseQueueAndRunningTasks = () => confirmAction({
    title: `暂停队列并停止 ${queue.running} 项进行中任务？`,
    content: "后续任务不会再启动；当前正在运行的 Codex 会话会被安全停止。每个任务已写入 worktree 的代码和日志都会保留，之后可在执行队列中逐项重新启动。",
    danger: true,
    onOk: async () => {
      setQueueUpdating(true);
      const response = await fetch("/api/queue/pause-running", { method: "POST" });
      const data = await response.json();
      setQueueUpdating(false);
      if (!response.ok) return setToast(data.error || "暂停进行中任务失败。");
      setQueue(data.queue);
      setTasks(data.tasks || []);
      setToast(`执行队列已暂停；已停止 ${data.stoppedIds?.length || 0} 项任务，可随时恢复。`);
    },
  });
  const stopQueueTask = (task) => confirmAction({
    title: `暂停「${task.title}」？`,
    content: "会立即停止该任务的 Codex 会话，但已写入 worktree 的代码和日志会保留。之后可从执行队列重新启动。",
    danger: true,
    onOk: async () => {
      const response = await fetch(`/api/tasks/${task.id}/stop`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) return setToast(data.error || "暂停任务失败。");
      setTasks(data.tasks || []);
      await refreshQueue();
      setToast(`已暂停 ${task.id}；worktree 变更已保留。`);
    },
  });
  const restartQueueTask = async (task) => {
    const response = await fetch(`/api/tasks/${task.id}/launch`, { method: "POST" });
    const data = await response.json();
    if (!response.ok) return setToast(data.error || "重新启动失败。");
    setTasks(data.tasks || []);
    await refreshQueue();
    setToast(`已重新启动 ${task.id}。`);
  };
  const savePolicy = async () => {
    if (!project?.path) {
      setToast("请先选择一个项目，再保存项目规则。");
      return;
    }
    setSavingPolicy(true);
    try {
      const response = await fetch("/api/projects/policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: project.path, ...policyDraft }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "项目规则保存失败，请稍后重试。");
      }
      if (!data.project) {
        throw new Error("项目规则保存失败：服务未返回项目数据。");
      }
      setProject(data.project);
      setProjects((items) =>
        items.map((item) =>
          item.path === data.project.path ? data.project : item,
        ),
      );
      setPolicyOpen(false);
      setToast("项目规则已保存；新创建的任务会使用这份规则快照。");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "项目规则保存失败，请稍后重试。");
    } finally {
      setSavingPolicy(false);
    }
  };
  const addProject = async () => {
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath }),
    });
    const data = await response.json();
    if (!response.ok) return setToast(data.error);
    await refreshProjects();
    setProjectModalOpen(false);
    setProjectPath("");
    setToast(`已添加真实项目：${data.project.name}`);
  };
  const chooseProject = async (path) => {
    const response = await fetch("/api/projects/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const data = await response.json();
    if (!response.ok) return setToast(data.error);
    setProject(data.project);
    setAllProjects(false);
    setSelectedId(null);
    setReleaseWorkspaceOpen(null);
    setEditingRelease(null);
    setToast(`当前项目：${data.project.name}`);
  };
  const pickProjectFolder = async () => {
    setProjectPicking(true);
    try {
      const response = await fetch("/api/projects/pick", { method: "POST" });
      const data = await response.json();
      if (!response.ok) return setToast("未选择文件夹。");
      setProjectPath(data.path);
      const discoveryResponse = await fetch(
        `/api/projects/discover?path=${encodeURIComponent(data.path)}`,
      );
      if (discoveryResponse.ok) setDiscovery(await discoveryResponse.json());
    } catch {
      setToast("无法打开文件夹选择器，请稍后重试。");
    } finally {
      setProjectPicking(false);
    }
  };
  const openProjectPicker = () => {
    setProjectPath("");
    setDiscovery({ contextFiles: [], scripts: [], skills: [] });
    setProjectModalOpen(true);
  };

  const projectTasks = tasks.filter(
    (task) => allProjects || task.projectPath === project?.path,
  );
  const confirmedReviewCount = (releaseWorkspaceOpen?.reviewItems || []).filter(
    (item) => item.status === "已确认" && item.conclusion,
  ).length;
  const isDark =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const antTheme = {
    algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: isDark ? "#7aa2ff" : "#2f6feb",
      colorBgBase: isDark ? "#1b1d20" : "#f7f8fa",
      colorBgContainer: isDark ? "#242629" : "#ffffff",
      colorBgElevated: isDark ? "#2a2d31" : "#ffffff",
      colorText: isDark ? "#eceef1" : "#1f2937",
      colorTextSecondary: isDark ? "#a7adb8" : "#64748b",
      colorBorder: isDark ? "#3a3d43" : "#d9e2ef",
      borderRadius: 8,
      controlHeight: 36,
      fontSize: 13,
    },
  };
  if (!tasksLoaded)
    return (
      <div className="app-shell">
        <section className="workspace">
          <header className="topbar">
            <div className="project">
              {initialDataUnavailable ? "本地服务暂不可用，正在重试…" : "正在读取本地任务数据…"}
            </div>
          </header>
          <main className="empty">
            <p>{initialDataUnavailable ? "任务服务连接中断；恢复后会自动继续加载。" : "正在加载 Flight Deck…"}</p>
            {initialDataUnavailable && <Button size="small" onClick={() => setInitialDataRetry((value) => value + 1)}>立即重试</Button>}
          </main>
        </section>
      </div>
    );
  return (
    <ConfigProvider theme={antTheme}>
      <div className="app-shell theme-system">
        <section className="workspace">
          <header className="topbar">
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  { key: "all", label: "全部项目" },
                  { type: "divider" },
                  ...projects.map((item) => ({ key: `project:${item.path}`, label: item.name })),
                  { type: "divider" },
                  { key: "add", label: "添加项目" },
                  { key: "policy", label: "项目规则与 Skills" },
                  { key: "knowledge", label: "本地知识库" },
                  { key: "apifox", label: "Apifox 配置" },
                ],
                selectedKeys: [allProjects ? "all" : `project:${project?.path || ""}`],
                onClick: ({ key }) => {
                  if (key === "all") {
                    setAllProjects(true);
                    setSelectedId(null);
                    setReleaseWorkspaceOpen(null);
                    refreshReleases("").catch(() => {});
                    return;
                  }
                  if (key.startsWith("project:")) return chooseProject(key.slice(8));
                  if (key === "add") return openProjectPicker();
                  if (key === "policy") return openPolicy();
                  if (key === "knowledge") return openKnowledge();
                  if (key === "apifox") return openApifoxConfig();
                },
              }}
            >
              <Button className="project-trigger" title={allProjects ? "显示所有项目任务" : project?.path}>
                {allProjects ? "全部项目" : project?.name || "正在读取项目…"}
                {!allProjects && project?.branch ? ` · ${project.branch}` : ""}
              </Button>
            </Dropdown>
            <Tabs
              className="top-tabs"
              activeKey={view}
              onChange={setView}
              items={[
                { key: "tasks", label: "任务" },
                { key: "releases", label: <span>版本 <Badge count={releases.length} showZero size="small" /></span> },
              ]}
            />
          </header>
          {view === "tasks" && (
            <main
              className={`content ${selected ? "with-inspector" : ""}`}
              style={
                selected
                  ? { "--inspector-width": `${inspectorWidth}px` }
                  : undefined
              }
            >
              <section className="task-list">
                <div className="list-heading">
                  <div>
                    <h1>
                      任务 <span>{visibleTasks.length}</span>
                    </h1>
                    <p>把需求变成可验证的 Codex 交付。</p>
                  </div>
                  <div className="list-actions">
                    <div className="task-view-switch" role="group" aria-label="任务展示方式">
                      <button className={taskViewMode === "board" ? "active" : ""} onClick={() => setTaskViewMode("board")}>看板</button>
                      <button className={taskViewMode === "list" ? "active" : ""} onClick={() => setTaskViewMode("list")}>列表</button>
                    </div>
                    <button
                      className="primary create-delivery"
                      onClick={() => {
                        setQuickMode(false);
                        setComposerStep(1);
                        setComposerOpen(true);
                      }}
                    >
                      + 新建交付
                    </button>
                    <button
                      className="outline quick-delivery"
                      onClick={() => {
                        setQuickMode(true);
                        setComposerStep(1);
                        setComposerOpen(true);
                      }}
                    >
                      ⚡ 快速任务
                    </button>
                    <button className={`outline queue-launch ${queue.paused ? "paused" : ""}`} onClick={() => setQueueControlOpen(true)} title="查看并控制计划执行队列">
                      ▷ 执行队列 · {queue.running}/{queue.concurrency}
                    </button>
                    <div className="filter-wrap">
                      <button
                        className={`filter-trigger ${filterOpen ? "open" : ""}`}
                        onClick={() => setFilterOpen((open) => !open)}
                        aria-haspopup="menu"
                        aria-expanded={filterOpen}
                      >
                        <span
                          className={
                            filter === "全部"
                              ? "filter-dot all"
                              : `filter-dot ${statusClass[filter]}`
                          }
                        ></span>
                        {filter === "全部" ? "全部状态" : filter}
                        <span className="chevron">⌄</span>
                      </button>
                      {filterOpen && (
                        <div className="filter-menu" role="menu">
                          {[
                            "全部",
                            "待开始",
                            "计划中",
                            "执行中",
                            "待验证",
                            "待复核",
                            "已阻塞",
                            "已完成",
                          ].map((option) => (
                            <button
                              role="menuitem"
                              key={option}
                              className={filter === option ? "chosen" : ""}
                              onClick={() => {
                                setFilter(option);
                                setFilterOpen(false);
                              }}
                            >
                              <span
                                className={
                                  option === "全部"
                                    ? "filter-dot all"
                                    : `filter-dot ${statusClass[option]}`
                                }
                              ></span>
                              {option === "全部" ? "全部状态" : option}
                              {filter === option && <b>✓</b>}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                {taskViewMode === "board" ? (
                  <>
                  <EmptyStageToggle pressed={showEmptyTaskStages} onToggle={setShowEmptyTaskStages} />
                  <div
                    className="release-board task-kanban"
                    ref={taskKanbanRef}
                    aria-label="任务看板"
                  >
                    {boardTaskStages.map((stage) => {
                      const stageTasks = visibleTasks.filter((task) => (task.taskStage || "待开发") === stage);
                      return (
                        <section
                          key={stage}
                          className={`release-lane task-kanban-column ${kanbanDropStage === stage ? "drop-target" : ""}`}
                          onDragOver={(event) => { event.preventDefault(); setKanbanDropStage(stage); }}
                          onDragLeave={() => setKanbanDropStage((current) => current === stage ? null : current)}
                          onDrop={(event) => {
                            event.preventDefault();
                            const task = visibleTasks.find((item) => item.id === draggedTaskId);
                            if (task && (task.taskStage || "待开发") !== stage) updateTaskStage(task, stage);
                            setDraggedTaskId(null);
                            setKanbanDropStage(null);
                          }}
                        >
                          <header><span>{stage}</span><b>{stageTasks.length}</b></header>
                          <div className="release-lane-cards">
                            {stageTasks.map((task) => (
                              <button
                                key={task.id}
                                draggable
                                className={`task-kanban-card ${selected?.id === task.id ? "selected" : ""}`}
                                onDragStart={() => setDraggedTaskId(task.id)}
                                onDragEnd={() => { setDraggedTaskId(null); setKanbanDropStage(null); }}
                                onClick={() => setSelectedId(task.id)}
                              >
                                <small>{task.id} · {task.role}</small>
                                <b>{task.title}</b>
                                <p>{task.description || "暂无任务说明"}</p>
                                <footer><i className={`status ${statusClass[task.status] ?? "done"}`}>{task.status}</i><span className={`test ${task.codex?.state === "stopped" ? "neutral" : task.testTone}`}>{task.codex?.state === "stopped" ? "已暂停" : task.test}</span></footer>
                              </button>
                            ))}
                            {!stageTasks.length && <span className="task-kanban-empty">暂无任务</span>}
                          </div>
                        </section>
                      );
                    })}
                  </div>
                  </>
                ) : (
                  <>
                <div className="table-head">
                  <span>任务</span>
                  <span>下一步</span>
                  <span>验证</span>
                </div>
                <div className="task-rows">
                  {visibleTasks.map((task) => (
                    <button
                      key={task.id}
                      className={`task-row ${selected?.id === task.id ? "selected" : ""}`}
                      onClick={() => setSelectedId(task.id)}
                    >
                      <span className="task-name">
                        <b>{task.title}</b>
                        <small>
                          {task.id} · {task.description}
                        </small>
                        <i
                          className={`status ${statusClass[task.status] ?? "done"}`}
                        >
                          {task.codex?.state === "stopped"
                            ? "计划中 · 已暂停"
                            : task.status === "已完成" &&
                          task.merge?.state === "merged"
                            ? "已完成 · 已合并"
                            : task.status}
                        </i>
                        {task.dependencies?.some(
                          (dependency) => !dependency.satisfied,
                        ) && (
                          <small className="dependency-note">
                            ↳ 等待{" "}
                            {task.dependencies
                              .filter((dependency) => !dependency.satisfied)
                              .map((dependency) => dependency.task.id)
                              .join("、")}{" "}
                            的{" "}
                            {task.dependencies.find(
                              (dependency) => !dependency.satisfied,
                            )?.gate === "accept"
                              ? "验收"
                              : "测试"}
                          </small>
                        )}
                      </span>
                      <span className="task-next-step">{taskConclusion(task, task.verification).title}</span>
                      <span className={`test ${task.testTone}`}>
                        {task.test}
                      </span>
                    </button>
                  ))}
                </div>
                  </>
                )}
                {visibleTasks.length === 0 && (
                  <div className="empty">没有匹配的任务</div>
                )}
              </section>
              {selected && (
                <>
                  <div
                    className={`pane-resizer ${resizingInspector ? "dragging" : ""}`}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      setResizingInspector(true);
                    }}
                    title="拖动调整详情宽度"
                  />
                  <aside className="inspector task-detail-workspace">
                    <div className="task-detail-layout-shell">
                    <div className="task-detail-layout">
                    <div className="task-detail-scroll">
                    <header className="task-detail-header">
                      <div className="task-detail-kicker">
                        <span>{selected.id}</span>
                        <i className={`status ${statusClass[selected.status] ?? "done"}`}>
                          {selected.codex?.state === "stopped" ? "已暂停" : selected.status}
                        </i>
                      </div>
                      <div className="task-detail-header-actions">
                        {!selected.codex?.workspacePath && selected.status !== "已完成" && <Button size="small" onClick={requestChanges}>编辑任务</Button>}
                        <Dropdown
                          trigger={["click"]}
                          menu={{ items: [
                            { key: "delete", danger: true, label: selected.codex?.workspacePath || selected.codex?.threadId || (selected.execution?.events || []).length ? "删除任务记录" : "删除任务", onClick: deleteSelectedTask },
                          ] }}
                        >
                          <Button type="text" size="small" className="task-detail-more-actions" aria-label="任务更多操作">•••</Button>
                        </Dropdown>
                        <button className="close" title="关闭详情" aria-label="关闭任务详情" onClick={() => setSelectedId(null)}>×</button>
                      </div>
                      <h2>{selected.title}</h2>
                    </header>
                    <div className="task-detail-body">
                    <>
                    {selected.codex?.workspacePath && (
                      <section className="task-workspace-summary">
                        <div><b>{selected.codex.deliveryMode === "release" ? "版本交付分支" : selected.codex.deliveryMode === "direct" ? "当前分支直接修改" : "独立任务分支"}</b><code>{selected.codex.branch}</code><small title={selected.codex.workspacePath}>{selected.codex.workspacePath}</small></div>
                        <div><Button size="small" onClick={() => openWorktree(selected)}>用默认编辑器打开</Button><Button size="small" onClick={inspectTaskDiff}>查看代码变更</Button></div>
                      </section>
                    )}
                    <section className="task-brief">
                      <h3>任务说明</h3>
                      <p>
                        {selected.goal || selected.description ||
                          "尚未补充任务说明。"}
                      </p>
                    </section>
                    <section className="acceptance-section">
                      <h3>验收标准</h3>
                      <p className="acceptance-copy">{selected.acceptance || "尚未补充验收标准；执行前请明确用户可见结果、验证方式与相关边界。"}</p>
                    </section>
                    {selected.deliveryMode === "no-code" && (
                      <section className="task-no-code-decision">
                        <h3>无需代码交付</h3>
                        <p>{selected.noCodeReason || "未填写原因。请在编辑任务中补充后再验收。"}</p>
                      </section>
                    )}
                    {selected.dependencies?.length > 0 && (
                      <section className="dependency-section task-dependency-summary">
                        <h3>依赖门禁</h3>
                        {selected.dependencies.map((dependency) => (
                          <div className={`dependency-gate ${dependency.satisfied ? "open" : ""}`} key={dependency.prerequisite_id}>
                            <b>{dependency.satisfied ? "✓" : "↳"} {dependency.satisfied ? "前置已满足" : "等待前置任务"}</b>
                            <span>{dependency.task.id} · {dependency.task.title}</span>
                          </div>
                        ))}
                      </section>
                    )}
                    <section className="task-next-step">
                      {(() => {
                        const conclusion = taskConclusion(selected, currentVerification(selected));
                        return <><h3>{conclusion.title}</h3><p>{conclusion.detail}</p></>;
                      })()}
                      <div className="task-next-actions">
                        {!selected.codex?.workspacePath && selected.deliveryMode !== "no-code" && selected.status !== "已完成" && <Button type="primary" size="small" disabled={selected.canRun === false || launching} onClick={launchTask}>{launching ? "正在启动…" : selected.canRun === false ? "等待依赖" : "启动 Codex"}</Button>}
                        {!selected.codex?.workspacePath && selected.status !== "已完成" && <Button size="small" onClick={requestChanges}>编辑任务</Button>}
                        {selected.codex?.state === "running" && <Button danger size="small" onClick={stopCodexTask}>停止执行</Button>}
                        {selected.codex?.state === "stopped" && <Button type="primary" size="small" disabled={launching} onClick={launchTask}>{launching ? "正在继续…" : "继续执行"}</Button>}
                        {selected.codex?.state === "completed" && !currentVerification(selected) && <Button type="primary" size="small" onClick={runVerification}>运行验证</Button>}
                        {selected.status === "待复核" && !selected.codex?.isolated && selected.codex?.deliveryMode !== "direct" && (
                          <Button type="primary" size="small" onClick={acceptDelivery}>
                            接受交付
                          </Button>
                        )}
                        {selected.status === "已阻塞" && <Button type="primary" size="small" onClick={retryTask}>重试任务</Button>}
                      </div>
                    </section>
                    <details className="task-detail-more" open={detailMoreOpen} onToggle={(event) => setDetailMoreOpen(event.currentTarget.open)}>
                      <summary>查看接口、上下文与实施计划</summary>
                      <div className="task-detail-more-content">
                      {selected.projectPolicy && (
                        <section className="policy-summary">
                          <h3>项目规范</h3>
                          <p>{selected.projectPolicy.rules || "未配置额外项目规则。"}</p>
                          {selected.projectPolicy.skills?.length > 0 && <small>Skills：{selected.projectPolicy.skills.map((skill) => `$${skill}`).join(" · ")}</small>}
                        </section>
                      )}
                      <section className="task-interface-section">
                      <h3>接口与联调</h3>
                      {selectedRelease ? (
                        selectedApiOptions.length ? (
                          <>
                            <p>从版本「{selectedRelease.name}」已同步的 Apifox 接口中选择与此任务相关的接口。</p>
                            <Select
                              mode="multiple"
                              allowClear
                              placeholder="选择接口（可多选）"
                              value={(selected.apiLinks || []).map((api) => api.key)}
                              options={selectedApiOptions}
                              disabled={selected.status === "执行中" || savingTaskInterfaces}
                              onChange={(apiKeys) => saveTaskInterfaces(apiKeys)}
                            />
                          </>
                        ) : (
                          <p>此版本尚未同步 Apifox 接口。可在下方填写接口路径、字段、错误码或联调约定；也可回到版本工作台完成 Apifox 同步。</p>
                        )
                      ) : (
                        <p>此任务未关联版本，暂无可选的 Apifox 接口；可在下方补充手工接口约定。</p>
                      )}
                      <Input.TextArea
                        autoSize={{ minRows: 3, maxRows: 7 }}
                        value={taskApiNotes}
                        disabled={selected.status === "执行中" || savingTaskInterfaces}
                        placeholder="例如：GET /api/orders 需确认分页字段；后端联调环境为 staging；失败统一展示 error.message；接口未定时写明负责人和确认时间。"
                        onChange={(event) => setTaskApiNotes(event.target.value)}
                        onBlur={() => {
                          if (taskApiNotes !== (selected.apiNotes || ""))
                            saveTaskInterfaces((selected.apiLinks || []).map((api) => api.key), taskApiNotes);
                        }}
                      />
                      {selected.apiLinks?.length > 0 && (
                        <small>已关联：{selected.apiLinks.map((api) => `${api.method} ${api.path}`).join("、")}</small>
                      )}
                    </section>
                    <section>
                      <h3>
                        {selected.evidence?.workspace
                          ? "实际变更文件"
                          : "任务上下文"}
                      </h3>
                      <ul className="files">
                        {selected.files.map((file) => (
                          <li key={file}>
                            <span>▧</span>
                            {file}
                          </li>
                        ))}
                      </ul>
                      {selected.evidence?.workspace?.diffStat && (
                        <pre className="evidence-output">
                          {selected.evidence.workspace.diffStat}
                        </pre>
                      )}
                      {selected.evidence?.workspace && <Button size="small" onClick={inspectTaskDiff}>查看本轮 diff</Button>}
                    </section>
                    <section>
                      <h3>实施计划</h3>
                      <ol className="plan">
                        {selected.plan.map((step) => (
                          <li key={step}>{step}</li>
                        ))}
                      </ol>
                    </section>
                    </div>
                    </details>
                    </>
                    {selected.codex?.workspacePath && <>
                    {(() => {
                      const verification = currentVerification(selected);
                      const verificationState = verificationSummary(verification);
                      const isRunning = selected.codex?.state === "running";
                      const executionTitle = !selected.codex
                        ? "尚未启动"
                        : isRunning
                          ? "正在执行"
                          : selected.codex.state === "completed"
                            ? "本轮已完成"
                            : "本轮已停止";
                      return <>
                        <details className="execution-activity-section">
                          <summary>查看完整执行记录{summarizedExecutionEvents.length ? `（${summarizedExecutionEvents.length} 个关键节点）` : ""}</summary>
                          {summarizedExecutionEvents.length ? (
                            <ol className="execution-activity-stream">
                              {summarizedExecutionEvents.slice().reverse().map((event, index) => (
                                <li key={`${event.at}-${index}`}>
                                  <time>{new Date(event.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
                                  <div><b>{event.label}{event.count > 1 ? `（${event.count} 次）` : ""}</b><span>{event.detail}</span></div>
                                </li>
                              ))}
                            </ol>
                          ) : <p className="execution-empty">启动后会在这里记录关键阶段、文件处理与验证结果。</p>}
                          {verification?.output && <details className="execution-evidence"><summary>查看原始验证日志</summary><div><p>{verification.command && `执行命令：${verification.command}`}</p><pre className="evidence-output">{verification.output}</pre></div></details>}
                        </details>
                      </>;
                    })()}
                    </>}
                    {selected.status === "待复核" && selected.testTone === "success" && selected.codex?.workspacePath && <>
                    <section className="delivery-actions">
                      <div>
                        <h3>复核交付</h3>
                        <p>{selected.merge?.state === "merged" ? "变更已保存，确认后即可接受交付。" : selected.merge?.state === "release-committed" ? "本任务变更已提交到版本分支；请在版本页查看最终 diff 并统一合并。" : hasOnlyWorkspaceNoise ? "未发现可审阅的代码变更；先补充意见或检查原始工作区文件。" : selected.codex?.deliveryMode === "direct" ? `先查看真实变更，确认无误后保存到当前分支；提交信息会包含 ${selected.id}。` : selected.codex?.deliveryMode === "release" ? "先查看本任务真实变更，确认后提交到版本分支；版本完成后再统一合并。" : "先查看真实变更，确认无误后再合并到目标分支。"}</p>
                        <div className="delivery-step-sequence" aria-label="交付复核步骤">
                          <span className={selected.merge?.state === "ready" || ["release-committed", "merged"].includes(selected.merge?.state) ? "done" : "active"}>1. 查看 diff</span>
                          <span className={["release-committed", "merged"].includes(selected.merge?.state) ? "done" : selected.merge?.state === "ready" ? "active" : ""}>2. {selected.codex?.deliveryMode === "release" ? "提交版本分支" : selected.codex?.deliveryMode === "direct" ? "保存当前分支" : "合并目标分支"}</span>
                          {selected.codex?.deliveryMode === "release" && <span className={selected.merge?.state === "release-committed" ? "active" : ""}>3. 版本最终合并</span>}
                        </div>
                      </div>
                      <div className="delivery-inline-actions">
                        {selected.preview?.url && <a className="preview-link" href={selected.preview.url} target="_blank" rel="noreferrer">打开预览</a>}
                        <Button size="small" onClick={launchPreview}>{selected.preview?.url ? "重启预览" : "预览页面"}</Button>
                        {selected.merge?.state === "release-committed" ? <Button type="primary" size="small" onClick={openSelectedReleaseMerge}>前往版本最终合并</Button> : hasOnlyWorkspaceNoise ? <Button size="small" onClick={() => { setActiveDiffFile(0); setDiffReviewOpen(true); }}>查看原始变更</Button> : !["merged", "release-committed"].includes(selected.merge?.state) && <Button type="primary" size="small" onClick={() => selected.codex?.deliveryMode === "direct" ? inspectTaskDiff() : selected.merge?.state === "ready" ? (setActiveDiffFile(0), setDiffReviewOpen(true)) : previewMerge()}>{selected.merge?.state === "ready" ? "查看代码 diff" : selected.codex?.deliveryMode === "direct" ? "查看代码 diff" : "生成代码审阅"}</Button>}
                      </div>
                    </section>
                    <details className="delivery-workspace-tools">
                      <summary>任务工作区</summary>
                      <div>
                        <span>独立工作区已保留，可在需要排查时打开。</span>
                        <Button size="small" onClick={() => openWorktree(selected)}>打开工作区</Button>
                      </div>
                    </details>
                    {selected.testTone === "success" &&
                      (selected.codex?.isolated || selected.codex?.deliveryMode === "direct") && (
                        <section className="merge-section">
                          <div className="merge-heading">
                            <h3>合并交付</h3>
                            <span
                              className={
                                selected.merge?.state === "merged"
                                  ? "merge-state merged"
                                  : "merge-state"
                              }
                            >
                              {selected.merge?.state === "merged"
                                ? "已合并"
                                : hasOnlyWorkspaceNoise || reviewedEmptyDiff
                                  ? "需要补充"
                                : "等待你确认"}
                            </span>
                          </div>
                          <p>
                            目标分支：
                            <b>
                              {selected.merge?.targetBranch ||
                                "创建任务时的当前分支"}
                            </b>
                          </p>
                          {["merged", "release-committed"].includes(selected.merge?.state) ? (
                            <>
                              <p className="merge-success">
                                ✓ {selected.merge?.state === "release-committed" ? "已提交到版本分支；版本完成后统一合并。" : selected.codex?.workspacePath ? "已合并；任务 worktree 仍被保留，可继续检查或回退。" : "已合并；任务 worktree 已清理，交付记录仍保留。"}
                              </p>
                              {selected.status === "已完成" && selected.codex?.workspacePath && (
                                <button className="cleanup-worktree" onClick={cleanupMergedWorktree}>清理已合并 worktree</button>
                              )}
                              {selected.status === "待复核" && selected.merge?.state === "merged" && <Button type="primary" size="small" onClick={acceptDelivery}>接受交付</Button>}
                            </>
                          ) : selected.merge?.state === "conflict" ? (
                            <div className="merge-conflict">
                              <b>合并已安全暂停</b>
                              <p>
                                检测到 {selected.merge.conflicts?.length || 0}{" "}
                                个冲突文件；目标分支没有写入任何半合并内容。
                              </p>
                              <ul>
                                {selected.merge.conflicts?.map((item) => (
                                  <li key={item.file}>{item.file}</li>
                                ))}
                              </ul>
                              <button
                                className="outline"
                                onClick={() => openWorktree(selected)}
                              >
                                打开任务 worktree 处理
                              </button>
                              <button
                                className="outline"
                                onClick={() => {
                                  setDiffReviewOpen(true);
                                  setActiveDiffFile(0);
                                }}
                              >
                                查看任务变更
                              </button>
                              {selected.merge.conflicts?.map((item) => (
                                <details
                                  className="conflict-file"
                                  key={`${item.file}-content`}
                                >
                                  <summary>对比冲突文件：{item.file}</summary>
                                  <div>
                                    <section>
                                      <b>目标分支版本</b>
                                      <pre>
                                        {item.target ||
                                          "（该文件在目标分支不存在）"}
                                      </pre>
                                    </section>
                                    <section>
                                      <b>任务分支版本</b>
                                      <pre>
                                        {item.task ||
                                          "（该文件在任务分支不存在）"}
                                      </pre>
                                    </section>
                                  </div>
                                </details>
                              ))}
                            </div>
                          ) : (
                            <>
                              {reviewedEmptyDiff ? (
                                <div className="merge-empty">
                                  <p>本轮没有检测到可合并的代码变更，不能进入最终验收。</p>
                                  <Button size="small" onClick={() => runAction(selected.id, "return", "已退回任务补充可交付的代码变更。")}>
                                    退回补充
                                  </Button>
                                </div>
                              ) : <>
                                <div className="merge-actions">
                                  {selected.merge?.state === "ready" && !hasOnlyWorkspaceNoise && (
                                    <button
                                      className="primary success"
                                      onClick={() =>
                                        confirmAction({
                                          title: "确认合并变更？",
                                      content: selected.codex?.deliveryMode === "direct"
                                        ? `将当前分支的本任务变更保存为 Git 提交“Flight Deck ${selected.id}: ${selected.title}”。`
                                        : `将 ${selected.merge?.branch || selected.worktree} 合并到 ${selected.merge?.targetBranch || "目标分支"}。`,
                                          onOk: mergeDelivery,
                                        })
                                      }
                                    >
                                      {selected.codex?.deliveryMode === "release" ? "确认并提交到版本分支" : selected.codex?.deliveryMode === "direct" ? "保存到当前分支" : "合并到目标分支"}
                                    </button>
                                  )}
                                </div>
                                {hasOnlyWorkspaceNoise && <div className="merge-empty"><p>只检测到工作区杂项文件，未提供可合并的代码变更，不能进入最终验收。</p><Button size="small" onClick={() => runAction(selected.id, "return", "已退回任务补充可交付的代码变更。")}>退回补充</Button></div>}
                              </>}
                              {selected.merge?.diffStat && (
                                <small className="merge-summary">
                                  {selected.merge.diffStat.split("\n").at(-1)}
                                </small>
                              )}
                            </>
                          )}
                        </section>
                      )}
                    </>}
                    <>
                    <section className="activity-section">
                      <div className="execution-heading">
                        <h3>最近动态</h3>
                      </div>
                      <ol className="detail-activity-stream">
                        <li className="detail-activity-created">
                          <time>{new Date(selected.createdAt || Date.now()).toLocaleString("zh-CN")}</time>
                          <div><b>任务已创建</b><span>等待确认计划并启动 Codex。</span></div>
                        </li>
                        {activityItems.map((item) => item.type === "comment" ? (
                            <li key={item.comment.id} className="detail-activity-comment">
                              <time>{new Date(item.at).toLocaleString("zh-CN")}</time>
                              <div><b>你补充了讨论</b><p>{item.comment.body}</p>{item.comment.attachment && <button className="detail-comment-attachment" onClick={() => setAttachmentPreview(item.comment.attachment)}>附件：{item.comment.attachment.name}</button>}<button className="detail-comment-delete" onClick={() => deleteDetailComment(item.comment.id)}>删除</button></div>
                            </li>
                          ) : item.type === "verification" ? (
                            <li key={`verification-${item.at}`} className="detail-activity-event">
                              <time>{new Date(item.at).toLocaleString("zh-CN")}</time>
                              <div><b>{item.verification.exitCode === 0 ? "项目验证通过" : "项目验证未通过"}</b><span>{item.verification.command || "未配置验证命令"}</span></div>
                            </li>
                          ) : (
                            <li key={`merge-${item.at}`} className="detail-activity-event">
                              <time>{new Date(item.at).toLocaleString("zh-CN")}</time>
                              <div><b>{item.merge.state === "merged" ? "已合并到目标分支" : "已提交到版本分支"}</b><span>{item.merge.targetBranch || item.merge.branch || "交付分支"}</span></div>
                            </li>
                          ))}
                      </ol>
                    </section>
                    <section className="detail-comment-composer">
                      <div className="section-heading-row"><div><h3>讨论与修改意见</h3><p>保存讨论不会重新执行；需要改动时，将同一条意见交给 Codex 增量处理。</p></div></div>
                      <Input.TextArea autoSize={{ minRows: 3, maxRows: 6 }} value={detailComment} onChange={(event) => setDetailComment(event.target.value)} placeholder="例如：确认列表默认按创建时间倒序；空状态按设计稿展示。" disabled={savingDetail} />
                      <div className="detail-comment-actions">
                        <Button size="small" onClick={pickDetailCommentAttachment} disabled={savingDetail}>{detailCommentAttachment ? `已附：${detailCommentAttachment.name}` : "添加附件"}</Button>
                        {detailCommentAttachment && <Button type="text" size="small" onClick={() => setDetailCommentAttachment(null)} disabled={savingDetail}>移除</Button>}
                        <span className="comment-actions">
                          <Button size="small" onClick={() => submitDetailComment(false)} disabled={savingDetail || !detailComment.trim()}>仅保存讨论</Button>
                          <Button type="primary" size="small" onClick={() => submitDetailComment(true)} disabled={savingDetail || !detailComment.trim() || !selected.codex?.workspacePath || selected.codex?.state === "running" || selected.merge?.state === "merged"} title={!selected.codex?.workspacePath ? "任务启动后才能请求增量修改" : selected.codex?.state === "running" ? "当前任务正在执行" : selected.merge?.state === "merged" ? "交付已合并，不能再请求增量修改" : undefined}>交给 Codex 增量修改</Button>
                        </span>
                      </div>
                    </section>
                    </>
                    </div>
                    </div>
                    </div>
                    </div>
                  </aside>
                </>
              )}
            </main>
          )}
          {view === "releases" && (
            <main className="standalone-view release-view">
              <header className="view-header">
                <div>
                  <p className="eyebrow">版本与发布</p>
                  <h1>版本发布</h1>
                  <p>
                    用可配置的研发阶段看板、列表与甘特图统一管理版本节奏和 Codex
                    交付。
                  </p>
                </div>
                <div className="release-header-actions">
                  <div
                    className="view-switch"
                    role="tablist"
                    aria-label="版本视图"
                  >
                    <button
                      className={releaseLayout === "board" ? "active" : ""}
                      onClick={() => setReleaseLayout("board")}
                    >
                      看板
                    </button>
                    <button
                      className={releaseLayout === "list" ? "active" : ""}
                      onClick={() => setReleaseLayout("list")}
                    >
                      列表
                    </button>
                    <button
                      className={releaseLayout === "gantt" ? "active" : ""}
                      onClick={() => setReleaseLayout("gantt")}
                    >
                      甘特图
                    </button>
                  </div>
                  <button
                    className="outline"
                    onClick={openReleaseStageSettings}
                  >
                    配置阶段
                  </button>
                  <button
                    className="primary create-delivery"
                    onClick={() => setReleaseOpen(true)}
                  >
                    + 新建版本
                  </button>
                </div>
              </header>
              {releases.length ? (
                <>
                  {releaseLayout === "board" && (
                    <>
                    <EmptyStageToggle pressed={showEmptyReleaseStages} onToggle={setShowEmptyReleaseStages} />
                    <div className={`release-board ${boardReleaseStages.length === 1 ? "release-board-single-lane" : ""}`}>
                      {boardReleaseStages.map((stageSetting) => {
                        const stage = stageSetting.name;
                        const column = releases.filter(
                          (release) => release.stage === stage,
                        );
                        return (
                          <section
                            className="release-lane"
                            key={stage}
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={() => {
                              if (draggedReleaseId)
                                updateReleaseStage(draggedReleaseId, stage);
                              setDraggedReleaseId(null);
                            }}
                          >
                            <header>
                              <span>{stage}</span>
                              <b>{column.length}</b>
                            </header>
                            <div className="release-lane-cards">
                              {column.map((release) => (
                                <article
                                  className="release-board-card"
                                  draggable
                                  key={release.id}
                                  onDragStart={() =>
                                    setDraggedReleaseId(release.id)
                                  }
                                  onDragEnd={() => setDraggedReleaseId(null)}
                                >
                                  <div className="card-top">
                                    <span
                                      className={`status ${release.health === "有风险" ? "blocked" : "ready"}`}
                                    >
                                      {release.health}
                                    </span>
                                    <small>
                                      {release.releaseDate || "未设日期"}
                                    </small>
                                  </div>
                                  <h2>{release.name}</h2>
                                  <p>{release.goal || "未填写版本目标"}</p>
                                  <footer>
                                    <span>
                                      {release.tasks.complete}/
                                      {release.tasks.total} 已完成
                                    </span>
                                    <span>
                                      {
                                        tasksForRelease(release.id).filter(
                                          (task) => task.status === "执行中",
                                        ).length
                                      }{" "}
                                      执行中
                                    </span>
                                  </footer>
                                  <Select
                                    size="small"
                                    value={release.stage}
                                    options={visibleReleaseStages.map(
                                      (item) => ({
                                        value: item.name,
                                        label: item.name,
                                      }),
                                    )}
                                    onChange={(value) =>
                                      updateReleaseStage(release.id, value)
                                    }
                                  />
                                  <button
                                    className="release-edit-link"
                                    onClick={() =>
                                      openReleaseWorkspace(release)
                                    }
                                  >
                                    需求与任务
                                  </button>
                                  <button
                                    className="release-edit-link"
                                    onClick={() => openReleaseEditor(release)}
                                  >
                                    编辑版本
                                  </button>
                                  <button
                                    className="release-edit-link danger-link"
                                    onClick={() => deleteRelease(release)}
                                  >
                                    删除版本
                                  </button>
                                </article>
                              ))}
                            </div>
                          </section>
                        );
                      })}
                    </div>
                    </>
                  )}
                  {releaseLayout === "list" && (
                    <section className="release-list-view antd-release-table">
                      <Table
                        size="middle"
                        rowKey="id"
                        pagination={false}
                        dataSource={releases}
                        scroll={{ x: 760 }}
                        columns={[
                          {
                            title: "版本",
                            dataIndex: "name",
                            width: 300,
                            render: (_, release) => (
                              <div className="release-table-name">
                                <b>{release.name}</b>
                                <small>
                                  {release.goal || "未填写版本目标"}
                                </small>
                              </div>
                            ),
                          },
                          {
                            title: "阶段",
                            dataIndex: "stage",
                            width: 190,
                            render: (_, release) => {
                              const options = visibleReleaseStages.some(
                                (stage) => stage.name === release.stage,
                              )
                                ? visibleReleaseStages
                                : [
                                    { name: `${release.stage}（已隐藏）` },
                                    ...visibleReleaseStages,
                                  ];
                              return (
                                <Select
                                  size="small"
                                  value={release.stage}
                                  options={options.map((item) => ({
                                    value: item.name.replace("（已隐藏）", ""),
                                    label: item.name,
                                  }))}
                                  onChange={(value) =>
                                    updateReleaseStage(release.id, value)
                                  }
                                />
                              );
                            },
                          },
                          {
                            title: "计划上线",
                            dataIndex: "releaseDate",
                            width: 140,
                            render: (value) => value || "未设置",
                          },
                          {
                            title: "交付",
                            width: 130,
                            render: (_, release) =>
                              `${release.tasks.complete}/${release.tasks.total} 已完成`,
                          },
                          {
                            title: "操作",
                            width: 190,
                            render: (_, release) => (
                              <div className="release-table-actions">
                                <Button
                                  size="small"
                                  onClick={() => openReleaseWorkspace(release)}
                                >
                                  需求与任务
                                </Button>
                                <Button
                                  size="small"
                                  onClick={() => openReleaseEditor(release)}
                                >
                                  编辑
                                </Button>
                                <Button
                                  size="small"
                                  danger
                                  onClick={() => deleteRelease(release)}
                                >
                                  删除
                                </Button>
                              </div>
                            ),
                          },
                        ]}
                      />
                    </section>
                  )}
                  {releaseLayout === "gantt" && (
                    <div className="release-gantt">
                      <div className="gantt-toolbar">
                        <span>时间粒度</span>
                        {[
                          ["day", "日"],
                          ["week", "周"],
                          ["month", "月"],
                        ].map(([scale, label]) => (
                          <button
                            className={ganttScale === scale ? "active" : ""}
                            key={scale}
                            onClick={() => setGanttScale(scale)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <div className="gantt-header">
                        <div>版本</div>
                        <div className={`gantt-timescale ${ganttScale}`}>
                          {Array.from(
                            {
                              length:
                                ganttScale === "day"
                                  ? 14
                                  : ganttScale === "week"
                                    ? 10
                                    : 8,
                            },
                            (_, index) => {
                              const date = new Date(releaseRange.start);
                              if (ganttScale === "day")
                                date.setDate(date.getDate() + index);
                              else if (ganttScale === "week")
                                date.setDate(date.getDate() + index * 7);
                              else date.setMonth(date.getMonth() + index);
                              return (
                                <span key={index}>
                                  {ganttScale === "month"
                                    ? `${date.getMonth() + 1}月`
                                    : ganttScale === "week"
                                      ? `${date.getMonth() + 1}/${date.getDate()}`
                                      : `${date.getMonth() + 1}/${date.getDate()}`}
                                </span>
                              );
                            },
                          )}
                        </div>
                      </div>
                      {releases.map((release) => (
                        <div className="gantt-row" key={release.id}>
                          <div>
                            <b>{release.name}</b>
                            <small>
                              {release.stage} ·{" "}
                              {release.releaseDate || "未设上线日"}
                            </small>
                          </div>
                          <div className="gantt-track">
                            <button
                              className="gantt-bar"
                              style={releaseBarStyle(release)}
                              title={`${release.name}：${release.startDate || "未设开始日"} 至 ${release.releaseDate || "未设上线日"}`}
                            >
                              {release.name}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="page-empty">
                  <b>还没有版本计划</b>
                  <p>先创建版本，再把 Codex 任务绑定到对应版本。</p>
                  <button
                    className="outline"
                    onClick={() => setReleaseOpen(true)}
                  >
                    + 新建版本
                  </button>
                </div>
              )}
            </main>
          )}
        </section>
        {diffReviewOpen && selected?.merge?.diff && (
          <div className="modal-backdrop diff-backdrop" role="presentation">
            <section
              className="modal diff-review-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="diff-review-title"
            >
              <button
                className="diff-review-close"
                onClick={() => setDiffReviewOpen(false)}
                aria-label="关闭变更审阅"
              >
                ×
              </button>
              <header className="diff-review-header">
                <div>
                  <div className="modal-kicker">
                    {selected.merge?.source === "commit" ? "已交付提交 · 代码变更" : "真实 Git diff · 合并前审阅"}
                  </div>
                  <div className="diff-review-title-row">
                    <h2 id="diff-review-title">{selected.title}</h2>
                    <span className="merge-state">
                      {selected.merge?.state === "merged" ? "已合并" : "等待你确认"}
                    </span>
                  </div>
                  <p className="diff-review-summary">
                    共 {diffFileSummaries.length} 个文件 · <b className="diff-add">+{diffTotals.additions}</b> 新增 · <b className="diff-del">−{diffTotals.deletions}</b> 删除
                    {diffTotals.reviewable === 0 && " · 未发现可合并的代码变更"}
                  </p>
                </div>
              </header>
              <div className="diff-review-body">
                <nav className="diff-file-list" aria-label="变更文件">
                  <div className="diff-file-list-title">变更文件</div>
                  {diffFileSummaries.map((file, index) => {
                    return (
                      <button
                        className={activeDiffFile === index ? "active" : ""}
                        key={file.id}
                        onClick={() => setActiveDiffFile(index)}
                      >
                        <span className="diff-file-name">
                          <i aria-hidden="true">{file.noise ? "⊘" : file.binary ? "◈" : file.change === "新增文件" ? "+" : file.change === "删除文件" ? "−" : "⌑"}</i>
                          {file.path}
                        </span>
                        <small>
                          {file.noise ? <i className="diff-noise">杂项</i> : <>
                          {file.additions > 0 && (
                            <i className="diff-add">+{file.additions}</i>
                          )}
                          {file.deletions > 0 && (
                            <i className="diff-del">−{file.deletions}</i>
                          )}
                          {file.binary && <i className="diff-binary">二进制</i>}
                          </>}
                        </small>
                      </button>
                    );
                  })}
                </nav>
                <div className="diff-code" aria-label="代码变更">
                  <div className="diff-code-title">
                    <span>{activeDiff?.path || "代码变更"} <em>{activeDiff?.change}</em></span>
                    <small>旧行 / 新行</small>
                  </div>
                  {activeDiff?.noise ? (
                    <div className="diff-not-reviewable"><b>这是工作区杂项，不是可交付的代码变更。</b><p>{activeDiff.path} 不会进入合并；请退回任务补充可审阅的代码改动。</p></div>
                  ) : activeDiff?.binary ? (
                    <div className="diff-binary-notice"><b>二进制文件变更</b><p>Git 无法提供逐行新增/删除内容。请确认此文件本应随交付变更；若不是，请退回补充。</p></div>
                  ) : activeDiffRows.some((row) => row.type === "addition" || row.type === "deletion") ? (
                    activeDiffRows.map((row) => {
                      return (
                        <div
                          className={`diff-line ${row.type}`}
                          key={`${row.id}-${row.text}`}
                        >
                          <span className="diff-line-number">
                            {row.oldLine}
                          </span>
                          <span className="diff-line-number">
                            {row.newLine}
                          </span>
                          <span className="diff-sign" aria-hidden="true">
                            {row.type === "addition"
                              ? "+"
                              : row.type === "deletion"
                                ? "−"
                                : ""}
                          </span>
                          <code>{row.text || " "}</code>
                        </div>
                      );
                    })
                  ) : (
                    <div className="diff-empty">
                      这个文件没有可呈现的新增或删除文本。
                    </div>
                  )}
                </div>
              </div>
              <footer className="diff-review-footer">
                {hasOnlyWorkspaceNoise ? (
                  <button className="outline" onClick={() => { setDiffReviewOpen(false); runAction(selected.id, "return", "已退回任务补充可交付的代码变更。"); }}>退回补充</button>
                ) : <button
                  className="outline"
                  onClick={() => setDiffReviewOpen(false)}
                >
                  继续检查
                </button>}
                <span></span>
                <button
                  className="primary success"
                  onClick={() =>
                    confirmAction({
                      title: "确认合并变更？",
                      content: `将 ${selected.merge?.branch || selected.worktree} 合并到 ${selected.merge?.targetBranch || "目标分支"}。`,
                      onOk: () => {
                        setDiffReviewOpen(false);
                        return mergeDelivery();
                      },
                    })
                  }
                >
                  确认合并到 {selected.merge?.targetBranch || "目标分支"}
                </button>
              </footer>
            </section>
          </div>
        )}
        {composerOpen && (
          <div className="modal-backdrop" role="presentation">
            <section
              className="modal modal-fixed-layout composer"
              role="dialog"
              aria-modal="true"
              aria-labelledby="composer-title"
            >
              <header className="modal-fixed-header">
                <button
                  className="modal-close"
                  aria-label="关闭新建交付"
                  onClick={() => {
                    setComposerOpen(false);
                    setQuickMode(false);
                    setComposerStep(1);
                  }}
                >
                  ×
                </button>
                <div className="modal-kicker">
                  {quickMode
                    ? "快速任务 · 一步创建"
                    : `新建交付 · 第 ${composerStep}/3 步`}
                </div>
                <h2 id="composer-title">
                  {quickMode
                    ? "用一句话交给 Codex"
                    : composerStep === 1
                      ? "先说清你想交付什么"
                      : composerStep === 2
                        ? "定义怎么判断完成"
                        : "确认上下文与交付方式"}
                </h2>
              </header>
              <div className="modal-fixed-scroll composer-scroll">
              {(composerStep === 1 || quickMode) && (
                <div className="form-stack">
                  <label>
                    交付名称 <em className="required-mark">必填</em>
                    <Input
                      autoFocus
                      aria-required="true"
                      value={draft.title}
                      onChange={(event) =>
                        setDraft({ ...draft, title: event.target.value })
                      }
                      placeholder="例如：增加订单导出能力"
                    />
                  </label>
                  <label>
                    负责角色
                    <Select
                      value={draft.role}
                      options={[
                        "产品专家", "前端专家", "后端专家", "UI/UX 专家", "全栈工程师",
                        "测试专家", "DevOps 专家", "安全专家", "数据工程师",
                      ].map((role) => ({ value: role, label: role }))}
                      onChange={(role) =>
                        setDraft({ ...draft, role })
                      }
                    />
                  </label>
                  <label>
                    目标 <em className="required-mark">必填</em>
                    <Input.TextArea
                      aria-required="true"
                      autoSize={{ minRows: 4, maxRows: 8 }}
                      value={draft.goal}
                      onChange={(event) =>
                        setDraft({ ...draft, goal: event.target.value })
                      }
                      placeholder="描述用户问题、预期行为与边界…"
                    />
                  </label>
                  <label>
                    所属版本（可选）
                    <Select
                      value={draft.versionId}
                      options={[
                        { value: "", label: "不关联版本" },
                        ...releases.map((release) => ({ value: release.id, label: release.name })),
                      ]}
                      onChange={(versionId) =>
                        setDraft({
                          ...draft,
                          versionId,
                          deliveryMode: versionId
                            ? "direct"
                            : (draft.deliveryMode === "direct" || draft.deliveryMode === "release" ? "task" : draft.deliveryMode),
                        })
                      }
                    />
                  </label>
                </div>
              )}
              {composerStep === 2 && (
                <div className="form-stack">
                  <label>
                    验收标准 <em className="required-mark">必填</em>
                    <Input.TextArea
                      autoFocus
                      aria-required="true"
                      autoSize={{ minRows: 4, maxRows: 8 }}
                      value={draft.acceptance}
                      onChange={(event) =>
                        setDraft({ ...draft, acceptance: event.target.value })
                      }
                      placeholder={"用户可见结果：导出文件包含当前筛选结果。\n验证与边界：以无数据筛选导出，显示空结果提示；运行 npm test，预期通过。"}
                    />
                  </label>
                  <AcceptanceGuidance />
                </div>
              )}
              {composerStep === 3 && (
                <div className="form-stack">
                  <label>
                    要提供给 Codex 的上下文
                    <Input.TextArea
                      autoFocus
                      autoSize={{ minRows: 4, maxRows: 8 }}
                      value={draft.context}
                      onChange={(event) =>
                        setDraft({ ...draft, context: event.target.value })
                      }
                    />
                  </label>
                  <div className="merge-mode">
                    <b>交付方式</b>
                    <Select
                      value={draft.deliveryMode}
                      options={[
                        ...(draft.versionId ? [{ value: "direct", label: "当前分支直接修改（版本任务）" }] : []),
                        { value: "task", label: "独立交付（单任务分支）" },
                        { value: "no-code", label: "无需代码交付" },
                      ]}
                      onChange={(deliveryMode) => setDraft({ ...draft, deliveryMode: draft.versionId && deliveryMode !== "no-code" ? "direct" : deliveryMode })}
                    />
                  <span>
                      {draft.deliveryMode === "direct"
                        ? `直接在 ${project?.branch || "当前分支"} 修改；查看 diff 后由你确认保存，Git 提交会标注任务号。`
                        : draft.deliveryMode === "no-code"
                          ? "不会创建分支或启动 Codex；确认原因后即可进入人工验收。"
                          : `默认方式：任务创建独立分支，并可在验证后直接合并到 ${project?.branch || "当前分支"}。`}
                    </span>
                    {draft.deliveryMode === "no-code" ? <label className="no-code-reason-field">
                      不开发原因 <em className="required-mark">必填</em>
                      <Input.TextArea
                        autoSize={{ minRows: 2, maxRows: 4 }}
                        value={draft.noCodeReason}
                        placeholder="例如：本版本不再纳入该需求，保留任务记录供人工确认。"
                        onChange={(event) => setDraft({ ...draft, noCodeReason: event.target.value })}
                      />
                    </label> : <div className="merge-confirmed">
                      <strong>查看真实 diff 后由你确认合并</strong>
                      <small>
                        Flight Deck 不会自动合并或复制代码。目标分支有未提交改动、分支不匹配或发生冲突时会拒绝合并。
                      </small>
                    </div>}
                  </div>
                  <div className="dependency-picker">
                    <b>依赖门禁（可选）</b>
                    <span>
                      选择每项任务后，再决定 B 要等待 A 的哪一级结果。
                    </span>
                    {tasks
                      .filter((task) => task.status !== "已完成")
                      .map((task) => (
                        <label key={task.id}>
                          <Checkbox
                            checked={draft.dependencies.some(
                              (dependency) => dependency.id === task.id,
                            )}
                            onChange={() =>
                              setDraft({
                                ...draft,
                                dependencies: draft.dependencies.some(
                                  (dependency) => dependency.id === task.id,
                                )
                                  ? draft.dependencies.filter(
                                      (dependency) => dependency.id !== task.id,
                                    )
                                  : [
                                      ...draft.dependencies,
                                      { id: task.id, gate: "test" },
                                    ],
                              })
                            }
                          />
                          {task.id} · {task.title}
                          <em>{task.test}</em>
                          {draft.dependencies.some(
                            (dependency) => dependency.id === task.id,
                          ) && (
                            <Select
                              size="small"
                              aria-label={`${task.title} 的依赖策略`}
                              value={
                                draft.dependencies.find(
                                  (dependency) => dependency.id === task.id,
                                )?.gate || "test"
                              }
                              options={[
                                { value: "test", label: "验证通过后手动启动 B" },
                                { value: "trust", label: "前置通过后可启动 B" },
                                { value: "accept", label: "等待人工验收" },
                              ]}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(gate) =>
                                setDraft({
                                  ...draft,
                                  dependencies: draft.dependencies.map(
                                    (dependency) =>
                                      dependency.id === task.id
                                        ? {
                                            ...dependency,
                                            gate,
                                          }
                                        : dependency,
                                  ),
                                })
                              }
                            />
                          )}
                        </label>
                      ))}
                  </div>
                  <div className="plan-preview">
                    <b>即将生成的计划</b>
                    <span>1. 阅读项目约定与相关模块</span>
                    <span>2. 进行范围内最小实现</span>
                    <span>3. 执行测试并准备交付证据</span>
                  </div>
                </div>
              )}
              </div>
              <footer className="modal-actions">
                {composerStep > 1 && (
                  <button
                    className="outline"
                    onClick={() => setComposerStep((step) => step - 1)}
                  >
                    上一步
                  </button>
                )}
                <span></span>
                {quickMode ? (
                  <button className="primary" onClick={createDelivery} disabled={!draft.title.trim() || !draft.goal.trim()}>
                    创建任务
                  </button>
                ) : composerStep < 3 ? (
                  <button
                    className="primary"
                    onClick={() => setComposerStep((step) => step + 1)}
                    disabled={!draft.title.trim() || !draft.goal.trim() || (composerStep === 2 && !draft.acceptance.trim())}
                  >
                    下一步
                  </button>
                ) : (
                  <button className="primary" onClick={createDelivery} disabled={!draft.title.trim() || !draft.goal.trim() || !draft.acceptance.trim() || (draft.deliveryMode === "no-code" && !draft.noCodeReason.trim())}>
                    创建任务包
                  </button>
                )}
              </footer>
            </section>
          </div>
        )}
        {releaseOpen && (
          <div className="modal-backdrop" role="presentation">
            <section
              className="modal release-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="release-title"
            >
              <button
                className="modal-close"
                onClick={() => setReleaseOpen(false)}
                aria-label="关闭新建版本"
              >
                ×
              </button>
              <div className="modal-kicker">版本与发布</div>
              <h2 id="release-title">新建版本</h2>
              <p className="description">
                会从此项目当前的研发阶段模板创建版本；可在「配置阶段」中随时调整展示与顺序。
              </p>
              <div className="form-stack">
                <label>
                  版本名称
                  <Input
                    autoFocus
                    value={releaseDraft.name}
                    onChange={(event) =>
                      setReleaseDraft({
                        ...releaseDraft,
                        name: event.target.value,
                      })
                    }
                    placeholder="例如：v1.8.0"
                  />
                </label>
                <label>
                  版本目标
                  <Input.TextArea
                    autoSize={{ minRows: 4, maxRows: 8 }}
                    value={releaseDraft.goal}
                    onChange={(event) =>
                      setReleaseDraft({
                        ...releaseDraft,
                        goal: event.target.value,
                      })
                    }
                    placeholder="本版本解决什么问题、交付什么价值？"
                  />
                </label>
                <ReleaseScheduleFields
                  value={releaseDraft}
                  onChange={setReleaseDraft}
                />
              </div>
              <footer className="modal-actions">
                <Button onClick={() => setReleaseOpen(false)}>取消</Button>
                <span></span>
                <Button type="primary" onClick={createRelease}>
                  创建版本
                </Button>
              </footer>
            </section>
          </div>
        )}
        {editingRelease && (
          <div className="modal-backdrop" role="presentation">
            <section
              className="modal release-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="edit-release-title"
            >
              <button
                className="modal-close"
                onClick={() => setEditingRelease(null)}
                aria-label="关闭编辑版本"
              >
                ×
              </button>
              <div className="modal-kicker">版本与发布</div>
              <h2 id="edit-release-title">编辑版本</h2>
              <p className="description">
                可随时补充或修改版本目标、计划开始日期和上线日期；甘特图会自动同步。
              </p>
              <div className="form-stack">
                <label>
                  版本名称
                  <Input
                    autoFocus
                    value={releaseEditDraft.name}
                    onChange={(event) =>
                      setReleaseEditDraft({
                        ...releaseEditDraft,
                        name: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  版本目标
                  <Input.TextArea
                    autoSize={{ minRows: 4, maxRows: 8 }}
                    value={releaseEditDraft.goal}
                    onChange={(event) =>
                      setReleaseEditDraft({
                        ...releaseEditDraft,
                        goal: event.target.value,
                      })
                    }
                    placeholder="本版本解决什么问题、交付什么价值？"
                  />
                </label>
                <ReleaseScheduleFields
                  value={releaseEditDraft}
                  onChange={setReleaseEditDraft}
                />
              </div>
              <footer className="modal-actions">
                <Button onClick={() => setEditingRelease(null)}>取消</Button>
                <span></span>
                <Button type="primary" onClick={saveReleaseEdit}>
                  保存修改
                </Button>
              </footer>
            </section>
          </div>
        )}
        {releaseWorkspaceOpen && (
          <div className="modal-backdrop" role="presentation">
            <section
              className="modal modal-fixed-layout release-workspace-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="release-workspace-title"
            >
              <header className="modal-fixed-header">
                <button
                  className="modal-close"
                  onClick={() => setReleaseWorkspaceOpen(null)}
                  aria-label="关闭版本需求工作台"
                >
                  ×
                </button>
                <div className="modal-kicker">
                  {releaseWorkspaceOpen.name} · 需求到交付
                </div>
                <h2 id="release-workspace-title">版本需求与任务工作台</h2>
                <p className="description">
                  先整理需求与待确认项，再生成可编辑的任务草稿。创建后的任务默认不执行，仍由你决定何时交给
                  Codex。
                </p>
                {tasksForRelease(releaseWorkspaceOpen.id).some((task) => task.deliveryMode === "release") && (
                  <div className="release-final-merge">
                    <span>{releaseWorkspaceOpen.merge?.state === "merged" ? `已合并到 ${releaseWorkspaceOpen.merge.targetBranch}` : "仅纳入版本分支的任务会参与统一合并；独立交付和无需代码任务不阻塞发布。"}</span>
                    {releaseWorkspaceOpen.merge?.state === "ready" ? <Button type="primary" size="small" onClick={mergeReleaseDelivery}>确认合并版本</Button> : releaseWorkspaceOpen.merge?.state !== "merged" && <Button size="small" onClick={previewReleaseMerge}>查看版本最终 diff</Button>}
                  </div>
                )}
              </header>
              <div className="modal-fixed-scroll">
              <div className="release-workspace-grid">
                <section className="release-workspace-section prd-section">
                  <header>
                    <b>1. PRD 与上下文</b>
                  </header>
                  <div className="prd-field">
                    <span className="prd-field-heading">
                      PRD / 需求说明
                      {releaseWorkspaceDraft.prd.trim() && (
                        <span className="prd-view-switch">
                          <Button size="small" type={prdViewMode === "edit" ? "primary" : "text"} onClick={() => setPrdViewMode("edit")}>编辑</Button>
                          <Button size="small" type={prdViewMode === "preview" ? "primary" : "text"} onClick={() => setPrdViewMode("preview")}>预览</Button>
                        </span>
                      )}
                    </span>
                    {prdViewMode === "preview" && looksLikeMarkdown(releaseWorkspaceDraft.prd) ? (
                      <MarkdownPreview content={releaseWorkspaceDraft.prd} />
                    ) : (
                      <Input.TextArea
                        className="prd-editor"
                        rows={8}
                        value={releaseWorkspaceDraft.prd}
                        onChange={(event) =>
                          setReleaseWorkspaceDraft({ ...releaseWorkspaceDraft, prd: event.target.value })
                        }
                        placeholder="粘贴 PRD、用户流程、验收规则、边界与非目标…"
                      />
                    )}
                  </div>
                  <details className="workspace-context">
                    <summary>补充上下文</summary>
                    <p className="workspace-context-intro">按需补充 AI 分析所需的资料。文件和接口均为可选项，不会阻塞 PRD 分析。</p>
                  <div className="context-source-card attachment-list">
                    <header className="context-source-header">
                      <div><b>文件与引用</b><small>设计稿、补充 PRD、接口文档或外部链接会作为版本上下文。</small></div>
                      <Button
                        size="small"
                        onClick={() =>
                          setReleaseWorkspaceDraft({
                            ...releaseWorkspaceDraft,
                            attachments: [
                              ...releaseWorkspaceDraft.attachments,
                              { id: `local-${Date.now()}`, name: "", type: "PRD 文档", url: "", note: "" },
                            ],
                          })
                        }
                      >
                        添加资料
                      </Button>
                    </header>
                    {releaseWorkspaceDraft.attachments.map((item, index) => (
                      <div className="attachment-entry" key={item.id || index}>
                      <div className="attachment-row">
                        <Input
                          value={item.name}
                          onChange={(event) =>
                            setReleaseWorkspaceDraft({
                              ...releaseWorkspaceDraft,
                              attachments:
                                releaseWorkspaceDraft.attachments.map(
                                  (entry, entryIndex) =>
                                    entryIndex === index
                                      ? { ...entry, name: event.target.value }
                                      : entry,
                                ),
                            })
                          }
                          placeholder="附件名称"
                        />
                        <Select
                          value={item.type}
                          options={[
                            "图片 / 设计稿",
                            "PRD 文档",
                            "接口文档",
                            "外部链接",
                          ].map((value) => ({ value, label: value }))}
                          onChange={(value) =>
                            setReleaseWorkspaceDraft({
                              ...releaseWorkspaceDraft,
                              attachments:
                                releaseWorkspaceDraft.attachments.map(
                                  (entry, entryIndex) =>
                                    entryIndex === index
                                      ? { ...entry, type: value }
                                      : entry,
                                ),
                            })
                          }
                        />
                        {item.type === "外部链接" ? (
                          <Input
                            className="attachment-url-input"
                            value={item.url}
                            onChange={(event) =>
                              setReleaseWorkspaceDraft({
                                ...releaseWorkspaceDraft,
                                attachments: releaseWorkspaceDraft.attachments.map(
                                  (entry, entryIndex) => entryIndex === index ? { ...entry, url: event.target.value } : entry,
                                ),
                              })
                            }
                            placeholder="粘贴外部链接"
                          />
                        ) : (
                          <>
                            <Button className="attachment-picker" onClick={() => pickReleaseAttachment(index)}>
                              {item.url ? "重新选择" : "选择文件"}
                            </Button>
                            <button
                              type="button"
                              className={`attachment-file-summary${item.url ? " is-selected" : ""}${item.content || item.previewable ? " is-previewable" : ""}`}
                              title={item.url || "尚未选择文件"}
                              disabled={!item.url || !(item.content || item.previewable)}
                              onClick={() => setAttachmentPreview({ ...item })}
                            >
                              {item.url ? (
                                <><span>已选择</span><strong>{item.url.split(/[\\/]/).pop()}</strong></>
                              ) : (
                                <span>未选择文件</span>
                              )}
                            </button>
                          </>
                        )}
                        <Button
                          className="attachment-remove"
                          size="small"
                          onClick={() =>
                            setReleaseWorkspaceDraft({
                              ...releaseWorkspaceDraft,
                              attachments:
                                releaseWorkspaceDraft.attachments.filter(
                                  (_, entryIndex) => entryIndex !== index,
                                ),
                            })
                          }
                        >
                          删除
                        </Button>
                      </div>
                      {item.content && (
                        <div className="attachment-document-actions">
                          <span>{item.truncated ? "文件较大，已读取前 30,000 个字符。" : "已读取文本内容，可用于 AI 分析。"}</span>
                          <Button size="small" type="link" onClick={() => setAttachmentPreview({ ...item })}>
                            预览 Markdown
                          </Button>
                          <Button size="small" type="link" onClick={() => importAttachmentToPrd(item)}>
                            导入 PRD
                          </Button>
                        </div>
                      )}
                      {item.previewable && item.url && (
                        <div className="attachment-document-actions">
                          <span>点击已选择的文件名可在弹窗中预览图片。</span>
                        </div>
                      )}
                      </div>
                    ))}
                    {!releaseWorkspaceDraft.attachments.length && <p className="context-source-empty">暂无补充资料。需要时点击“添加资料”即可，不必先填写路径。</p>}
                  </div>
                  <div className="context-source-card apifox-note">
                    <header className="context-source-header">
                      <div><b>接口定义</b><small>默认继承当前项目的 Apifox 配置；PRD 分析时自动只读同步，用于补充任务的接口上下文。</small></div>
                      {releaseWorkspaceOpen.apifox?.definitions?.length > 0 && <Tag color="success">已同步 {releaseWorkspaceOpen.apifox.definitions.length} 个</Tag>}
                    </header>
                    <div className="apifox-project-source">
                      <span className="apifox-status">{apifoxConfig.projectId && apifoxConfig.configured ? "已继承项目 Apifox 配置" : "项目尚未完成 Apifox 配置"}</span>
                      <small>{apifoxConfig.projectId && apifoxConfig.configured ? "每次重新分析 PRD 时自动只读更新；不会写回 Apifox。" : "不影响 PRD 分析或任务创建；需要接口上下文时可到项目设置补充。"}</small>
                      {!apifoxConfig.projectId || !apifoxConfig.configured ? <Button type="link" size="small" onClick={openApifoxConfig}>配置项目 Apifox</Button> : null}
                    </div>
                    {releaseWorkspaceOpen.apifox?.definitions?.length > 0 && (
                      <div className="apifox-definitions">
                        <small>
                          已同步{" "}
                          {releaseWorkspaceOpen.apifox.definitions.length}{" "}
                          个接口 ·{" "}
                          {releaseWorkspaceOpen.apifox.syncedAt
                            ?.slice(0, 16)
                            .replace("T", " ")}
                        </small>
                        {releaseWorkspaceOpen.apifox.definitions
                          .slice(0, 6)
                          .map((definition) => (
                            <span
                              key={`${definition.method}-${definition.path}`}
                            >
                              <b>{definition.method}</b> {definition.path} ·{" "}
                              {definition.summary}
                            </span>
                          ))}
                        {releaseWorkspaceOpen.apifox.definitions.length > 6 && (
                          <small>其余接口将作为版本上下文供任务引用。</small>
                        )}
                      </div>
                    )}
                  </div>
                  </details>
                  <div className="prd-analysis-actions">
                    <div className="prd-analysis-selects">
                      <label>
                        分析视角
                        <Select
                          mode="multiple"
                          size="small"
                          value={analysisPerspectives}
                          disabled={analysingPrd}
                          maxTagCount="responsive"
                          options={["前端开发", "后端开发", "UI/UX 设计", "测试", "产品"].map((value) => ({ value, label: value }))}
                          onChange={(values) => setAnalysisPerspectives(values.length ? values : ["前端开发"])}
                        />
                      </label>
                      <label>
                        产出任务角色
                        <Select
                          mode="multiple"
                          size="small"
                          value={analysisDeliveryRoles}
                          disabled={analysingPrd}
                          maxTagCount="responsive"
                          options={["前端专家", "后端专家", "全栈工程师", "UI/UX 专家", "测试专家", "产品专家"].map((value) => ({ value, label: value }))}
                          onChange={(values) => setAnalysisDeliveryRoles(values.length ? values : ["前端专家"])}
                        />
                      </label>
                    </div>
                    <Button type="primary" loading={analysingPrd} onClick={analysePrd}>
                      {analysingPrd
                        ? "正在调用 Codex 分析…"
                        : confirmedReviewCount
                          ? `✦ 带入 ${confirmedReviewCount} 条确认结论${releaseWorkspaceOpen.prdAnalysis ? "重新" : ""}分析`
                          : "✦ 分析 PRD 并建议任务"}
                    </Button>
                  </div>
                </section>
                <section className="release-workspace-section review-items-section">
                  <header>
                    <b>2. 评审问题</b>
                    <div className="review-section-actions">
                      <small>
                        {
                          (releaseWorkspaceOpen.reviewItems || []).filter(
                            (item) => item.status === "待确认",
                          ).length
                        }{" "}
                        项待确认
                      </small>
                      <Button
                        size="small"
                        type="text"
                        onClick={mergeSimilarReviewItems}
                      >
                        合并相似项
                      </Button>
                      {confirmedReviewCount > 0 && (
                        <Button
                          size="small"
                          type="primary"
                          loading={analysingPrd}
                          onClick={analysePrd}
                        >
                          带入 {confirmedReviewCount} 条结论重新分析
                        </Button>
                      )}
                    </div>
                  </header>
                  <div className="review-item-form">
                    <Input
                      value={reviewItemDraft.title}
                      onChange={(event) =>
                        setReviewItemDraft({
                          ...reviewItemDraft,
                          title: event.target.value,
                        })
                      }
                      placeholder="例如：退款超时后的状态定义是什么？"
                    />
                    <Select
                      value={reviewItemDraft.type}
                      options={[
                        "业务规则",
                        "交互 / 设计",
                        "接口 / 数据",
                        "风险 / 依赖",
                      ].map((value) => ({ value, label: value }))}
                      onChange={(value) =>
                        setReviewItemDraft({
                          ...reviewItemDraft,
                          type: value,
                        })
                      }
                    />
                    <Select
                      value={reviewItemDraft.impact}
                      options={["普通", "高优先级", "阻塞"].map((value) => ({
                        value,
                        label: value,
                      }))}
                      onChange={(value) =>
                        setReviewItemDraft({
                          ...reviewItemDraft,
                          impact: value,
                        })
                      }
                    />
                    <Input
                      value={reviewItemDraft.owner}
                      onChange={(event) =>
                        setReviewItemDraft({
                          ...reviewItemDraft,
                          owner: event.target.value,
                        })
                      }
                      placeholder="确认人（可选）"
                    />
                    <DatePicker
                      placement="bottomLeft"
                      getPopupContainer={() => document.body}
                      value={
                        reviewItemDraft.dueDate
                          ? dayjs(reviewItemDraft.dueDate)
                          : null
                      }
                      onChange={(date) =>
                        setReviewItemDraft({
                          ...reviewItemDraft,
                          dueDate: date ? date.format("YYYY-MM-DD") : "",
                        })
                      }
                      placeholder="截止日期"
                    />
                    <Button size="small" onClick={addReviewItem}>
                      添加
                    </Button>
                  </div>
                  {releaseWorkspaceOpen.prdAnalysis?.source === "codex" && (releaseWorkspaceOpen.prdAnalysis?.questions || []).filter(
                    (question) =>
                      !(releaseWorkspaceOpen.reviewItems || []).some(
                        (item) => item.title === question,
                      ),
                  ).length > 0 && (
                    <div className="ai-review-suggestions">
                      <b>AI 发现的待确认问题</b>
                      {(releaseWorkspaceOpen.prdAnalysis.questions || [])
                        .filter(
                          (question) =>
                            !(releaseWorkspaceOpen.reviewItems || []).some(
                              (item) => item.title === question,
                            ),
                        )
                        .map((question) => (
                          <div key={question}>
                            <span>{question}</span>
                            <Button
                              size="small"
                              onClick={() => addAiReviewSuggestion(question)}
                            >
                              转为待确认项
                            </Button>
                          </div>
                        ))}
                    </div>
                  )}
                  <div className="review-item-list">
                    {(releaseWorkspaceOpen.reviewItems || []).length ? (
                      releaseWorkspaceOpen.reviewItems.map((item) => (
                        <article
                          key={item.id}
                          className={
                            expandedReviewConclusionId === item.id
                              ? "conclusion-open"
                              : ""
                          }
                        >
                          <div className="review-item-content">
                            <div className="review-title-row">
                              <b>{item.title}</b>
                              {(item.mergedCount || 1) > 1 && (
                                <Tag className="review-merged-tag">
                                  合并 {item.mergedCount} 条
                                </Tag>
                              )}
                            </div>
                            <small>
                              {item.type} · {item.impact}
                              {item.owner ? ` · ${item.owner}` : ""}
                              {item.dueDate ? ` · ${item.dueDate}` : ""}
                            </small>
                            {item.conclusion &&
                            expandedReviewConclusionId !== item.id ? (
                              <p className="review-conclusion-summary">
                                结论：{item.conclusion}
                              </p>
                            ) : null}
                          </div>
                          <div className="review-item-actions">
                            <Select
                              size="small"
                              value={item.status}
                              options={["待确认", "已确认", "暂缓", "已关闭"].map(
                                (value) => ({ value, label: value }),
                              )}
                              onChange={(value) => {
                                const current = releaseWorkspaceOpen.reviewItems.find(
                                  (entry) => entry.id === item.id,
                                );
                                if (value === "已确认" && !current?.conclusion?.trim())
                                  {
                                    setExpandedReviewConclusionId(item.id);
                                    return setToast("请先填写确认结论，再标记为已确认。");
                                  }
                                updateReviewItem(current || item, {
                                  status: value,
                                  conclusion: current?.conclusion || item.conclusion,
                                });
                              }}
                            />
                            <Button
                              type="text"
                              size="small"
                              onClick={() =>
                                setExpandedReviewConclusionId((id) =>
                                  id === item.id ? null : item.id,
                                )
                              }
                            >
                              {expandedReviewConclusionId === item.id
                                ? "收起结论"
                                : item.conclusion
                                  ? "查看结论"
                                  : "填写结论"}
                            </Button>
                            <Button
                              type="text"
                              danger
                              size="small"
                              onClick={() => deleteReviewItem(item)}
                            >
                              删除
                            </Button>
                          </div>
                          {expandedReviewConclusionId === item.id && (
                            <div className="review-conclusion-editor">
                              <label>确认结论</label>
                              <Input.TextArea
                                autoSize={{ minRows: 2, maxRows: 5 }}
                                value={item.conclusion || ""}
                                onChange={(event) =>
                                  setReleaseWorkspaceOpen({
                                    ...releaseWorkspaceOpen,
                                    reviewItems: releaseWorkspaceOpen.reviewItems.map(
                                      (entry) =>
                                        entry.id === item.id
                                          ? {
                                              ...entry,
                                              conclusion: event.target.value,
                                            }
                                          : entry,
                                    ),
                                  })
                                }
                                onBlur={(event) =>
                                  updateReviewItem(item, {
                                    conclusion: event.target.value,
                                  })
                                }
                                placeholder="填写已确认的规则、范围或处理结论"
                              />
                            </div>
                          )}
                        </article>
                      ))
                    ) : (
                      <p className="empty-inline">暂无评审问题。可手动补充，或将 AI 建议转入这里跟踪。</p>
                    )}
                  </div>
                </section>
              </div>
              {releaseWorkspaceOpen.prdAnalysis && (
                <section className="prd-analysis">
                  <header>
                    <div>
                      <b>3. PRD 分析草稿</b>
                      <p>
                        分析视角：{(releaseWorkspaceOpen.prdAnalysis.perspectives || [releaseWorkspaceOpen.prdAnalysis.perspective || "前端开发"]).join("、")}
                        {` · 产出角色：${(releaseWorkspaceOpen.prdAnalysis.deliveryRoles || []).join("、") || "按分析视角"}`}
                        {releaseWorkspaceOpen.prdAnalysis.source === "fallback" ? " · 本地草稿（Codex 未返回）" : " · Codex 分析"}
                        {` · ${releaseWorkspaceOpen.prdAnalysis.summary}`}
                      </p>
                    </div>
                    <div className="prd-schedule-actions">
                      <Button size="small" onClick={importReleaseSchedule}>导入排期 CSV</Button>
                      <Button size="small" onClick={exportReleaseSchedule}>导出版本排期</Button>
                    </div>
                  </header>
                  <div className="analysis-feedback">
                    <label>
                      给 AI 补充意见
                      <Input.TextArea
                        autoSize={{ minRows: 2, maxRows: 5 }}
                        value={analysisFeedback}
                        onChange={(event) => setAnalysisFeedback(event.target.value)}
                        placeholder="例如：不拆后端任务；将入口与权限合成一项；先处理移动端；补充异常状态。"
                      />
                    </label>
                    <Button loading={analysingPrd} onClick={analysePrd}>
                      按意见重新分析
                    </Button>
                  </div>
                  <div className="analysis-task-list">
                    {releaseWorkspaceOpen.prdAnalysis.proposals.map((item) => (
                      <article key={item.key}>
                        <Checkbox checked={item.selected !== false} onChange={() => patchAnalysisProposal(item.key, { selected: item.selected === false })}>纳入</Checkbox>
                        <div className="analysis-task-summary">
                          <b><code className="analysis-task-key">{item.key}</code>{item.title}</b>
                          <small>{item.role} · {item.stage}{item.startDate || item.endDate ? ` · ${item.startDate || "未排期"} 至 ${item.endDate || "未排期"}` : " · 未排期"}</small>
                          <p><span>任务说明</span>{item.goal || "暂未补充任务说明"}</p>
                          <p><span>验收标准</span>{item.acceptance || "暂未补充验收标准"}</p>
                          {item.dependencies?.length > 0 && (
                            <p className="analysis-task-dependencies"><span>依赖</span>{item.dependencies.join("、")}</p>
                          )}
                        </div>
                        <Button size="small" onClick={() => setEditingAnalysisTask({ ...item })}>查看 / 编辑</Button>
                        {item.createdTaskId && tasks.some((task) => task.id === item.createdTaskId) && (
                          <small className="analysis-created">已创建：{item.createdTaskId}</small>
                        )}
                      </article>
                    ))}
                  </div>
                </section>
              )}
              <section className="release-workspace-section version-task-board">
                <header>
                  <div>
                    <b>版本任务看板</b>
                    <small>真实执行、验证、复核状态会自动覆盖手动阶段</small>
                  </div>
                  {releaseWorkspaceOpen.prdAnalysis && tasksForRelease(releaseWorkspaceOpen.id).some((task) => releaseWorkspaceOpen.prdAnalysis.proposals?.some((proposal) => proposal.createdTaskId === task.id)) && (
                    <Button danger size="small" onClick={deleteReleaseAnalysisTasks}>删除 AI 分析任务</Button>
                  )}
                </header>
                <div className="mini-task-board">
                  {visibleTaskStages.map((stage) => {
                    const items = tasksForRelease(
                      releaseWorkspaceOpen.id,
                    ).filter((task) => (task.taskStage || "待开发") === stage);
                    return (
                      <div key={stage}>
                        <b>{stage}</b>
                        {items.map((task) => (
                          <article
                            key={task.id}
                            onClick={() => {
                              setSelectedId(task.id);
                              setView("tasks");
                              setReleaseWorkspaceOpen(null);
                            }}
                          >
                            <strong>{task.title}</strong>
                            <small>
                              {task.role} · {task.status}
                            </small>
                            <Select
                              size="small"
                              value={task.taskStage || "待开发"}
                              disabled={[
                                "执行中",
                                "待复核",
                                "已完成",
                                "已阻塞",
                              ].includes(task.status)}
                              onClick={(event) => event.stopPropagation()}
                              options={visibleTaskStages.map(
                                (value) => ({ value, label: value }),
                              )}
                              onChange={(value) => updateTaskStage(task, value)}
                            />
                          </article>
                        ))}
                        {!items.length && (
                          <span className="empty-inline">暂无任务</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
              </div>
              <footer className="modal-actions modal-fixed-footer">
                <Button onClick={saveReleaseWorkspace}>保存 PRD 与附件</Button>
                <span></span>
                {releaseWorkspaceOpen.prdAnalysis && (
                  <Button onClick={savePrdAnalysisDraft}>
                    保存任务草稿
                  </Button>
                )}
                {releaseWorkspaceOpen.prdAnalysis && (
                  <Button
                    type="primary"
                    disabled={analysisDraftDirty}
                    onClick={createTasksFromAnalysis}
                  >
                    创建已选任务
                  </Button>
                )}
              </footer>
            </section>
          </div>
        )}
        {editingAnalysisTask && (
          <Modal
            open
            centered
            getContainer={() => document.body}
            title="编辑任务草稿"
            okText="完成"
            cancelText="取消"
            width={680}
            onCancel={() => setEditingAnalysisTask(null)}
            onOk={() => {
              patchAnalysisProposal(editingAnalysisTask.key, editingAnalysisTask);
              setEditingAnalysisTask(null);
            }}
          >
            <div className="analysis-task-editor">
              <label>任务名称<Input value={editingAnalysisTask.title || ""} onChange={(event) => setEditingAnalysisTask({ ...editingAnalysisTask, title: event.target.value })} /></label>
              <div className="analysis-task-editor-grid">
                <label>执行角色<Select value={editingAnalysisTask.role} options={["产品专家", "UI/UX 专家", "前端专家", "后端专家", "测试专家", "全栈工程师"].map((value) => ({ value, label: value }))} onChange={(role) => setEditingAnalysisTask({ ...editingAnalysisTask, role })} /></label>
                <label>任务阶段<Select value={editingAnalysisTask.stage} options={visibleTaskStages.map((value) => ({ value, label: value }))} onChange={(stage) => setEditingAnalysisTask({ ...editingAnalysisTask, stage })} /></label>
                <label>计划开始<DatePicker allowClear placement="topLeft" getPopupContainer={() => document.body} value={editingAnalysisTask.startDate ? dayjs(editingAnalysisTask.startDate) : null} onChange={(date) => setEditingAnalysisTask({ ...editingAnalysisTask, startDate: date ? date.format("YYYY-MM-DD") : "" })} /></label>
                <label>计划结束<DatePicker allowClear placement="topLeft" getPopupContainer={() => document.body} disabledDate={(date) => Boolean(editingAnalysisTask.startDate) && date.startOf("day").isBefore(dayjs(editingAnalysisTask.startDate), "day")} value={editingAnalysisTask.endDate ? dayjs(editingAnalysisTask.endDate) : null} onChange={(date) => setEditingAnalysisTask({ ...editingAnalysisTask, endDate: date ? date.format("YYYY-MM-DD") : "" })} /></label>
              </div>
              <label>任务说明<Input.TextArea autoSize={{ minRows: 3, maxRows: 7 }} value={editingAnalysisTask.goal || ""} onChange={(event) => setEditingAnalysisTask({ ...editingAnalysisTask, goal: event.target.value })} /></label>
              <label>
                调用接口
                {releaseWorkspaceOpen?.apifox?.definitions?.length ? (
                  <Select
                    mode="multiple"
                    allowClear
                    placeholder="选择该功能需要调用的接口（可多选）"
                    value={editingAnalysisTask.apiKeys || []}
                    options={releaseWorkspaceOpen.apifox.definitions.map((api) => ({
                      value: `${api.method} ${api.path}`,
                      label: `${api.method} ${api.path}${api.summary ? ` · ${api.summary}` : ""}`,
                    }))}
                    onChange={(apiKeys) => setEditingAnalysisTask({ ...editingAnalysisTask, apiKeys })}
                  />
                ) : (
                  <small className="field-hint">当前版本尚未同步 Apifox 接口；可先填写下方的接口约定，之后再到任务详情中关联已同步接口。</small>
                )}
              </label>
              <label>接口与联调说明<Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} value={editingAnalysisTask.apiNotes || ""} placeholder="例如：GET /api/history 需支持分页和时间筛选；确认错误码、字段映射及联调环境。" onChange={(event) => setEditingAnalysisTask({ ...editingAnalysisTask, apiNotes: event.target.value })} /></label>
              <label>验收标准<Input.TextArea autoSize={{ minRows: 3, maxRows: 7 }} placeholder={"用户可见结果：…\n验证与边界：…"} value={editingAnalysisTask.acceptance || ""} onChange={(event) => setEditingAnalysisTask({ ...editingAnalysisTask, acceptance: event.target.value })} /></label>
              <AcceptanceGuidance />
              {editingAnalysisTask.dependencies?.length > 0 && <p>依赖：{editingAnalysisTask.dependencies.join("、")}</p>}
            </div>
          </Modal>
        )}
        {releaseStageSettingsOpen && (
          <div className="modal-backdrop" role="presentation">
            <section
              className="modal modal-fixed-layout stage-settings-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="stage-settings-title"
            >
              <header className="modal-fixed-header">
                <button
                  className="modal-close"
                  onClick={() => setReleaseStageSettingsOpen(false)}
                  aria-label="关闭阶段配置"
                >
                  ×
                </button>
                <div className="modal-kicker">项目级研发流程</div>
                <h2 id="stage-settings-title">配置版本阶段</h2>
                <p className="description">
                  阶段顺序同时决定看板列和版本推进顺序。取消展示只会隐藏列，不会移动已有版本。
                </p>
              </header>
              <div className="modal-fixed-scroll">
              <div className="stage-settings-list">
                {releaseStageDraft.map((stage, index) => (
                  <div className="stage-settings-row" key={stage.name}>
                    <label className="stage-visible">
                      <input
                        type="checkbox"
                        checked={stage.visible}
                        onChange={(event) =>
                          setReleaseStageDraft((stages) =>
                            stages.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, visible: event.target.checked }
                                : item,
                            ),
                          )
                        }
                      />
                      <span>{stage.visible ? "展示" : "隐藏"}</span>
                    </label>
                    <b>{stage.name}</b>
                    <div className="stage-order-actions">
                      <button
                        className="outline"
                        aria-label={`上移 ${stage.name}`}
                        disabled={index === 0}
                        onClick={() => moveReleaseStage(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        className="outline"
                        aria-label={`下移 ${stage.name}`}
                        disabled={index === releaseStageDraft.length - 1}
                        onClick={() => moveReleaseStage(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        className="outline danger"
                        aria-label={`删除 ${stage.name}`}
                        disabled={releaseStageDraft.length <= 1}
                        onClick={() =>
                          setReleaseStageDraft((stages) =>
                            stages.filter(
                              (_, itemIndex) => itemIndex !== index,
                            ),
                          )
                        }
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="add-stage-row">
                <input
                  value={newReleaseStage}
                  onChange={(event) => setNewReleaseStage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      const name = newReleaseStage.trim();
                      if (
                        name &&
                        !releaseStageDraft.some((stage) => stage.name === name)
                      ) {
                        setReleaseStageDraft((stages) => [
                          ...stages,
                          { name, visible: true },
                        ]);
                        setNewReleaseStage("");
                      }
                    }
                  }}
                  placeholder="例如：安全 / 合规评审"
                />
                <button
                  className="outline"
                  onClick={() => {
                    const name = newReleaseStage.trim();
                    if (!name) return;
                    if (releaseStageDraft.some((stage) => stage.name === name))
                      return setToast("阶段名称不能重复");
                    setReleaseStageDraft((stages) => [
                      ...stages,
                      { name, visible: true },
                    ]);
                    setNewReleaseStage("");
                  }}
                >
                  + 添加阶段
                </button>
              </div>
              </div>
              <footer className="modal-actions">
                <button
                  className="outline"
                  onClick={() => setReleaseStageSettingsOpen(false)}
                >
                  取消
                </button>
                <span></span>
                <button className="primary" onClick={saveReleaseStages}>
                  保存阶段配置
                </button>
              </footer>
            </section>
          </div>
        )}
        {taskStageSettingsOpen && (
          <div className="modal-backdrop" role="presentation">
            <section className="modal modal-fixed-layout stage-settings-modal" role="dialog" aria-modal="true" aria-labelledby="task-stage-settings-title">
              <header className="modal-fixed-header">
                <button className="modal-close" onClick={() => setTaskStageSettingsOpen(false)} aria-label="关闭任务阶段配置">×</button>
                <div className="modal-kicker">项目级任务流转</div>
                <h2 id="task-stage-settings-title">配置任务阶段</h2>
                <p className="description">此处只管理任务从待澄清到完成的流转阶段，不影响版本研发阶段。</p>
              </header>
              <div className="modal-fixed-scroll">
              <div className="stage-settings-list">
                {taskStageDraft.map((stage, index) => (
                  <div className="stage-settings-row" key={`${stage}-${index}`}>
                    <Input size="small" value={stage} disabled={isSystemTaskStage(stage)} onChange={(event) => setTaskStageDraft((stages) => stages.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} />
                    <div className="stage-order-actions">
                      <Button size="small" disabled={index === 0 || isSystemTaskStage(stage)} onClick={() => setTaskStageDraft((stages) => { const next = [...stages]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}>↑</Button>
                      <Button size="small" disabled={index === taskStageDraft.length - 1 || isSystemTaskStage(stage)} onClick={() => setTaskStageDraft((stages) => { const next = [...stages]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; return next; })}>↓</Button>
                      <Button danger size="small" disabled={taskStageDraft.length <= 1 || isSystemTaskStage(stage)} onClick={() => setTaskStageDraft((stages) => stages.filter((_, itemIndex) => itemIndex !== index))}>删除</Button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="add-stage-row">
                <Input size="small" value={newTaskStage} onChange={(event) => setNewTaskStage(event.target.value)} placeholder="例如：等待接口" />
                <Button size="small" onClick={() => { const stage = newTaskStage.trim(); if (!stage) return; if (taskStageDraft.includes(stage)) return setToast("任务阶段名称不能重复"); setTaskStageDraft((stages) => [...stages, stage]); setNewTaskStage(""); }}>添加阶段</Button>
              </div>
              </div>
              <footer className="modal-actions"><Button onClick={() => setTaskStageSettingsOpen(false)}>取消</Button><span></span><Button type="primary" onClick={saveTaskStages}>保存任务阶段</Button></footer>
            </section>
          </div>
        )}
        {projectModalOpen && (
          <div className="modal-backdrop" role="presentation">
            <section
              className="modal project-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="project-title"
            >
              <button
                className="modal-close"
                onClick={() => setProjectModalOpen(false)}
                aria-label="关闭添加项目"
              >
                ×
              </button>
              <div className="modal-kicker">接入本机项目</div>
              <h2 id="project-title">添加项目</h2>
              <p className="description">
                选择本机项目文件夹。系统会自动检查 Git 和项目上下文；有
                Git 提交时，任务会创建独立 worktree。
              </p>
              <div className="form-stack">
                <div className="project-picker-field">
                  <div>
                    <b>项目文件夹</b>
                    <span>
                      {projectPath
                        ? "已选择，确认后将接入此项目"
                        : "请选择要接入的本机项目文件夹"}
                    </span>
                  </div>
                  <Button
                    type={projectPath ? "default" : "primary"}
                    onClick={pickProjectFolder}
                    loading={projectPicking}
                  >
                    {projectPath ? "重新选择文件夹" : "选择文件夹"}
                  </Button>
                </div>
                {projectPath && (
                  <div className="selected-project-path" title={projectPath}>
                    <b>已选路径</b>
                    <code>{projectPath}</code>
                  </div>
                )}
                {discovery.contextFiles.length > 0 && (
                  <div className="discovery-card">
                    <b>已发现项目上下文</b>
                    <span>{discovery.contextFiles.join(" · ")}</span>
                    <small>
                      {discovery.scripts.length
                        ? `可用 npm scripts：${discovery.scripts.join("、")}`
                        : "未发现 package.json 脚本"}
                    </small>
                  </div>
                )}
              </div>
              <footer className="modal-actions">
                <button
                  className="outline"
                  onClick={() => setProjectModalOpen(false)}
                >
                  取消
                </button>
                <span></span>
                <button
                  className="primary"
                  onClick={addProject}
                  disabled={!projectPath}
                >
                  验证并添加
                </button>
              </footer>
            </section>
          </div>
        )}
        {policyOpen && (
          <div className="modal-backdrop" role="presentation">
            <section
              className="modal modal-fixed-layout policy-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="policy-title"
            >
              <header className="modal-fixed-header">
                <button
                  className="modal-close"
                  onClick={() => setPolicyOpen(false)}
                  aria-label="关闭项目规则"
                >
                  ×
                </button>
                <div className="modal-kicker">
                  {project?.name || "当前项目"} · 执行规范
                </div>
                <h2 id="policy-title">项目规则与 Skills</h2>
                <p className="description">
                  这些设置只在 Flight Deck
                  创建的新任务中生效，并会在任务创建时保存快照。
                </p>
              </header>
              <div className="modal-fixed-scroll">
              <div className="form-stack">
                <label>
                  项目规则
                  <Input.TextArea
                    value={policyDraft.rules}
                    onChange={(event) =>
                      setPolicyDraft({
                        ...policyDraft,
                        rules: event.target.value,
                      })
                    }
                    placeholder="例如：改动接口前先检查权限；禁止修改支付结算核心目录…"
                    autoSize={{ minRows: 3, maxRows: 7 }}
                  />
                </label>
                <label>
                  工程规范
                  <Input.TextArea
                    value={policyDraft.standards}
                    onChange={(event) =>
                      setPolicyDraft({
                        ...policyDraft,
                        standards: event.target.value,
                      })
                    }
                    placeholder="例如：TypeScript 严格模式；新增接口须有单测；组件遵守现有设计系统…"
                    autoSize={{ minRows: 3, maxRows: 7 }}
                  />
                </label>
                <label>
                  固定验证命令（可选）
                  <Input
                    value={policyDraft.verificationCommand}
                    onChange={(event) =>
                      setPolicyDraft({
                        ...policyDraft,
                        verificationCommand: event.target.value,
                      })
                    }
                    placeholder="npm run test"
                  />
                  <small>
                    仅允许 npm run &lt;script&gt;。不填则按 test → check → build
                    自动选择。
                  </small>
                </label>
                <div className="skill-picker">
                  <b>启用已安装的 Codex Skills</b>
                  <span>
                    启用后会将规则快照写入新任务提示词。缺失的推荐 Skill
                    会明确标识；为避免静默安装未知代码，需从项目页确认来源后再安装。
                  </span>
                  {discovery.skillHealth?.length > 0 && (
                    <div className="skill-health-list">
                      {discovery.skillHealth.map((skill) => (
                        <div
                          key={skill.id}
                          className={skill.installed ? "healthy" : "missing"}
                        >
                          <span>{skill.installed ? "✓" : "!"}</span>
                          <p>
                            <b>${skill.id}</b>
                            <small>
                              {skill.label} ·{" "}
                              {skill.installed ? "已安装" : "尚未安装"}
                            </small>
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                  {(discovery.skills.length
                    ? discovery.skills
                    : ["manage-taskboard", "dashi-ppt", "task-handoff"]
                  ).map((skill) => (
                    <Checkbox
                      key={skill}
                        checked={policyDraft.skills.includes(skill)}
                        onChange={() =>
                          setPolicyDraft({
                            ...policyDraft,
                            skills: policyDraft.skills.includes(skill)
                              ? policyDraft.skills.filter(
                                  (item) => item !== skill,
                                )
                              : [...policyDraft.skills, skill],
                          })
                        }
                    >
                      ${skill}
                    </Checkbox>
                  ))}
                </div>
              </div>
              </div>
              <footer className="modal-actions">
                <Button
                  onClick={() => setPolicyOpen(false)}
                  disabled={savingPolicy}
                >
                  取消
                </Button>
                <span></span>
                <Button type="primary" onClick={savePolicy} loading={savingPolicy}>
                  保存项目规则
                </Button>
              </footer>
            </section>
          </div>
        )}
        {knowledgeOpen && (
          <div className="modal-backdrop" role="presentation">
            <section
              className="modal knowledge-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="knowledge-title"
            >
              <button
                className="modal-close"
                onClick={() => setKnowledgeOpen(false)}
                aria-label="关闭本地知识库"
              >
                ×
              </button>
              <div className="modal-kicker">
                {project?.name || "当前项目"} · 本地优先
              </div>
              <h2 id="knowledge-title">项目知识库</h2>
              <p className="description">
                文档、PRD 摘要、接口约定和手工备注只保存在本机
                SQLite；保存时生成本地向量，可按语义检索后作为任务上下文。
              </p>
              <div className="knowledge-grid">
                <section className="knowledge-editor">
                  <b>新增知识</b>
                  <input
                    value={knowledgeDraft.title}
                    onChange={(event) =>
                      setKnowledgeDraft({
                        ...knowledgeDraft,
                        title: event.target.value,
                      })
                    }
                    placeholder="标题，例如：退款接口约定"
                  />
                  <input
                    value={knowledgeDraft.source}
                    onChange={(event) =>
                      setKnowledgeDraft({
                        ...knowledgeDraft,
                        source: event.target.value,
                      })
                    }
                    placeholder="来源，例如：PRD v2 / Apifox"
                  />
                  <input
                    value={knowledgeDraft.tags}
                    onChange={(event) =>
                      setKnowledgeDraft({
                        ...knowledgeDraft,
                        tags: event.target.value,
                      })
                    }
                    placeholder="标签，用逗号分隔"
                  />
                  <textarea
                    value={knowledgeDraft.content}
                    onChange={(event) =>
                      setKnowledgeDraft({
                        ...knowledgeDraft,
                        content: event.target.value,
                      })
                    }
                    placeholder="粘贴或手动输入项目知识、接口说明、设计约束、验收标准…"
                  />
                  <button className="primary" onClick={saveKnowledge}>
                    保存并本地向量化
                  </button>
                </section>
                <section className="knowledge-browser">
                  <div className="knowledge-search">
                    <input
                      value={knowledgeQuery}
                      onChange={(event) =>
                        setKnowledgeQuery(event.target.value)
                      }
                      onKeyDown={(event) =>
                        event.key === "Enter" && searchKnowledge()
                      }
                      placeholder="搜索本地知识"
                    />
                    <button className="outline" onClick={searchKnowledge}>
                      搜索
                    </button>
                  </div>
                  <div className="knowledge-list">
                    {(knowledgeResults.length
                      ? knowledgeResults
                      : knowledgeDocs
                    ).map((document) => (
                      <article key={document.id}>
                        <div>
                          <b>
                            {document.title}{" "}
                            <em className="knowledge-version">
                              v{document.version || 1}
                            </em>
                          </b>
                          <small>
                            {document.source} ·{" "}
                            {(document.tags || []).join("、") || "未分类"}
                          </small>
                          <p>{document.excerpt}</p>
                        </div>
                        <span className="knowledge-actions">
                          <button
                            className="outline"
                            onClick={() => openKnowledgeVersions(document)}
                          >
                            版本
                          </button>
                          <button
                            className="danger-text"
                            onClick={() => removeKnowledge(document.id)}
                          >
                            删除条目
                          </button>
                        </span>
                      </article>
                    ))}
                    {!(
                      knowledgeResults.length ? knowledgeResults : knowledgeDocs
                    ).length && (
                      <p className="empty-inline">
                        还没有本地知识。建议先录入 PRD、设计约束或接口说明。
                      </p>
                    )}
                  </div>
                </section>
              </div>
            </section>
          </div>
        )}
        {knowledgeVersionDoc && (
          <div className="modal-backdrop" role="presentation">
            <section
              className="modal knowledge-version-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="knowledge-version-title"
            >
              <button
                className="modal-close"
                onClick={() => setKnowledgeVersionDoc(null)}
                aria-label="关闭知识版本"
              >
                ×
              </button>
              <div className="modal-kicker">需求变更记录 · 本地优先</div>
              <h2 id="knowledge-version-title">
                {knowledgeVersionDoc.title} 的版本
              </h2>
              <p className="description">
                保存更新会生成新版本。选择任意两个版本可查看增加、删除的需求内容；当前版本不可删除。
              </p>
              <div className="knowledge-version-grid">
                <section className="knowledge-version-list">
                  {knowledgeVersions.map((item, index) => (
                    <article key={item.version}>
                      <div>
                        <b>
                          v{item.version}{" "}
                          {index === 0 && (
                            <em className="knowledge-version">当前</em>
                          )}
                        </b>
                        <small>
                          {new Date(
                            item.updatedAt || item.createdAt,
                          ).toLocaleString("zh-CN")}{" "}
                          · {item.source}
                        </small>
                        <p>{item.excerpt}</p>
                      </div>
                      {index > 0 && (
                        <button
                          className="danger-text"
                          onClick={() => removeKnowledgeVersion(item.version)}
                        >
                          删除 v{item.version}
                        </button>
                      )}
                    </article>
                  ))}
                </section>
                <section className="knowledge-compare">
                  <b>编辑当前需求</b>
                  <textarea
                    className="knowledge-revision-input"
                    value={knowledgeVersionDoc.content}
                    onChange={(event) =>
                      setKnowledgeVersionDoc({
                        ...knowledgeVersionDoc,
                        content: event.target.value,
                      })
                    }
                  />
                  <button className="primary" onClick={saveKnowledgeRevision}>
                    保存为 v{(knowledgeVersionDoc.version || 1) + 1}
                  </button>
                  <b>版本对比</b>
                  <div className="knowledge-compare-pickers">
                    <Select
                      value={knowledgeCompareFrom}
                      options={knowledgeVersions.map((item) => ({ value: `${item.version}`, label: `v${item.version}` }))}
                      onChange={setKnowledgeCompareFrom}
                    />
                    <span>→</span>
                    <Select
                      value={knowledgeCompareTo}
                      options={knowledgeVersions.map((item) => ({ value: `${item.version}`, label: `v${item.version}` }))}
                      onChange={setKnowledgeCompareTo}
                    />
                    <button
                      className="outline"
                      disabled={
                        !knowledgeCompareFrom ||
                        !knowledgeCompareTo ||
                        knowledgeCompareFrom === knowledgeCompareTo
                      }
                      onClick={() =>
                        compareKnowledgeVersions(
                          knowledgeCompareFrom,
                          knowledgeCompareTo,
                        )
                      }
                    >
                      比较
                    </button>
                  </div>
                  {knowledgeComparison ? (
                    <div className="knowledge-diff">
                      <h3>
                        v{knowledgeComparison.from.version} → v
                        {knowledgeComparison.to.version}
                      </h3>
                      <div>
                        <b>新增 {knowledgeComparison.added.length}</b>
                        {knowledgeComparison.added.length ? (
                          knowledgeComparison.added.map((line, index) => (
                            <p className="diff-added" key={`a-${index}`}>
                              + {line || "（空行）"}
                            </p>
                          ))
                        ) : (
                          <p>没有新增内容</p>
                        )}
                      </div>
                      <div>
                        <b>删除 {knowledgeComparison.removed.length}</b>
                        {knowledgeComparison.removed.length ? (
                          knowledgeComparison.removed.map((line, index) => (
                            <p className="diff-removed" key={`r-${index}`}>
                              − {line || "（空行）"}
                            </p>
                          ))
                        ) : (
                          <p>没有删除内容</p>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className="empty-inline">
                      请选择两个不同的版本进行比较。
                    </p>
                  )}
                </section>
              </div>
            </section>
          </div>
        )}
        {apifoxConfigOpen && (
          <div className="modal-backdrop" role="presentation">
            <section
              className="modal apifox-config-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="apifox-config-title"
            >
              <button
                className="modal-close"
                onClick={() => setApifoxConfigOpen(false)}
                aria-label="关闭 Apifox 配置"
              >
                ×
              </button>
              <div className="modal-kicker">
                {project?.name || "当前项目"} · 只读接口同步
              </div>
              <h2 id="apifox-config-title">Apifox 配置</h2>
              <p className="description">
                Project ID 会保存在 Flight Deck 本地项目配置；个人 Token
                仅保存在 macOS 钥匙串，页面与数据库不会显示或保存明文。
              </p>
              <div className="form-stack">
                <label>
                  Apifox Project ID 或项目地址
                  <input
                    value={apifoxConfig.projectId}
                    onChange={(event) =>
                      setApifoxConfig({
                        ...apifoxConfig,
                        projectId: event.target.value,
                      })
                    }
                    placeholder="7917093 或 https://app.apifox.com/project/7917093"
                  />
                </label>
                <label>
                  个人访问 Token
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={apifoxConfig.token}
                    onChange={(event) =>
                      setApifoxConfig({
                        ...apifoxConfig,
                        token: event.target.value,
                      })
                    }
                    placeholder={
                      apifoxConfig.configured
                        ? "已配置；留空则不修改"
                        : "粘贴 Apifox 访问 Token"
                    }
                  />
                  <small>
                    {apifoxConfig.configured
                      ? "已检测到本机钥匙串中的 Token。"
                      : "尚未配置 Token；保存后可在版本页一键只读同步。"}
                  </small>
                </label>
              </div>
              <footer className="modal-actions">
                <button
                  className="outline"
                  onClick={() => setApifoxConfigOpen(false)}
                >
                  取消
                </button>
                <span></span>
                <button className="primary" onClick={saveApifoxConfig}>
                  保存配置
                </button>
              </footer>
            </section>
          </div>
        )}
        {revisionOpen && selected && (
          <div className="modal-backdrop" role="presentation">
            <section
              className="modal revision-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="revision-title"
            >
              <button
                className="modal-close"
                onClick={() => setRevisionOpen(false)}
                disabled={revising}
                aria-label="关闭增量修改"
              >
                ×
              </button>
              <div className="modal-kicker">增量修改 · 保留已有交付</div>
              <h2 id="revision-title">补充修改意见</h2>
              <p className="description">
                Codex 会在当前任务 worktree 中继续修改。已有代码、diff
                和验证记录都会保留，不会重新生成整个任务。
              </p>
              <div className="revision-context">
                <b>本次只处理</b>
                <span>与下方意见直接相关的文件和最小验证。</span>
                {selected.evidence?.verification?.command && (
                  <small>
                    可复用的上一轮验证：{selected.evidence.verification.command}
                  </small>
                )}
              </div>
              <label className="revision-input">
                需要修改什么
                <textarea
                  autoFocus
                  value={revisionFeedback}
                  onChange={(event) => setRevisionFeedback(event.target.value)}
                  placeholder="例如：欢迎页标题在窄屏换行，请只调整该组件的响应式样式，并保留现有布局。"
                  disabled={revising}
                />
              </label>
              <footer className="modal-actions">
                <button
                  className="outline"
                  onClick={() => setRevisionOpen(false)}
                  disabled={revising}
                >
                  取消
                </button>
                <span></span>
                <button
                  className="primary"
                  onClick={submitRevision}
                  disabled={revising || !revisionFeedback.trim()}
                >
                  {revising ? "正在启动…" : "开始增量修改"}
                </button>
              </footer>
            </section>
          </div>
        )}
        {taskPlanEditorOpen && selected && taskPlanDraft && (
          <div className="modal-backdrop" role="presentation">
            <section className="modal revision-modal task-plan-modal" role="dialog" aria-modal="true" aria-labelledby="task-plan-title">
              <header className="task-plan-header">
                <button className="modal-close" onClick={() => setTaskPlanEditorOpen(false)} disabled={revising} aria-label="关闭任务定义">×</button>
                <div className="modal-kicker">编辑任务计划 · 尚未启动 Codex</div>
                <h2 id="task-plan-title">修改任务定义</h2>
                <p className="description">这里修改的目标、验收、接口和排期会替换原计划；首次启动时，Codex 只会读取这份最新任务定义。</p>
              </header>
              <div className="task-plan-editor">
                <label>任务名称<Input autoFocus value={taskPlanDraft.title} onChange={(event) => setTaskPlanDraft({ ...taskPlanDraft, title: event.target.value })} disabled={revising} /></label>
                <div className="analysis-task-editor-grid">
                  <label>执行角色<Select value={taskPlanDraft.role} options={["产品专家", "UI/UX 专家", "前端专家", "后端专家", "测试专家", "全栈工程师"].map((value) => ({ value, label: value }))} onChange={(role) => setTaskPlanDraft({ ...taskPlanDraft, role })} disabled={revising} /></label>
                  <label>任务阶段<Select value={taskPlanDraft.taskStage} options={visibleTaskStages.map((value) => ({ value, label: value }))} onChange={(taskStage) => setTaskPlanDraft({ ...taskPlanDraft, taskStage })} disabled={revising} /></label>
                  <label>优先级<Select value={taskPlanDraft.priority} options={["低", "普通", "高", "紧急"].map((value) => ({ value, label: value }))} onChange={(priority) => setTaskPlanDraft({ ...taskPlanDraft, priority })} disabled={revising} /></label>
                  <label>所属版本<Select allowClear value={taskPlanDraft.versionId || undefined} placeholder="未关联版本" options={releases.filter((release) => release.projectPath === selected.projectPath).map((release) => ({ value: release.id, label: release.name }))} onChange={(versionId) => setTaskPlanDraft({ ...taskPlanDraft, versionId: versionId || "", deliveryMode: versionId ? taskPlanDraft.deliveryMode : (taskPlanDraft.deliveryMode === "release" ? "task" : taskPlanDraft.deliveryMode) })} disabled={revising} /></label>
                  <label>交付方式<Select value={taskPlanDraft.deliveryMode} options={[...(taskPlanDraft.versionId ? [{ value: "release", label: "纳入版本统一合并（批量）" }] : []), { value: "task", label: "独立交付（可直接合并）" }, { value: "no-code", label: "无需代码交付" }]} onChange={(deliveryMode) => setTaskPlanDraft({ ...taskPlanDraft, deliveryMode })} disabled={revising} /></label>
                  <label>计划开始<DatePicker allowClear placement="topLeft" getPopupContainer={() => document.body} value={taskPlanDraft.startDate ? dayjs(taskPlanDraft.startDate) : null} onChange={(date) => setTaskPlanDraft({ ...taskPlanDraft, startDate: date ? date.format("YYYY-MM-DD") : "" })} disabled={revising} /></label>
                  <label>计划结束<DatePicker allowClear placement="topLeft" getPopupContainer={() => document.body} disabledDate={(date) => Boolean(taskPlanDraft.startDate) && date.startOf("day").isBefore(dayjs(taskPlanDraft.startDate), "day")} value={taskPlanDraft.endDate ? dayjs(taskPlanDraft.endDate) : null} onChange={(date) => setTaskPlanDraft({ ...taskPlanDraft, endDate: date ? date.format("YYYY-MM-DD") : "" })} disabled={revising} /></label>
                </div>
                <label>任务目标<Input.TextArea autoSize={{ minRows: 3, maxRows: 7 }} value={taskPlanDraft.description} onChange={(event) => setTaskPlanDraft({ ...taskPlanDraft, description: event.target.value })} disabled={revising} /></label>
                {taskPlanDraft.deliveryMode === "no-code" && <label>不开发原因<Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={taskPlanDraft.noCodeReason} placeholder="说明为什么无需代码交付。" onChange={(event) => setTaskPlanDraft({ ...taskPlanDraft, noCodeReason: event.target.value })} disabled={revising} /></label>}
                {selectedRelease?.apifox?.definitions?.length ? <label>调用接口<Select mode="multiple" allowClear placeholder="选择需要调用的接口（可多选）" value={taskPlanDraft.apiKeys} options={selectedApiOptions} onChange={(apiKeys) => setTaskPlanDraft({ ...taskPlanDraft, apiKeys })} disabled={revising} /></label> : <p className="field-hint">当前版本尚未同步 Apifox 接口；可填写接口与联调说明，后续仍可在任务详情关联接口。</p>}
                <label>接口与联调说明<Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} value={taskPlanDraft.apiNotes} placeholder="填写接口路径、字段映射、错误码、联调环境等约定。" onChange={(event) => setTaskPlanDraft({ ...taskPlanDraft, apiNotes: event.target.value })} disabled={revising} /></label>
                <label>验收标准<Input.TextArea autoSize={{ minRows: 3, maxRows: 7 }} placeholder={"用户可见结果：…\n验证与边界：…"} value={taskPlanDraft.acceptance} onChange={(event) => setTaskPlanDraft({ ...taskPlanDraft, acceptance: event.target.value })} disabled={revising} /></label>
                <AcceptanceGuidance />
              </div>
              <footer className="modal-actions">
                <button className="outline" onClick={() => setTaskPlanEditorOpen(false)} disabled={revising}>取消</button>
                <span></span>
                <button className="primary" onClick={saveTaskPlan} disabled={revising || !taskPlanDraft.title.trim() || !taskPlanDraft.description.trim() || !taskPlanDraft.acceptance.trim() || (taskPlanDraft.deliveryMode === "no-code" && !taskPlanDraft.noCodeReason.trim())}>{revising ? "正在保存…" : "保存任务计划"}</button>
              </footer>
            </section>
          </div>
        )}
        {queueControlOpen && (
          <Modal
            open
            centered
            width={760}
            title="执行队列"
            footer={null}
            onCancel={() => setQueueControlOpen(false)}
            closeIcon={<span aria-label="关闭执行队列">×</span>}
            className="queue-control-modal"
          >
            <p className="queue-control-description">按计划执行只会启动已到计划开始日期、依赖门禁已满足的任务。没有依赖或依赖已满足的任务可并行执行。</p>
            {queue.scheduleNotice && <p className="queue-schedule-notice" role="status">{queue.scheduleNotice}</p>}
            {dependencyBlockedTasks.length > 0 && (
              <div className="queue-blocker-action">
                <span>有 {dependencyBlockedTasks.length} 项任务正在等待前置交付。</span>
                <Button size="small" onClick={openFirstDependencyBlocker}>
                  查看首个阻塞任务
                </Button>
              </div>
            )}
            <div className="queue-summary-grid">
              <div><small>并发上限</small><b>{queue.concurrency}</b><span>当前设备最多 {queue.maxConcurrency} 项</span></div>
              <div><small>正在执行</small><b>{queue.running}</b><span>当前占用</span></div>
              <div><small>可立即启动</small><b>{queue.scheduled}</b><span>已排期且可运行</span></div>
              <div><small>剩余并发</small><b>{queue.capacity}</b><span>可新增执行</span></div>
            </div>
            <section className="queue-settings-section">
              <div><b>执行设置</b><small>暂停后可选择仅暂停后续任务，或同时安全停止当前任务；停止后均可恢复。</small></div>
              <div className="queue-settings-actions">
                <Select value={queue.concurrency} disabled={queueUpdating} options={Array.from({ length: queue.maxConcurrency }, (_, index) => index + 1).map((value) => ({ value, label: `${value} 项并发` }))} onChange={updateQueueConcurrency} />
                <Button danger={queue.paused} loading={queueUpdating} onClick={toggleQueue}>{queue.paused ? "恢复队列" : "暂停后续"}</Button>
                {!queue.paused && queue.running > 0 && <Button danger loading={queueUpdating} onClick={pauseQueueAndRunningTasks}>暂停后续并停止当前</Button>}
                <Button type="primary" disabled={queue.paused || queue.capacity === 0 || queue.scheduled === 0} onClick={runScheduledTasks}>按计划执行{queue.scheduled ? `（${Math.min(queue.scheduled, queue.capacity)} 项）` : ""}</Button>
              </div>
            </section>
            <section className="queue-task-section">
              <header><b>正在执行</b><span>{queue.runningTasks.length} 项</span></header>
              {queue.runningTasks.length ? <div className="queue-task-list">{queue.runningTasks.map((task) => <article key={task.id}><div><b>{task.title}</b><small>{task.id} · {task.role} · {task.activity}</small></div><Button danger size="small" onClick={() => stopQueueTask(task)}>暂停任务</Button></article>)}</div> : <p className="queue-empty">当前没有运行中的任务。</p>}
            </section>
            <section className="queue-task-section">
              <header><b>已暂停，可重启</b><span>{queue.pausedTasks.length} 项</span></header>
              {queue.pausedTasks.length ? <div className="queue-task-list">{queue.pausedTasks.map((task) => <article key={task.id}><div><b>{task.title}</b><small>{task.id} · {task.role} · {task.activity}</small></div><Button type="primary" size="small" disabled={!task.canRun || queue.running >= queue.concurrency} onClick={() => restartQueueTask(task)}>重新启动</Button></article>)}</div> : <p className="queue-empty">没有已暂停的任务。</p>}
            </section>
          </Modal>
        )}
        {attachmentPreview && (
          <Modal
            open
            centered
            width={attachmentPreview.previewable ? 880 : 760}
            title={attachmentPreview.name || attachmentPreview.url?.split(/[\\/]/).pop() || "文件预览"}
            footer={null}
            onCancel={() => setAttachmentPreview(null)}
            className="attachment-preview-modal"
          >
            {attachmentPreview.previewable ? (
              <img className="attachment-modal-image" src={`/api/context-files/preview?path=${encodeURIComponent(attachmentPreview.url)}`} alt={attachmentPreview.name || "附件图片预览"} />
            ) : (
              <MarkdownPreview content={attachmentPreview.content} expanded />
            )}
          </Modal>
        )}
        <Modal
          open={Boolean(taskDeletion)}
          centered
          title={taskDeletion?.hasExecutionHistory ? `删除任务记录“${taskDeletion?.title || ""}”？` : `删除任务“${taskDeletion?.title || ""}”？`}
          okText={deletingTask ? "正在删除…" : "确定删除"}
          cancelText="取消"
          okButtonProps={{ danger: true, loading: deletingTask }}
          cancelButtonProps={{ disabled: deletingTask }}
          onOk={confirmTaskDeletion}
          onCancel={() => !deletingTask && setTaskDeletion(null)}
          closable={!deletingTask}
          maskClosable={!deletingTask}
          keyboard={!deletingTask}
          className="task-deletion-modal"
        >
          <p>
            {taskDeletion?.hasExecutionHistory
              ? "该任务已有执行记录。删除后会从 Flight Deck 看板和依赖关系中移除；不会删除项目文件、Git 分支或 worktree，已有本地改动会保留在原目录。"
              : "将删除尚未启动的 Flight Deck 本地任务记录及其依赖关系；不会删除项目文件、Git 分支或 worktree。"}
          </p>
        </Modal>
        {toast && (
          <div className="toast" role="status">
            {toast}
            <button onClick={() => setToast("")}>×</button>
          </div>
        )}
      </div>
    </ConfigProvider>
  );
}
