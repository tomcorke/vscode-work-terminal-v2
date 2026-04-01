/**
 * In-memory session store for hot-reload persistence.
 *
 * Uses a module-level global that survives extension host restarts within the
 * same VS Code window. Sessions are stashed before deactivation and retrieved
 * on the next activation cycle, preserving session metadata (not live terminal
 * handles - those are managed by VS Code's Terminal API).
 *
 * Delete-after-read pattern prevents double-consumption of stashed state.
 */
import type { StoredSession, StoredState } from "../core/session/types";

// Module-level store that persists across extension reloads within the same
// VS Code window (the extension host process keeps module state alive).
const STORE_KEY = Symbol.for("workTerminal.sessionStore");

interface GlobalWithStore {
  [STORE_KEY]?: StoredState;
}

const _global = globalThis as GlobalWithStore;

export class SessionStore {
  /**
   * Stash session state for reload recovery.
   * Merges with any existing stashed state to handle partial stash scenarios.
   */
  static stash(
    sessions: Map<string, StoredSession[]>,
    activeTaskPath: string | null,
    activeTabIndex: number,
  ): void {
    const existing = _global[STORE_KEY];
    const mergedSessions = new Map(existing?.sessions || []);
    for (const [itemId, tabs] of sessions) {
      const existingTabs = mergedSessions.get(itemId) || [];
      mergedSessions.set(itemId, [...existingTabs, ...tabs]);
    }
    _global[STORE_KEY] = {
      sessions: mergedSessions,
      activeTaskPath: activeTaskPath ?? existing?.activeTaskPath ?? null,
      activeTabIndex:
        activeTaskPath !== null || !existing
          ? activeTabIndex
          : (existing.activeTabIndex ?? 0),
    };
    console.log(
      "[work-terminal] Stashed",
      mergedSessions.size,
      "task groups for reload",
    );
  }

  /**
   * Retrieve stashed session state. Delete-after-read: the store is cleared
   * after retrieval to prevent double-consumption.
   */
  static retrieve(): StoredState | null {
    const store = _global[STORE_KEY];
    if (!store) return null;
    delete _global[STORE_KEY];
    console.log(
      "[work-terminal] Retrieved",
      store.sessions.size,
      "task groups from store",
    );
    return store;
  }

  /** Check if there is a stashed store from a previous reload. */
  static isReload(): boolean {
    return !!_global[STORE_KEY];
  }

  /** Clear the stashed store without retrieving. */
  static clear(): void {
    delete _global[STORE_KEY];
  }
}
