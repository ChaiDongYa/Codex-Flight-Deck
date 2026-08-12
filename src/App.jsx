import { useEffect, useMemo, useState } from "react";
import "./styles.css";

const statusClass = {
  待开始: "ready",
  计划中: "planning",
  执行中: "running",
  待复核: "review",
  已阻塞: "blocked",
  等待依赖: "blocked",
};

function splitDiffFiles(diff = "") {
  return (diff.match(/^diff --git [\s\S]*?(?=^diff --git |$)/gm) || []).map(
    (section, index) => {
      const lines = section.split("\n");
      const match = lines[0]?.match(/^diff --git a\/(.+?) b\/(.+)$/);
      return {
        id: `${match?.[2] || index}-${index}`,
        path: match?.[2] || match?.[1] || `未命名变更 ${index + 1}`,
        lines,
      };
    });
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
      const row = { id: index, type: "addition", oldLine: "", newLine: newLine ?? "", text: line.slice(1) };
      if (newLine !== null) newLine += 1;
      return row;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      const row = { id: index, type: "deletion", oldLine: oldLine ?? "", newLine: "", text: line.slice(1) };
      if (oldLine !== null) oldLine += 1;
      return row;
    }

    if (line.startsWith(" ")) {
      const row = { id: index, type: "context", oldLine: oldLine ?? "", newLine: newLine ?? "", text: line.slice(1) };
      if (oldLine !== null) oldLine += 1;
      if (newLine !== null) newLine += 1;
      return row;
    }

    return { id: index, type: "meta", oldLine: "", newLine: "", text: line };
  });
}

export function App() {
  const [theme, setTheme] = useState(
    () => localStorage.getItem("flight-deck-theme") || "system",
  );
  const [tasks, setTasks] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [filter, setFilter] = useState("全部");
  const [filterOpen, setFilterOpen] = useState(false);
  const [project, setProject] = useState(null);
  const [projects, setProjects] = useState([]);
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [policyDraft, setPolicyDraft] = useState({
    rules: "",
    standards: "",
    skills: [],
    verificationCommand: "",
  });
  const [projectPath, setProjectPath] = useState("");
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
    automation: { autoRun: false, autoVerify: false },
  });
  const [reviewDetail, setReviewDetail] = useState(null);
  const [diffReviewOpen, setDiffReviewOpen] = useState(false);
  const [activeDiffFile, setActiveDiffFile] = useState(0);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState("");
  const [launching, setLaunching] = useState(false);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(420);
  const [resizingInspector, setResizingInspector] = useState(false);
  const [queue, setQueue] = useState({ paused: false, running: 0, queued: 0 });
  const [onlyActionable, setOnlyActionable] = useState(false);
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
          (filter === "全部" || task.status === filter) &&
          (!onlyActionable ||
            ["待开始", "计划中", "待复核", "已阻塞"].includes(task.status)) &&
          `${task.title} ${task.id}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [tasks, filter, query, allProjects, project],
  );
  const selected = visibleTasks.find((task) => task.id === selectedId) ?? null;
  const diffFiles = useMemo(
    () => splitDiffFiles(selected?.merge?.diff),
    [selected?.merge?.diff],
  );
  const activeDiff = diffFiles[activeDiffFile] ?? diffFiles[0];
  const activeDiffRows = useMemo(
    () => parseUnifiedDiff(activeDiff?.lines),
    [activeDiff],
  );
  const hasRunningTask = tasks.some((task) => task.codex?.state === "running");
  const executionEvents = selected?.execution?.events || [];

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
  const refreshQueue = async () => {
    const response = await fetch("/api/queue");
    if (response.ok) setQueue(await response.json());
  };
  useEffect(() => {
    refreshTasks().catch(() => setToast("无法读取本地 SQLite 数据库。"));
    refreshProjects().catch(() => setToast("无法读取真实 Git 项目。"));
    refreshQueue().catch(() => {});
  }, []);
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
        Math.min(640, Math.max(320, window.innerWidth - event.clientX)),
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
  const requestChanges = () =>
    runAction(selected.id, "return", "已退回计划，等待补充要求。");
  const acceptDelivery = () =>
    runAction(
      selected.id,
      "accept",
      "交付已接受；所有依赖它的任务会重新检查门禁。",
    );
  const runVerification = () =>
    runAction(
      selected.id,
      "verify",
      "已运行项目的真实验证命令，结果已写入交付证据。",
    );
  const retryTask = () =>
    runAction(
      selected.id,
      "retry",
      "已加入重试队列；会沿用原任务规则与 worktree。 ",
    );
  const stopCodexTask = async () => {
    if (
      !window.confirm(
        "停止当前 Codex 执行？\n\n已写入任务 worktree 的代码变更和执行日志会保留，不会自动合并到主项目。",
      )
    )
      return;
    await runAction(
      selected.id,
      "stop",
      "Codex 已停止；已有 worktree 变更已保留，可修改计划后重新执行。",
    );
  };
  const launchPreview = async () => {
    const response = await fetch(`/api/tasks/${selected.id}/preview`, {
      method: "POST",
    });
    const data = await response.json();
    if (!response.ok) return setToast(data.error);
    setTasks(data.tasks);
    window.open(data.task.preview.url, "_blank", "noopener,noreferrer");
    setToast(`已在任务 worktree 启动预览：${data.task.preview.url}`);
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
  const mergeDelivery = () =>
    runAction(
      selected.id,
      "merge",
      `已安全合并到 ${selected.merge?.targetBranch || "目标分支"}，任务 worktree 已保留。`,
    );
  const deleteSelectedTask = async () => {
    if (
      !window.confirm(
        `删除任务“${selected.title}”？\n\n只会删除 Flight Deck 本地任务记录和依赖关系，不会删除项目文件、Git 分支或 worktree。`,
      )
    )
      return;
    const response = await fetch(`/api/tasks/${selected.id}`, {
      method: "DELETE",
    });
    const data = await response.json();
    if (!response.ok) return setToast(data.error);
    setTasks(data.tasks);
    setSelectedId(null);
    setToast("任务已从 Flight Deck 本地记录中删除。");
  };
  const createDelivery = async () => {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...draft,
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
      automation: { autoRun: false, autoVerify: false },
    });
    setQuickMode(false);
    setToast(
      data.task.automation?.autoRun
        ? `已加入夜间自动队列：${data.task.title}`
        : `已创建 ${data.task.role} 任务，等待你确认计划。`,
    );
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
    const response = await fetch("/api/queue/toggle", { method: "POST" });
    const data = await response.json();
    if (!response.ok) return setToast(data.error);
    setQueue((current) => ({ ...current, paused: data.paused }));
    setToast(
      data.paused
        ? "夜间队列已暂停；运行中任务不会被中断。"
        : "夜间队列已恢复。",
    );
  };
  const savePolicy = async () => {
    const response = await fetch("/api/projects/policy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: project?.path, ...policyDraft }),
    });
    const data = await response.json();
    if (!response.ok) return setToast(data.error);
    setProject(data.project);
    setProjects((items) =>
      items.map((item) =>
        item.path === data.project.path ? data.project : item,
      ),
    );
    setPolicyOpen(false);
    setToast("项目规则已保存；新创建的任务会使用这份规则快照。");
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
    setProjectOpen(false);
    setToast(`当前项目：${data.project.name}`);
  };
  const pickProjectFolder = async () => {
    const response = await fetch("/api/projects/pick", { method: "POST" });
    const data = await response.json();
    if (!response.ok) return setToast("未选择文件夹。");
    setProjectPath(data.path);
  };

  const projectTasks = tasks.filter(
    (task) => allProjects || task.projectPath === project?.path,
  );
  const worktrees = projectTasks.filter((task) => task.status !== "已完成");
  const reviewTasks = projectTasks.filter((task) => task.status === "待复核");
  const cycleTheme = () => {
    const next = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
    setTheme(next);
    localStorage.setItem("flight-deck-theme", next);
  };
  if (!tasksLoaded)
    return (
      <div className="app-shell">
        <section className="workspace">
          <header className="topbar">
            <div className="project">正在读取本地任务数据…</div>
          </header>
          <main className="empty">正在加载 Flight Deck…</main>
        </section>
      </div>
    );
  return (
    <div className={`app-shell theme-${theme}`}>
      <section className="workspace">
        <header className="topbar">
          <div className="project-wrap">
            <button
              className={`project ${projectOpen ? "open" : ""}`}
              onClick={() => setProjectOpen((open) => !open)}
              title={allProjects ? "显示所有项目任务" : project?.path}
            >
              <span className="project-mark"></span>
              {allProjects
                ? "全部项目"
                : project
                  ? project.name
                  : "正在读取项目…"}
              <small>
                {!allProjects && project?.branch ? ` · ${project.branch}` : ""}
              </small>
              <span className="chevron">⌄</span>
            </button>
            {projectOpen && (
              <div className="project-menu" role="menu">
                <p>本机项目</p>
                <button
                  role="menuitem"
                  className={allProjects ? "chosen" : ""}
                  onClick={() => {
                    setAllProjects(true);
                    setProjectOpen(false);
                  }}
                >
                  <span className="project-mark"></span>全部项目
                  {allProjects && <b>✓</b>}
                </button>
                {projects.map((item) => (
                  <button
                    role="menuitem"
                    className={
                      !allProjects && project?.path === item.path
                        ? "chosen"
                        : ""
                    }
                    key={item.path}
                    onClick={() => chooseProject(item.path)}
                  >
                    <span className="project-mark"></span>
                    {item.name}
                    {!allProjects && project?.path === item.path && <b>✓</b>}
                  </button>
                ))}
                <div className="project-divider"></div>
                <button
                  className="new-project"
                  onClick={() => {
                    setProjectOpen(false);
                    setProjectModalOpen(true);
                  }}
                >
                  + 添加项目
                </button>
                <button className="new-project" onClick={openPolicy}>
                  ⚙ 项目规则与 Skills
                </button>
              </div>
            )}
          </div>
          <nav className="top-tabs" aria-label="Flight Deck 页面">
            <button
              className={view === "tasks" ? "active" : ""}
              onClick={() => setView("tasks")}
            >
              任务
            </button>
            <button
              className={view === "worktrees" ? "active" : ""}
              onClick={() => setView("worktrees")}
            >
              Worktrees <span>{worktrees.length}</span>
            </button>
            <button
              className={view === "reviews" ? "active" : ""}
              onClick={() => setView("reviews")}
            >
              复核 {reviewTasks.length > 0 && <span>{reviewTasks.length}</span>}
            </button>
          </nav>
          <label className="search">
            <span>⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索任务…"
            />
          </label>
          <button
            className="theme-control"
            onClick={cycleTheme}
            title="切换 Flight Deck 主题"
            aria-label="切换 Flight Deck 主题"
          >
            {theme === "system" ? "◐ 跟随系统" : theme === "dark" ? "☾ 深色" : "☀ 浅色"}
          </button>
          <button
            className={`queue-control ${queue.paused ? "paused" : ""}`}
            onClick={toggleQueue}
            title="夜间队列最多并行 2 项任务"
          >
            {queue.paused ? "▶ 恢复队列" : "Ⅱ 暂停队列"}{" "}
            <span>
              {queue.running}/{queue.queued}
            </span>
          </button>
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
                          "待复核",
                          "已阻塞",
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
                  <button
                    className={`outline actionable-filter ${onlyActionable ? "active" : ""}`}
                    onClick={() => setOnlyActionable((value) => !value)}
                    title="显示待开始、计划中、待复核和已阻塞的任务"
                  >
                    仅看待我处理
                  </button>
                </div>
              </div>
              <div className="table-head">
                <span>任务</span>
                <span>Worktree</span>
                <span>Codex 动态</span>
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
                        {task.status}
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
                    <span className="worktree">
                      {task.worktree}
                      <small>
                        {task.codex?.head || task.merge?.commit || "尚未创建"}
                      </small>
                    </span>
                    <span className="activity">{task.activity}</span>
                    <span className={`test ${task.testTone}`}>{task.test}</span>
                  </button>
                ))}
              </div>
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
                <aside className="inspector">
                  <button
                    className="close"
                    title="关闭详情"
                    onClick={() => setSelectedId(null)}
                  >
                    ×
                  </button>
                  <div className="inspector-status">
                    <i
                      className={`status ${statusClass[selected.status] ?? "done"}`}
                    >
                      {selected.status}
                    </i>
                  </div>
                  <h2>{selected.title}</h2>
                  <p className="role-badge">{selected.role || "全栈工程师"}</p>
                  <p className="description">{selected.description}</p>
                  <section>
                    <h3>摘要</h3>
                    <p>
                      {selected.summary?.headline ||
                        "尚未产生交付摘要；启动后会汇总执行、验证与变更。"}
                    </p>
                    {selected.summary?.details?.length > 0 && (
                      <ul className="delivery-summary">
                        {selected.summary.details.map((detail) => (
                          <li key={detail}>✓ {detail}</li>
                        ))}
                      </ul>
                    )}
                  </section>
                  {selected.projectPolicy && (
                    <section className="policy-summary">
                      <h3>任务使用的项目规范</h3>
                      <p>
                        {selected.projectPolicy.rules || "未配置额外项目规则。"}
                      </p>
                      {selected.projectPolicy.skills?.length > 0 && (
                        <small>
                          Skills：
                          {selected.projectPolicy.skills
                            .map((skill) => `$${skill}`)
                            .join(" · ")}
                        </small>
                      )}
                    </section>
                  )}
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
                  </section>
                  <section>
                    <h3>实施计划</h3>
                    <ol className="plan">
                      {selected.plan.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                  </section>
                  <section className="execution-section">
                    <div className="execution-heading">
                      <h3>实时执行动态</h3>
                      {selected.codex?.state === "running" && (
                        <span className="live-indicator">
                          <i></i>实时
                        </span>
                      )}
                    </div>
                    {selected.codex ? (
                      <>
                        <p className="execution-phase">
                          {selected.execution?.phase ||
                            (selected.codex.state === "running"
                              ? "等待 Codex 返回事件"
                              : "本轮执行已结束")}
                        </p>
                        <p className="execution-note">
                          {selected.codex.state === "running"
                            ? `已接收 ${executionEvents.length} 条执行事件，约每 2 秒刷新。`
                            : "以下为本轮 Codex 实际返回的执行事件。"}
                        </p>
                        {executionEvents.length > 0 && (
                          <ol className="execution-log">
                            {executionEvents
                              .slice(-8)
                              .reverse()
                              .map((event, index) => (
                                <li key={`${event.at}-${index}`}>
                                  <time>
                                    {new Date(event.at).toLocaleTimeString(
                                      "zh-CN",
                                      {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                        second: "2-digit",
                                      },
                                    )}
                                  </time>
                                  <div>
                                    <b>{event.label}</b>
                                    {event.detail && (
                                      <span>{event.detail}</span>
                                    )}
                                  </div>
                                </li>
                              ))}
                          </ol>
                        )}
                      </>
                    ) : (
                      <p className="execution-note">
                        批准计划并启动后，这里会显示 Codex
                        返回的执行阶段、命令和文件变更。
                      </p>
                    )}
                  </section>
                  {selected.codex?.workspacePath &&
                    selected.codex?.state !== "running" && (
                      <section className="preview-section">
                        <div className="preview-heading">
                          <h3>不合并预览</h3>
                          <span>仅任务 worktree</span>
                        </div>
                        <p>
                          在此任务独立目录中启动页面，不会写入或切换主项目分支。
                        </p>
                        {selected.preview?.url && (
                          <a
                            className="preview-link"
                            href={selected.preview.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            打开当前预览 ↗
                          </a>
                        )}
                        <button className="outline" onClick={launchPreview}>
                          {selected.preview?.url
                            ? "重新启动预览"
                            : "启动本地预览"}
                        </button>
                      </section>
                    )}
                  <section className="timeline-section">
                    <h3>交付证据</h3>
                    <ol className="timeline">
                      <li>
                        <b>任务已创建</b>
                        <span>等待批准后启动 Codex</span>
                      </li>
                      <li>
                        <b>
                          {selected.codex?.state === "completed"
                            ? "Codex 已完成本轮"
                            : selected.codex?.state === "running"
                              ? "Codex 正在执行"
                              : "尚未启动 Codex"}
                        </b>
                        <span>
                          {selected.codex?.workspacePath || "尚未创建工作目录"}
                        </span>
                      </li>
                      <li>
                        <b>
                          {selected.evidence?.verification
                            ? selected.evidence.verification.exitCode === 0
                              ? "真实验证通过"
                              : "真实验证未通过"
                            : "尚未运行验证"}
                        </b>
                        <span>
                          {selected.evidence?.verification?.command ||
                            "完成 Codex 执行后，可运行项目脚本"}
                        </span>
                      </li>
                    </ol>
                    {selected.evidence?.verification?.output && (
                      <pre className="evidence-output">
                        {selected.evidence.verification.output}
                      </pre>
                    )}
                  </section>
                  {selected.dependencies?.length > 0 && (
                    <section className="dependency-section">
                      <h3>依赖门禁</h3>
                      {selected.dependencies.map((dependency) => (
                        <div
                          className={`dependency-gate ${dependency.satisfied ? "open" : ""}`}
                          key={dependency.prerequisite_id}
                        >
                          <b>
                            {dependency.satisfied ? "✓" : "↳"}{" "}
                            {dependency.task.id} · {dependency.task.title}
                          </b>
                          <span>
                            {dependency.satisfied
                              ? dependency.gate === "trust"
                                ? "已完全信任前置任务，自动队列可以启动"
                                : "门禁已满足，可以执行"
                              : `等待 ${dependency.gate === "accept" ? "人工验收" : "测试通过"} · 当前：${dependency.task.test}`}
                          </span>
                        </div>
                      ))}
                    </section>
                  )}
                  {selected.testTone === "success" &&
                    selected.codex?.isolated && (
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
                        {selected.merge?.state === "merged" ? (
                          <p className="merge-success">
                            ✓ 已合并；任务 worktree 仍被保留，可继续检查或回退。
                          </p>
                        ) : (
                          <>
                            <div className="merge-actions">
                              <button
                                className="outline"
                                onClick={() => {
                                  if (selected.merge?.state === "ready") {
                                    setActiveDiffFile(0);
                                    setDiffReviewOpen(true);
                                  } else previewMerge();
                                }}
                              >
                                {selected.merge?.state === "ready"
                                  ? "查看变更"
                                  : "生成变更审阅"}
                              </button>
                              {selected.merge?.state === "ready" && (
                                <button
                                  className="primary success"
                                  onClick={() => {
                                    if (
                                      window.confirm(
                                        `确认将 ${selected.merge?.branch || selected.worktree} 合并到 ${selected.merge?.targetBranch || "目标分支"}？`,
                                      )
                                    )
                                      mergeDelivery();
                                  }}
                                >
                                  合并到目标分支
                                </button>
                              )}
                            </div>
                            {selected.merge?.diffStat && (
                              <small className="merge-summary">
                                {selected.merge.diffStat.split("\n").at(-1)}
                              </small>
                            )}
                          </>
                        )}
                      </section>
                    )}
                  <div className="actions">
                    {selected.codex?.state === "running" ? (
                      <>
                        <button
                          className="danger-action"
                          onClick={stopCodexTask}
                        >
                          ■ 停止 Codex
                        </button>
                        <small>
                          停止会保留本轮 worktree 变更和日志；计划、验证、合并、删除仍会保持锁定。
                        </small>
                      </>
                    ) : selected.status === "执行中" ? (
                      <>
                        <button
                          className="primary success"
                          onClick={runVerification}
                        >
                          ▷ 运行真实验证
                        </button>
                        <small>
                          本轮已结束；验证通过后才能查看 diff 和确认合并。
                        </small>
                      </>
                    ) : selected.status === "待复核" ? (
                      <>
                        {selected.codex?.isolated &&
                          selected.merge?.state !== "merged" && (
                            <button
                              className="primary"
                              onClick={() => {
                                if (selected.merge?.state === "ready") {
                                  setActiveDiffFile(0);
                                  setDiffReviewOpen(true);
                                } else previewMerge();
                              }}
                            >
                              {selected.merge?.diff
                                ? "查看变更"
                                : "生成变更审阅"}
                            </button>
                          )}
                        {selected.codex?.isolated &&
                          selected.merge?.state === "ready" && (
                            <button
                              className="primary success"
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `确认合并到 ${selected.merge.targetBranch}？`,
                                  )
                                )
                                  mergeDelivery();
                              }}
                            >
                              确认合并到 {selected.merge.targetBranch}
                            </button>
                          )}
                        {selected.codex?.isolated &&
                          selected.merge?.state === "merged" && (
                            <button
                              className="primary success"
                              onClick={acceptDelivery}
                            >
                              ✓ 接受已合并交付
                            </button>
                          )}
                        {!selected.codex?.isolated && (
                          <button
                            className="primary success"
                            onClick={acceptDelivery}
                          >
                            ✓ 接受共享目录交付
                          </button>
                        )}
                        <button onClick={requestChanges}>请求修改</button>
                        <small>
                          {selected.codex?.isolated
                            ? "验证通过后先查看真实 diff；只有你确认后才会写入目标分支。"
                            : "共享目录没有可安全自动合并的 Git 分支。"}
                        </small>
                      </>
                    ) : selected.status === "已阻塞" ? (
                      <>
                        <button className="primary" onClick={retryTask}>
                          ↻ 重试任务
                        </button>
                        <button onClick={requestChanges}>修改计划后重试</button>
                        <small>
                          {selected.automation?.lastError ||
                            "请处理验证或依赖问题后重新启动。"}
                        </small>
                      </>
                    ) : selected.status === "已完成" ? (
                      <small>已验收。代码、验证和合并记录会保留。</small>
                    ) : (
                      <>
                        <button
                          className="primary"
                          disabled={selected.canRun === false || launching}
                          onClick={launchTask}
                        >
                          {selected.canRun === false
                            ? "等待依赖门禁"
                            : launching
                              ? "正在启动 Codex…"
                              : "▷ 批准计划并启动"}
                        </button>
                        <button onClick={requestChanges}>请求修改</button>
                        <button
                          className="danger-action"
                          onClick={deleteSelectedTask}
                        >
                          删除任务
                        </button>
                        <small>
                          {selected.canRun === false
                            ? "前置任务未满足测试或验收要求。"
                            : "启动后任务会锁定，Codex 在独立 worktree 中执行。"}
                        </small>
                      </>
                    )}
                  </div>
                </aside>
              </>
            )}
          </main>
        )}
        {view === "worktrees" && (
          <main className="standalone-view">
            <header className="view-header">
              <div>
                <p className="eyebrow">并行执行</p>
                <h1>
                  Worktrees <span>{worktrees.length}</span>
                </h1>
                <p>每个任务在独立目录和分支中运行，互不覆盖本地改动。</p>
              </div>
              <button className="outline" onClick={() => setComposerOpen(true)}>
                + 新建交付
              </button>
            </header>
            {worktrees.length ? (
              <div className="worktree-grid">
                {worktrees.map((task) => (
                  <article className="worktree-card" key={task.id}>
                    <div className="card-top">
                      <span
                        className={`status ${statusClass[task.status] ?? "done"}`}
                      >
                        {task.status}
                      </span>
                      <button
                        onClick={() => {
                          setSelectedId(task.id);
                          setView("tasks");
                        }}
                      >
                        查看任务 →
                      </button>
                    </div>
                    <h2>{task.title}</h2>
                    <p>
                      {task.id} · {task.worktree}
                    </p>
                    <div className="branch">
                      <span>⌘</span>
                      <div>
                        <b>feature/{task.worktree.replace("wt/", "")}</b>
                        <small>基于 main · a1b2c3d</small>
                      </div>
                    </div>
                    <div className="card-progress">
                      <span>{task.activity}</span>
                      <div>
                        <i
                          style={{
                            width:
                              task.status === "执行中"
                                ? "64%"
                                : task.status === "待复核"
                                  ? "100%"
                                  : "28%",
                          }}
                        ></i>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="page-empty">
                <b>还没有活跃 worktree</b>
                <p>创建并启动第一项交付后，它会显示在这里。</p>
                <button
                  className="outline"
                  onClick={() => setComposerOpen(true)}
                >
                  + 新建交付
                </button>
              </div>
            )}
          </main>
        )}
        {view === "reviews" && (
          <main className="standalone-view review-view">
            <header className="view-header">
              <div>
                <p className="eyebrow">人工验收队列</p>
                <h1>
                  复核 <span>{reviewTasks.length}</span>
                </h1>
                <p>
                  只在这里做最终判断：查看变更证据，然后接受交付或退回给 Codex。
                </p>
              </div>
              <div className="review-count">
                {reviewTasks.length} 项待你确认
              </div>
            </header>
            {reviewTasks.length ? (
              <div className="review-list">
                {reviewTasks.map((task) => (
                  <article className="review-card" key={task.id}>
                    <div className="review-main">
                      <span className="status review">待复核</span>
                      <h2>{task.title}</h2>
                      <p>{task.description}</p>
                      <div className="review-evidence">
                        <span>
                          {task.summary?.headline || "未采集验证结果"}
                        </span>
                        <span>
                          {task.summary?.details?.find((detail) =>
                            detail.includes("变更"),
                          ) || "未采集变更统计"}
                        </span>
                        <span>⌘ {task.worktree}</span>
                      </div>
                    </div>
                    <div className="review-actions">
                      <button
                        className="outline"
                        onClick={() => setReviewDetail(task)}
                      >
                        查看证据
                      </button>
                      {!task.codex?.isolated ||
                      task.merge?.state === "merged" ? (
                        <button
                          className="primary success"
                          onClick={() =>
                            runAction(
                              task.id,
                              "accept",
                              "交付已验收，任务已归档。",
                            )
                          }
                        >
                          ✓ 接受交付
                        </button>
                      ) : (
                        <button
                          className="primary"
                          onClick={() => {
                            setSelectedId(task.id);
                            setView("tasks");
                          }}
                        >
                          查看 diff 并合并
                        </button>
                      )}
                      <button
                        onClick={() =>
                          runAction(
                            task.id,
                            "return",
                            "已退回复核任务，等待补充证据。",
                          )
                        }
                      >
                        退回补充
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="page-empty">
                <b>没有待复核的交付</b>
                <p>Codex 完成并验证任务后，会自动出现在这里。</p>
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
                <div className="modal-kicker">真实 Git diff · 合并前审阅</div>
                <div className="diff-review-title-row">
                  <h2 id="diff-review-title">{selected.title}</h2>
                  <span className="merge-state">等待你确认</span>
                </div>
                <p>
                  {selected.merge?.diffStat.split("\n").at(-1) ||
                    "已生成变更"}
                </p>
              </div>
            </header>
            <div className="diff-review-body">
              <nav className="diff-file-list" aria-label="变更文件">
                <div className="diff-file-list-title">变更文件</div>
                {diffFiles.map((file, index) => {
                  const additions = file.lines.filter(
                    (line) => line.startsWith("+") && !line.startsWith("+++"),
                  ).length;
                  const deletions = file.lines.filter(
                    (line) => line.startsWith("-") && !line.startsWith("---"),
                  ).length;
                  return (
                    <button
                      className={activeDiffFile === index ? "active" : ""}
                      key={file.id}
                      onClick={() => setActiveDiffFile(index)}
                    >
                      <span className="diff-file-name">
                        <i aria-hidden="true">⌑</i>
                        {file.path}
                      </span>
                      <small>
                        {additions > 0 && <i className="diff-add">+{additions}</i>}
                        {deletions > 0 && <i className="diff-del">−{deletions}</i>}
                      </small>
                    </button>
                  );
                })}
              </nav>
              <div className="diff-code" aria-label="代码变更">
                <div className="diff-code-title">
                  <span>{activeDiff?.path || "代码变更"}</span>
                  <small>旧行 / 新行</small>
                </div>
                {activeDiffRows.length ? activeDiffRows.map((row) => {
                  return (
                    <div className={`diff-line ${row.type}`} key={`${row.id}-${row.text}`}>
                      <span className="diff-line-number">{row.oldLine}</span>
                      <span className="diff-line-number">{row.newLine}</span>
                      <span className="diff-sign" aria-hidden="true">
                        {row.type === "addition" ? "+" : row.type === "deletion" ? "−" : ""}
                      </span>
                      <code>{row.text || " "}</code>
                    </div>
                  );
                }) : (
                  <div className="diff-empty">这个文件没有可呈现的文本补丁。</div>
                )}
              </div>
            </div>
            <footer className="diff-review-footer">
              <button className="outline" onClick={() => setDiffReviewOpen(false)}>
                继续检查
              </button>
              <span></span>
              <button
                className="primary success"
                onClick={() => {
                  if (
                    window.confirm(
                      `确认将 ${selected.merge?.branch || selected.worktree} 合并到 ${selected.merge?.targetBranch || "目标分支"}？`,
                    )
                  ) {
                    setDiffReviewOpen(false);
                    mergeDelivery();
                  }
                }}
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
            className="modal composer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="composer-title"
          >
            <button
              className="modal-close"
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
            {(composerStep === 1 || quickMode) && (
              <div className="form-stack">
                <label>
                  交付名称
                  <input
                    autoFocus
                    value={draft.title}
                    onChange={(event) =>
                      setDraft({ ...draft, title: event.target.value })
                    }
                    placeholder="例如：增加订单导出能力"
                  />
                </label>
                <label>
                  负责角色
                  <select
                    value={draft.role}
                    onChange={(event) =>
                      setDraft({ ...draft, role: event.target.value })
                    }
                  >
                    {[
                      "产品专家",
                      "前端专家",
                      "后端专家",
                      "UI/UX 专家",
                      "全栈工程师",
                      "测试专家",
                      "DevOps 专家",
                      "安全专家",
                      "数据工程师",
                    ].map((role) => (
                      <option key={role}>{role}</option>
                    ))}
                  </select>
                </label>
                <label>
                  目标
                  <textarea
                    value={draft.goal}
                    onChange={(event) =>
                      setDraft({ ...draft, goal: event.target.value })
                    }
                    placeholder="描述用户问题、预期行为与边界…"
                  />
                </label>
                {quickMode && (
                  <label className="automation-switch">
                    <input
                      type="checkbox"
                      checked={draft.automation.autoRun}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          automation: {
                            autoRun: event.target.checked,
                            autoVerify: event.target.checked,
                          },
                        })
                      }
                    />
                    <span>
                      <b>加入夜间自动队列</b>
                      <small>Codex 完成后自动验证；不会自动合并或验收。</small>
                    </span>
                  </label>
                )}
              </div>
            )}
            {composerStep === 2 && (
              <div className="form-stack">
                <label>
                  验收标准
                  <textarea
                    autoFocus
                    value={draft.acceptance}
                    onChange={(event) =>
                      setDraft({ ...draft, acceptance: event.target.value })
                    }
                    placeholder="例如：导出包含 CSV；权限不足返回 403；相关测试通过。"
                  />
                </label>
                <div className="hint-card">
                  <b>建议</b>
                  <span>
                    写出“可观察的结果”，而不是只写实现方式。这样更容易审核 Codex
                    的交付。
                  </span>
                </div>
              </div>
            )}
            {composerStep === 3 && (
              <div className="form-stack">
                <label>
                  要提供给 Codex 的上下文
                  <textarea
                    autoFocus
                    value={draft.context}
                    onChange={(event) =>
                      setDraft({ ...draft, context: event.target.value })
                    }
                  />
                </label>
                <div className="merge-mode">
                  <b>验证通过后的安全交付</b>
                  <span>
                    任务会以当前分支 <em>{project?.branch || "当前分支"}</em>{" "}
                    作为目标分支。
                  </span>
                  <div className="merge-confirmed">
                    <strong>查看真实 diff 后由你确认合并</strong>
                    <small>
                      Flight Deck
                      不会自动合并或复制代码。目标分支有未提交改动、分支不匹配或发生冲突时会拒绝合并。
                    </small>
                  </div>
                </div>
                <label className="automation-switch">
                  <input
                    type="checkbox"
                    checked={draft.automation.autoRun}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        automation: {
                          autoRun: event.target.checked,
                          autoVerify: event.target.checked,
                        },
                      })
                    }
                  />
                  <span>
                    <b>夜间自动执行与验证</b>
                    <small>
                      依赖满足后自动启动；完成后自动运行项目验证。不会自动合并或人工验收。
                    </small>
                  </span>
                </label>
                <div className="dependency-picker">
                  <b>依赖门禁（可选）</b>
                  <span>选择每项任务后，再决定 B 要等待 A 的哪一级结果。</span>
                  {tasks
                    .filter((task) => task.status !== "已完成")
                    .map((task) => (
                      <label key={task.id}>
                        <input
                          type="checkbox"
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
                          <select
                            aria-label={`${task.title} 的依赖策略`}
                            value={
                              draft.dependencies.find(
                                (dependency) => dependency.id === task.id,
                              )?.gate || "test"
                            }
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                dependencies: draft.dependencies.map(
                                  (dependency) =>
                                    dependency.id === task.id
                                      ? {
                                          ...dependency,
                                          gate: event.target.value,
                                        }
                                      : dependency,
                                ),
                              })
                            }
                          >
                            <option value="test">验证通过后手动启动 B</option>
                            <option value="trust">
                              完全信任 A：通过即自动启动 B
                            </option>
                            <option value="accept">等待人工验收</option>
                          </select>
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
                <button className="primary" onClick={createDelivery}>
                  创建并{draft.automation.autoRun ? "加入夜间队列" : "等待启动"}
                </button>
              ) : composerStep < 3 ? (
                <button
                  className="primary"
                  onClick={() => setComposerStep((step) => step + 1)}
                >
                  下一步
                </button>
              ) : (
                <button className="primary" onClick={createDelivery}>
                  创建任务包
                </button>
              )}
            </footer>
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
            >
              ×
            </button>
            <div className="modal-kicker">接入本机项目</div>
            <h2 id="project-title">添加项目</h2>
            <p className="description">
              选择任意本机文件夹。有 Git 提交时，任务会创建独立
              worktree；没有提交或未启用 Git 时，Codex
              会在原项目目录执行，并标记为共享工作目录。
            </p>
            <div className="form-stack">
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
              <label>
                项目文件夹
                <input
                  value={projectPath}
                  onChange={(event) => setProjectPath(event.target.value)}
                  placeholder="点击右侧选择文件夹"
                />
                <button className="outline" onClick={pickProjectFolder}>
                  选择文件夹…
                </button>
              </label>
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
            className="modal policy-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="policy-title"
          >
            <button
              className="modal-close"
              onClick={() => setPolicyOpen(false)}
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
            <div className="form-stack">
              <label>
                项目规则
                <textarea
                  value={policyDraft.rules}
                  onChange={(event) =>
                    setPolicyDraft({
                      ...policyDraft,
                      rules: event.target.value,
                    })
                  }
                  placeholder="例如：改动接口前先检查权限；禁止修改支付结算核心目录…"
                />
              </label>
              <label>
                工程规范
                <textarea
                  value={policyDraft.standards}
                  onChange={(event) =>
                    setPolicyDraft({
                      ...policyDraft,
                      standards: event.target.value,
                    })
                  }
                  placeholder="例如：TypeScript 严格模式；新增接口须有单测；组件遵守现有设计系统…"
                />
              </label>
              <label>
                固定验证命令（可选）
                <input
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
                  只会把名称和使用要求写入任务提示词，不会自动安装或执行未知
                  Skill。
                </span>
                {(discovery.skills.length
                  ? discovery.skills
                  : ["manage-taskboard", "dashi-ppt", "task-handoff"]
                ).map((skill) => (
                  <label key={skill}>
                    <input
                      type="checkbox"
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
                    />
                    ${skill}
                  </label>
                ))}
              </div>
            </div>
            <footer className="modal-actions">
              <button className="outline" onClick={() => setPolicyOpen(false)}>
                取消
              </button>
              <span></span>
              <button className="primary" onClick={savePolicy}>
                保存项目规则
              </button>
            </footer>
          </section>
        </div>
      )}
      {reviewDetail && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal evidence-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="evidence-title"
          >
            <button
              className="modal-close"
              onClick={() => setReviewDetail(null)}
            >
              ×
            </button>
            <div className="modal-kicker">{reviewDetail.id} · 交付证据</div>
            <h2 id="evidence-title">{reviewDetail.title}</h2>
            <p className="description">{reviewDetail.description}</p>
            <div className="evidence-grid">
              <section>
                <h3>验证结果</h3>
                <ul>
                  <li>
                    {reviewDetail.evidence?.verification?.command ||
                      "未配置或未运行验证命令"}
                  </li>
                  <li>
                    {reviewDetail.evidence?.verification
                      ? reviewDetail.evidence.verification.exitCode === 0
                        ? "✓ 命令退出成功"
                        : `✕ 命令失败（退出码 ${reviewDetail.evidence.verification.exitCode}）`
                      : "未采集验证结果"}
                  </li>
                  <li>
                    {reviewDetail.preview?.url
                      ? `预览：${reviewDetail.preview.url}`
                      : "未启动任务预览"}
                  </li>
                </ul>
              </section>
              <section>
                <h3>变更摘要</h3>
                <ul>
                  <li>
                    {reviewDetail.evidence?.workspace?.changedFiles?.length
                      ? `${reviewDetail.evidence.workspace.changedFiles.length} 个文件发生变化`
                      : "未采集变更文件"}
                  </li>
                  <li>
                    {reviewDetail.merge?.diffStat ||
                      reviewDetail.evidence?.workspace?.diffStat ||
                      "未生成 Git diff 统计"}
                  </li>
                  <li>
                    {reviewDetail.merge?.state === "merged"
                      ? `已合并到 ${reviewDetail.merge.targetBranch}`
                      : "尚未合并到目标分支"}
                  </li>
                </ul>
              </section>
            </div>
            <section className="risk-box">
              <b>交付风险与下一步</b>
              <p>
                {reviewDetail.evidence?.verification?.guidance ||
                reviewDetail.merge?.state !== "merged"
                  ? "尚未合并；请查看真实 diff、预览效果并确认目标分支状态。"
                  : "未记录额外风险；仍建议按项目发布流程进行人工验收。"}
              </p>
            </section>
            <section>
              <h3>执行时间线</h3>
              <div className="evidence-timeline">
                <span>
                  创建：
                  {new Date(
                    reviewDetail.createdAt || Date.now(),
                  ).toLocaleString("zh-CN")}
                </span>
                <span>
                  启动：
                  {reviewDetail.codex?.startedAt
                    ? new Date(reviewDetail.codex.startedAt).toLocaleString(
                        "zh-CN",
                      )
                    : "未启动"}
                </span>
                <span>
                  验证：
                  {reviewDetail.evidence?.verifiedAt
                    ? new Date(reviewDetail.evidence.verifiedAt).toLocaleString(
                        "zh-CN",
                      )
                    : "未验证"}
                </span>
                <span>复核：等待人工确认</span>
              </div>
            </section>
            <footer className="modal-actions">
              <button
                className="outline"
                onClick={() => {
                  const taskId = reviewDetail.id;
                  setReviewDetail(null);
                  runAction(taskId, "return", "已退回复核任务，等待补充证据。");
                }}
              >
                退回补充
              </button>
              <span></span>
              <button
                className="primary success"
                onClick={() => {
                  const taskId = reviewDetail.id;
                  setReviewDetail(null);
                  runAction(taskId, "accept", "交付已验收，任务已归档。");
                }}
              >
                ✓ 接受交付
              </button>
            </footer>
          </section>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
          <button onClick={() => setToast("")}>×</button>
        </div>
      )}
    </div>
  );
}
