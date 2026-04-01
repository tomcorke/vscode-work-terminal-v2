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
import type { WebviewMessage, TerminalSessionInfo } from "./messages";

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

// ---------------------------------------------------------------------------
// TerminalPanel
// ---------------------------------------------------------------------------

export class TerminalPanel {
  private tabs: TerminalTab[] = [];
  private activeIndex = -1;
  private postMessage: (msg: WebviewMessage) => void;
  private tabsContainerEl: HTMLElement;
  private tabButtonsEl: HTMLElement;
  private terminalWrapperEl: HTMLElement;
  private emptyStateEl: HTMLElement;
  private resizeObserver: ResizeObserver;
  private searchBarVisible = false;

  constructor(postMessage: (msg: WebviewMessage) => void) {
    this.postMessage = postMessage;

    this.tabsContainerEl = document.getElementById("tabs-container")!;
    this.tabButtonsEl = document.getElementById("tab-buttons")!;
    this.terminalWrapperEl = document.getElementById("terminal-wrapper")!;
    this.emptyStateEl = document.getElementById("empty-state")!;

    injectXtermCss();
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
  // Terminal lifecycle
  // -------------------------------------------------------------------------

  /**
   * Called when the extension creates a new terminal.
   */
  addTerminal(sessionId: string, label: string, sessionType: string): void {
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

    // Web links addon - open URLs in default browser
    try {
      const webLinksAddon = new WebLinksAddon();
      terminal.loadAddon(webLinksAddon);
    } catch {
      // WebLinksAddon may fail in some environments
    }

    // Unicode11 addon for better character rendering
    try {
      const unicode11 = new Unicode11Addon();
      terminal.loadAddon(unicode11);
      terminal.unicode.activeVersion = "11";
    } catch {
      // Optional addon
    }

    terminal.open(containerEl);

    // Scroll-to-bottom button
    this.attachScrollButton(containerEl, terminal);

    // Try WebGL renderer, fall back to canvas
    let webglAddon: WebglAddon | null = null;
    try {
      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon?.dispose();
        webglAddon = null;
      });
      terminal.loadAddon(webglAddon);
    } catch {
      // Canvas fallback is automatic
    }

    // Route keyboard input to extension host
    terminal.onData((data: string) => {
      this.postMessage({
        type: "terminalInput",
        sessionId,
        data,
      });
    });

    const tab: TerminalTab = {
      sessionId,
      label,
      sessionType,
      terminal,
      fitAddon,
      searchAddon,
      containerEl,
      webglAddon,
      agentState: "inactive",
    };

    this.tabs.push(tab);
    this.switchToTab(this.tabs.length - 1);
    this.renderTabBar();
    this.updateEmptyState();
  }

  /**
   * Write output data to a terminal.
   */
  writeOutput(sessionId: string, data: string): void {
    const tab = this.tabs.find((t) => t.sessionId === sessionId);
    if (tab) {
      tab.terminal.write(data);
    }
  }

  /**
   * Remove a terminal.
   */
  removeTerminal(sessionId: string): void {
    const index = this.tabs.findIndex((t) => t.sessionId === sessionId);
    if (index === -1) return;

    const tab = this.tabs[index];
    tab.webglAddon?.dispose();
    tab.terminal.dispose();
    tab.containerEl.remove();

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

  /**
   * Update agent state indicator on a tab.
   */
  updateAgentState(sessionId: string, state: string): void {
    const tab = this.tabs.find((t) => t.sessionId === sessionId);
    if (tab) {
      tab.agentState = state;
      this.renderTabBar();
    }
  }

  /**
   * Update sessions from extension (batch update).
   */
  updateSessions(sessions: TerminalSessionInfo[]): void {
    // Add new sessions, remove stale ones
    const currentIds = new Set(this.tabs.map((t) => t.sessionId));
    const incomingIds = new Set(sessions.map((s) => s.sessionId));

    // Remove terminals not in incoming list
    for (const tab of [...this.tabs]) {
      if (!incomingIds.has(tab.sessionId)) {
        this.removeTerminal(tab.sessionId);
      }
    }

    // Add new terminals
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
    if (index < 0 || index >= this.tabs.length) return;

    // Hide all
    for (const tab of this.tabs) {
      tab.containerEl.classList.add("hidden");
    }

    // Show target
    const tab = this.tabs[index];
    tab.containerEl.classList.remove("hidden");
    this.activeIndex = index;

    // Fit after making visible
    requestAnimationFrame(() => {
      try {
        tab.fitAddon.fit();
        const dims = tab.fitAddon.proposeDimensions();
        if (dims) {
          this.postMessage({
            type: "terminalResize",
            sessionId: tab.sessionId,
            cols: dims.cols,
            rows: dims.rows,
          });
        }
      } catch {
        // fit can fail if container is zero-sized
      }
      tab.terminal.focus();
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
          type: "terminalResize",
          sessionId: tab.sessionId,
          cols: dims.cols,
          rows: dims.rows,
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

    for (let i = 0; i < this.tabs.length; i++) {
      const tab = this.tabs[i];
      const tabEl = document.createElement("div");
      tabEl.className = `wt-tab${i === this.activeIndex ? " wt-tab-active" : ""}`;
      tabEl.draggable = true;
      tabEl.dataset.index = String(i);

      // Agent state dot
      if (tab.sessionType !== "shell" && tab.agentState !== "inactive") {
        const dot = document.createElement("span");
        dot.style.width = "6px";
        dot.style.height = "6px";
        dot.style.borderRadius = "50%";
        dot.style.backgroundColor = STATE_COLORS[tab.agentState] || "transparent";
        dot.style.flexShrink = "0";
        dot.title = tab.agentState;
        tabEl.appendChild(dot);
      }

      // Label
      const labelEl = document.createElement("span");
      labelEl.className = "wt-tab-label";
      labelEl.textContent = tab.label;
      tabEl.appendChild(labelEl);

      // Close button
      const closeEl = document.createElement("span");
      closeEl.className = "wt-tab-close";
      closeEl.textContent = "\u00d7";
      closeEl.addEventListener("click", (e) => {
        e.stopPropagation();
        this.postMessage({ type: "closeTerminal", sessionId: tab.sessionId });
      });
      tabEl.appendChild(closeEl);

      // Click to switch
      tabEl.addEventListener("click", () => {
        this.switchToTab(i);
        this.renderTabBar();
      });

      // Double-click to rename
      tabEl.addEventListener("dblclick", (e) => {
        e.preventDefault();
        this.startInlineRename(i, labelEl);
      });

      // Drag and drop for tab reordering
      tabEl.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData("text/plain", String(i));
        tabEl.classList.add("wt-tab-dragging");
      });
      tabEl.addEventListener("dragend", () => {
        tabEl.classList.remove("wt-tab-dragging");
      });
      tabEl.addEventListener("dragover", (e) => {
        e.preventDefault();
        tabEl.classList.add("wt-tab-drop-target");
      });
      tabEl.addEventListener("dragleave", () => {
        tabEl.classList.remove("wt-tab-drop-target");
      });
      tabEl.addEventListener("drop", (e) => {
        e.preventDefault();
        tabEl.classList.remove("wt-tab-drop-target");
        const fromIndex = parseInt(e.dataTransfer?.getData("text/plain") || "-1", 10);
        if (fromIndex >= 0 && fromIndex !== i) {
          this.reorderTab(fromIndex, i);
        }
      });

      // Context menu
      tabEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.showTabContextMenu(i, e.clientX, e.clientY);
      });

      this.tabsContainerEl.appendChild(tabEl);
    }
  }

  private renderSpawnButtons(): void {
    this.tabButtonsEl.innerHTML = "";

    const buttons = [
      { label: "Shell", type: "shell" as const },
      { label: "Claude", type: "claude" as const },
      { label: "Copilot", type: "copilot" as const },
    ];

    for (const btn of buttons) {
      const el = document.createElement("button");
      el.className = "wt-spawn-btn";
      el.textContent = `+ ${btn.label}`;
      el.addEventListener("click", () => {
        this.postMessage({
          type: "createTerminal",
          terminalType: btn.type,
        });
      });
      this.tabButtonsEl.appendChild(el);
    }
  }

  private updateEmptyState(): void {
    if (this.tabs.length > 0) {
      this.emptyStateEl.style.display = "none";
    } else {
      this.emptyStateEl.style.display = "flex";
    }
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
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        input.removeEventListener("blur", commit);
        this.renderTabBar();
      }
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

    // Update active index to follow the active tab
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

  private showTabContextMenu(index: number, x: number, y: number): void {
    const existing = document.querySelector(".wt-context-menu");
    if (existing) existing.remove();

    const tab = this.tabs[index];
    const menu = document.createElement("div");
    menu.className = "wt-context-menu";
    menu.style.cssText =
      `position: fixed; left: ${x}px; top: ${y}px; z-index: 1000; ` +
      "background: var(--vscode-menu-background); color: var(--vscode-menu-foreground); " +
      "border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); " +
      "border-radius: 4px; padding: 4px 0; min-width: 140px; " +
      "box-shadow: 0 2px 8px rgba(0,0,0,0.3);";

    const items = [
      {
        label: "Rename",
        action: () => {
          const labelEl = this.tabsContainerEl.children[index]?.querySelector(".wt-tab-label");
          if (labelEl) this.startInlineRename(index, labelEl as HTMLElement);
        },
      },
      {
        label: "Close",
        action: () => this.postMessage({ type: "closeTerminal", sessionId: tab.sessionId }),
      },
      {
        label: "Close Others",
        action: () => {
          for (const t of this.tabs) {
            if (t.sessionId !== tab.sessionId) {
              this.postMessage({ type: "closeTerminal", sessionId: t.sessionId });
            }
          }
        },
      },
    ];

    for (const item of items) {
      const itemEl = document.createElement("div");
      itemEl.textContent = item.label;
      itemEl.style.cssText =
        "padding: 4px 16px; cursor: pointer; font-size: 12px; white-space: nowrap;";
      itemEl.addEventListener("mouseenter", () => {
        itemEl.style.background = "var(--vscode-menu-selectionBackground)";
        itemEl.style.color = "var(--vscode-menu-selectionForeground)";
      });
      itemEl.addEventListener("mouseleave", () => {
        itemEl.style.background = "";
        itemEl.style.color = "";
      });
      itemEl.addEventListener("click", () => {
        menu.remove();
        item.action();
      });
      menu.appendChild(itemEl);
    }

    document.body.appendChild(menu);

    const dismiss = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        document.removeEventListener("mousedown", dismiss);
      }
    };
    // Delay to avoid catching the contextmenu click
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", dismiss);
    });
  }

  // -------------------------------------------------------------------------
  // Keyboard handling
  // -------------------------------------------------------------------------

  private handleKeyboard(e: KeyboardEvent): void {
    const isMod = e.metaKey || e.ctrlKey;

    // Cmd/Ctrl+F: toggle search in active terminal
    if (isMod && !e.altKey && !e.shiftKey && e.key === "f") {
      if (this.activeIndex >= 0 && this.activeIndex < this.tabs.length) {
        const activeEl = document.activeElement;
        const tab = this.tabs[this.activeIndex];
        const termContainer = tab.containerEl;
        if (termContainer.contains(activeEl) || activeEl === document.body) {
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
      // Remove search bar
      const bar = this.terminalWrapperEl.querySelector(".wt-search-bar");
      if (bar) bar.remove();
      this.searchBarVisible = false;
      tab.terminal.focus();
      return;
    }

    // Create search bar
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

    input.addEventListener("input", () => {
      tab.searchAddon.findNext(input.value);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) {
          tab.searchAddon.findPrevious(input.value);
        } else {
          tab.searchAddon.findNext(input.value);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.toggleSearch();
      }
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

  /**
   * Re-apply theme to all terminals (call on themeChanged).
   */
  refreshTheme(): void {
    const theme = this.getTheme();
    for (const tab of this.tabs) {
      tab.terminal.options.theme = theme;
    }
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

    // xterm's onScroll may not fire for trackpad/wheel scrolling,
    // so also listen on the viewport element's native scroll event.
    const viewport = containerEl.querySelector(".xterm-viewport");
    if (viewport) {
      viewport.addEventListener("scroll", scheduleUpdate, { passive: true });
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      terminal.scrollToBottom();
      terminal.focus();
      scheduleUpdate();
    });
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  dispose(): void {
    this.resizeObserver.disconnect();
    for (const tab of this.tabs) {
      tab.webglAddon?.dispose();
      tab.terminal.dispose();
      tab.containerEl.remove();
    }
    this.tabs = [];
  }
}
