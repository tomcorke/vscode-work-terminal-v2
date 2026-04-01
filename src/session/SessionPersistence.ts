/**
 * Disk persistence for resumable agent session metadata.
 *
 * Saves/loads PersistedSession metadata via VS Code's ExtensionContext.globalState
 * so supported agent sessions (Claude, Copilot with session IDs) can be resumed
 * after a full extension close/restart.
 *
 * Sessions older than 7 days are pruned on load.
 */
import {
  isSessionType,
  isResumableSessionType,
  type DurableRecoveryMode,
  type PersistedSession,
  type SessionType,
} from "../core/session/types";
import { DataStore } from "../core/dataStore";

const STORAGE_KEY = "workTerminal.persistedSessions";

/** 7 days in milliseconds */
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Default interval for periodic disk persist (30 seconds) */
export const PERSIST_INTERVAL_MS = 30_000;

/** Minimal interface for extracting persistable data from a terminal instance. */
export interface PersistableSession {
  id: string;
  label: string;
  itemId: string | null;
  agentSessionId?: string | null;
  claudeSessionId?: string | null;
  durableSessionId?: string | null;
  sessionType: SessionType;
  cwd?: string;
  command?: string;
  commandArgs?: string[];
  profileColor?: string;
}

export class SessionPersistence {
  private readonly store: DataStore;

  constructor(store: DataStore) {
    this.store = store;
  }

  /**
   * Save resumable sessions to globalState.
   * Only persists sessions with resumable types and a session ID.
   */
  async save(sessions: PersistableSession[]): Promise<void> {
    const persisted = this.buildPersistedSessions(sessions);
    await this.store.set(STORAGE_KEY, persisted);
    if (persisted.length > 0) {
      console.log(
        "[work-terminal] Saved",
        persisted.length,
        "resumable sessions to disk",
      );
    }
  }

  /**
   * Load persisted sessions from globalState.
   * Filters out sessions older than 7 days.
   */
  async load(): Promise<PersistedSession[]> {
    const raw = this.store.get<unknown[]>(STORAGE_KEY) || [];
    const cutoff = Date.now() - SESSION_MAX_AGE_MS;
    const valid = raw
      .map((entry) => SessionPersistence.normalizePersistedSession(entry))
      .filter((session): session is PersistedSession => {
        return !!session && new Date(session.savedAt).getTime() > cutoff;
      });
    if (valid.length !== raw.length) {
      console.log(
        "[work-terminal] Pruned",
        raw.length - valid.length,
        "stale persisted sessions",
      );
      // Write back the pruned list
      await this.store.set(STORAGE_KEY, valid);
    }
    return valid;
  }

  /**
   * Remove a single persisted session by its agent/claude session ID.
   */
  async remove(sessionId: string): Promise<void> {
    const sessions = await this.load();
    const filtered = sessions.filter(
      (s) => s.claudeSessionId !== sessionId && s.agentSessionId !== sessionId,
    );
    await this.store.set(STORAGE_KEY, filtered);
  }

  /**
   * Clear all persisted sessions.
   */
  async clear(): Promise<void> {
    await this.store.set(STORAGE_KEY, undefined);
  }

  /**
   * Start a periodic persist interval. Returns a stop function.
   */
  static startPeriodicPersist(
    persistFn: () => Promise<void>,
    intervalMs: number = PERSIST_INTERVAL_MS,
  ): () => void {
    let isPersisting = false;
    const id = setInterval(() => {
      if (isPersisting) return;
      isPersisting = true;
      persistFn()
        .catch((err) =>
          console.error("[work-terminal] Periodic persist failed:", err),
        )
        .finally(() => {
          isPersisting = false;
        });
    }, intervalMs);
    return () => clearInterval(id);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildPersistedSessions(
    sessions: PersistableSession[],
  ): PersistedSession[] {
    const persisted: PersistedSession[] = [];
    const savedAt = new Date().toISOString();
    for (const session of sessions) {
      const entry = this.buildPersistedSession(session, savedAt);
      if (entry) {
        persisted.push(entry);
      }
    }
    return persisted;
  }

  private buildPersistedSession(
    session: PersistableSession,
    savedAt: string,
  ): PersistedSession | null {
    if (!isResumableSessionType(session.sessionType)) {
      return null;
    }

    const claudeSessionId =
      session.claudeSessionId ?? session.agentSessionId ?? null;
    if (!claudeSessionId) {
      return null;
    }

    if (!session.itemId) {
      return null;
    }

    return {
      version: 2,
      taskPath: session.itemId,
      claudeSessionId,
      durableSessionId: session.durableSessionId ?? undefined,
      label: session.label,
      sessionType: session.sessionType,
      savedAt,
      recoveryMode: "resume" as DurableRecoveryMode,
      cwd: session.cwd,
      command: session.command,
      commandArgs: session.commandArgs ? [...session.commandArgs] : undefined,
      profileColor: session.profileColor,
    };
  }

  private static normalizePersistedSession(
    raw: unknown,
  ): PersistedSession | null {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const candidate = raw as Record<string, unknown>;
    const taskPath =
      typeof candidate.taskPath === "string" ? candidate.taskPath : null;
    const label =
      typeof candidate.label === "string" ? candidate.label : null;
    const sessionType = isSessionType(candidate.sessionType)
      ? candidate.sessionType
      : null;
    const savedAt =
      typeof candidate.savedAt === "string" ? candidate.savedAt : null;

    if (!taskPath || !label || !sessionType || !savedAt) {
      return null;
    }

    const claudeSessionId =
      typeof candidate.claudeSessionId === "string"
        ? candidate.claudeSessionId
        : typeof candidate.agentSessionId === "string"
          ? candidate.agentSessionId
          : null;
    const durableSessionId =
      typeof candidate.durableSessionId === "string"
        ? candidate.durableSessionId
        : undefined;
    const recoveryMode =
      candidate.recoveryMode === "resume" || candidate.recoveryMode === "relaunch"
        ? candidate.recoveryMode
        : claudeSessionId
          ? "resume"
          : null;
    const cwd =
      typeof candidate.cwd === "string" ? candidate.cwd : undefined;
    const command =
      typeof candidate.command === "string" ? candidate.command : undefined;
    const commandArgs = Array.isArray(candidate.commandArgs)
      ? candidate.commandArgs.filter(
          (value): value is string => typeof value === "string",
        )
      : undefined;
    const profileColor =
      typeof candidate.profileColor === "string"
        ? candidate.profileColor
        : undefined;

    if (!recoveryMode) {
      return null;
    }

    if (recoveryMode === "resume" && !claudeSessionId) {
      return null;
    }

    return {
      version: candidate.version === 1 ? 1 : 2,
      taskPath,
      claudeSessionId,
      durableSessionId,
      label,
      sessionType,
      savedAt,
      recoveryMode,
      cwd,
      command,
      commandArgs,
      profileColor,
    };
  }
}
