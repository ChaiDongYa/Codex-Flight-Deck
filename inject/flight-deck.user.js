(() => {
  window.__flightDeckInjector?.dispose?.();
  const ENTRY_ID = "flight-deck-codex-entry";
  const PAGE_ID = "flight-deck-codex-page";
  const FRAME_ID = "flight-deck-codex-frame";
  const OWNED = "data-flight-deck-owned";
  const HIDDEN = "data-flight-deck-native-hidden";
  const APP_URL = window.__FLIGHT_DECK_URL__ || "http://127.0.0.1:48173/";
  // The launcher can inject an updated script into an already-open Codex
  // window. Remove the previous instance first; otherwise an old iframe can
  // remain above the new one and preserve stale positioning rules.
  document.querySelectorAll(`[${OWNED}="true"]`).forEach((node) => node.remove());
  document.querySelectorAll(`[${HIDDEN}="true"]`).forEach((node) => node.removeAttribute(HIDDEN));
  let active = false;
  let entry;
  let page;
  let disposed = false;

  const style = document.createElement("style");
  style.setAttribute(OWNED, "true");
  style.textContent = `
    #${PAGE_ID}{position:absolute;inset:0;z-index:20;background:var(--color-token-main-surface-primary,#fff)}
    #${PAGE_ID}[hidden]{display:none!important}
    #${FRAME_ID}{width:100%;height:100%;border:0;background:#fff}
    [${HIDDEN}="true"]{display:none!important}
    #${ENTRY_ID}{box-shadow:none!important}
    #${ENTRY_ID}[data-flight-deck-active="true"]{background:var(--color-token-main-surface-secondary,rgba(127,127,127,.12))!important}
    [data-app-action-sidebar-scroll][data-flight-deck-active="true"] :is(button,a,[role="button"]):not(#${ENTRY_ID})[aria-current="page"],
    [data-app-action-sidebar-scroll][data-flight-deck-active="true"] :is(button,a,[role="button"]):not(#${ENTRY_ID})[data-state="active"],
    [data-app-action-sidebar-scroll][data-flight-deck-active="true"] :is(button,a,[role="button"]):not(#${ENTRY_ID})[data-active="true"],
    [data-app-action-sidebar-scroll][data-flight-deck-active="true"] :is(button,a,[role="button"]):not(#${ENTRY_ID})[aria-current="page"] *,
    [data-app-action-sidebar-scroll][data-flight-deck-active="true"] :is(button,a,[role="button"]):not(#${ENTRY_ID})[data-state="active"] *,
    [data-app-action-sidebar-scroll][data-flight-deck-active="true"] :is(button,a,[role="button"]):not(#${ENTRY_ID})[data-active="true"] *{background:transparent!important;background-color:transparent!important;box-shadow:none!important;outline:0!important}
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
      const label = entry.querySelector(".text-fade-truncate") || [...entry.querySelectorAll("span")].find((node) => node.textContent?.trim());
      if (label) label.textContent = "Flight Deck";
      else entry.textContent = "Flight Deck";
      entry.setAttribute("aria-label", "打开 Flight Deck");
      entry.setAttribute("title", "Flight Deck");
      replaceIcon(entry);
      entry.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); open(); });
    }
    if (entry.parentElement !== reference.parentElement || entry.previousElementSibling !== reference) reference.after(entry);
    entry.toggleAttribute("data-flight-deck-active", active);
    const sidebar = entry.closest("[data-app-action-sidebar-scroll]");
    if (sidebar) {
      sidebar.toggleAttribute("data-flight-deck-active", active);
      if (active) suppressNativeSidebarSelection(sidebar);
    }
  }

  function suppressNativeSidebarSelection(sidebar) {
    // React owns these attributes, so do not mutate them. The scoped CSS above
    // suppresses their visual state only while Flight Deck is active.
    sidebar.querySelectorAll(":is(button,a,[role=button])").forEach((node) => {
      if (node === entry) return;
      node.style.removeProperty("background");
      node.style.removeProperty("box-shadow");
    });
  }

  function hideNativeTitle(layout) {
    const surface = layout?.closest("main");
    const titleRoot = surface?.querySelector(":scope > header");
    if (titleRoot) titleRoot.setAttribute(HIDDEN, "true");
  }

  function mount() {
    if (disposed) return;
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
    hideNativeTitle(layout);
    page.hidden = false;
  }

  function close() {
    if (disposed) return;
    active = false;
    if (page) page.hidden = true;
    document.querySelectorAll(`[${HIDDEN}="true"]`).forEach((node) => node.removeAttribute(HIDDEN));
    ensureEntry();
  }

  function open() { if (disposed) return; active = true; ensureEntry(); mount(); }
  function nativeNavigation(event) {
    const target = event.target?.closest?.("button,a,[role=button]");
    return target && target !== entry && !target.closest(`#${ENTRY_ID}`) && target.closest("aside");
  }

  document.addEventListener("click", (event) => { if (active && nativeNavigation(event)) close(); }, true);
  const observer = new MutationObserver(() => { ensureEntry(); if (active) mount(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.__flightDeckInjector = {
    dispose() {
      disposed = true;
      observer.disconnect();
      page?.remove();
      entry?.remove();
      style.remove();
      document.querySelectorAll(`[${HIDDEN}="true"]`).forEach((node) => node.removeAttribute(HIDDEN));
    },
  };
  ensureEntry();
})();
