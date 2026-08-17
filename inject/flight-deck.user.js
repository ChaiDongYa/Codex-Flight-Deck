(() => {
  "use strict";

  const SENTINEL = "__flightDeckInjector";
  const ENTRY_ID = "flight-deck-codex-entry";
  const PAGE_ID = "flight-deck-codex-page";
  const FRAME_ID = "flight-deck-codex-frame";
  const STATUS_ID = "flight-deck-codex-status";
  const STYLE_ID = "flight-deck-codex-style";
  const OWNED = "data-flight-deck-owned";
  const HIDDEN = "data-flight-deck-native-hidden";
  const HOST_ATTR = "data-flight-deck-page-host";
  const MUTED = "data-flight-deck-native-selected";
  const APP_URL = window.__FLIGHT_DECK_URL__ || "http://127.0.0.1:48173/";
  const PLUGIN_LABELS = ["插件", "plugins", "任务面板", "taskboard"];
  const previous = window[SENTINEL];
  if (previous && typeof previous.refresh === "function" && previous.version === 5) {
    previous.refresh();
    return;
  }
  try { previous?.dispose?.(); } catch {}

  let active = false;
  let entry;
  let page;
  let frame;
  let status;
  let disposed = false;
  let frameName = "";
  let frameReady = false;
  let reattachTimer = null;
  const mutedNativeSelections = new Map();

  document.querySelectorAll(`[${OWNED}="true"]`).forEach((node) => node.remove());
  document.querySelectorAll(`[${HIDDEN}="true"]`).forEach((node) => node.removeAttribute(HIDDEN));
  document.querySelectorAll(`[${HOST_ATTR}="true"]`).forEach((node) => node.removeAttribute(HOST_ATTR));
  document.querySelectorAll(`[${MUTED}="true"]`).forEach((node) => node.removeAttribute(MUTED));

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.setAttribute(OWNED, "true");
  style.textContent = `
    [${HOST_ATTR}="true"]{position:relative!important;z-index:31!important;pointer-events:none!important}
    [${HIDDEN}="true"]{visibility:hidden!important;pointer-events:none!important}
    #${PAGE_ID}{position:absolute;inset:0;z-index:1;min-width:0;min-height:0;overflow:hidden;background:Canvas;color:CanvasText;pointer-events:auto}
    #${PAGE_ID}[hidden]{display:none!important}
    #${FRAME_ID}{display:block;width:100%;height:100%;border:0;background:Canvas;pointer-events:auto}
    #${FRAME_ID}[hidden]{display:none!important}
    #${STATUS_ID}{position:absolute;inset:0;display:grid;place-items:center;padding:24px;color:var(--color-token-text-secondary,#64748b);font:13px/1.5 system-ui,sans-serif;text-align:center}
    #${STATUS_ID}[hidden]{display:none!important}
  `;
  (document.head || document.documentElement).appendChild(style);

  function normalizedLabel(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function buttonMatches(button, labels) {
    if (!button) return false;
    return labels.includes(normalizedLabel(button.textContent || button.getAttribute("aria-label")));
  }

  function referenceButton() {
    const scroll = document.querySelector("[data-app-action-sidebar-scroll]")
      || document.querySelector('aside [role="navigation"]')
      || document.querySelector("aside nav")
      || document.querySelector("aside");
    if (!scroll) return null;
    const buttons = [...scroll.querySelectorAll("button,[role=button]")];
    const plugin = buttons.find((button) => buttonMatches(button, PLUGIN_LABELS));
    if (plugin?.parentElement) return plugin;
    const firstSection = scroll.querySelector("[data-app-action-sidebar-section]");
    const sectionTop = firstSection?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    const groups = [...scroll.querySelectorAll("div")].filter((element) => {
      const directButtons = [...element.children].filter((child) => child.tagName === "BUTTON");
      return directButtons.length >= 3 && element.getBoundingClientRect().top < sectionTop;
    });
    const group = groups.sort((left, right) => right.children.length - left.children.length)[0];
    return [...(group?.children || [])].filter((child) => child.tagName === "BUTTON").at(-1)
      || buttons[3]
      || buttons[0]
      || null;
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
    if (disposed) return;
    const reference = referenceButton();
    if (!reference?.parentElement) return;
    if (!entry) {
      entry = reference.cloneNode(true);
      entry.id = ENTRY_ID;
      entry.type = "button";
      entry.setAttribute(OWNED, "true");
      entry.removeAttribute("aria-expanded");
      entry.removeAttribute("aria-controls");
      entry.removeAttribute("aria-current");
      entry.removeAttribute("data-state");
      entry.removeAttribute("data-active");
      entry.classList.remove("active", "selected");
      entry.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
      replaceIcon(entry);
      entry.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        open();
      });
    }
    const label = entry.querySelector(".text-fade-truncate")
      || [...entry.querySelectorAll("span")].find((node) => node.textContent?.trim());
    if (label) label.textContent = "Flight Deck";
    else entry.textContent = "Flight Deck";
    entry.setAttribute("aria-label", "打开 Flight Deck");
    entry.setAttribute("title", "Flight Deck");
    if (entry.parentElement !== reference.parentElement || entry.previousElementSibling !== reference) {
      reference.after(entry);
    }
    if (active) {
      entry.setAttribute("aria-current", "page");
      muteNativeSelection();
    } else {
      entry.removeAttribute("aria-current");
    }
  }

  function nativeSidebarRoot() {
    return entry?.closest("aside")
      || document.querySelector("[data-app-action-sidebar-scroll]")
      || document.querySelector('aside [role="navigation"]')
      || document.querySelector("aside");
  }

  function muteNativeSelection() {
    if (!active) return;
    const sidebar = nativeSidebarRoot();
    if (!sidebar) return;
    sidebar.querySelectorAll("[aria-current]").forEach((node) => {
      if (node === entry || node.closest(`#${ENTRY_ID}`)) return;
      if (!mutedNativeSelections.has(node)) {
        mutedNativeSelections.set(node, node.getAttribute("aria-current"));
      }
      node.removeAttribute("aria-current");
    });
  }

  function restoreNativeSelection() {
    mutedNativeSelections.forEach((ariaCurrent, node) => {
      if (!node.isConnected) return;
      if (ariaCurrent) node.setAttribute("aria-current", ariaCurrent);
      else node.removeAttribute("aria-current");
      node.removeAttribute(MUTED);
    });
    mutedNativeSelections.clear();
    document.querySelectorAll(`[${MUTED}="true"]`).forEach((node) => node.removeAttribute(MUTED));
  }

  function findPageMount() {
    const frameHost = document.querySelector(".app-shell-main-content-frame");
    const viewport = frameHost?.closest?.("[data-app-shell-main-content-layout]")
      || document.querySelector("[data-app-shell-main-content-layout]");
    const surface = viewport?.parentElement;
    if (surface?.closest?.("main")) return { surface, layout: viewport };
    const layout = document.querySelector("main");
    if (!layout) return null;
    return { surface: layout, layout };
  }

  function hideNativeTitle(layout) {
    const surface = layout?.closest("main") || layout;
    const titleRoot = surface?.querySelector(":scope > header")
      || document.querySelector('[data-testid="app-shell-header-context-menu-surface"]');
    if (titleRoot) titleRoot.setAttribute(HIDDEN, "true");
  }

  function createPage() {
    const section = document.createElement("section");
    section.id = PAGE_ID;
    section.hidden = true;
    section.setAttribute(OWNED, "true");
    section.setAttribute("aria-label", "Flight Deck");
    status = document.createElement("div");
    status.id = STATUS_ID;
    status.setAttribute("role", "status");
    status.textContent = "正在启动 Flight Deck…";
    section.appendChild(status);
    return section;
  }

  function showFrame() {
    if (status) status.hidden = true;
    if (frame) frame.hidden = false;
  }

  function loadIsolatedFrame() {
    frame?.remove();
    frameReady = false;
    frameName = `flight-deck-${crypto.randomUUID()}`;
    const next = document.createElement("iframe");
    next.id = FRAME_ID;
    next.name = frameName;
    next.hidden = true;
    next.title = "Flight Deck";
    next.referrerPolicy = "no-referrer";
    next.src = "about:blank";
    next.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-downloads");
    next.setAttribute("allow", "clipboard-read; clipboard-write");
    frame = next;
    page.appendChild(next);
    return frameName;
  }

  function mount() {
    if (disposed || !active) return;
    const found = findPageMount();
    if (!found) return;
    const { surface, layout } = found;
    if (!page) page = createPage();
    if (!frame) loadIsolatedFrame();
    if (page.parentElement !== surface) surface.appendChild(page);
    surface.setAttribute(HOST_ATTR, "true");
    [...surface.children].forEach((child) => {
      if (child !== page && child.getAttribute(OWNED) !== "true") child.setAttribute(HIDDEN, "true");
    });
    hideNativeTitle(layout);
    muteNativeSelection();
    page.hidden = false;
    if (frameReady) showFrame();
  }

  function close() {
    if (disposed) return;
    active = false;
    if (page) page.hidden = true;
    document.querySelectorAll(`[${HIDDEN}="true"]`).forEach((node) => node.removeAttribute(HIDDEN));
    document.querySelectorAll(`[${HOST_ATTR}="true"]`).forEach((node) => node.removeAttribute(HOST_ATTR));
    restoreNativeSelection();
    ensureEntry();
  }

  function open() {
    if (disposed) return;
    active = true;
    ensureEntry();
    mount();
    if (!frame) loadIsolatedFrame();
  }

  function snapshot() {
    return {
      entry: Boolean(document.getElementById(ENTRY_ID)),
      page: Boolean(document.getElementById(PAGE_ID)),
      frame: Boolean(document.getElementById(FRAME_ID)),
      frameName,
      frameReady,
      pageVisible: page?.hidden === false,
      appUrl: APP_URL,
    };
  }

  function nativeNavigation(event) {
    const target = event.target?.closest?.("button,a,[role=button],[data-app-action-sidebar-thread-id]");
    return target && target !== entry && !target.closest(`#${ENTRY_ID}`) && target.closest("aside");
  }

  document.addEventListener("click", (event) => {
    if (active && nativeNavigation(event)) close();
  }, true);

  const observer = new MutationObserver(() => {
    if (disposed || reattachTimer !== null) return;
    reattachTimer = window.setTimeout(() => {
      reattachTimer = null;
      ensureEntry();
      if (active) {
        mount();
        muteNativeSelection();
      }
    }, 160);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window[SENTINEL] = {
    version: 5,
    open,
    close,
    loadIsolatedFrame,
    markFrameReady() {
      frameReady = true;
      showFrame();
      return snapshot();
    },
    snapshot,
    refresh() {
      ensureEntry();
      if (active) {
        mount();
        muteNativeSelection();
      }
      return snapshot();
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      if (reattachTimer !== null) window.clearTimeout(reattachTimer);
      page?.remove();
      entry?.remove();
      style.remove();
      document.querySelectorAll(`[${HIDDEN}="true"]`).forEach((node) => node.removeAttribute(HIDDEN));
      document.querySelectorAll(`[${HOST_ATTR}="true"]`).forEach((node) => node.removeAttribute(HOST_ATTR));
      restoreNativeSelection();
    },
  };
  ensureEntry();
})();
