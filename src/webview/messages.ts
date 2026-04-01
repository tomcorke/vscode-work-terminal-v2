/**
 * Shared message types between extension host and webview.
 */

import type { AgentProfile } from "../core/agents/types";

// ---- Webview -> Extension ----

export type WebviewMessage =
  | { type: "ready" }
  | { type: "itemSelected"; id: string }
  | { type: "createItem"; title: string; column?: string }
  | { type: "deleteItem"; id: string }
  | { type: "moveItem"; id: string; toColumn: string; index: number }
  | { type: "launchTerminal"; itemId: string; profile?: string }
  | { type: "terminalInput"; sessionId: string; data: string }
  | { type: "terminalResize"; sessionId: string; cols: number; rows: number }
  | { type: "createTerminal"; terminalType: string; itemId?: string }
  | { type: "closeTerminal"; sessionId: string }
  | { type: "renameTerminal"; sessionId: string; label: string }
  | { type: "filterChanged"; query: string }
  | { type: "dragDrop"; itemId: string; toColumn: string; index: number }
  | { type: "reopenClosedTerminal" }
  | { type: "getProfiles" }
  | { type: "saveProfile"; profile: AgentProfile }
  | { type: "deleteProfile"; profileId: string }
  | { type: "reorderProfiles"; orderedIds: string[] }
  | { type: "launchProfile"; profileId: string; itemId?: string; cwdOverride?: string; labelOverride?: string; extraArgs?: string }
  | { type: "importProfiles" }
  | { type: "exportProfiles" }
  | { type: "moveProfileUp"; profileId: string }
  | { type: "moveProfileDown"; profileId: string }
  | { type: "copyToClipboard"; text: string }
  | { type: "contextMenuMove"; itemId: string; toColumn: string }
  | { type: "contextMenuDelete"; itemId: string }
  | { type: "requestLaunchModal" };

// ---- Extension -> Webview ----

export interface WorkItemDTO {
  id: string;
  title: string;
  column: string;
  source?: string;
  meta?: Record<string, string>;
  goals?: string[];
  hasBlocker?: boolean;
  blockerContext?: string;
  jiraKey?: string;
  jiraBaseUrl?: string;
}

export interface TerminalSessionInfo {
  sessionId: string;
  label: string;
  sessionType: string;
}

/** Minimal button profile info sent to the webview for rendering profile buttons. */
export interface ButtonProfileInfo {
  profileId: string;
  label: string;
  icon?: string;
  color?: string;
  borderStyle?: string;
}

export type ExtensionMessage =
  | { type: "updateItems"; items: WorkItemDTO[]; columns: string[] }
  | { type: "terminalOutput"; sessionId: string; data: string }
  | { type: "terminalCreated"; sessionId: string; label: string; sessionType: string }
  | { type: "terminalClosed"; sessionId: string }
  | { type: "agentStateChanged"; sessionId: string; state: string }
  | {
      type: "sessionStateChanged";
      itemId: string;
      sessions: Array<{ id: string; label: string; kind: "shell" | "agent" }>;
    }
  | { type: "themeChanged" }
  | { type: "profileList"; profiles: AgentProfile[] }
  | { type: "profileSaved"; profile: AgentProfile }
  | { type: "profileDeleted"; profileId: string }
  | { type: "focusFilter" }
  | { type: "requestCreateItem" }
  | { type: "requestCreateTerminal"; terminalType: string }
  | { type: "requestCloseActiveTerminal" }
  | { type: "selectItem"; itemId: string }
  | { type: "setIngesting"; itemId: string }
  | { type: "clearIngesting"; itemId: string }
  | { type: "buttonProfiles"; profiles: ButtonProfileInfo[] };
