import type { WebviewApi } from "../types/vscode";
import type { ExtensionMessage } from "./messages";
import { ListPanel } from "./listPanel";

const vscode: WebviewApi = acquireVsCodeApi();

// ---------------------------------------------------------------------------
// List panel instance (full-fidelity cards, same as main panel)
// ---------------------------------------------------------------------------

let listPanel: ListPanel | null = null;

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

window.addEventListener("message", (event: MessageEvent<ExtensionMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "updateItems":
      if (listPanel) {
        listPanel.updateItems(message.items, message.columns);
      }
      break;
    case "sessionStateChanged":
      if (listPanel) {
        listPanel.updateSessionState(message.itemId, message.sessions);
      }
      break;
    case "agentStateChanged":
      if (listPanel && message.itemId) {
        const state = message.state;
        let agentState: "active" | "idle" | "waiting" | null = null;
        if (state === "active" || state === "idle" || state === "waiting" || state === null) {
          agentState = state;
        }
        listPanel.setAgentState(message.itemId, agentState, message.idleSince);
      }
      break;
    case "setIngesting":
      listPanel?.setIngesting(message.itemId);
      break;
    case "clearIngesting":
      listPanel?.clearIngesting(message.itemId);
      break;
    case "addPlaceholder":
      listPanel?.addPlaceholder(message.placeholderId, message.title, message.column);
      break;
    case "resolvePlaceholder":
      listPanel?.resolvePlaceholder(message.placeholderId, message.realId);
      break;
    case "failPlaceholder":
      listPanel?.failPlaceholder(message.placeholderId);
      break;
    case "resumeItemIds":
      listPanel?.updateResumeItemIds(message.itemIds);
      break;
    case "focusFilter":
      showFilter();
      break;
    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// Toolbar handlers
// ---------------------------------------------------------------------------

function initToolbar(): void {
  const filterInput = document.getElementById("sb-filter") as HTMLInputElement | null;
  const filterContainer = document.getElementById("sb-filter-container");
  const filterToggleBtn = document.getElementById("sb-filter-toggle");

  if (filterInput && listPanel) {
    filterInput.addEventListener("input", () => {
      listPanel!.applyFilter(filterInput.value);
    });
  }

  if (filterToggleBtn && filterContainer && filterInput) {
    filterToggleBtn.addEventListener("click", () => {
      const isVisible = filterContainer.style.display !== "none";
      if (isVisible) {
        filterContainer.style.display = "none";
        filterInput.value = "";
        listPanel?.applyFilter("");
        filterToggleBtn.classList.remove("wt-toolbar-icon-btn-active");
      } else {
        filterContainer.style.display = "";
        filterInput.focus();
        filterToggleBtn.classList.add("wt-toolbar-icon-btn-active");
      }
    });
  }

  const newItemBtn = document.getElementById("sb-new-item");
  if (newItemBtn) {
    newItemBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "createItem", title: "" });
    });
  }
}

function showFilter(): void {
  const filterInput = document.getElementById("sb-filter") as HTMLInputElement | null;
  const filterContainer = document.getElementById("sb-filter-container");
  const filterToggleBtn = document.getElementById("sb-filter-toggle");
  if (filterContainer && filterInput) {
    filterContainer.style.display = "";
    filterInput.focus();
    filterToggleBtn?.classList.add("wt-toolbar-icon-btn-active");
  }
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

function init(): void {
  listPanel = new ListPanel(vscode, "sb-list");
  initToolbar();
  vscode.postMessage({ type: "ready" });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
