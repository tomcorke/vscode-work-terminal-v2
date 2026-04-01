import type { WebviewApi } from "../types/vscode";
import type { WebviewMessage, ExtensionMessage } from "./messages";
import { ListPanel } from "./listPanel";

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

window.addEventListener("message", (event: MessageEvent<ExtensionMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "updateItems":
      if (listPanel) {
        listPanel.updateItems(message.items, message.columns);
      }
      break;
    case "terminalOutput":
      // Will be handled by terminal panel module
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
  // VS Code injects updated CSS variables automatically when the theme
  // changes. This handler is a hook for any additional work needed
  // (e.g. re-rendering canvas-based components like xterm).
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
