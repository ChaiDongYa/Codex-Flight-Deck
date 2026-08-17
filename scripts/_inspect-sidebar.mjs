const port = 49233;
const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const target = list.find((t) => t.type === "page" && (t.url?.startsWith("app://") || t.title === "Codex"));
if (!target) throw new Error("no codex page");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let id = 0;
const pending = new Map();
ws.addEventListener("message", async ({ data }) => {
  const text = typeof data === "string" ? data : await data.text();
  const msg = JSON.parse(text);
  if (!msg.id) return;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
});
function send(method, params = {}) {
  const next = ++id;
  return new Promise((resolve, reject) => {
    pending.set(next, { resolve, reject });
    ws.send(JSON.stringify({ id: next, method, params }));
  });
}
await send("Runtime.enable");
const { result } = await send("Runtime.evaluate", {
  returnByValue: true,
  expression: `(() => {
    const style = document.getElementById("flight-deck-codex-style");
    const buttons = [...document.querySelectorAll("aside button, [data-app-action-sidebar-scroll] button")];
    const plugin = buttons.find((b) => /插件|plugins/i.test(b.textContent || b.getAttribute("aria-label") || ""));
    const fd = document.getElementById("flight-deck-codex-entry");
    function summarize(el) {
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName,
        id: el.id,
        className: String(el.className).slice(0, 300),
        ariaCurrent: el.getAttribute("aria-current"),
        dataState: el.getAttribute("data-state"),
        bg: cs.backgroundColor,
        pointerEvents: cs.pointerEvents,
        attrs: [...el.attributes].map((a) => a.name + "=" + a.value.slice(0, 80)).slice(0, 20),
      };
    }
    const hoverRules = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        if (!rule.selectorText || !/:hover/.test(rule.selectorText)) continue;
        if (/sidebar|nav|token-list|app-action|text-fade|hover:bg/.test(rule.selectorText + rule.cssText)) {
          hoverRules.push(rule.cssText.slice(0, 280));
        }
      }
    }
    return {
      plugin: summarize(plugin),
      pluginParent: summarize(plugin?.parentElement),
      fd: summarize(fd),
      fdParent: summarize(fd?.parentElement),
      hoverRules: hoverRules.slice(0, 25),
      pluginHtml: plugin?.outerHTML?.slice(0, 800),
      fdHtml: fd?.outerHTML?.slice(0, 800),
    };
  })()`,
});
console.log(JSON.stringify(result.value, null, 2));
ws.close();
