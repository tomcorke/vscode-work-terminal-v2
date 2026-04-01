import type { WebviewApi } from "../types/vscode";
import type { WebviewMessage, ExtensionMessage } from "./messages";
import { ListPanel } from "./listPanel";
import { TerminalPanel } from "./terminalPanel";

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
    default:
      break;
  }
});

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
