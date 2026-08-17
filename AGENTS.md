# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

For local filesystem locations, prefer the native folder/file picker over a
manually editable path input. After selection, show the path only as a
read-only confirmation and keep the primary action disabled until a selection
exists.

Keep transient notices and destructive/important confirmation dialogs centered
in the viewport; do not place them at the top edge where they are hard to act on.

Project task and version kanban views share the same release-board DOM layout:
one native board-level horizontal scroll container and release-lane columns.
Keep an overflowing task column constrained to the visible board height and
make its card area independently scrollable; do not add a task-only scrolling
wrapper or create a long empty space in other columns.

In task list view, keep the title, view switcher, filters, bulk actions, and
table header fixed. Only the task rows may scroll when the list is long.

Expose scheduling through one task-page execution-queue control centre. State
the concurrency limit, running work, ready scheduled work, capacity, queue
pause behavior, and safe per-task pause/restart actions. Queue pause must not
silently stop already running work.

Derive the maximum selectable task concurrency from the current machine's
available CPU parallelism with a conservative safety cap. When pausing, offer
an explicit separate action to also stop running work; stopped worktrees and
logs must remain restartable.

Task-board horizontal navigation must use the same single native scroll
container as the version board, without an intermediate clipping wrapper.
Preserve native trackpad behavior, avoid wheel event interception and scroll
snapping, and never crop the last stage.

After a successful terminal action such as creating a batch of tasks, close
the source workspace and navigate to the newly affected task view. Keep a
centered success notice, rather than leaving a completed creation dialog open.

Before a task has started, its edit action opens the complete task definition
for direct editing (goal, acceptance, linked APIs, schedule, and role). Once a
task has execution/worktree history, use a separate incremental-feedback flow
that preserves prior code and verification records.

Inspector status sections such as execution activity and dependency gates are
complete bordered cards with padding and rounded corners; never leave a status
surface with only a background fill or a partial edge.

Use the adopted Taskboard UI baseline for Flight Deck task surfaces: compact
neutral panels, 1px theme-aware borders, 8px spacing rhythm, restrained shadows,
and stable 32px controls. Keep task state readable through both explicit text
and color. Task cards show identifier, title, concise context, then status;
hover makes the card actionable without changing its layout.

For task detail pages, optimise the default view for the next decision: task
goal, acceptance, blocker/next step, and the primary action. Put project rules,
interfaces, scanned context, implementation plans, and system explanations in
clear progressive-disclosure sections rather than showing every detail by
default. Keep the editable property sidebar compact; advanced metadata must not
compete with task execution.

Treat editable task metadata as a task-setting workflow, not persistent detail
content. Put configuration in the explicit “编辑任务” action and modal; keep
the default detail surface for delivery evidence and the next decision. Show a
dependency gate near the top only when an actual dependency exists.

The task-detail property rail must never be squeezed below a readable form
width. Keep it as a 300px side rail when detail space allows; when the detail
pane is narrow, stack it below the primary task content with its own scroll
area rather than clipping labels, controls, or task relationships.

In task execution views, show a concise status summary, recent short activity
items, and a verification conclusion first. Never expose raw commands,
machine-specific paths, or full build logs by default; retain them in an
explicit evidence disclosure for troubleshooting.

Task delivery must be a visible sequence: preview the worktree, inspect the
real diff, then explicitly merge. Consolidate post-execution feedback in the
activity composer: publishing preserves a record, while an explicit option may
also request an incremental Codex revision; do not duplicate this action in a
separate fixed footer.

When a version task is waiting for the release merge, task detail must provide a
direct, actionable route to that version's final-diff and merge control; do not
replace the action with instructional copy alone or expose task acceptance early.

Version membership is planning metadata, not a Git branch strategy. Version
tasks edit the project's current target branch directly. Before execution the
branch must be clean; after diff review, the explicit save action creates a
Git commit whose message includes the Flight Deck task ID (for example
`Flight Deck FD-2200: …`).

At creation, make the delivery type explicit: current-branch delivery for a
version task, an independent task branch, a direct quick change, or a no-code
delivery with a required reason. Versions must not add a separate Git merge
gate for their direct-delivery tasks.

This single-owner workflow has no top-level “复核” tab. Keep verification,
diff inspection, explicit merge, and final acceptance in task detail, where
the next action is directly available. Never reintroduce a separate review
queue or label a task “待合并” based solely on workspace-noise files.

Discussion publishing must present two separate, explicit actions: “仅保存讨论”
records feedback for later review without executing Codex, while “交给 Codex
增量修改” records the feedback and requests a focused incremental revision for
the current task. Do not use a checkbox to alter the meaning of a generic
publish button; the distinction must prevent accidental re-execution and make
small, targeted fixes the natural choice.

Acceptance criteria are a delivery contract, not generic completion prose.
Generate and edit them in two explicit parts: “用户可见结果” for observable
outcomes, and “验证与边界” for the smallest verification plus relevant empty,
error, permission, input, or state-transition boundaries. Do not accept vague
criteria such as “功能正常” or “测试通过”.

PRD analysis separates “分析视角” from “产出任务角色”. Both are multi-select:
the former broadens the concerns Codex evaluates, while the latter is the only
allowlist for generated task assignments. Never infer a task's execution role
solely from the analysis perspective.

Do not offer or run night-time automatic task execution or verification. Tasks
are started only through an explicit user action in the execution queue.

Worktrees are task-scoped execution resources, not a primary destination. Keep
the main navigation focused on tasks and releases; make task detail
the single action centre for preview, diff review, discussion, incremental
revision, and explicit merge. Expose opening a worktree only as a progressive
disclosure troubleshooting action, and clearly flag an empty or
workspace-noise-only diff as having no reviewable code change before merging.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
