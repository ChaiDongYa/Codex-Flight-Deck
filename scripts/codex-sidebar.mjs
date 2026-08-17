#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, open as openFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultPort = Number(process.env.FLIGHT_DECK_CDP_PORT || 49233);
const appUrl = process.env.FLIGHT_DECK_URL || "http://127.0.0.1:48173/";
const viteLogPath = path.join(os.tmpdir(), "flight-deck-vite.log");
const profilePath = process.env.FLIGHT_DECK_CODEX_PROFILE
  || path.join(os.homedir(), "Library", "Application Support", "Flight Deck", "codex-profile-v6");
const appPath = "/Applications/ChatGPT.app";
const injectionPath = path.join(root, "inject", "flight-deck.user.js");

function parseArgs(argv) {
  const options = { port: defaultPort, launch: true, watch: true, open: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--no-launch") options.launch = false;
    else if (arg === "--no-watch") options.watch = false;
    else if (arg === "--no-open") options.open = false;
    else if (arg === "--watch") options.watch = true;
    else if (arg === "--launch") options.launch = true;
    else if (arg === "--open") options.open = true;
    else if (arg === "--port") options.port = Number(argv[++index]);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function validatedPageWebSocketUrl(value, port) {
  if (typeof value !== "string") throw new Error("Codex 页面未提供调试 WebSocket。");
  const debuggerUrl = new URL(value);
  if (
    debuggerUrl.protocol !== "ws:"
    || debuggerUrl.hostname !== "127.0.0.1"
    || debuggerUrl.port !== String(port)
    || !debuggerUrl.pathname.startsWith("/devtools/page/")
  ) {
    throw new Error(`拒绝非本机 Codex 页面调试地址：${debuggerUrl.origin}`);
  }
  return debuggerUrl.href;
}

function isCodexTarget(target) {
  return target.type === "page"
    && !target.url?.includes("initialRoute=%2Fglobal-dictation")
    && !target.url?.includes("initialRoute=%2Favatar-overlay")
    && (target.url?.startsWith("app://") || target.title === "Codex");
}

class CdpConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.closed = false;
  }

  async open() {
    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onFail = () => { cleanup(); this.closed = true; reject(new Error("无法连接 Codex 页面调试端点。")); };
      const cleanup = () => {
        this.socket.removeEventListener("open", onOpen);
        this.socket.removeEventListener("error", onFail);
        this.socket.removeEventListener("close", onFail);
      };
      this.socket.addEventListener("open", onOpen, { once: true });
      this.socket.addEventListener("error", onFail, { once: true });
      this.socket.addEventListener("close", onFail, { once: true });
    });
    this.socket.addEventListener("message", async ({ data }) => {
      const payload = typeof data === "string" ? data : await data.text();
      const message = JSON.parse(payload);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      this.closed = true;
      const error = new Error("Codex 页面调试连接已关闭。");
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, timeoutMs = 30_000) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Codex 页面调试连接已关闭。"));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 调试命令超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function isReachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function isFlightDeckAvailable() {
  try {
    const [page, api] = await Promise.all([
      fetch(appUrl, { signal: AbortSignal.timeout(1500) }),
      fetch(new URL("/api/tasks", appUrl), { signal: AbortSignal.timeout(1500) }),
    ]);
    return page.ok && api.ok;
  } catch {
    return false;
  }
}

async function ensureFlightDeck() {
  if (await isFlightDeckAvailable()) return;
  const log = await openFile(viteLogPath, "a");
  const vite = spawn(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", "48173"], {
    cwd: root,
    stdio: ["ignore", log.fd, log.fd],
    detached: true,
  });
  vite.unref();
  await log.close();
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (await isFlightDeckAvailable()) return;
    await sleep(500);
  }
  const logTail = (await readFile(viteLogPath, "utf8").catch(() => "")).trim().split("\n").slice(-12).join("\n");
  throw new Error(`Flight Deck 本地服务未能启动：${appUrl}\nVite 日志：${logTail || "（未写入日志）"}`);
}

async function waitUntilReachable(url, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < until) {
    try {
      if (await isReachable(url)) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`等待 ${url} 超时：${lastError?.message || "未开放"}`);
}

async function codexTargets(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  return targets.filter(isCodexTarget).map((target) => ({
    ...target,
    webSocketDebuggerUrl: validatedPageWebSocketUrl(target.webSocketDebuggerUrl, port),
  }));
}

async function waitForCodexTargets(port, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const targets = await codexTargets(port);
      if (targets.length) return targets;
    } catch {}
    await sleep(400);
  }
  throw new Error(`Codex 主窗口未在 ${Math.round(timeoutMs / 1000)} 秒内出现可注入的页面。`);
}

async function launchCodex(port) {
  if (await isReachable(`http://127.0.0.1:${port}/json/version`)) return;
  await mkdir(profilePath, { recursive: true });
  spawn("open", [
    "-n",
    "-a",
    appPath,
    "--args",
    `--user-data-dir=${profilePath}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://127.0.0.1:${port}`,
  ], { stdio: "ignore", detached: true }).unref();
  console.log(`正在启动专用 Codex 窗口（独立 profile：${profilePath}）…`);
  await waitUntilReachable(`http://127.0.0.1:${port}/json/version`, 45_000);
}

function findFrameByName(frameTree, name) {
  if (frameTree.frame?.name === name) return frameTree.frame;
  for (const child of frameTree.childFrames ?? []) {
    const match = findFrameByName(child, name);
    if (match) return match;
  }
  return null;
}

async function flightDeckDocument() {
  const pageResponse = await fetch(appUrl, { cache: "no-store", headers: { origin: "app://-" } });
  if (!pageResponse.ok) throw new Error(`Flight Deck 本地页面无法读取（HTTP ${pageResponse.status}）。`);
  const pageHtml = await pageResponse.text();
  if (!pageHtml.includes("<head>")) throw new Error("Flight Deck 本地页面缺少 head 标签。");
  const apiBridge = `<script>(() => {
    const apiOrigin = ${JSON.stringify(appUrl)};
    const resolveApi = (value) => typeof value === "string" && value.startsWith("/api/")
      ? new URL(value, apiOrigin).href
      : value;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => nativeFetch(resolveApi(input), init);
    const NativeEventSource = window.EventSource;
    window.EventSource = function FlightDeckEventSource(url, options) { return new NativeEventSource(resolveApi(url), options); };
    window.EventSource.prototype = NativeEventSource.prototype;
  })();</script>`;
  return pageHtml.replace("<head>", `<head><base href=${JSON.stringify(appUrl)}>${apiBridge}`);
}

async function evaluate(cdp, expression, timeoutMs) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, timeoutMs);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "Flight Deck 注入脚本执行失败。");
  }
  return result.result?.value;
}

async function readStatus(cdp) {
  return evaluate(cdp, `window.__flightDeckInjector?.refresh?.() || { entry: false }`);
}

async function waitForStatus(cdp, predicate, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let status = await readStatus(cdp);
  while (Date.now() < until && !predicate(status)) {
    await sleep(250);
    status = await readStatus(cdp);
  }
  return status;
}

async function loadFrameDocument(cdp, frameName, html) {
  const until = Date.now() + 8_000;
  while (Date.now() < until) {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const targetFrame = findFrameByName(frameTree, frameName);
    if (targetFrame) {
      await cdp.send("Page.setDocumentContent", { frameId: targetFrame.id, html });
      return true;
    }
    await sleep(80);
  }
  throw new Error("等待隔离 Flight Deck iframe 超时。");
}

async function injectTarget(target, source, html, shouldOpen, keepAlive) {
  const cdp = new CdpConnection(target.webSocketDebuggerUrl);
  await cdp.open();
  let retained = false;
  try {
    await cdp.send("Page.enable");
    await cdp.send("Page.setBypassCSP", { enabled: true });
    await cdp.send("Runtime.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `${source}\n//# sourceURL=flight-deck.user.js`,
    });
    await evaluate(cdp, source);
    let status = await waitForStatus(cdp, (value) => value?.entry, 20_000);
    if (!status?.entry) throw new Error("Codex 侧栏尚未出现 Flight Deck 入口。");
    if (shouldOpen) {
      await evaluate(cdp, `window.__flightDeckInjector?.open?.()`);
      status = await waitForStatus(cdp, (value) => value?.frameName && value?.pageVisible, 15_000);
      if (!status?.frameName) throw new Error("Flight Deck 隔离 iframe 未能挂载。");
      await loadFrameDocument(cdp, status.frameName, html);
      await evaluate(cdp, `window.__flightDeckInjector?.markFrameReady?.()`);
    }
    retained = keepAlive;
    return { connection: retained ? cdp : null, status: await readStatus(cdp) };
  } finally {
    if (!retained) cdp.close();
  }
}

async function injectAll(port, source, html, shouldOpen, injected, keepAlive) {
  const targets = await waitForCodexTargets(port, injected.size ? 5_000 : 45_000).catch((error) => {
    if (injected.size) return [];
    throw error;
  });
  const activeIds = new Set(targets.map((target) => target.id));
  for (const [id, connection] of injected) {
    if (!activeIds.has(id) || connection.closed) {
      connection.close();
      injected.delete(id);
    }
  }
  const results = [];
  for (const target of targets) {
    if (injected.has(target.id)) continue;
    const first = injected.size === 0 && results.length === 0;
    try {
      const { connection, status } = await injectTarget(target, source, html, shouldOpen && first, keepAlive);
      if (connection) injected.set(target.id, connection);
      results.push({ targetId: target.id, title: target.title, url: target.url, ...status });
      console.log(JSON.stringify({ injected: true, title: target.title, entry: status.entry, pageVisible: status.pageVisible, frameReady: status.frameReady }));
    } catch (error) {
      console.error(`注入 ${target.title || target.id} 失败：${error.message}`);
    }
  }
  return results;
}

const options = parseArgs(process.argv.slice(2));
await ensureFlightDeck();
const source = `window.__FLIGHT_DECK_URL__ = ${JSON.stringify(appUrl)};\n${await readFile(injectionPath, "utf8")}`;
const html = await flightDeckDocument();
if (options.launch) await launchCodex(options.port);
else await waitUntilReachable(`http://127.0.0.1:${options.port}/json/version`, 15_000);

const injected = new Map();
console.log("正在按 Codex Taskboard 方式注入侧栏…");
const first = await injectAll(options.port, source, html, options.open, injected, options.watch);
if (!first.length && !options.watch) {
  throw new Error("未能注入任何 Codex 主窗口。");
}

if (!options.watch) {
  for (const connection of injected.values()) connection.close();
  process.exit(first.some((item) => item.entry) ? 0 : 1);
}

console.log(`注入器保持运行中（端口 ${options.port}）。按 Ctrl-C 结束。`);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const connection of injected.values()) connection.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

while (!stopping) {
  await sleep(1500);
  try {
    await injectAll(options.port, source, html, false, injected, true);
  } catch (error) {
    console.error(`监视注入失败：${error.message}`);
  }
}
