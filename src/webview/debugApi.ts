/**
 * Debug API exposed on window.__workTerminalDebug when the
 * workTerminal.exposeDebugApi setting is enabled.
 *
 * Provides read-only inspection methods for development and troubleshooting.
 */

import type { ListPanel } from "./listPanel";
import type { TerminalPanel } from "./terminalPanel";

export interface DebugApi {
  /** Full snapshot of items, columns, tabs, and session counts. */
  getSnapshot(): {
    items: Array<{ id: string; title: string; column: string }>;
    columns: string[];
    tabs: Array<{
      sessionId: string;
      label: string;
      sessionType: string;
      itemId: string | null;
      agentState: string;
    }>;
    activeTabIndex: number;
    terminalCount: number;
  };

  /** All active terminal tabs. */
  getAllActiveTabs(): Array<{
    sessionId: string;
    label: string;
    sessionType: string;
    itemId: string | null;
    agentState: string;
  }>;

  /** Find tabs whose label contains the given string (case-insensitive). */
  findTabsByLabel(label: string): Array<{
    sessionId: string;
    label: string;
    sessionType: string;
    itemId: string | null;
    agentState: string;
  }>;

  /** Session IDs of all active terminal tabs. */
  getActiveSessionIds(): string[];

  /** Items with their session counts, optionally filtered by item ID. */
  getPersistedSessions(itemId?: string): Array<{
    id: string;
    title: string;
    column: string;
    sessionCount: number;
    sessionKind: string | undefined;
    agentState: string | undefined;
  }>;

  /** Diagnostic summary for troubleshooting. */
  getSessionDiagnostics(): {
    totalItems: number;
    totalTabs: number;
    activeTabIndex: number;
    itemsWithSessions: number;
    agentTabs: number;
    shellTabs: number;
    tabsByState: Record<string, number>;
  };
}

declare global {
  interface Window {
    __workTerminalDebug?: DebugApi;
  }
}

/**
 * Install the debug API on window.__workTerminalDebug.
 * Requires getter methods on ListPanel (getItems, getColumns, getSessionCounts)
 * and TerminalPanel (getTabSnapshots, getActiveIndex).
 */
export function installDebugApi(
  listPanel: ListPanel,
  terminalPanel: TerminalPanel,
): void {
  const api: DebugApi = {
    getSnapshot() {
      const tabs = terminalPanel.getTabSnapshots();
      return {
        items: listPanel.getItems().map((i) => ({
          id: i.id,
          title: i.title,
          column: i.column,
        })),
        columns: listPanel.getColumns(),
        tabs,
        activeTabIndex: terminalPanel.getActiveIndex(),
        terminalCount: tabs.length,
      };
    },

    getAllActiveTabs() {
      return terminalPanel.getTabSnapshots();
    },

    findTabsByLabel(label: string) {
      const lower = label.toLowerCase();
      return terminalPanel
        .getTabSnapshots()
        .filter((t) => t.label.toLowerCase().includes(lower));
    },

    getActiveSessionIds() {
      return terminalPanel.getTabSnapshots().map((t) => t.sessionId);
    },

    getPersistedSessions(itemId?: string) {
      const items = listPanel.getItems();
      const counts = listPanel.getSessionCounts();
      const filtered = itemId
        ? items.filter((i) => i.id === itemId)
        : items;
      return filtered.map((i) => {
        const info = counts.get(i.id);
        return {
          id: i.id,
          title: i.title,
          column: i.column,
          sessionCount: info?.count ?? 0,
          sessionKind: info?.kind,
          agentState: info?.agentState,
        };
      });
    },

    getSessionDiagnostics() {
      const tabs = terminalPanel.getTabSnapshots();
      const counts = listPanel.getSessionCounts();
      const tabsByState: Record<string, number> = {};
      let agentTabs = 0;
      let shellTabs = 0;
      for (const tab of tabs) {
        tabsByState[tab.agentState] = (tabsByState[tab.agentState] ?? 0) + 1;
        if (tab.sessionType === "shell") {
          shellTabs++;
        } else {
          agentTabs++;
        }
      }
      return {
        totalItems: listPanel.getItems().length,
        totalTabs: tabs.length,
        activeTabIndex: terminalPanel.getActiveIndex(),
        itemsWithSessions: counts.size,
        agentTabs,
        shellTabs,
        tabsByState,
      };
    },
  };

  window.__workTerminalDebug = api;
  console.log("[work-terminal] Debug API installed on window.__workTerminalDebug");
}

/** Remove the debug API from window. */
export function removeDebugApi(): void {
  delete window.__workTerminalDebug;
}
