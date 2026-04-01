import type { WebviewApi } from "../types/vscode";
import type { WebviewMessage, ExtensionMessage } from "./messages";
import { ListPanel } from "./listPanel";
import { TerminalPanel } from "./terminalPanel";
import { renderProfileList } from "./profileManager";

const vscode: WebviewApi = acquireVsCodeApi();

// ---------------------------------------------------------------------------
// Message bridge
// ---------------------------------------------------------------------------

function postMessage(msg: WebviewMessage): void {
  vscode.postMessage(msg);
}

// ---------------------------------------------------------------------------
// List panel instance
// ---------------------------------------------------------------------------

let listPanel: ListPanel | null = null;
let terminalPanel: TerminalPanel | null = null;

window.addEventListener("message", (event: MessageEvent<ExtensionMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "updateItems":
      if (listPanel) {
        listPanel.updateItems(message.items, message.columns);
      }
      break;
    case "terminalOutput":
      terminalPanel?.writeOutput(message.sessionId, message.data);
      break;
    case "terminalCreated":
      terminalPanel?.addTerminal(message.sessionId, message.label, message.sessionType);
      break;
    case "terminalClosed":
      terminalPanel?.removeTerminal(message.sessionId);
      break;
    case "agentStateChanged":
      terminalPanel?.updateAgentState(message.sessionId, message.state);
      break;
    case "sessionStateChanged":
      if (listPanel) {
        listPanel.updateSessionState(message.itemId, message.sessions);
      }
      break;
    case "themeChanged":
      handleThemeChange();
      break;
    case "profileList":
      handleProfileList(message);
      break;
    case "profileSaved":
      // Profile saved confirmation - refresh the list via getProfiles
      vscode.postMessage({ type: "getProfiles" });
      break;
    case "profileDeleted":
      // Profile deleted confirmation - refresh the list via getProfiles
      vscode.postMessage({ type: "getProfiles" });
      break;
    case "requestCreateItem":
      // Triggered by keybinding - forward to extension to show input flow
      postMessage({ type: "createItem", title: "" });
      break;
    case "setIngesting":
      listPanel?.setIngesting(message.itemId);
      break;
    case "clearIngesting":
      listPanel?.clearIngesting(message.itemId);
      break;
    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// Profile management
// ---------------------------------------------------------------------------

function handleProfileList(message: Extract<ExtensionMessage, { type: "profileList" }>): void {
  // Render profiles into a dialog overlay
  let overlay = document.getElementById("profile-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "profile-overlay";
    overlay.style.cssText =
      "position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; " +
      "justify-content: center; background: rgba(0,0,0,0.4);";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay!.remove();
    });
    document.body.appendChild(overlay);
  }
  const html = renderProfileList(message.profiles);
  overlay.innerHTML = `<div style="background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 16px; max-width: 480px; width: 90%; max-height: 80vh; overflow-y: auto;">${html}</div>`;
}

// ---------------------------------------------------------------------------
// Resizable divider
// ---------------------------------------------------------------------------

function initDivider(): void {
  const divider = document.getElementById("divider");
  const leftPanel = document.getElementById("left-panel");
  if (!divider || !leftPanel) return;

  let startX = 0;
  let startWidth = 0;

  const onMouseMove = (e: MouseEvent) => {
    const delta = e.clientX - startX;
    const newWidth = Math.max(200, startWidth + delta);
    leftPanel.style.width = `${newWidth}px`;
    leftPanel.style.flexBasis = `${newWidth}px`;
    leftPanel.style.flexGrow = "0";
    leftPanel.style.flexShrink = "0";
  };

  const onMouseUp = () => {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    divider.classList.remove("wt-divider-active");
  };

  divider.addEventListener("mousedown", (e: MouseEvent) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = leftPanel.offsetWidth;
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    divider.classList.add("wt-divider-active");
  });
}

// ---------------------------------------------------------------------------
// Theme change handling
// ---------------------------------------------------------------------------

function handleThemeChange(): void {
  // Re-apply theme to xterm instances when VS Code theme changes
  terminalPanel?.refreshTheme();
}

// ---------------------------------------------------------------------------
// Toolbar handlers
// ---------------------------------------------------------------------------

function initToolbar(): void {
  const filterInput = document.getElementById("filter-input") as HTMLInputElement | null;
  if (filterInput && listPanel) {
    filterInput.addEventListener("input", () => {
      listPanel!.applyFilter(filterInput.value);
    });
  }

  const newItemBtn = document.getElementById("new-item-btn");
  if (newItemBtn) {
    newItemBtn.addEventListener("click", () => {
      postMessage({ type: "createItem", title: "" });
    });
  }
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

function init(): void {
  listPanel = new ListPanel(vscode);
  terminalPanel = new TerminalPanel(postMessage);
  initDivider();
  initToolbar();
  postMessage({ type: "ready" });
}

// Run when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
