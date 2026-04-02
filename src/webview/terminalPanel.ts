/**
 * Terminal panel renderer for the webview side.
 *
 * Manages xterm.js Terminal instances, tab bar rendering, addons (fit, search,
 * web links, webgl, unicode11), and routes keyboard input back to the extension
 * host via postMessage.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { WebviewMessage, TerminalSessionInfo, ButtonProfileInfo, WorkItemDTO } from "./messages";
import { getProfileIconSymbol } from "./profileIcons";

// ---------------------------------------------------------------------------
// xterm.js CSS (embedded to avoid CSP issues with external stylesheets)
// ---------------------------------------------------------------------------

const XTERM_CSS_INJECTED = "__wt_xterm_css_injected__";

function injectXtermCss(): void {
  if ((window as unknown as Record<string, unknown>)[XTERM_CSS_INJECTED]) return;
  (window as unknown as Record<string, unknown>)[XTERM_CSS_INJECTED] = true;

  const style = document.createElement("style");
  style.textContent = `
    .xterm {
      cursor: text;
      position: relative;
      user-select: none;
      -ms-user-select: none;
      -webkit-user-select: none;
    }
    .xterm.focus, .xterm:focus { outline: none; }
    .xterm .xterm-helpers { position: absolute; top: 0; z-index: 5; }
    .xterm .xterm-helper-textarea {
      padding: 0; border: 0; margin: 0;
      position: absolute; overflow: hidden;
      resize: none; width: 1px; height: 1px;
      left: -9999em; top: 0; bottom: 0;
      opacity: 0; z-index: -5;
      white-space: nowrap;
    }
    .xterm .composition-view {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      display: none; position: absolute; white-space: nowrap; z-index: 1;
    }
    .xterm .composition-view.active { display: block; }
    .xterm .xterm-viewport {
      background-color: var(--vscode-terminal-background, var(--vscode-editor-background));
      overflow-y: scroll; cursor: default;
      position: absolute; right: 0; left: 0; top: 0; bottom: 0;
    }
    .xterm .xterm-screen {
      position: relative;
    }
    .xterm .xterm-screen canvas { position: absolute; left: 0; top: 0; }
    .xterm .xterm-scroll-area { visibility: hidden; }
    .xterm-char-measure-element {
      display: inline-block; visibility: hidden;
      position: absolute; top: 0; left: -9999em;
      line-height: normal;
    }
    .xterm.enable-mouse-events { cursor: default; }
    .xterm .xterm-cursor-pointer { cursor: pointer; }
    .xterm.column-select.focus { cursor: crosshair; }
    .xterm.xterm-cursor-stylebar .xterm-rows .xterm-cursor { border-left-color: var(--vscode-terminalCursor-foreground, #fff); }
    .xterm.xterm-cursor-styleunderline .xterm-rows .xterm-cursor { border-bottom-color: var(--vscode-terminalCursor-foreground, #fff); }
    .xterm .xterm-rows { color: var(--vscode-terminal-foreground, var(--vscode-editor-foreground)); }
    .xterm .xterm-rows .xterm-cursor.xterm-cursor-block { background-color: var(--vscode-terminalCursor-foreground, #fff); color: var(--vscode-terminal-background, var(--vscode-editor-background)); }
    .xterm .xterm-selection div {
      position: absolute;
      background-color: var(--vscode-terminal-selectionBackground, rgba(255,255,255,0.3));
    }
    .xterm .xterm-decoration-container .xterm-decoration { z-index: 6; position: absolute; }
    .xterm .xterm-decoration-container .xterm-decoration.xterm-decoration-top-layer { z-index: 7; }
    .xterm .xterm-decoration-overview-ruler {
      z-index: 8; position: absolute; top: 0; right: 0;
      pointer-events: none;
    }
    .xterm .xterm-decoration-top { z-index: 2; position: relative; }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Terminal tab state
// ---------------------------------------------------------------------------

interface TerminalTab {
  sessionId: string;
  label: string;
  sessionType: string;
  itemId: string | null;
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  containerEl: HTMLElement;
  webglAddon: WebglAddon | null;
  agentState: string;
}

// ---------------------------------------------------------------------------
// Agent state colors
// ---------------------------------------------------------------------------

const STATE_COLORS: Record<string, string> = {
  active: "#38a169",
  idle: "#d69e2e",
  waiting: "#e53e3e",
  inactive: "transparent",
};

const TAB_OVERFLOW_BUFFER_PX = 20;

// ---------------------------------------------------------------------------
// TerminalPanel
// ---------------------------------------------------------------------------

export class TerminalPanel {
  private tabs: TerminalTab[] = [];
  private activeIndex = -1;
  private pendingTabSwitchFrame: number | null = null;
  private disposed = false;
  private postMessage: (msg: WebviewMessage) => void;
  private selectedItemId: string | null = null;
  private tabBarEl: HTMLElement;
  private tabsContainerEl: HTMLElement;
  private tabButtonsEl: HTMLElement;
  private terminalWrapperEl: HTMLElement;
  private emptyStateEl: HTMLElement;
  private taskTitleEl: HTMLElement;
  private taskTitleTextEl: HTMLElement;
  private resizeObserver: ResizeObserver;
  private tabBarResizeObserver: ResizeObserver | null = null;
  private tabBarOverflowFrame: number | null = null;
  private overflowMenuFrame: number | null = null;
  private dismissOverflowMenu: (() => void) | null = null;
  private searchBarVisible = false;
  private buttonProfiles: ButtonProfileInfo[] = [];
  private workItems: WorkItemDTO[] = [];
  private hookBannerEl: HTMLElement | null = null;
  private hookStatusEl: HTMLElement | null = null;

  constructor(postMessage: (msg: WebviewMessage) => void) {
    this.postMessage = postMessage;

    this.tabBarEl = document.getElementById("tab-bar")!;
    this.tabsContainerEl = document.getElementById("tabs-container")!;
    this.tabButtonsEl = document.getElementById("tab-buttons")!;
    this.terminalWrapperEl = document.getElementById("terminal-wrapper")!;
    this.emptyStateEl = document.getElementById("empty-state")!;
    this.taskTitleEl = document.getElementById("task-title")!;
    this.taskTitleTextEl = document.getElementById("task-title-text")!;

    injectXtermCss();
    this.renderTabBar();
    this.renderSpawnButtons();

    // Observe terminal wrapper resizes to refit active terminal
    this.resizeObserver = new ResizeObserver(() => {
      this.refitActive();
    });
    this.resizeObserver.observe(this.terminalWrapperEl);

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => this.handleKeyboard(e));
  }

  // -------------------------------------------------------------------------
  // Debug accessors (used by debugApi.ts)
  // -------------------------------------------------------------------------

  /** Snapshot of all tab metadata (excludes live Terminal instances). */
  getTabSnapshots(): Array<{ sessionId: string; label: string; sessionType: string; itemId: string | null; agentState: string }> {
    return this.tabs.map((t) => ({ sessionId: t.sessionId, label: t.label, sessionType: t.sessionType, itemId: t.itemId, agentState: t.agentState }));
  }

  /** Current active tab index. */
  getActiveIndex(): number { return this.activeIndex; }
  getActiveSessionId(): string | null {
    const tab = this.tabs[this.activeIndex];
    return tab?.sessionId ?? null;
  }

  selectItem(itemId: string): void {
    this.selectedItemId = itemId;
    this.focusSelectedItem();
    this.syncSelectedItemUi();
  }

  // -------------------------------------------------------------------------
  // Terminal lifecycle
  // -------------------------------------------------------------------------

  addTerminal(sessionId: string, label: string, sessionType: string, itemId?: string): void {
    const containerEl = document.createElement("div");
    containerEl.className = "wt-terminal-instance hidden";
    containerEl.dataset.sessionId = sessionId;
    this.terminalWrapperEl.appendChild(containerEl);

    const terminal = new Terminal({
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10000,
      allowProposedApi: true,
      theme: this.getTheme(),
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);

    try {
      const webLinksAddon = new WebLinksAddon();
      terminal.loadAddon(webLinksAddon);
    } catch {
      // WebLinksAddon may fail in some environments
    }

    try {
      const unicode11 = new Unicode11Addon();
      terminal.loadAddon(unicode11);
      terminal.unicode.activeVersion = "11";
    } catch {
      // Optional addon
    }

    terminal.open(containerEl);
    this.attachScrollButton(containerEl, terminal);

    const tab: TerminalTab = {
      sessionId, label, sessionType, itemId: itemId ?? null, terminal, fitAddon, searchAddon,
      containerEl, webglAddon: null, agentState: "inactive",
    };

    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        if (tab.webglAddon !== addon) return;
        tab.webglAddon = null;
        addon.dispose();
      });
      terminal.loadAddon(addon);
      tab.webglAddon = addon;
    } catch {
      // Canvas fallback is automatic
    }

    terminal.onData((data: string) => {
      this.postMessage({ type: "terminalInput", sessionId, data });
    });

    this.attachTerminalKeyHandler(terminal, sessionId);

    this.tabs.push(tab);
    this.switchToTab(this.tabs.length - 1);
    this.renderTabBar();
    this.updateEmptyState();
  }

  writeOutput(sessionId: string, data: string): void {
    const tab = this.tabs.find((t) => t.sessionId === sessionId);
    if (tab) tab.terminal.write(data);
  }

  renameTab(sessionId: string, label: string): void {
    const tab = this.tabs.find((t) => t.sessionId === sessionId);
    if (tab) {
      tab.label = label;
      this.renderTabBar();
    }
  }

  removeTerminal(sessionId: string): void {
    const index = this.tabs.findIndex((t) => t.sessionId === sessionId);
    if (index === -1) return;

    this.cancelPendingTabSwitchFrame();

    const tab = this.tabs[index];
    this.disposeTab(tab);
    this.tabs.splice(index, 1);

    if (this.tabs.length === 0) {
      this.activeIndex = -1;
    } else if (this.activeIndex >= this.tabs.length) {
      this.switchToTab(this.tabs.length - 1);
    } else if (this.activeIndex === index) {
      this.switchToTab(Math.min(index, this.tabs.length - 1));
    }

    this.renderTabBar();
    this.updateEmptyState();
  }

  updateAgentState(sessionId: string, state: string): void {
    const tab = this.tabs.find((t) => t.sessionId === sessionId);
    if (tab) {
      tab.agentState = state;
      this.renderTabBar();
    }
  }

  updateSessions(sessions: TerminalSessionInfo[]): void {
    const currentIds = new Set(this.tabs.map((t) => t.sessionId));
    const incomingIds = new Set(sessions.map((s) => s.sessionId));

    for (const tab of [...this.tabs]) {
      if (!incomingIds.has(tab.sessionId)) this.removeTerminal(tab.sessionId);
    }
    for (const session of sessions) {
      if (!currentIds.has(session.sessionId)) {
        this.addTerminal(session.sessionId, session.label, session.sessionType);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Tab management
  // -------------------------------------------------------------------------

  private switchToTab(index: number): void {
    if (this.disposed || index < 0 || index >= this.tabs.length) return;

    for (const tab of this.tabs) tab.containerEl.classList.add("hidden");

    const tab = this.tabs[index];
    tab.containerEl.classList.remove("hidden");
    this.activeIndex = index;
    this.selectedItemId = tab.itemId;
    this.syncSelectedItemUi();

    this.cancelPendingTabSwitchFrame();
    this.pendingTabSwitchFrame = requestAnimationFrame(() => {
      this.pendingTabSwitchFrame = null;
      if (!this.isLiveTab(tab)) return;

      try {
        tab.fitAddon.fit();
        const dims = tab.fitAddon.proposeDimensions();
        if (dims) {
          this.postMessage({
            type: "terminalResize", sessionId: tab.sessionId,
            cols: dims.cols, rows: dims.rows,
          });
        }
      } catch {
        // fit can fail if container is zero-sized or the terminal is being disposed
      }

      if (!this.isLiveTab(tab)) return;

      try {
        tab.terminal.focus();
      } catch {
        // focus can fail if the terminal was disposed while the frame was pending
      }
    });
  }

  private refitActive(): void {
    if (this.activeIndex < 0 || this.activeIndex >= this.tabs.length) return;
    const tab = this.tabs[this.activeIndex];
    try {
      tab.fitAddon.fit();
      const dims = tab.fitAddon.proposeDimensions();
      if (dims) {
        this.postMessage({
          type: "terminalResize", sessionId: tab.sessionId,
          cols: dims.cols, rows: dims.rows,
        });
      }
    } catch {
      // Container might be hidden or zero-sized
    }
  }

  // -------------------------------------------------------------------------
  // Tab bar rendering
  // -------------------------------------------------------------------------

  private renderTabBar(): void {
    this.tabsContainerEl.innerHTML = "";

    if (this.tabs.length === 0) {
      const placeholderEl = document.createElement("div");
      placeholderEl.className = "wt-tab wt-tab-placeholder";
      placeholderEl.textContent = "No sessions yet";
      this.tabsContainerEl.appendChild(placeholderEl);
      this.setupTabBarOverflowDetection();
      return;
    }

    for (let i = 0; i < this.tabs.length; i++) {
      const tab = this.tabs[i];
      const tabEl = document.createElement("div");
      tabEl.className = `wt-tab${i === this.activeIndex ? " wt-tab-active" : ""}`;
      tabEl.draggable = true;
      tabEl.dataset.index = String(i);

      if (tab.sessionType !== "shell" && tab.agentState !== "inactive") {
        const dot = document.createElement("span");
        dot.className = `wt-tab-state-dot wt-tab-state-dot--${tab.agentState}`;
        dot.title = tab.agentState;
        tabEl.appendChild(dot);
      }

      const labelEl = document.createElement("span");
      labelEl.className = "wt-tab-label";
      labelEl.textContent = tab.label;
      tabEl.appendChild(labelEl);

      const closeEl = document.createElement("span");
      closeEl.className = "wt-tab-close";
      closeEl.textContent = "\u00d7";
      closeEl.addEventListener("click", (e) => {
        e.stopPropagation();
        this.postMessage({ type: "closeTerminal", sessionId: tab.sessionId });
      });
      tabEl.appendChild(closeEl);

      tabEl.addEventListener("click", () => { this.switchToTab(i); this.renderTabBar(); });
      tabEl.addEventListener("dblclick", (e) => { e.preventDefault(); this.startInlineRename(i, labelEl); });

      tabEl.addEventListener("dragstart", (e) => { e.dataTransfer?.setData("text/plain", String(i)); tabEl.classList.add("wt-tab-dragging"); });
      tabEl.addEventListener("dragend", () => { tabEl.classList.remove("wt-tab-dragging"); });
      tabEl.addEventListener("dragover", (e) => { e.preventDefault(); tabEl.classList.add("wt-tab-drop-target"); });
      tabEl.addEventListener("dragleave", () => { tabEl.classList.remove("wt-tab-drop-target"); });
      tabEl.addEventListener("drop", (e) => {
        e.preventDefault();
        tabEl.classList.remove("wt-tab-drop-target");
        const fromIndex = parseInt(e.dataTransfer?.getData("text/plain") || "-1", 10);
        if (fromIndex >= 0 && fromIndex !== i) this.reorderTab(fromIndex, i);
      });

      tabEl.addEventListener("contextmenu", (e) => { e.preventDefault(); this.showTabContextMenu(i, e.clientX, e.clientY); });

      this.tabsContainerEl.appendChild(tabEl);
    }

    this.setupTabBarOverflowDetection();
  }

  // -------------------------------------------------------------------------
  // Spawn buttons (profile-driven)
  // -------------------------------------------------------------------------

  /**
   * Update the cached work items list for context menu features.
   */
  updateWorkItems(items: WorkItemDTO[]): void {
    this.workItems = items;
    this.syncSelectedItemUi();
  }

  /**
   * Update the spawn button area with profile-driven buttons.
   * Called on init and whenever button profiles change from the extension host.
   */
  updateButtonProfiles(profiles: ButtonProfileInfo[]): void {
    this.buttonProfiles = profiles;
    this.renderSpawnButtons();
  }

  private renderSpawnButtons(): void {
    this.tabButtonsEl.innerHTML = "";

    // Shell button (always shown)
    const shellBtn = document.createElement("button");
    shellBtn.className = "wt-spawn-btn";
    shellBtn.textContent = "+ Shell";
    shellBtn.addEventListener("click", () => {
      this.postMessage({
        type: "createTerminal",
        terminalType: "shell",
        itemId: this.selectedItemId ?? undefined,
      });
    });
    this.tabButtonsEl.appendChild(shellBtn);

    // Profile-driven agent buttons (profiles with button.enabled)
    for (const profile of this.buttonProfiles) {
      const btn = document.createElement("button");
      btn.className = "wt-spawn-btn wt-spawn-profile";

      if (profile.color) {
        btn.style.borderColor = profile.color;
        btn.style.color = profile.color;
      }
      if (profile.borderStyle) {
        if (profile.borderStyle === "thick") {
          btn.style.borderStyle = "solid";
          btn.style.borderWidth = "2px";
        } else {
          btn.style.borderStyle = profile.borderStyle;
        }
      }

      if (profile.icon) {
        const iconSpan = document.createElement("span");
        iconSpan.className = "wt-spawn-profile-icon";
        iconSpan.textContent = getProfileIconSymbol(profile.icon);
        iconSpan.style.marginRight = "4px";
        if (profile.color) iconSpan.style.color = profile.color;
        btn.appendChild(iconSpan);
      }

      btn.appendChild(document.createTextNode(profile.label));
      btn.title = `Launch ${profile.label}`;
      btn.addEventListener("click", () => {
        this.postMessage({
          type: "launchProfile",
          profileId: profile.profileId,
          itemId: this.selectedItemId ?? undefined,
        });
      });
      this.tabButtonsEl.appendChild(btn);
    }

    // Launch modal button ("..." opens the full profile launcher)
    const launchBtn = document.createElement("button");
    launchBtn.className = "wt-spawn-btn wt-spawn-custom";
    launchBtn.textContent = "...";
    launchBtn.title = "More profile actions";
    launchBtn.setAttribute("aria-label", "More profile actions");
    launchBtn.setAttribute("aria-haspopup", "menu");
    launchBtn.setAttribute("aria-expanded", "false");
    launchBtn.addEventListener("click", () => {
      this.showOverflowMenu(launchBtn);
    });
    this.tabButtonsEl.appendChild(launchBtn);

    this.setupTabBarOverflowDetection();
  }

  private setupTabBarOverflowDetection(): void {
    if (!this.tabBarResizeObserver) {
      this.tabBarResizeObserver = new ResizeObserver(() => {
        this.scheduleTabBarOverflowCheck();
      });
      this.tabBarResizeObserver.observe(this.tabsContainerEl);
      this.tabBarResizeObserver.observe(this.tabButtonsEl);
    }

    this.scheduleTabBarOverflowCheck();
  }

  private scheduleTabBarOverflowCheck(): void {
    if (this.tabBarOverflowFrame !== null) {
      return;
    }

    this.tabBarOverflowFrame = requestAnimationFrame(() => {
      this.tabBarOverflowFrame = null;
      this.checkTabBarOverflow();
    });
  }

  private checkTabBarOverflow(): void {
    const tabEls = this.tabsContainerEl.querySelectorAll(".wt-tab");
    if (tabEls.length === 0) {
      this.tabBarEl.classList.remove("wt-tab-bar-expanded");
      return;
    }

    const wasExpanded = this.tabBarEl.classList.contains("wt-tab-bar-expanded");
    if (wasExpanded) {
      this.tabBarEl.classList.remove("wt-tab-bar-expanded");
    }

    const tabsScrollableWidth = this.tabsContainerEl.scrollWidth;
    const tabsVisibleWidth = this.tabsContainerEl.clientWidth;
    const shouldExpand = tabsScrollableWidth > tabsVisibleWidth - TAB_OVERFLOW_BUFFER_PX;

    if (shouldExpand === wasExpanded) {
      if (wasExpanded) {
        this.tabBarEl.classList.add("wt-tab-bar-expanded");
      }
      return;
    }

    this.tabBarEl.classList.toggle("wt-tab-bar-expanded", shouldExpand);
  }

  private updateEmptyState(): void {
    if (this.activeIndex >= 0 && this.activeIndex < this.tabs.length) {
      this.emptyStateEl.style.display = "none";
    } else {
      this.emptyStateEl.style.display = "flex";
    }
  }

  private focusSelectedItem(): void {
    if (!this.selectedItemId) {
      this.clearActiveTerminal();
      return;
    }

    const tabIndex = this.tabs.findIndex((tab) => tab.itemId === this.selectedItemId);
    if (tabIndex >= 0) {
      this.switchToTab(tabIndex);
      this.renderTabBar();
      return;
    }

    this.clearActiveTerminal();
  }

  private clearActiveTerminal(): void {
    for (const tab of this.tabs) {
      tab.containerEl.classList.add("hidden");
    }
    this.activeIndex = -1;
    this.renderTabBar();
    this.updateEmptyState();
  }

  private syncSelectedItemUi(): void {
    const selectedItem = this.selectedItemId
      ? this.workItems.find((item) => item.id === this.selectedItemId) ?? null
      : null;

    if (!selectedItem) {
      this.taskTitleEl.style.display = "none";
      this.taskTitleTextEl.textContent = "";
      this.emptyStateEl.textContent = "Select an item from the sidebar to begin";
    } else {
      this.taskTitleEl.style.display = "block";
      this.taskTitleTextEl.textContent = selectedItem.title;
      this.emptyStateEl.textContent = `No terminals for "${selectedItem.title}"`;
    }

    this.renderSpawnButtons();
    this.updateEmptyState();
  }

  // -------------------------------------------------------------------------
  // Inline rename
  // -------------------------------------------------------------------------

  private startInlineRename(index: number, labelEl: HTMLElement): void {
    const tab = this.tabs[index];
    const input = document.createElement("input");
    input.type = "text";
    input.value = tab.label;
    input.style.cssText =
      "font-size: inherit; font-weight: inherit; font-family: inherit; " +
      "background: var(--vscode-input-background); color: var(--vscode-input-foreground); " +
      "border: 1px solid var(--vscode-focusBorder); border-radius: 2px; " +
      "padding: 0 4px; width: 100%; box-sizing: border-box; outline: none;";

    const commit = () => {
      const newLabel = input.value.trim();
      if (newLabel && newLabel !== tab.label) {
        tab.label = newLabel;
        this.postMessage({ type: "renameTerminal", sessionId: tab.sessionId, label: newLabel });
      }
      this.renderTabBar();
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); input.blur(); }
      else if (e.key === "Escape") { e.preventDefault(); input.removeEventListener("blur", commit); this.renderTabBar(); }
    });

    labelEl.textContent = "";
    labelEl.appendChild(input);
    input.focus();
    input.select();
  }

  // -------------------------------------------------------------------------
  // Tab reordering
  // -------------------------------------------------------------------------

  private reorderTab(fromIndex: number, toIndex: number): void {
    const [tab] = this.tabs.splice(fromIndex, 1);
    this.tabs.splice(toIndex, 0, tab);

    if (this.activeIndex === fromIndex) {
      this.activeIndex = toIndex;
    } else if (fromIndex < this.activeIndex && toIndex >= this.activeIndex) {
      this.activeIndex--;
    } else if (fromIndex > this.activeIndex && toIndex <= this.activeIndex) {
      this.activeIndex++;
    }

    this.renderTabBar();
  }

  // -------------------------------------------------------------------------
  // Context menu
  // -------------------------------------------------------------------------

  private showOverflowMenu(anchorEl: HTMLElement): void {
    const wasExpanded = anchorEl.getAttribute("aria-expanded") === "true";
    this.dismissOverflowMenu?.();
    if (wasExpanded) {
      return;
    }

    const menu = document.createElement("div");
    menu.className = "wt-context-menu";
    menu.setAttribute("role", "menu");
    menu.tabIndex = -1;
    menu.style.minWidth = "180px";
    anchorEl.setAttribute("aria-expanded", "true");
    let menuDismissed = false;
    let documentListenersAttached = false;

    const detachDocumentListeners = () => {
      if (!documentListenersAttached) {
        return;
      }

      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", onKeyDown);
      documentListenersAttached = false;
    };

    const dismissMenu = () => {
      if (menuDismissed) {
        return;
      }

      menuDismissed = true;
      if (this.overflowMenuFrame !== null) {
        cancelAnimationFrame(this.overflowMenuFrame);
        this.overflowMenuFrame = null;
      }
      detachDocumentListeners();
      anchorEl.setAttribute("aria-expanded", "false");
      this.dismissOverflowMenu = null;
      if (menu.isConnected) {
        menu.remove();
      }
      if (!this.disposed && anchorEl.isConnected) {
        anchorEl.focus();
      }
    };
    this.dismissOverflowMenu = dismissMenu;

    const menuItems: HTMLButtonElement[] = [];

    const focusItem = (index: number) => {
      if (menuItems.length === 0) {
        return;
      }

      const targetIndex = (index + menuItems.length) % menuItems.length;
      menuItems[targetIndex].focus();
    };

    const addItem = (label: string, action: () => void) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "wt-context-menu-item wt-context-menu-item-button";
      el.setAttribute("role", "menuitem");
      el.textContent = label;
      el.addEventListener("mouseenter", () => {
        el.focus();
      });
      el.addEventListener("click", () => {
        dismissMenu();
        action();
      });
      menu.appendChild(el);
      menuItems.push(el);
    };

    addItem("Launch Profile", () => {
      this.postMessage({
        type: "requestLaunchModal",
        itemId: this.selectedItemId ?? undefined,
      });
    });

    addItem("Agent Profiles", () => {
      this.postMessage({ type: "getProfiles" });
    });

    document.body.appendChild(menu);

    const anchorRect = anchorEl.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let left = anchorRect.right - menuRect.width;
    let top = anchorRect.bottom + 4;

    if (left < 0) {
      left = 0;
    }
    if (left + menuRect.width > window.innerWidth) {
      left = Math.max(0, window.innerWidth - menuRect.width);
    }
    if (top + menuRect.height > window.innerHeight) {
      top = Math.max(0, anchorRect.top - menuRect.height - 4);
    }

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const dismiss = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node) && e.target !== anchorEl) {
        dismissMenu();
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const currentIndex = menuItems.findIndex((item) => item === document.activeElement);

      switch (e.key) {
        case "Escape":
          e.preventDefault();
          dismissMenu();
          break;
        case "ArrowDown":
          e.preventDefault();
          focusItem(currentIndex + 1);
          break;
        case "ArrowUp":
          e.preventDefault();
          focusItem(currentIndex - 1);
          break;
        case "Home":
          e.preventDefault();
          focusItem(0);
          break;
        case "End":
          e.preventDefault();
          focusItem(menuItems.length - 1);
          break;
      }
    };

    this.overflowMenuFrame = requestAnimationFrame(() => {
      this.overflowMenuFrame = null;
      if (menuDismissed || this.dismissOverflowMenu !== dismissMenu || this.disposed || !menu.isConnected) {
        return;
      }
      document.addEventListener("mousedown", dismiss);
      document.addEventListener("keydown", onKeyDown);
      documentListenersAttached = true;
      focusItem(0);
    });
  }

  private showTabContextMenu(index: number, x: number, y: number): void {
    this.dismissOverflowMenu?.();
    const existing = document.querySelector(".wt-context-menu");
    if (existing) existing.remove();

    const tab = this.tabs[index];
    const menu = document.createElement("div");
    menu.className = "wt-context-menu";
    menu.style.cssText =
      `position: fixed; left: ${x}px; top: ${y}px; z-index: 1000; ` +
      "background: var(--vscode-menu-background); color: var(--vscode-menu-foreground); " +
      "border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); " +
      "border-radius: 4px; padding: 4px 0; min-width: 160px; " +
      "box-shadow: 0 2px 8px rgba(0,0,0,0.3);";

    const menuItemStyle =
      "padding: 4px 16px; cursor: pointer; font-size: 12px; white-space: nowrap;";
    const disabledStyle =
      "padding: 4px 16px; font-size: 12px; white-space: nowrap; opacity: 0.5; cursor: default;";
    const separatorStyle =
      "height: 1px; margin: 4px 8px; background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border));";

    const addItem = (label: string, action: (() => void) | null) => {
      const el = document.createElement("div");
      el.textContent = label;
      el.style.cssText = action ? menuItemStyle : disabledStyle;
      if (action) {
        el.addEventListener("mouseenter", () => { el.style.background = "var(--vscode-menu-selectionBackground)"; el.style.color = "var(--vscode-menu-selectionForeground)"; });
        el.addEventListener("mouseleave", () => { el.style.background = ""; el.style.color = ""; });
        el.addEventListener("click", () => { menu.remove(); action(); });
      }
      menu.appendChild(el);
    };

    const addSeparator = () => {
      const sep = document.createElement("div");
      sep.style.cssText = separatorStyle;
      menu.appendChild(sep);
    };

    // Rename
    addItem("Rename", () => {
      const labelEl = this.tabsContainerEl.children[index]?.querySelector(".wt-tab-label");
      if (labelEl) this.startInlineRename(index, labelEl as HTMLElement);
    });

    // Move to Item submenu
    const otherItems = this.workItems.filter((item) => item.id !== tab.itemId);
    if (otherItems.length > 0) {
      const moveEl = document.createElement("div");
      moveEl.textContent = "Move to Item";
      moveEl.style.cssText = menuItemStyle + " position: relative;";
      // Add submenu arrow
      const arrow = document.createElement("span");
      arrow.textContent = "\u25B6";
      arrow.style.cssText = "float: right; margin-left: 12px; font-size: 10px;";
      moveEl.appendChild(arrow);

      let submenu: HTMLElement | null = null;
      const showSubmenu = () => {
        if (submenu) return;
        submenu = document.createElement("div");
        submenu.className = "wt-context-menu wt-context-submenu";
        submenu.style.cssText =
          "position: fixed; z-index: 1001; " +
          "background: var(--vscode-menu-background); color: var(--vscode-menu-foreground); " +
          "border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); " +
          "border-radius: 4px; padding: 4px 0; min-width: 160px; max-height: 300px; overflow-y: auto; " +
          "box-shadow: 0 2px 8px rgba(0,0,0,0.3);";

        for (const item of otherItems) {
          const subEl = document.createElement("div");
          subEl.textContent = item.title;
          subEl.style.cssText = menuItemStyle;
          subEl.addEventListener("mouseenter", () => { subEl.style.background = "var(--vscode-menu-selectionBackground)"; subEl.style.color = "var(--vscode-menu-selectionForeground)"; });
          subEl.addEventListener("mouseleave", () => { subEl.style.background = ""; subEl.style.color = ""; });
          subEl.addEventListener("click", () => {
            menu.remove();
            submenu?.remove();
            tab.itemId = item.id;
            this.postMessage({ type: "moveTerminalToItem", sessionId: tab.sessionId, toItemId: item.id });
          });
          submenu.appendChild(subEl);
        }

        document.body.appendChild(submenu);

        // Position submenu to the right of the parent item
        const rect = moveEl.getBoundingClientRect();
        const subRect = submenu.getBoundingClientRect();
        let subLeft = rect.right;
        let subTop = rect.top;
        // Flip left if it would overflow the viewport
        if (subLeft + subRect.width > window.innerWidth) {
          subLeft = rect.left - subRect.width;
        }
        // Adjust top if it would overflow the viewport
        if (subTop + subRect.height > window.innerHeight) {
          subTop = Math.max(0, window.innerHeight - subRect.height);
        }
        submenu.style.left = `${subLeft}px`;
        submenu.style.top = `${subTop}px`;
      };

      const hideSubmenu = () => {
        if (submenu) { submenu.remove(); submenu = null; }
      };

      moveEl.addEventListener("mouseenter", () => {
        moveEl.style.background = "var(--vscode-menu-selectionBackground)";
        moveEl.style.color = "var(--vscode-menu-selectionForeground)";
        showSubmenu();
      });
      moveEl.addEventListener("mouseleave", (e) => {
        const related = e.relatedTarget as Node | null;
        if (submenu && related && submenu.contains(related)) return;
        moveEl.style.background = "";
        moveEl.style.color = "";
        hideSubmenu();
      });

      menu.appendChild(moveEl);
    } else {
      addItem("Move to Item", null);
    }

    // Copy Tab Info
    addItem("Copy Tab Info", () => {
      const itemTitle = tab.itemId
        ? this.workItems.find((i) => i.id === tab.itemId)?.title ?? "Unknown"
        : "None";
      const lines = [
        `Label: ${tab.label}`,
        `Type: ${tab.sessionType}`,
        `Session ID: ${tab.sessionId}`,
        `Item: ${itemTitle}`,
      ];
      this.postMessage({ type: "copyToClipboard", text: lines.join("\n") });
    });

    addSeparator();

    // Close
    addItem("Close", () => {
      this.postMessage({ type: "closeTerminal", sessionId: tab.sessionId });
    });

    // Close Others
    addItem("Close Others", () => {
      for (const t of this.tabs) {
        if (t.sessionId !== tab.sessionId) {
          this.postMessage({ type: "closeTerminal", sessionId: t.sessionId });
        }
      }
    });

    // Close All for Item
    if (tab.itemId) {
      const itemTitle = this.workItems.find((i) => i.id === tab.itemId)?.title;
      const closeAllLabel = itemTitle ? `Close All for "${itemTitle}"` : "Close All for Item";
      addItem(closeAllLabel, () => {
        this.postMessage({ type: "closeAllTerminalsForItem", itemId: tab.itemId! });
      });
    }

    document.body.appendChild(menu);

    // Adjust menu position if it would overflow the viewport
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth) {
      menu.style.left = `${Math.max(0, window.innerWidth - menuRect.width)}px`;
    }
    if (menuRect.bottom > window.innerHeight) {
      menu.style.top = `${Math.max(0, window.innerHeight - menuRect.height)}px`;
    }

    const dismiss = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        // Also remove any open submenu
        const sub = document.querySelector(".wt-context-submenu");
        if (sub) sub.remove();
        document.removeEventListener("mousedown", dismiss);
      }
    };
    requestAnimationFrame(() => { document.addEventListener("mousedown", dismiss); });
  }

  // -------------------------------------------------------------------------
  // Keyboard handling
  // -------------------------------------------------------------------------

  private attachTerminalKeyHandler(terminal: Terminal, sessionId: string): void {
    const sendInput = (data: string) => {
      this.postMessage({ type: "terminalInput", sessionId, data });
    };

    terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== "keydown") return true;

      // AltGraph combos (e.g. right-Alt on Windows/Linux) produce printable
      // characters on many keyboard layouts - pass them through as text input.
      if (event.getModifierState("AltGraph") && event.key.length === 1) {
        sendInput(event.key);
        return false;
      }

      if (event.altKey && !event.metaKey && !event.ctrlKey) {
        switch (event.key) {
          case "ArrowLeft":   sendInput("\x1bb");     return false;
          case "ArrowRight":  sendInput("\x1bf");     return false;
          case "Backspace":   sendInput("\x1b\x7f");  return false;
          case "b":           sendInput("\x1bb");     return false;
          case "f":           sendInput("\x1bf");     return false;
          case "d":           sendInput("\x1bd");     return false;
        }
        // Alt/Option + key producing a printable character (e.g. Alt+3 = #
        // on UK keyboard) - send as text rather than an escape sequence.
        if (event.key.length === 1) {
          sendInput(event.key);
          return false;
        }
      }

      if (event.metaKey && !event.altKey && !event.ctrlKey) {
        switch (event.key) {
          case "ArrowLeft":   sendInput("\x01");  return false;
          case "ArrowRight":  sendInput("\x05");  return false;
        }
      }

      if (event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && event.key === "Enter") {
        sendInput("\n");
        return false;
      }

      return true;
    });
  }

  private handleKeyboard(e: KeyboardEvent): void {
    const isMod = e.metaKey || e.ctrlKey;

    if (isMod && !e.altKey && !e.shiftKey && e.key === "f") {
      if (this.activeIndex >= 0 && this.activeIndex < this.tabs.length) {
        const activeEl = document.activeElement;
        const tab = this.tabs[this.activeIndex];
        if (tab.containerEl.contains(activeEl) || activeEl === document.body) {
          e.preventDefault();
          e.stopPropagation();
          this.toggleSearch();
        }
      }
    }
  }

  private toggleSearch(): void {
    if (this.activeIndex < 0) return;
    const tab = this.tabs[this.activeIndex];

    if (this.searchBarVisible) {
      const bar = this.terminalWrapperEl.querySelector(".wt-search-bar");
      if (bar) bar.remove();
      this.searchBarVisible = false;
      tab.terminal.focus();
      return;
    }

    const bar = document.createElement("div");
    bar.className = "wt-search-bar";
    bar.style.cssText =
      "position: absolute; top: 0; right: 0; z-index: 10; " +
      "display: flex; gap: 4px; padding: 4px 8px; " +
      "background: var(--vscode-editorWidget-background); " +
      "border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); " +
      "border-radius: 0 0 0 4px;";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Find...";
    input.style.cssText =
      "font-size: 12px; padding: 2px 6px; " +
      "background: var(--vscode-input-background); color: var(--vscode-input-foreground); " +
      "border: 1px solid var(--vscode-input-border); border-radius: 2px; outline: none; width: 180px;";

    input.addEventListener("input", () => { tab.searchAddon.findNext(input.value); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) tab.searchAddon.findPrevious(input.value); else tab.searchAddon.findNext(input.value); }
      else if (e.key === "Escape") { e.preventDefault(); this.toggleSearch(); }
    });

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "\u00d7";
    closeBtn.style.cssText =
      "font-size: 14px; border: none; background: none; cursor: pointer; " +
      "color: var(--vscode-descriptionForeground); padding: 0 4px;";
    closeBtn.addEventListener("click", () => this.toggleSearch());

    bar.appendChild(input);
    bar.appendChild(closeBtn);
    this.terminalWrapperEl.appendChild(bar);
    this.searchBarVisible = true;
    input.focus();
  }

  // -------------------------------------------------------------------------
  // Theme
  // -------------------------------------------------------------------------

  private getTheme(): Record<string, string> {
    return {
      background: this.getCssVar("--vscode-terminal-background", this.getCssVar("--vscode-editor-background", "#1e1e1e")),
      foreground: this.getCssVar("--vscode-terminal-foreground", this.getCssVar("--vscode-editor-foreground", "#d4d4d4")),
      cursor: this.getCssVar("--vscode-terminalCursor-foreground", "#aeafad"),
      cursorAccent: this.getCssVar("--vscode-terminal-background", "#000000"),
      selectionBackground: this.getCssVar("--vscode-terminal-selectionBackground", "rgba(255,255,255,0.3)"),
    };
  }

  private getCssVar(name: string, fallback: string): string {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  refreshTheme(): void {
    const theme = this.getTheme();
    for (const tab of this.tabs) tab.terminal.options.theme = theme;
  }

  // -------------------------------------------------------------------------
  // Scroll-to-bottom button
  // -------------------------------------------------------------------------

  private attachScrollButton(containerEl: HTMLElement, terminal: Terminal): void {
    const btn = document.createElement("button");
    btn.className = "wt-scroll-btn";
    btn.setAttribute("aria-label", "Scroll to bottom");
    btn.textContent = "\u2193";
    containerEl.appendChild(btn);

    let raf: number | null = null;
    let lastVisible = false;

    const updateVisibility = () => {
      raf = null;
      const buf = terminal.buffer.active;
      const shouldShow = buf.viewportY < buf.baseY;
      if (shouldShow === lastVisible) return;
      lastVisible = shouldShow;
      btn.style.display = shouldShow ? "flex" : "none";
    };

    const scheduleUpdate = () => {
      if (raf !== null) return;
      raf = requestAnimationFrame(updateVisibility);
    };

    terminal.onScroll(scheduleUpdate);

    const viewport = containerEl.querySelector(".xterm-viewport");
    if (viewport) viewport.addEventListener("scroll", scheduleUpdate, { passive: true });

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      terminal.scrollToBottom();
      terminal.focus();
      scheduleUpdate();
    });
  }

  // -------------------------------------------------------------------------
  // Hook warning banner
  // -------------------------------------------------------------------------

  updateHookBanner(visible: boolean, message: string): void {
    if (!visible) {
      if (this.hookBannerEl) {
        this.hookBannerEl.remove();
        this.hookBannerEl = null;
      }
      return;
    }

    if (!this.hookBannerEl) {
      this.hookBannerEl = document.createElement("div");
      this.hookBannerEl.className = "wt-hook-banner";
      // Insert before the terminal wrapper
      this.terminalWrapperEl.parentElement!.insertBefore(
        this.hookBannerEl,
        this.terminalWrapperEl,
      );
    }

    this.hookBannerEl.innerHTML = "";

    const icon = document.createElement("span");
    icon.className = "codicon codicon-warning wt-hook-banner-icon";
    this.hookBannerEl.appendChild(icon);

    const text = document.createElement("span");
    text.className = "wt-hook-banner-text";
    text.textContent = message;
    this.hookBannerEl.appendChild(text);

    const installBtn = document.createElement("button");
    installBtn.className = "wt-hook-banner-btn";
    installBtn.textContent = "Install Hooks";
    installBtn.addEventListener("click", () => {
      this.postMessage({ type: "installHooks" });
    });
    this.hookBannerEl.appendChild(installBtn);

    const dismissBtn = document.createElement("button");
    dismissBtn.className = "wt-hook-banner-dismiss";
    dismissBtn.textContent = "\u00d7";
    dismissBtn.title = "Dismiss";
    dismissBtn.addEventListener("click", () => {
      this.postMessage({ type: "dismissHookBanner" });
    });
    this.hookBannerEl.appendChild(dismissBtn);
  }

  // -------------------------------------------------------------------------
  // Hook status indicator
  // -------------------------------------------------------------------------

  updateHookStatus(installed: boolean): void {
    if (!installed) {
      if (this.hookStatusEl) {
        this.hookStatusEl.remove();
        this.hookStatusEl = null;
      }
      return;
    }

    if (!this.hookStatusEl) {
      this.hookStatusEl = document.createElement("div");
      this.hookStatusEl.className = "wt-hook-status-bar";
      this.terminalWrapperEl.parentElement!.insertBefore(
        this.hookStatusEl,
        this.terminalWrapperEl,
      );
    }

    this.hookStatusEl.innerHTML = "";

    const icon = document.createElement("span");
    icon.className = "codicon codicon-check wt-hook-status-icon";
    this.hookStatusEl.appendChild(icon);

    const text = document.createElement("span");
    text.className = "wt-hook-status-text";
    text.textContent = "Claude resume hooks configured";
    this.hookStatusEl.appendChild(text);

    const removeBtn = document.createElement("button");
    removeBtn.className = "wt-hook-status-remove-btn";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => {
      this.postMessage({ type: "removeHooks" });
    });
    this.hookStatusEl.appendChild(removeBtn);
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  private cancelPendingTabSwitchFrame(): void {
    if (this.pendingTabSwitchFrame === null) return;
    cancelAnimationFrame(this.pendingTabSwitchFrame);
    this.pendingTabSwitchFrame = null;
  }

  private isLiveTab(tab: TerminalTab): boolean {
    return !this.disposed && this.tabs.includes(tab);
  }

  private disposeTab(tab: TerminalTab): void {
    if (tab.webglAddon) {
      const addon = tab.webglAddon;
      tab.webglAddon = null;
      addon.dispose();
    }
    tab.terminal.dispose();
    tab.containerEl.remove();
  }

  dispose(): void {
    this.disposed = true;
    this.dismissOverflowMenu?.();
    this.cancelPendingTabSwitchFrame();
    this.resizeObserver.disconnect();
    this.tabBarResizeObserver?.disconnect();
    if (this.tabBarOverflowFrame !== null) {
      cancelAnimationFrame(this.tabBarOverflowFrame);
      this.tabBarOverflowFrame = null;
    }
    this.hookBannerEl?.remove();
    this.hookStatusEl?.remove();
    for (const tab of this.tabs) {
      this.disposeTab(tab);
    }
    this.tabs = [];
    this.activeIndex = -1;
  }
}
