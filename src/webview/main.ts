import type { WebviewApi } from "../types/vscode";
import type { WebviewMessage, ExtensionMessage } from "./messages";
import { ListPanel } from "./listPanel";
import { TerminalPanel } from "./terminalPanel";
import { renderProfileList, renderProfileEditor } from "./profileManager";
import type { AgentProfile, AgentType, ParamPassMode, ProfileIcon, BorderStyle } from "../core/agents/types";

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
    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// Profile management
// ---------------------------------------------------------------------------

/** Cached profile list from the most recent profileList message. */
let cachedProfiles: AgentProfile[] = [];

function getOrCreateOverlay(): HTMLElement {
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
    overlay.addEventListener("click", handleProfileAction);
    document.body.appendChild(overlay);
  }
  return overlay;
}

function setOverlayContent(overlay: HTMLElement, html: string): void {
  overlay.innerHTML =
    `<div style="background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 16px; max-width: 480px; width: 90%; max-height: 80vh; overflow-y: auto;">${html}</div>`;
}

function handleProfileList(message: Extract<ExtensionMessage, { type: "profileList" }>): void {
  cachedProfiles = message.profiles;
  const overlay = getOrCreateOverlay();
  setOverlayContent(overlay, renderProfileList(message.profiles));
}

function handleProfileAction(e: Event): void {
  const target = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target) return;

  const action = target.dataset.action;
  const profileId = target.dataset.profileId;

  switch (action) {
    case "editProfile": {
      if (!profileId) break;
      const profile = cachedProfiles.find((p) => p.id === profileId);
      if (!profile) break;
      const overlay = getOrCreateOverlay();
      setOverlayContent(overlay, renderProfileEditor(profile));
      break;
    }
    case "saveProfile": {
      const editor = document.querySelector<HTMLElement>(".wt-profile-editor");
      if (!editor) break;
      const profile = collectProfileFromForm(editor);
      postMessage({ type: "saveProfile", profile });
      break;
    }
    case "cancelEdit": {
      // Return to the profile list
      postMessage({ type: "getProfiles" });
      break;
    }
    case "deleteProfile": {
      if (!profileId) break;
      postMessage({ type: "deleteProfile", profileId });
      break;
    }
    case "moveProfileUp": {
      if (!profileId) break;
      postMessage({ type: "moveProfileUp", profileId });
      break;
    }
    case "moveProfileDown": {
      if (!profileId) break;
      postMessage({ type: "moveProfileDown", profileId });
      break;
    }
    case "importProfiles": {
      postMessage({ type: "importProfiles" });
      break;
    }
    case "exportProfiles": {
      postMessage({ type: "exportProfiles" });
      break;
    }
  }
}

function collectProfileFromForm(editor: HTMLElement): AgentProfile {
  const val = (name: string): string => {
    const el = editor.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${name}"]`);
    return el?.value ?? "";
  };
  const checked = (name: string): boolean => {
    const el = editor.querySelector<HTMLInputElement>(`[name="${name}"]`);
    return el?.checked ?? false;
  };

  const existingId = editor.dataset.profileId || "";
  const id = existingId || crypto.randomUUID();

  return {
    id,
    name: val("name"),
    agentType: val("agentType") as AgentType,
    command: val("command"),
    defaultCwd: val("defaultCwd"),
    arguments: val("arguments"),
    contextPrompt: val("contextPrompt"),
    useContext: checked("useContext"),
    paramPassMode: (val("paramPassMode") || "launch-only") as ParamPassMode,
    button: {
      enabled: checked("buttonEnabled"),
      label: val("buttonLabel"),
      icon: (val("buttonIcon") || undefined) as ProfileIcon | undefined,
      borderStyle: (val("buttonBorderStyle") || "solid") as BorderStyle,
      color: val("buttonColor") || undefined,
    },
    sortOrder: cachedProfiles.find((p) => p.id === existingId)?.sortOrder ?? cachedProfiles.length,
  };
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
