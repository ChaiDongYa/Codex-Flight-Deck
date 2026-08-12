(() => {
  const ENTRY_ID = "flight-deck-codex-entry";
  const PAGE_ID = "flight-deck-codex-page";
  const FRAME_ID = "flight-deck-codex-frame";
  const OWNED = "data-flight-deck-owned";
  const HIDDEN = "data-flight-deck-native-hidden";
  const APP_URL = window.__FLIGHT_DECK_URL__ || "http://127.0.0.1:48173/";
  let active = false;
  let entry;
  let page;
  let reconnectTimer;

  const style = document.createElement("style");
  style.setAttribute(OWNED, "true");
  style.textContent = `
    #${PAGE_ID}{position:absolute;inset:0;z-index:20;background:var(--color-token-main-surface-primary,#fff)}
    #${PAGE_ID}[hidden]{display:none!important}
    #${FRAME_ID}{width:100%;height:100%;border:0;background:#fff}
    [${HIDDEN}="true"]{display:none!important}
    #${ENTRY_ID}[aria-current="page"]{background:var(--color-token-main-surface-secondary,rgba(127,127,127,.12))}
  `;
  (document.head || document.documentElement).appendChild(style);

  function referenceButton() {
    const sidebar = document.querySelector("[data-app-action-sidebar-scroll]");
    if (!sidebar) return null;
    const buttons = [...sidebar.querySelectorAll("button")];
    return buttons.find((button) => /任务面板|taskboard/i.test(button.textContent || button.getAttribute("aria-label") || ""))
      || buttons.find((button) => /插件|plugins/i.test(button.textContent || button.getAttribute("aria-label") || ""))
      || buttons[3];
  }

  function replaceIcon(button) {
    const icon = button.querySelector("svg");
    if (!icon) return;
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.8");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.innerHTML = '<path d="M4 6.5h16M4 12h16M4 17.5h10"></path><path d="M17 16.5l1.5 1.5L21 15.5"></path>';
  }

  function ensureEntry() {
    const reference = referenceButton();
    if (!reference?.parentElement) return;
    if (!entry) {
      entry = reference.cloneNode(true);
      entry.id = ENTRY_ID;
      entry.type = "button";
      entry.setAttribute(OWNED, "true");
      entry.removeAttribute("aria-expanded");
      entry.removeAttribute("aria-controls");
      entry.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
      const label = entry.querySelector(".text-fade-truncate") || [...entry.querySelectorAll("span")].find((node) => node.textContent?.trim());
      if (label) label.textContent = "Flight Deck";
      else entry.textContent = "Flight Deck";
      entry.setAttribute("aria-label", "打开 Flight Deck");
      entry.setAttribute("title", "Flight Deck");
      replaceIcon(entry);
      entry.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); open(); });
    }
    if (entry.parentElement !== reference.parentElement || entry.previousElementSibling !== reference) reference.after(entry);
    if (active) entry.setAttribute("aria-current", "page"); else entry.removeAttribute("aria-current");
  }

  function mount() {
    const layout = document.querySelector("[data-app-shell-main-content-layout]");
    const host = layout?.parentElement;
    if (!layout || !host) return;
    host.style.position = "relative";
    if (!page) {
      page = document.createElement("section");
      page.id = PAGE_ID;
      page.setAttribute(OWNED, "true");
      page.setAttribute("aria-label", "Flight Deck");
      const frame = document.createElement("iframe");
      frame.id = FRAME_ID;
      frame.title = "Flight Deck";
      frame.src = APP_URL;
      frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-downloads allow-same-origin");
      page.appendChild(frame);
    }
    if (page.parentElement !== host) host.appendChild(page);
    [...host.children].forEach((child) => { if (child !== page && child.getAttribute(OWNED) !== "true") child.setAttribute(HIDDEN, "true"); });
    page.hidden = false;
    if (!reconnectTimer) reconnectTimer = window.setInterval(() => {
      if (!active) return;
      fetch(APP_URL, { mode: "no-cors", cache: "no-store" }).then(() => {
        const frame = page?.querySelector(`#${FRAME_ID}`);
        if (frame?.dataset.flightDeckOffline === "true") { frame.dataset.flightDeckOffline = "false"; frame.src = APP_URL; }
      }).catch(() => {
        const frame = page?.querySelector(`#${FRAME_ID}`);
        if (frame) frame.dataset.flightDeckOffline = "true";
      });
    }, 3000);
  }

  function close() {
    active = false;
    if (reconnectTimer) { window.clearInterval(reconnectTimer); reconnectTimer = undefined; }
    if (page) page.hidden = true;
    document.querySelectorAll(`[${HIDDEN}="true"]`).forEach((node) => node.removeAttribute(HIDDEN));
    ensureEntry();
  }

  function open() { active = true; ensureEntry(); mount(); }
  function nativeNavigation(event) {
    const target = event.target?.closest?.("button,a,[role=button]");
    return target && target !== entry && !target.closest(`#${ENTRY_ID}`) && target.closest("aside");
  }

  document.addEventListener("click", (event) => { if (active && nativeNavigation(event)) close(); }, true);
  const observer = new MutationObserver(() => { ensureEntry(); if (active) mount(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureEntry();
})();
