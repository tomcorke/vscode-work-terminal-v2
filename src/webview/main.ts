import type { WebviewApi } from "../types/vscode";
import type { WebviewMessage, ExtensionMessage } from "./messages";
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
// Terminal panel instance
// ---------------------------------------------------------------------------

let terminalPanel: TerminalPanel | null = null;

window.addEventListener("message", (event: MessageEvent<ExtensionMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "updateItems":
      terminalPanel?.updateWorkItems(message.items);
      break;
    case "terminalOutput":
      terminalPanel?.writeOutput(message.sessionId, message.data);
      break;
    case "terminalCreated":
      terminalPanel?.addTerminal(message.sessionId, message.label, message.sessionType, message.itemId);
      break;
    case "terminalClosed":
      terminalPanel?.removeTerminal(message.sessionId);
      break;
    case "terminalRenamed":
      terminalPanel?.renameTab(message.sessionId, message.label);
      break;
    case "agentStateChanged":
      terminalPanel?.updateAgentState(message.sessionId, message.state);
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
    case "buttonProfiles":
      terminalPanel?.updateButtonProfiles(message.profiles);
      break;
    case "hookBannerState":
      terminalPanel?.updateHookBanner(message.visible, message.message);
      break;
    case "hookStatusChanged":
      terminalPanel?.updateHookStatus(message.installed);
      break;
    case "requestCreateTerminal":
      postMessage({ type: "createTerminal", terminalType: message.terminalType });
      break;
    case "requestCloseActiveTerminal": {
      const activeSessionId = terminalPanel?.getActiveSessionId();
      if (activeSessionId) {
        postMessage({ type: "closeTerminal", sessionId: activeSessionId });
      }
      break;
    }
    case "debugApiState": {
      // Install or remove a terminal-only debug API on window.__workTerminalDebug
      const anyWindow = window as unknown as Record<string, unknown>;
      if (message.enabled) {
        anyWindow.__workTerminalDebug = {
          panel: "terminal",
          postMessage,
          getActiveSessionId: () => terminalPanel?.getActiveSessionId() ?? null,
        };
      } else {
        delete anyWindow.__workTerminalDebug;
      }
      break;
    }
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
    overlay.className = "wt-profile-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay!.remove();
    });
    overlay.addEventListener("click", handleProfileAction);
    document.body.appendChild(overlay);
  }
  return overlay;
}

function setOverlayContent(overlay: HTMLElement, html: string): void {
  overlay.innerHTML = `<div class="wt-profile-dialog">${html}</div>`;
  initColorSync(overlay);
}

function initColorSync(container: HTMLElement): void {
  const textInput = container.querySelector<HTMLInputElement>('input[name="buttonColor"]');
  const picker = container.querySelector<HTMLInputElement>('input[name="buttonColorPicker"]');
  const swatch = container.querySelector<HTMLElement>(".wt-color-preview-swatch");
  if (!textInput || !picker || !swatch) return;

  const updateSwatch = (color: string) => {
    swatch.style.backgroundColor = color || "transparent";
    swatch.classList.toggle("wt-color-preview-swatch--empty", !color);
  };

  textInput.addEventListener("input", () => {
    const val = textInput.value.trim();
    updateSwatch(val);
    if (/^#[0-9a-fA-F]{6}$/.test(val)) {
      picker.value = val;
    }
  });

  picker.addEventListener("input", () => {
    textInput.value = picker.value;
    updateSwatch(picker.value);
  });

  updateSwatch(textInput.value.trim());
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
    case "addProfile": {
      const overlay = getOrCreateOverlay();
      setOverlayContent(overlay, renderProfileEditor(null));
      break;
    }
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
    case "closeOverlay": {
      const overlay = document.getElementById("profile-overlay");
      if (overlay) overlay.remove();
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
// Theme change handling
// ---------------------------------------------------------------------------

function handleThemeChange(): void {
  // Re-apply theme to xterm instances when VS Code theme changes
  terminalPanel?.refreshTheme();
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

function init(): void {
  terminalPanel = new TerminalPanel(postMessage);
  postMessage({ type: "ready" });
}

// Run when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
