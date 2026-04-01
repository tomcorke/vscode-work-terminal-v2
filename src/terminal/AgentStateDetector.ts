/**
 * Agent state detection from terminal output.
 *
 * Reads terminal buffer content to detect whether an agent is active, idle,
 * or waiting for user input. Ported from the Obsidian reference implementation.
 *
 * This module runs on the extension host side - it receives terminal output
 * strings and maintains state. The webview reads screen buffers separately
 * for its own rendering, but state detection happens here via raw output.
 */

import type { AgentRuntimeState } from "../core/session/types";

export type AgentState = AgentRuntimeState;

/**
 * Strip ANSI escape codes from a string.
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[()][0-2AB]/g, "");
}

function normalizeWaitingLine(line: string): string {
  return line
    .replace(/[\u2502\u2503\u2551\u256d\u256e\u2570\u256f\u2500\u2550]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detect whether terminal output lines indicate the agent is waiting for input.
 */
export function hasAgentWaitingIndicator(lines: string[]): boolean {
  if (lines.length === 0) return false;

  const tail = lines.slice(-20);
  for (let i = tail.length - 1; i >= Math.max(0, tail.length - 15); i--) {
    const normalized = normalizeWaitingLine(tail[i]);
    if (!normalized) continue;

    // Permission prompts
    if (/Enter to (?:select|confirm)|to navigate/i.test(normalized)) return true;
    if (/\bAllow\b.*\?/i.test(normalized)) return true;
    if (/\ballowOnce\b|\bdenyOnce\b|\ballowAlways\b/i.test(normalized)) return true;

    // Numbered selection lists
    if (/^\s*[>\u276f]\s*\d+\.\s+\S/.test(normalized)) return true;

    // Yes/No prompts
    if (/^\s*(Yes|No)\s*$/i.test(normalized)) return true;

    // Questions (only in the last few lines)
    if (
      i >= tail.length - 5 &&
      normalized.endsWith("?") &&
      normalized.length > 10
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Detect whether terminal output indicates the agent is actively working.
 * Supports Claude's spinner/tool rows and Copilot's activity indicators.
 */
export function hasAgentActiveIndicator(lines: string[]): boolean {
  const tail = lines.slice(-6);
  const tailJoined = tail.join(" ");
  const tailCompact = tail.map((l) => l.trim()).join("");

  // Claude: spinner with ellipsis (work in progress)
  const hasClaudeActive =
    tail.some(
      (line) =>
        /^\s*\u2733.*\u2026/.test(line) ||
        /^\s*\u23bf\s+.*\u2026/.test(line),
    ) ||
    (/\u2733/.test(tailJoined) &&
      /\u2026/.test(tailJoined) &&
      tail.some((line) => /^\s*\u2733/.test(line)));

  // Copilot: spinner characters with status labels
  const copilotSpinner = /^\s*[\u25c9\u25ce\u25cb\u25cf]\s+(?!\(Esc\b)\S/;
  const copilotStatus = /\b(?:Thinking|Executing|Cancelling)\b/;
  const copilotCancel = /\(Esc\s+to\s+cancel(?:\s+\u00b7\s+[^)]*)?\)/;

  const hasCopilotActive =
    tail.some(
      (line) =>
        /^\s*[\u25c9\u25ce\u25cb\u25cf]\s+(?:Thinking|Executing|Cancelling)\b/.test(line) ||
        (copilotSpinner.test(line) && copilotCancel.test(line)),
    ) ||
    (tail.some((line) => copilotSpinner.test(line)) &&
      (copilotStatus.test(tailCompact) ||
        copilotCancel.test(tailJoined) ||
        copilotCancel.test(tailCompact)));

  return hasClaudeActive || hasCopilotActive;
}

/**
 * Detects agent state from terminal output on the extension host side.
 * Maintains a rolling buffer of recent output lines and periodically checks
 * for state patterns.
 */
export class AgentStateDetector {
  private _state: AgentState = "inactive";
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _recentLines: string[] = [];
  private _suppressActiveUntil = 0;

  onChange?: (state: AgentState) => void;

  get state(): AgentState {
    return this._state;
  }

  /**
   * Start periodic state checking.
   */
  start(suppressActive = false): void {
    this._state = suppressActive ? "idle" : "active";
    if (suppressActive) this._suppressActiveUntil = Date.now() + 2000;
    this._timer = setInterval(() => this._check(), 2000);
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Feed output data for pattern matching.
   */
  trackOutput(data: string): void {
    const lines = stripAnsi(data)
      .split(/\r\n|\n|\r/)
      .filter((l) => l.trim().length > 0);

    this._recentLines.push(...lines);
    if (this._recentLines.length > 50) {
      this._recentLines = this._recentLines.slice(-50);
    }
  }

  private _check(): void {
    const lines = this._recentLines;
    if (lines.length === 0) return;

    // Check waiting first (highest priority)
    if (hasAgentWaitingIndicator(lines)) {
      this._setState("waiting");
      return;
    }

    if (hasAgentActiveIndicator(lines)) {
      if (Date.now() < this._suppressActiveUntil) {
        this._setState("idle");
      } else {
        this._setState("active");
      }
    } else {
      this._suppressActiveUntil = 0;
      this._setState("idle");
    }
  }

  private _setState(s: AgentState): void {
    if (this._state === s) return;
    this._state = s;
    this.onChange?.(s);
  }

  dispose(): void {
    this.stop();
  }
}

/**
 * Aggregate multiple agent states.
 * Priority: waiting > active > idle > inactive.
 */
export function aggregateState(states: AgentState[]): AgentState {
  if (states.some((s) => s === "waiting")) return "waiting";
  if (states.some((s) => s === "active")) return "active";
  if (states.some((s) => s === "idle")) return "idle";
  return "inactive";
}
