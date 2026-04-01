/**
 * RecentlyClosedStore - circular buffer of recently closed terminal sessions
 * for undo/reopen functionality.
 *
 * Stores enough info to re-launch a session: command, cwd, item association,
 * and session type. Entries expire after 30 minutes and the buffer is capped
 * at 10 entries.
 */
import {
  isSessionType,
  type DurableRecoveryMode,
  type SessionType,
} from "../core/session/types";

export interface ClosedSessionEntry {
  sessionType: SessionType;
  label: string;
  agentSessionId?: string | null;
  claudeSessionId?: string | null;
  durableSessionId?: string;
  closedAt: number; // Date.now() timestamp
  itemId: string;
  recoveryMode: DurableRecoveryMode;
  cwd?: string;
  command?: string;
  commandArgs?: string[];
  profileColor?: string;
}

const MAX_ENTRIES = 10;
const EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

export class RecentlyClosedStore {
  private entries: ClosedSessionEntry[] = [];

  /** Record a closed session. Deduplicates by entry key. */
  push(entry: ClosedSessionEntry): void {
    const normalized = RecentlyClosedStore.normalizeEntry(entry);
    if (!normalized) return;

    const key = RecentlyClosedStore.entryKey(normalized);
    this.entries = this.entries.filter(
      (existing) => RecentlyClosedStore.entryKey(existing) !== key,
    );
    this.entries.unshift(normalized);
    this.prune();
  }

  /** Pop the most recently closed session (LIFO). */
  pop(): ClosedSessionEntry | null {
    this.prune();
    const entry = this.entries.shift();
    return entry ?? null;
  }

  /** Peek at the most recently closed session without removing it. */
  peek(): ClosedSessionEntry | null {
    this.prune();
    return this.entries[0] ?? null;
  }

  /** List all recently closed sessions, newest first. */
  list(): ClosedSessionEntry[] {
    this.prune();
    return [...this.entries];
  }

  /**
   * Get recently closed sessions, filtered to exclude currently active session IDs.
   * Returns newest first, max `limit` entries.
   */
  getFiltered(activeSessionIds: Set<string>, limit = 5): ClosedSessionEntry[] {
    this.prune();
    const result: ClosedSessionEntry[] = [];
    for (const entry of this.entries) {
      if (result.length >= limit) break;
      const sessionId = entry.claudeSessionId ?? entry.agentSessionId;
      if (sessionId && activeSessionIds.has(sessionId)) {
        continue;
      }
      result.push(entry);
    }
    return result;
  }

  /** Remove expired entries and enforce max size. */
  private prune(): void {
    const cutoff = Date.now() - EXPIRY_MS;
    this.entries = this.entries.filter((e) => e.closedAt > cutoff);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.length = MAX_ENTRIES;
    }
  }

  private static entryKey(entry: ClosedSessionEntry): string {
    if (entry.recoveryMode === "resume" && entry.claudeSessionId) {
      return `resume:${entry.claudeSessionId}`;
    }
    if (entry.durableSessionId) {
      return `relaunch:${entry.itemId}\u0001${entry.durableSessionId}`;
    }
    const args = entry.commandArgs?.join("\u0000") || "";
    return [
      "relaunch",
      entry.itemId,
      entry.sessionType,
      entry.label,
      entry.cwd || "",
      entry.command || "",
      args,
    ].join("\u0001");
  }

  private static normalizeEntry(raw: unknown): ClosedSessionEntry | null {
    if (!raw || typeof raw !== "object") return null;

    const candidate = raw as Record<string, unknown>;
    const itemId =
      typeof candidate.itemId === "string" ? candidate.itemId : null;
    const label =
      typeof candidate.label === "string" ? candidate.label : null;
    const sessionType = isSessionType(candidate.sessionType)
      ? candidate.sessionType
      : null;
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
    const closedAt =
      typeof candidate.closedAt === "number"
        ? candidate.closedAt
        : NaN;
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

    if (
      !itemId ||
      !label ||
      !sessionType ||
      !Number.isFinite(closedAt) ||
      !recoveryMode
    ) {
      return null;
    }

    if (recoveryMode === "resume" && !claudeSessionId) {
      return null;
    }

    if (recoveryMode === "relaunch" && (!cwd || !command)) {
      return null;
    }

    return {
      itemId,
      label,
      sessionType,
      claudeSessionId,
      durableSessionId,
      closedAt,
      recoveryMode,
      cwd,
      command,
      commandArgs,
      profileColor,
    };
  }
}
