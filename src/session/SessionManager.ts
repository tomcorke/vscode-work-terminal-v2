/**
 * SessionManager - coordinator that ties session stores together.
 *
 * - On activate: loads persisted sessions, attempts recovery
 * - On terminal close: adds to recently-closed, removes from persistence
 * - On deactivate: persists all resumable sessions, stashes in-memory state
 * - Provides session filtering by item for UI display
 */
import type * as vscode from "vscode";
import { DataStore } from "../core/dataStore";
import { isResumableSessionType, type PersistedSession, type StoredSession } from "../core/session/types";
import { SessionStore } from "./SessionStore";
import { SessionPersistence, type PersistableSession } from "./SessionPersistence";
import { RecentlyClosedStore, type ClosedSessionEntry } from "./RecentlyClosedStore";
import type { TerminalManager } from "../terminal/TerminalManager";

export interface SessionManagerOptions {
  context: vscode.ExtensionContext;
  terminalManager: TerminalManager;
}

export class SessionManager {
  private readonly persistence: SessionPersistence;
  private readonly recentlyClosed = new RecentlyClosedStore();
  private readonly terminalManager: TerminalManager;
  private stopPeriodicPersist: (() => void) | null = null;

  constructor(options: SessionManagerOptions) {
    this.terminalManager = options.terminalManager;
    const store = new DataStore(options.context.globalState);
    this.persistence = new SessionPersistence(store);
  }

  /**
   * Initialize on extension activation.
   * Loads persisted sessions and checks for hot-reload stash.
   */
  async activate(): Promise<{
    persisted: PersistedSession[];
    stashedState: ReturnType<typeof SessionStore.retrieve>;
  }> {
    // Check for hot-reload stash first
    const stashedState = SessionStore.retrieve();

    // Load disk-persisted sessions (with 7-day pruning)
    const persisted = await this.persistence.load();

    if (persisted.length > 0) {
      console.log(
        "[work-terminal] Loaded",
        persisted.length,
        "persisted sessions for recovery",
      );
    }

    // Start periodic persistence as a safety net
    this.stopPeriodicPersist = SessionPersistence.startPeriodicPersist(
      () => this.persistCurrentSessions(),
    );

    return { persisted, stashedState };
  }

  /**
   * Handle terminal close event.
   * Adds session to recently-closed and removes from persistence.
   */
  async onTerminalClosed(sessionInfo: {
    sessionId: string;
    label: string;
    itemId: string | null;
    sessionType: string;
    agentSessionId?: string | null;
    claudeSessionId?: string | null;
    durableSessionId?: string | null;
    cwd?: string;
    command?: string;
    commandArgs?: string[];
    profileColor?: string;
  }): Promise<void> {
    const {
      sessionId,
      label,
      itemId,
      sessionType,
      agentSessionId,
      claudeSessionId,
      cwd,
      command,
      commandArgs,
      profileColor,
    } = sessionInfo;

    // Add to recently-closed store
    if (itemId) {
      const recoveryMode = claudeSessionId || agentSessionId ? "resume" : "relaunch";
      this.recentlyClosed.push({
        sessionType: sessionType as ClosedSessionEntry["sessionType"],
        label,
        agentSessionId,
        claudeSessionId,
        closedAt: Date.now(),
        itemId,
        recoveryMode: recoveryMode as ClosedSessionEntry["recoveryMode"],
        cwd,
        command,
        commandArgs,
        profileColor,
      });
    }

    // Remove from disk persistence if it was a resumable session
    const sid = claudeSessionId ?? agentSessionId;
    if (sid) {
      await this.persistence.remove(sid);
    }
  }

  /**
   * Persist all current resumable sessions.
   * Called periodically and on deactivation.
   */
  async persistCurrentSessions(): Promise<void> {
    const sessions = this.terminalManager.getAllSessionInfo();
    const persistable: PersistableSession[] = sessions.map((s) => ({
      id: s.sessionId,
      label: s.label,
      itemId: s.itemId,
      agentSessionId: s.agentSessionId,
      sessionType: s.sessionType,
      cwd: s.cwd,
      commandArgs: s.commandArgs,
      profileColor: s.profileColor,
    }));
    await this.persistence.save(persistable);
  }

  /**
   * Stash in-memory session state for hot-reload recovery.
   */
  stashForReload(
    sessions: Map<string, StoredSession[]>,
    activeTaskPath: string | null,
    activeTabIndex: number,
  ): void {
    SessionStore.stash(sessions, activeTaskPath, activeTabIndex);
  }

  /**
   * Handle extension deactivation.
   * Persists resumable sessions and cleans up.
   */
  async deactivate(): Promise<void> {
    this.stopPeriodicPersist?.();
    this.stopPeriodicPersist = null;
    await this.persistCurrentSessions();
  }

  /**
   * Get recently closed sessions, optionally filtered by active session IDs.
   */
  getRecentlyClosed(
    activeSessionIds?: Set<string>,
    limit = 5,
  ): ClosedSessionEntry[] {
    if (activeSessionIds) {
      return this.recentlyClosed.getFiltered(activeSessionIds, limit);
    }
    return this.recentlyClosed.list().slice(0, limit);
  }

  /**
   * Pop the most recently closed session for reopen.
   */
  popRecentlyClosed(): ClosedSessionEntry | null {
    return this.recentlyClosed.pop();
  }

  /**
   * Get persisted sessions for a specific item.
   */
  async getPersistedSessionsForItem(
    itemId: string,
  ): Promise<PersistedSession[]> {
    const all = await this.persistence.load();
    return all.filter((s) => s.taskPath === itemId);
  }

  /**
   * Clear all persisted sessions (e.g. after full recovery).
   */
  async clearPersisted(): Promise<void> {
    await this.persistence.clear();
  }
}
