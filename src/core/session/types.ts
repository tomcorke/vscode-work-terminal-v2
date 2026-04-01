/**
 * Session type and persistence interfaces.
 *
 * Ported from the Obsidian plugin. Runtime-only types (Terminal, FitAddon,
 * ChildProcess, ResizeObserver, HTMLElement) are removed from StoredSession
 * since VS Code terminals are managed differently. StoredSession retains only
 * the metadata needed for session tracking; live terminal state is managed
 * by the VS Code Terminal API.
 */

export const SESSION_TYPES = [
  "shell",
  "claude",
  "claude-with-context",
  "copilot",
  "copilot-with-context",
  "strands",
  "strands-with-context",
] as const;

export type SessionType = (typeof SESSION_TYPES)[number];

export type DurableRecoveryMode = "resume" | "relaunch";

export type AgentRuntimeState = "inactive" | "active" | "idle" | "waiting";

/**
 * Metadata for a terminal session that can survive extension reload.
 * Unlike the Obsidian version, this does NOT hold live terminal/process
 * references - those are managed by the VS Code Terminal API.
 */
export interface StoredSession {
  id: string;
  taskPath: string | null;
  label: string;
  agentSessionId?: string | null;
  claudeSessionId?: string | null;
  durableSessionId?: string | null;
  sessionType: SessionType;
  profileColor?: string;
  shell?: string;
  cwd?: string;
  commandArgs?: string[];
}

/**
 * Lightweight metadata persisted to disk so resumable agent sessions can be
 * resumed after a full extension close/restart.
 */
export interface PersistedSession {
  version: 1 | 2;
  taskPath: string;
  agentSessionId?: string | null;
  claudeSessionId?: string | null;
  durableSessionId?: string;
  durableSessionIdGenerated?: boolean;
  label: string;
  sessionType: SessionType;
  savedAt: string; // ISO timestamp
  recoveryMode?: DurableRecoveryMode;
  cwd?: string;
  command?: string;
  commandArgs?: string[];
  profileColor?: string;
}

export interface ActiveTabInfo {
  tabId: string;
  itemId: string;
  label: string;
  sessionId: string | null;
  sessionType: SessionType;
  isResumableAgent: boolean;
}

export interface StoredState {
  sessions: Map<string, StoredSession[]>;
  activeTaskPath: string | null;
  activeTabIndex: number;
}

export function isSessionType(value: unknown): value is SessionType {
  return typeof value === "string" && SESSION_TYPES.includes(value as SessionType);
}

export function isResumableSessionType(sessionType: SessionType): boolean {
  return (
    sessionType === "claude" ||
    sessionType === "claude-with-context" ||
    sessionType === "copilot" ||
    sessionType === "copilot-with-context"
  );
}
