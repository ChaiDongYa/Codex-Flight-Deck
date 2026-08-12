import { useEffect, useMemo, useState } from "react";
import "./styles.css";

const initialTasks = [
  {
    id: "FD-2187",
    title: "增加支付幂等键支持",
    description: "防止重试请求导致重复扣款。",
    status: "待开始",
    worktree: "wt/idempotency-key",
    activity: "已生成实施计划",
    test: "未运行",
    testTone: "neutral",
    files: ["server/api/charges/create.ts", "server/services/idempotency.ts", "migrations/20240514_idempotency.sql", "tests/idempotency.test.ts"],
    plan: ["新增幂等键的持久化与过期清理", "把校验接入支付与退款请求链路", "补充单元测试、集成测试与结构化日志"],
    approved: false,
  },
  { id: "FD-2191", title: "重构 Webhook 签名校验", description: "抽取校验策略并补充审计测试。", status: "计划中", worktree: "wt/webhook-refactor", activity: "正在分析代码库 · 12 个文件", test: "未运行", testTone: "neutral", files: ["server/webhooks/verify.ts", "tests/webhooks.test.ts"], plan: ["梳理现有签名入口", "提取可复用策略", "覆盖边界条件"], approved: false },
  { id: "FD-2193", title: "增加退款原因码", description: "在 API 和控制台中暴露退款原因。", status: "执行中", worktree: "wt/refund-reasons", activity: "Codex 正在修改 · 8/12 个文件", test: "18 项通过", testTone: "success", files: ["server/refunds/reasons.ts", "web/refunds/form.tsx"], plan: ["扩展退款模型", "更新 API 与界面", "运行退款测试"], approved: true },
  { id: "FD-2184", title: "更新 VAT 计算规则", description: "应用 2024 年欧盟税率调整。", status: "待复核", worktree: "wt/vat-rules-2024", activity: "变更已完成，等待人工复核", test: "42 项通过", testTone: "success", files: ["server/tax/vat.ts", "tests/vat.test.ts"], plan: ["更新税率表", "校验地区规则", "执行全量税务测试"], approved: true },
  { id: "FD-2189", title: "修复 Apple Pay 3DS 流程", description: "处理 3DS 验证超时场景。", status: "已阻塞", worktree: "wt/applepay-3ds", activity: "等待支付网关依赖更新", test: "3 项失败", testTone: "danger", files: ["server/payments/apple-pay.ts"], plan: ["复现超时", "等待网关补丁", "增加降级路径"], approved: true },
];

const statusClass = { "待开始": "ready", "计划中": "planning", "执行中": "running", "待复核": "review", "已阻塞": "blocked", "等待依赖": "blocked" };

export function App() {
  const [tasks, setTasks] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [filter, setFilter] = useState("全部");
  const [filterOpen, setFilterOpen] = useState(false);
  const [project, setProject] = useState(null);
  const [projects, setProjects] = useState([]);
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectPath, setProjectPath] = useState("");
  const [view, setView] = useState("tasks");
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerStep, setComposerStep] = useState(1);
  const [draft, setDraft] = useState({ title: "", goal: "", acceptance: "", context: "支付 API、现有测试与项目约定", dependencies: [] });
  const [reviewDetail, setReviewDetail] = useState(null);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState("");
  const [launching, setLaunching] = useState(false);
  const selected = tasks.find((task) => task.id === selectedId) ?? tasks[0];
  const visibleTasks = useMemo(() => tasks.filter((task) => (filter === "全部" || task.status === filter) && `${task.title} ${task.id}`.toLowerCase().includes(query.toLowerCase())), [tasks, filter, query]);

  const refreshTasks = async () => { const response = await fetch("/api/tasks"); const data = await response.json(); setTasks(data.tasks); if (data.tasks.length && !data.tasks.some((task) => task.id === selectedId)) setSelectedId(data.tasks[0].id); };
  const refreshProjects = async () => { const response = await fetch("/api/projects"); const data = await response.json(); if (!response.ok) throw new Error(data.error); setProjects(data.projects); setProject(data.active); };
  useEffect(() => { refreshTasks().catch(() => setToast("无法读取本地 SQLite 数据库。")); refreshProjects().catch(() => setToast("无法读取真实 Git 项目。")); }, []);
  const runAction = async (id, action, success) => { const response = await fetch(`/api/tasks/${id}/${action}`, { method: "POST" }); const data = await response.json(); if (!response.ok) { setToast(data.error); return false; } setTasks(data.tasks); setToast(success); return true; };
  const approvePlan = () => runAction(selected.id, "approve", project?.executionMode === "worktree" ? "计划已批准，任务将在独立 worktree 中执行。" : "计划已批准，任务会在共享工作目录中执行。请先确认本地改动。 ");
  const launchTask = async () => { setLaunching(true); const response = await fetch(`/api/tasks/${selected.id}/launch`, { method: "POST" }); const data = await response.json(); setLaunching(false); if (!response.ok) return setToast(data.error); setTasks(data.tasks); setToast(`Codex 已启动 · 会话 ${data.task.codex.threadId.slice(0, 8)}`); };
  const requestChanges = () => runAction(selected.id, "return", "已退回计划，等待补充要求。");
  const acceptDelivery = () => runAction(selected.id, "accept", "交付已接受；所有依赖它的任务会重新检查门禁。");
  const markTestsPassed = () => runAction(selected.id, "pass-tests", "测试已通过，交付进入人工复核；后续依赖已重新计算。");
  const createDelivery = async () => { const response = await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...draft, projectPath: project?.path }) }); const data = await response.json(); if (!response.ok) return setToast(data.error); await refreshTasks(); setSelectedId(data.task.id); setView("tasks"); setComposerOpen(false); setComposerStep(1); setDraft({ title: "", goal: "", acceptance: "", context: "支付 API、现有测试与项目约定", dependencies: [] }); setToast("交付已写入本地 SQLite，等待你确认计划。"); };
  const addProject = async () => { const response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: projectPath }) }); const data = await response.json(); if (!response.ok) return setToast(data.error); await refreshProjects(); setProjectModalOpen(false); setProjectPath(""); setToast(`已添加真实项目：${data.project.name}`); };
  const chooseProject = async (path) => { const response = await fetch("/api/projects/active", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) }); const data = await response.json(); if (!response.ok) return setToast(data.error); setProject(data.project); setProjectOpen(false); setToast(`当前项目：${data.project.name}`); };

  const worktrees = tasks.filter((task) => task.status !== "已完成");
  const reviewTasks = tasks.filter((task) => task.status === "待复核");
  return <div className="app-shell">
    <section className="workspace">
      <header className="topbar"><div className="project-wrap"><button className={`project ${projectOpen ? "open" : ""}`} onClick={() => setProjectOpen((open) => !open)} title={project?.path}><span className="project-mark"></span>{project ? project.name : "正在读取项目…"}<small>{project?.branch ? ` · ${project.branch}` : ""}</small><span className="chevron">⌄</span></button>{projectOpen && <div className="project-menu" role="menu"><p>本机项目</p>{projects.map((item) => <button role="menuitem" className={project?.path === item.path ? "chosen" : ""} key={item.path} onClick={() => chooseProject(item.path)}><span className="project-mark"></span>{item.name}{project?.path === item.path && <b>✓</b>}</button>)}<div className="project-divider"></div><button className="new-project" onClick={() => { setProjectOpen(false); setProjectModalOpen(true); }}>+ 添加项目</button></div>}</div><label className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务…" /></label></header>
      {view === "tasks" && <main className="content">
        <section className="task-list">
          <div className="list-heading"><div><h1>任务 <span>{tasks.length}</span></h1><p>把需求变成可验证的 Codex 交付。</p></div><div className="filter-wrap"><button className={`filter-trigger ${filterOpen ? "open" : ""}`} onClick={() => setFilterOpen((open) => !open)} aria-haspopup="menu" aria-expanded={filterOpen}><span className={filter === "全部" ? "filter-dot all" : `filter-dot ${statusClass[filter]}`}></span>{filter === "全部" ? "全部状态" : filter}<span className="chevron">⌄</span></button>{filterOpen && <div className="filter-menu" role="menu">{["全部", "待开始", "计划中", "执行中", "待复核", "已阻塞"].map((option) => <button role="menuitem" key={option} className={filter === option ? "chosen" : ""} onClick={() => { setFilter(option); setFilterOpen(false); }}><span className={option === "全部" ? "filter-dot all" : `filter-dot ${statusClass[option]}`}></span>{option === "全部" ? "全部状态" : option}{filter === option && <b>✓</b>}</button>)}</div>}</div></div>
          <div className="table-head"><span>任务</span><span>Worktree</span><span>Codex 动态</span><span>验证</span></div>
          <div className="task-rows">{visibleTasks.map((task) => <button key={task.id} className={`task-row ${selected.id === task.id ? "selected" : ""}`} onClick={() => setSelectedId(task.id)}>
            <span className="task-name"><b>{task.title}</b><small>{task.id} · {task.description}</small><i className={`status ${statusClass[task.status] ?? "done"}`}>{task.status}</i>{task.dependencies?.some((dependency) => !dependency.satisfied) && <small className="dependency-note">↳ 等待 {task.dependencies.filter((dependency) => !dependency.satisfied).map((dependency) => dependency.task.id).join("、")} 的 {task.dependencies.find((dependency) => !dependency.satisfied)?.gate === "accept" ? "验收" : "测试"}</small>}</span>
            <span className="worktree">{task.worktree}<small>a1b2c3d</small></span>
            <span className="activity">{task.activity}</span>
            <span className={`test ${task.testTone}`}>{task.test}</span>
          </button>)}</div>
          {visibleTasks.length === 0 && <div className="empty">没有匹配的任务</div>}
        </section>
        <aside className="inspector">
          <button className="close" onClick={() => setToast("详情面板已固定显示，便于快速审批。")}>×</button>
          <div className="inspector-status"><i className={`status ${statusClass[selected.status] ?? "done"}`}>{selected.status}</i></div>
          <h2>{selected.title}</h2><p className="description">{selected.description}</p>
          <section><h3>摘要</h3><p>此任务包会把关键上下文、实施计划与验证证据集中在一起，方便你确认 Codex 的执行边界。</p></section>
          <section><h3>上下文文件</h3><ul className="files">{selected.files.map((file, index) => <li key={file}><span>▧</span>{file}<em>+{32 + index * 17}</em></li>)}</ul><button className="link-button" onClick={() => setToast("完整文件清单将在真实 Git 集成后展示。")}>查看全部文件</button></section>
          <section><h3>实施计划</h3><ol className="plan">{selected.plan.map((step) => <li key={step}>{step}</li>)}</ol></section>
          <section className="timeline-section"><h3>活动记录</h3><ol className="timeline"><li><b>计划已生成</b><span>09:20 · 根据任务上下文整理执行步骤</span></li><li><b>{selected.approved ? "已批准执行" : "等待你批准"}</b><span>{selected.approved ? "09:24 · 已创建隔离 worktree" : "确认范围后即可启动 Codex"}</span></li><li><b>{selected.status === "待复核" ? "验证已完成" : "等待交付"}</b><span>{selected.status === "待复核" ? "09:34 · 测试与类型检查均已通过" : selected.activity}</span></li></ol></section>
          {selected.dependencies?.length > 0 && <section className="dependency-section"><h3>依赖门禁</h3>{selected.dependencies.map((dependency) => <div className={`dependency-gate ${dependency.satisfied ? "open" : ""}`} key={dependency.prerequisite_id}><b>{dependency.satisfied ? "✓" : "↳"} {dependency.task.id} · {dependency.task.title}</b><span>{dependency.satisfied ? "门禁已满足，可以执行" : `等待 ${dependency.gate === "accept" ? "人工验收" : "测试通过"} · 当前：${dependency.task.test}`}</span></div>)}</section>}
          {selected.status === "待复核" ? <div className="actions"><button className="primary success" onClick={acceptDelivery}>✓ 接受交付</button><button onClick={requestChanges}>请求补充</button><small>验证、diff 与风险说明会随交付保留。</small></div> : <div className="actions">{selected.status === "执行中" ? <>{selected.codex?.state === "running" ? <button className="primary" disabled>Codex 正在执行…</button> : <button className="primary success" onClick={markTestsPassed}>✓ 标记测试通过</button>}<button onClick={requestChanges}>停止并修改计划</button></> : <><button className="primary" disabled={selected.canRun === false || launching} onClick={launchTask}>{selected.canRun === false ? "等待依赖门禁" : launching ? "正在启动 Codex…" : "▷ 批准计划并启动"}</button><button onClick={requestChanges}>请求修改</button></>}<small>{selected.canRun === false ? "前置任务未满足测试或验收要求。" : "Codex 会在新的 worktree 中运行。"}</small></div>}
        </aside>
      </main>}
      {view === "worktrees" && <main className="standalone-view"><header className="view-header"><div><p className="eyebrow">并行执行</p><h1>Worktrees</h1><p>每个任务在独立目录和分支中运行，互不覆盖本地改动。</p></div><button className="outline" onClick={() => setToast("新 worktree 会在批准计划后自动创建。")}>+ 创建 worktree</button></header><div className="worktree-grid">{worktrees.map((task) => <article className="worktree-card" key={task.id}><div className="card-top"><span className={`status ${statusClass[task.status] ?? "done"}`}>{task.status}</span><button onClick={() => { setSelectedId(task.id); setView("tasks"); }}>查看任务 →</button></div><h2>{task.title}</h2><p>{task.id} · {task.worktree}</p><div className="branch"><span>⌘</span><div><b>feature/{task.worktree.replace("wt/", "")}</b><small>基于 main · a1b2c3d</small></div></div><div className="card-progress"><span>{task.activity}</span><div><i style={{ width: task.status === "执行中" ? "64%" : task.status === "待复核" ? "100%" : "28%" }}></i></div></div></article>)}</div></main>}
      {view === "reviews" && <main className="standalone-view review-view"><header className="view-header"><div><p className="eyebrow">人工验收队列</p><h1>复核</h1><p>只在这里做最终判断：查看变更证据，然后接受交付或退回给 Codex。</p></div><div className="review-count">{reviewTasks.length} 项待你确认</div></header>{reviewTasks.length ? <div className="review-list">{reviewTasks.map((task) => <article className="review-card" key={task.id}><div className="review-main"><span className="status review">待复核</span><h2>{task.title}</h2><p>{task.description}</p><div className="review-evidence"><span>✓ 42 项测试通过</span><span>✓ 类型检查通过</span><span>⌘ {task.worktree}</span></div></div><div className="review-actions"><button className="outline" onClick={() => setReviewDetail(task)}>查看证据</button><button className="primary success" onClick={() => runAction(task.id, "accept", "交付已验收，任务已归档。")} >✓ 接受交付</button><button onClick={() => runAction(task.id, "return", "已退回复核任务，等待补充证据。")}>退回补充</button></div></article>)}</div> : <div className="review-empty"><b>没有待复核的交付</b><p>Codex 完成并验证任务后，会自动出现在这里。</p></div>}</main>}
    </section>
    <aside className="action-rail" aria-label="Flight Deck 操作">
      <button className="new-delivery" onClick={() => setComposerOpen(true)}>+ 新建交付</button>
      <nav className="primary-nav">
        <button className={view === "tasks" ? "active" : ""} onClick={() => setView("tasks")}>任务</button><button className={view === "worktrees" ? "active" : ""} onClick={() => setView("worktrees")}>Worktrees <span>{worktrees.length}</span></button><button className={view === "reviews" ? "active" : ""} onClick={() => setView("reviews")}>复核 {reviewTasks.length > 0 && <span>{reviewTasks.length}</span>}</button>
      </nav>
    </aside>
    {composerOpen && <div className="modal-backdrop" role="presentation"><section className="modal composer" role="dialog" aria-modal="true" aria-labelledby="composer-title"><button className="modal-close" onClick={() => setComposerOpen(false)}>×</button><div className="modal-kicker">新建交付 · 第 {composerStep}/3 步</div><h2 id="composer-title">{composerStep === 1 ? "先说清你想交付什么" : composerStep === 2 ? "定义怎么判断完成" : "确认上下文与计划"}</h2>{composerStep === 1 && <div className="form-stack"><label>交付名称<input autoFocus value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="例如：增加订单导出能力" /></label><label>目标<textarea value={draft.goal} onChange={(event) => setDraft({ ...draft, goal: event.target.value })} placeholder="描述用户问题、预期行为与边界…" /></label></div>}{composerStep === 2 && <div className="form-stack"><label>验收标准<textarea autoFocus value={draft.acceptance} onChange={(event) => setDraft({ ...draft, acceptance: event.target.value })} placeholder="例如：导出包含 CSV；权限不足返回 403；相关测试通过。" /></label><div className="hint-card"><b>建议</b><span>写出“可观察的结果”，而不是只写实现方式。这样更容易审核 Codex 的交付。</span></div></div>}{composerStep === 3 && <div className="form-stack"><label>要提供给 Codex 的上下文<textarea autoFocus value={draft.context} onChange={(event) => setDraft({ ...draft, context: event.target.value })} /></label><div className="dependency-picker"><b>依赖门禁（可选）</b><span>选择后，新任务会等待前置任务测试通过才可启动。</span>{tasks.filter((task) => task.status !== "已完成").map((task) => <label key={task.id}><input type="checkbox" checked={draft.dependencies.some((dependency) => dependency.id === task.id)} onChange={() => setDraft({ ...draft, dependencies: draft.dependencies.some((dependency) => dependency.id === task.id) ? draft.dependencies.filter((dependency) => dependency.id !== task.id) : [...draft.dependencies, { id: task.id, gate: "test" }] })} />{task.id} · {task.title}<em>{task.test}</em></label>)}</div><div className="plan-preview"><b>即将生成的计划</b><span>1. 阅读项目约定与相关模块</span><span>2. 进行范围内最小实现</span><span>3. 执行测试并准备交付证据</span></div></div>}<footer className="modal-actions">{composerStep > 1 && <button className="outline" onClick={() => setComposerStep((step) => step - 1)}>上一步</button>}<span></span>{composerStep < 3 ? <button className="primary" onClick={() => setComposerStep((step) => step + 1)}>下一步</button> : <button className="primary" onClick={createDelivery}>创建任务包</button>}</footer></section></div>}
    {projectModalOpen && <div className="modal-backdrop" role="presentation"><section className="modal project-modal" role="dialog" aria-modal="true" aria-labelledby="project-title"><button className="modal-close" onClick={() => setProjectModalOpen(false)}>×</button><div className="modal-kicker">接入本机项目</div><h2 id="project-title">添加项目</h2><p className="description">任何本机文件夹都可使用。有 Git 提交时，任务会创建独立 worktree；没有提交或未启用 Git 时，Codex 会在原项目目录执行，并标记为共享工作目录。</p><div className="form-stack"><label>项目文件夹绝对路径<input autoFocus value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder="/Users/你的用户名/code/项目名" /></label></div><footer className="modal-actions"><button className="outline" onClick={() => setProjectModalOpen(false)}>取消</button><span></span><button className="primary" onClick={addProject}>验证并添加</button></footer></section></div>}
    {reviewDetail && <div className="modal-backdrop" role="presentation"><section className="modal evidence-modal" role="dialog" aria-modal="true" aria-labelledby="evidence-title"><button className="modal-close" onClick={() => setReviewDetail(null)}>×</button><div className="modal-kicker">{reviewDetail.id} · 交付证据</div><h2 id="evidence-title">{reviewDetail.title}</h2><p className="description">{reviewDetail.description}</p><div className="evidence-grid"><section><h3>验证结果</h3><ul><li>✓ 42 项单元与集成测试通过</li><li>✓ 类型检查与代码规范通过</li><li>✓ 构建产物生成成功</li></ul></section><section><h3>变更摘要</h3><ul><li>2 个核心文件修改</li><li>+184 / -26 行变更</li><li>未触及受保护目录</li></ul></section></div><section className="risk-box"><b>Codex 风险说明</b><p>税率生效时间依赖配置数据；上线前应由业务确认 2024 年地区规则的最终版本。</p></section><section><h3>执行时间线</h3><div className="evidence-timeline"><span>09:24 创建 worktree</span><span>09:26 开始实施</span><span>09:32 测试通过</span><span>09:34 提交复核</span></div></section><footer className="modal-actions"><button className="outline" onClick={() => { const taskId = reviewDetail.id; setReviewDetail(null); runAction(taskId, "return", "已退回复核任务，等待补充证据。"); }}>退回补充</button><span></span><button className="primary success" onClick={() => { const taskId = reviewDetail.id; setReviewDetail(null); runAction(taskId, "accept", "交付已验收，任务已归档。"); }}>✓ 接受交付</button></footer></section></div>}
    {toast && <div className="toast" role="status">{toast}<button onClick={() => setToast("")}>×</button></div>}
  </div>;
}
