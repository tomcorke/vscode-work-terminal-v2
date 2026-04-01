/**
 * Shared message types between extension host and webview.
 */

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
  | { type: "dragDrop"; itemId: string; toColumn: string; index: number };

// ---- Extension -> Webview ----

export interface WorkItemDTO {
  id: string;
  title: string;
  column: string;
  source?: string;
  meta?: Record<string, string>;
}

export interface TerminalSessionInfo {
  sessionId: string;
  label: string;
  sessionType: string;
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
  | { type: "themeChanged" };
