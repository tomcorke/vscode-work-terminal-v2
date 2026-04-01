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

export type ExtensionMessage =
  | { type: "updateItems"; items: WorkItemDTO[]; columns: string[] }
  | { type: "terminalOutput"; sessionId: string; data: string }
  | {
      type: "sessionStateChanged";
      itemId: string;
      sessions: Array<{ id: string; label: string; kind: "shell" | "agent" }>;
    }
  | { type: "themeChanged" };
