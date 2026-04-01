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
import { stripAnsi } from "../core/utils";

export type AgentState = AgentRuntimeState;

function normalizeWaitingLine(line: string): string {
  return line
    .replace(/[\u2502\u2503\u2551\u256d\u256e\u2570\u256f\u2500\u2550]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const GENERIC_WAITING_QUESTION_WINDOW = 5;
const HIDDEN_CLAUDE_QUESTION_WINDOW = 10;
const HIDDEN_CLAUDE_PROMPT_CHROME_SCAN_LINES = 6;

/**
 * Detect hidden Claude prompts where a question is followed by an empty
 * prompt character, then a shell-like indicator below it.
 */
function looksLikeHiddenClaudePrompt(
  tail: string[],
  questionIndex: number,
): boolean {
  const normalizedQuestion = normalizeWaitingLine(tail[questionIndex]);
  if (
    questionIndex < tail.length - HIDDEN_CLAUDE_QUESTION_WINDOW ||
    !normalizedQuestion.endsWith("?") ||
    normalizedQuestion.length <= 10
  ) {
    return false;
  }

  const normalizedAfterQuestion = tail
    .slice(
      questionIndex + 1,
      Math.min(
        tail.length,
        questionIndex + 1 + HIDDEN_CLAUDE_PROMPT_CHROME_SCAN_LINES,
      ),
    )
    .map((line) => normalizeWaitingLine(line))
    .filter((line) => line.length > 0);
  const promptIndex = normalizedAfterQuestion.findIndex(
    (line) => line === "\u276f",
  );
  if (promptIndex === -1) return false;
  if (
    normalizedAfterQuestion
      .slice(0, promptIndex)
      .some((line) => /^\u276f\s+\S/.test(line))
  ) {
    return false;
  }

  return normalizedAfterQuestion
    .slice(promptIndex + 1)
    .some((line) => /^\u279c\s+\S/.test(line) || /^\u23f5\u23f5/.test(line));
}

/**
 * Find the index of the last line that looks like a waiting indicator.
 * Returns -1 if no waiting indicator is found.
 */
function findLastWaitingLineIndex(lines: string[]): number {
  if (lines.length === 0) return -1;

  const tailStart = Math.max(0, lines.length - 20);
  const tail = lines.slice(tailStart);

  for (let i = tail.length - 1; i >= Math.max(0, tail.length - 15); i--) {
    const normalized = normalizeWaitingLine(tail[i]);
    if (!normalized) continue;

    // Permission prompts
    if (/Enter to (?:select|confirm)|to navigate/i.test(normalized))
      return tailStart + i;
    if (/\bAllow\b.*\?/i.test(normalized)) return tailStart + i;
    if (/\ballowOnce\b|\bdenyOnce\b|\ballowAlways\b/i.test(normalized))
      return tailStart + i;

    // Numbered selection lists (with arrow/chevron prefix)
    if (/^\s*[>\u276f]\s*\d+\.\s+\S/.test(normalized))
      return tailStart + i;

    // Numbered selection lists (bare numbers with a preceding question)
    if (/^\s*\(?\d+\)?\s+\S/.test(normalized) && i > 0) {
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        const normalizedPrevious = normalizeWaitingLine(tail[j]);
        if (normalizedPrevious.endsWith("?")) return tailStart + i;
      }
    }

    // Hidden Claude prompts (question + empty prompt + shell indicator)
    if (looksLikeHiddenClaudePrompt(tail, i)) return tailStart + i;

    // Questions (only in the last few lines)
    if (
      i >= tail.length - GENERIC_WAITING_QUESTION_WINDOW &&
      normalized.endsWith("?") &&
      normalized.length > 10
    ) {
      return tailStart + i;
    }

    // Yes/No prompts
    if (/^\s*(Yes|No)\s*$/i.test(normalized)) return tailStart + i;
  }

  return -1;
}

/**
 * Detect whether terminal output lines indicate the agent is waiting for input.
 * If active indicators appear after the waiting line, the agent is no longer waiting.
 */
export function hasAgentWaitingIndicator(lines: string[]): boolean {
  const waitingIndex = findLastWaitingLineIndex(lines);
  if (waitingIndex === -1) return false;
  // If there are active indicators after the waiting line, the agent resumed work
  if (hasAgentActiveIndicator(lines.slice(waitingIndex + 1))) return false;
  return true;
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
