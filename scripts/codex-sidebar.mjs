#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.FLIGHT_DECK_CDP_PORT || 49232);
const appUrl = process.env.FLIGHT_DECK_URL || "http://127.0.0.1:48173/";
const profilePath = process.env.FLIGHT_DECK_CODEX_PROFILE || path.join(os.homedir(), "Library", "Application Support", "Flight Deck", "codex-profile");
const script = await readFile(path.join(root, "inject", "flight-deck.user.js"), "utf8");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function targets() { const response = await fetch(`http://127.0.0.1:${port}/json/list`); return response.json(); }
async function waitForTarget() {
  const until = Date.now() + 45_000;
  while (Date.now() < until) {
    try {
      const pages = await targets();
      const target = pages.find((item) => item.type === "page" && item.url === "app://-/index.html" && item.webSocketDebuggerUrl);
      if (target) return target;
    } catch {}
    await sleep(500);
  }
  throw new Error("未能连接到 Codex 窗口。请确认已登录 Codex 后重试。");
}
function connect(url) {
  const socket = new WebSocket(url);
  let sequence = 0;
  const waiting = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id);
    message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; waiting.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  return new Promise((resolve, reject) => { socket.addEventListener("open", () => resolve({ socket, call }), { once: true }); socket.addEventListener("error", reject, { once: true }); });
}
async function isDebugging() { try { await targets(); return true; } catch { return false; } }
async function isFlightDeckAvailable() { try { const response = await fetch(appUrl, { signal: AbortSignal.timeout(1500) }); return response.ok; } catch { return false; } }
async function ensureFlightDeck() {
  if (await isFlightDeckAvailable()) return;
  spawn("npm", ["run", "dev"], { cwd: root, stdio: "ignore", detached: true }).unref();
  const until = Date.now() + 20_000;
  while (Date.now() < until) { if (await isFlightDeckAvailable()) return; await sleep(500); }
  throw new Error(`Flight Deck 本地服务未能启动：${appUrl}`);
}

await ensureFlightDeck();
if (!(await isDebugging())) {
  await mkdir(profilePath, { recursive: true });
  spawn("open", ["-n", "-a", "/Applications/ChatGPT.app", "--args", `--user-data-dir=${profilePath}`, `--remote-debugging-port=${port}`, `--remote-allow-origins=http://127.0.0.1:${port}`], { stdio: "ignore", detached: true }).unref();
  console.log("正在启动专用 Codex 窗口…");
}
const target = await waitForTarget();
const cdp = await connect(target.webSocketDebuggerUrl);
await cdp.call("Page.setBypassCSP", { enabled: true });
await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: `window.__FLIGHT_DECK_URL__=${JSON.stringify(appUrl)};\n${script}` });
// Codex's renderer applies its CSP after initial document creation. Reload once
// after enabling the CDP bypass so the local Flight Deck iframe is permitted.
await cdp.call("Page.reload", { ignoreCache: true });
await sleep(700);
await cdp.call("Runtime.evaluate", { expression: `window.__FLIGHT_DECK_URL__=${JSON.stringify(appUrl)};\n${script}`, awaitPromise: true });
console.log(`Flight Deck 已注入独立 Codex 窗口（端口 ${port}）。点击 Flight Deck 即可打开。`);
cdp.socket.close();
