#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.FLIGHT_DECK_CDP_PORT || 9232);
const appUrl = process.env.FLIGHT_DECK_URL || "http://127.0.0.1:4173/";
const script = await readFile(path.join(root, "inject", "flight-deck.user.js"), "utf8");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function targets() { const response = await fetch(`http://127.0.0.1:${port}/json/list`); return response.json(); }
async function waitForTarget() {
  const until = Date.now() + 45_000;
  while (Date.now() < until) {
    try {
      const pages = await targets();
      const target = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
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

if (!(await isDebugging())) {
  spawn("open", ["-n", "-a", "/Applications/ChatGPT.app", "--args", `--remote-debugging-port=${port}`, `--remote-allow-origins=http://127.0.0.1:${port}`], { stdio: "ignore", detached: true }).unref();
  console.log("正在启动专用 Codex 窗口…");
}
const target = await waitForTarget();
const cdp = await connect(target.webSocketDebuggerUrl);
await cdp.call("Page.setBypassCSP", { enabled: true });
await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: `window.__FLIGHT_DECK_URL__=${JSON.stringify(appUrl)};\n${script}` });
await cdp.call("Page.reload", { ignoreCache: true });
console.log(`Flight Deck 已注入 Codex 侧栏（端口 ${port}）。Codex 窗口会重载一次；重载后点击 Flight Deck 即可打开。`);
cdp.socket.close();
