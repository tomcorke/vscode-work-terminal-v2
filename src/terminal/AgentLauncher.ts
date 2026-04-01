/**
 * CLI launch helpers for agent processes.
 *
 * Builds argument arrays for Claude Code, GitHub Copilot, and custom agent
 * profiles. Ported from the Obsidian reference implementation with
 * platform-specific Electron references removed.
 */

import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const EXTRA_PATH_DIRS = [
  "~/.local/bin",
  "~/.nvm/versions/node/current/bin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
  // VS Code Copilot CLI location
  "~/Library/Application Support/Code/User/globalStorage/github.copilot-chat/copilotCli",
];

function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Build an augmented PATH that includes common tool directories.
 */
export function augmentPath(env: NodeJS.ProcessEnv = process.env): string {
  const delimiter = path.delimiter;
  const existing = env.PATH || "/usr/local/bin:/usr/bin:/bin";
  const dirs = EXTRA_PATH_DIRS.map((d) => expandTilde(d));
  const all = [...dirs, ...existing.split(delimiter)].filter(Boolean);
  return [...new Set(all)].join(delimiter);
}

/**
 * Resolve a command name to its absolute path by searching the augmented PATH.
 */
export function resolveCommand(cmd: string, env?: NodeJS.ProcessEnv): string {
  const requested = cmd.trim();
  if (!requested) return requested;

  const expanded = requested.startsWith("~") ? expandTilde(requested) : requested;
  if (path.isAbsolute(expanded)) {
    return expanded;
  }

  const pathDirs = augmentPath(env).split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const full = path.join(dir, expanded);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      // not found in this dir
    }
  }
  return requested;
}

/**
 * Parse extra args string into an array, handling quoted strings.
 */
export function parseExtraArgs(extraArgs = ""): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (const char of extraArgs.trim()) {
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

/**
 * Build Claude CLI argument array.
 */
export function buildClaudeArgs(
  settings: {
    claudeExtraArgs?: string;
    additionalAgentContext?: string;
  },
  sessionId: string,
  prompt?: string,
  resumeSessionId?: string,
): { args: string[]; initialPrompt?: string } {
  const args: string[] = [];
  if (settings.claudeExtraArgs) {
    args.push(...parseExtraArgs(settings.claudeExtraArgs));
  }
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  } else {
    args.push("--session-id", sessionId);
  }
  // Context prompt is written to stdin after Claude reaches idle state,
  // NOT passed as a positional arg (which triggers --print / one-shot mode).
  let initialPrompt: string | undefined;
  if (prompt) {
    initialPrompt = prompt;
    if (settings.additionalAgentContext) {
      initialPrompt += "\n\n" + settings.additionalAgentContext;
    }
  }
  return { args, initialPrompt };
}

/**
 * Build GitHub Copilot CLI argument array.
 */
export function buildCopilotArgs(
  settings: { copilotExtraArgs?: string },
  prompt?: string,
  resumeSessionId?: string,
): string[] {
  const args: string[] = [];
  if (settings.copilotExtraArgs) {
    args.push(...parseExtraArgs(settings.copilotExtraArgs));
  }
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }
  if (prompt) {
    args.push("-i", prompt);
  }
  return args;
}

/**
 * Build launch command and args for an agent session type.
 * When `resumeSessionId` is provided, the agent CLI receives `--resume <id>`
 * instead of a fresh `--session-id`.
 */
export function buildAgentLaunchArgs(
  sessionType: string,
  settings: Record<string, string | undefined>,
  sessionId: string,
  prompt?: string,
  resumeSessionId?: string,
): { command: string; args: string[]; initialPrompt?: string } {
  switch (sessionType) {
    case "claude":
    case "claude-with-context": {
      const command = resolveCommand(settings.claudeCommand || "claude");
      const result = buildClaudeArgs(
        {
          claudeExtraArgs: settings.claudeExtraArgs,
          additionalAgentContext: settings.additionalAgentContext,
        },
        sessionId,
        sessionType === "claude-with-context" ? prompt : undefined,
        resumeSessionId,
      );
      return { command, args: result.args, initialPrompt: result.initialPrompt };
    }
    case "copilot":
    case "copilot-with-context": {
      const command = resolveCommand(settings.copilotCommand || "copilot");
      const extraArgs = buildCopilotArgs(
        { copilotExtraArgs: settings.copilotExtraArgs },
        sessionType === "copilot-with-context" ? prompt : undefined,
        resumeSessionId,
      );
      return { command, args: extraArgs };
    }
    default: {
      // Custom profile or shell - return as-is
      const command = resolveCommand(settings.command || "bash");
      return { command, args: parseExtraArgs(settings.extraArgs) };
    }
  }
}

/**
 * Generate a session ID for agent tracking (UUID v4 format).
 */
export function generateSessionId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Fallback for environments without crypto.randomUUID
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}
