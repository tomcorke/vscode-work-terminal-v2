/**
 * TerminalManager - manages terminal processes on the extension host side.
 *
 * Spawns shell/agent processes using node-pty (with child_process fallback),
 * routes I/O to/from the webview via postMessage, and tracks terminal lifecycle.
 */

import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { SessionType } from "../core/session/types";
import { isResumableSessionType } from "../core/session/types";
import { AgentStateDetector, aggregateState } from "./AgentStateDetector";
import type { AgentState } from "./AgentStateDetector";
import { buildAgentLaunchArgs, generateSessionId, augmentPath } from "./AgentLauncher";

// ---------------------------------------------------------------------------
// node-pty types (optional dependency)
// ---------------------------------------------------------------------------

interface IPty {
  pid: number;
  cols: number;
  rows: number;
  onData: (callback: (data: string) => void) => { dispose(): void };
  onExit: (callback: (e: { exitCode: number; signal?: number }) => void) => { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): IPty;
}

// ---------------------------------------------------------------------------
// Try to load node-pty
// ---------------------------------------------------------------------------

let nodePty: NodePtyModule | null = null;
try {
  // node-pty is an optional native dependency - fall back gracefully
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  nodePty = require("node-pty") as NodePtyModule;
} catch {
  // Will use child_process fallback
}

// ---------------------------------------------------------------------------
// child_process fallback types
// ---------------------------------------------------------------------------

import { spawn as cpSpawn, type ChildProcess } from "child_process";

// ---------------------------------------------------------------------------
// Terminal instance
// ---------------------------------------------------------------------------

interface TerminalInstance {
  sessionId: string;
  itemId: string | null;
  label: string;
  sessionType: SessionType;
  agentSessionId: string;
  pty: IPty | null;
  process: ChildProcess | null;
  stateDetector: AgentStateDetector | null;
  disposed: boolean;
  disposables: Array<{ dispose(): void }>;
}

// ---------------------------------------------------------------------------
// TerminalManager
// ---------------------------------------------------------------------------

export class TerminalManager {
  private terminals = new Map<string, TerminalInstance>();

  /** Callback to send data to the webview. */
  onOutput?: (sessionId: string, data: string) => void;
  /** Callback when a terminal is created. */
  onCreated?: (sessionId: string, label: string, sessionType: SessionType) => void;
  /** Callback when a terminal exits/closes. */
  onClosed?: (sessionId: string) => void;
  /** Callback when agent state changes. */
  onAgentStateChanged?: (sessionId: string, state: AgentState) => void;

  private getDefaultCwd(): string {
    const config = vscode.workspace.getConfiguration("workTerminal");
    const configured = config.get<string>("defaultTerminalCwd", "").trim();
    if (configured) {
      if (configured === "~") {
        return os.homedir();
      }
      if (configured.startsWith("~/")) {
        return path.join(os.homedir(), configured.slice(2));
      }
      return configured;
    }
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0].uri.fsPath;
    }
    return os.homedir();
  }

  private getDefaultShell(): string {
    const config = vscode.workspace.getConfiguration("workTerminal");
    const configured = config.get<string>("defaultShell", "").trim();
    if (configured) {
      return configured;
    }
    const platform = os.platform();
    if (platform === "win32") {
      return process.env.COMSPEC || "cmd.exe";
    }
    return process.env.SHELL || "/bin/bash";
  }

  private getEnv(): Record<string, string> {
    const env = { ...process.env } as Record<string, string>;
    env.PATH = augmentPath(process.env);
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";
    return env;
  }

  /**
   * Create a new terminal session.
   * When `resumeSessionId` is provided, the agent CLI is launched with
   * `--resume <id>` to continue a previous session.
   */
  createTerminal(options: {
    sessionType: SessionType;
    itemId?: string;
    label?: string;
    cwd?: string;
    command?: string;
    args?: string[];
    contextPrompt?: string;
    resumeSessionId?: string;
    cols?: number;
    rows?: number;
  }): string {
    const sessionId = generateSessionId();
    const agentSessionId = options.resumeSessionId || generateSessionId();
    const cwd = options.cwd || this.getDefaultCwd();
    const sessionType = options.sessionType;
    const label = options.label || this.getLabelForType(sessionType);

    let command: string;
    let args: string[];

    if (options.command) {
      // Caller already resolved the command (profile-based launch)
      command = options.command;
      args = options.args || [];
    } else if (sessionType === "shell") {
      command = this.getDefaultShell();
      args = options.args || [];
    } else {
      // Agent session - build launch args using defaults
      const config = vscode.workspace.getConfiguration("workTerminal");
      const settings: Record<string, string | undefined> = {
        additionalAgentContext: config.get<string>("additionalAgentContext"),
      };

      const launch = buildAgentLaunchArgs(
        sessionType,
        settings,
        agentSessionId,
        options.contextPrompt,
        options.resumeSessionId,
      );
      command = launch.command;
      args = launch.args;
    }

    const cols = options.cols || 120;
    const rows = options.rows || 30;
    const env = this.getEnv();

    const instance: TerminalInstance = {
      sessionId,
      itemId: options.itemId || null,
      label,
      sessionType,
      agentSessionId,
      pty: null,
      process: null,
      stateDetector: null,
      disposed: false,
      disposables: [],
    };

    // Set up agent state detection for resumable sessions
    if (isResumableSessionType(sessionType)) {
      const detector = new AgentStateDetector();
      detector.onChange = (state) => {
        this.onAgentStateChanged?.(sessionId, state);
      };
      detector.start();
      instance.stateDetector = detector;
    }

    console.log(`[TerminalManager] Spawning: ${command} ${args.join(" ")} (cwd: ${cwd})`);

    if (nodePty) {
      // Use node-pty for proper PTY support
      try {
        const pty = nodePty.spawn(command, args, {
          name: "xterm-256color",
          cols,
          rows,
          cwd,
          env,
        });

        instance.pty = pty;

        const dataDisposable = pty.onData((data: string) => {
          if (instance.disposed) return;
          instance.stateDetector?.trackOutput(data);
          this.onOutput?.(sessionId, data);
        });
        instance.disposables.push(dataDisposable);

        const exitDisposable = pty.onExit((e) => {
          console.log(`[TerminalManager] Process exited: ${sessionId} (code: ${e.exitCode}, signal: ${e.signal})`);
          if (instance.disposed) return;
          this.destroyTerminal(sessionId);
        });
        instance.disposables.push(exitDisposable);
      } catch (err) {
        console.error("[TerminalManager] node-pty spawn failed, falling back to child_process:", err);
        this.spawnWithChildProcess(instance, command, args, cwd, env);
      }
    } else {
      // Fallback to child_process (no PTY - limited terminal features)
      this.spawnWithChildProcess(instance, command, args, cwd, env);
    }

    this.terminals.set(sessionId, instance);
    this.onCreated?.(sessionId, label, sessionType);

    return sessionId;
  }

  private spawnWithChildProcess(
    instance: TerminalInstance,
    command: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
  ): void {
    const proc = cpSpawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    instance.process = proc;

    proc.stdout?.on("data", (data: Buffer) => {
      if (instance.disposed) return;
      const str = data.toString("utf8");
      instance.stateDetector?.trackOutput(str);
      this.onOutput?.(instance.sessionId, str);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      if (instance.disposed) return;
      const str = data.toString("utf8");
      instance.stateDetector?.trackOutput(str);
      this.onOutput?.(instance.sessionId, str);
    });

    proc.on("exit", () => {
      if (instance.disposed) return;
      this.destroyTerminal(instance.sessionId);
    });

    proc.on("error", (err) => {
      console.error("[TerminalManager] process error:", err);
      const errorMsg = `\r\nProcess error: ${err.message}\r\n`;
      this.onOutput?.(instance.sessionId, errorMsg);
    });
  }

  /**
   * Write input data to a terminal.
   */
  writeToTerminal(sessionId: string, data: string): void {
    const instance = this.terminals.get(sessionId);
    if (!instance || instance.disposed) return;

    if (instance.pty) {
      instance.pty.write(data);
    } else if (instance.process?.stdin && !instance.process.stdin.destroyed) {
      instance.process.stdin.write(data);
    }
  }

  /**
   * Resize a terminal.
   */
  resizeTerminal(sessionId: string, cols: number, rows: number): void {
    const instance = this.terminals.get(sessionId);
    if (!instance || instance.disposed) return;

    if (instance.pty) {
      try {
        instance.pty.resize(cols, rows);
      } catch {
        // Resize can fail if process already exited
      }
    }
    // child_process fallback doesn't support resize
  }

  /**
   * Destroy a terminal session.
   */
  destroyTerminal(sessionId: string): void {
    const instance = this.terminals.get(sessionId);
    if (!instance) return;

    instance.disposed = true;
    instance.stateDetector?.dispose();

    for (const d of instance.disposables) {
      d.dispose();
    }

    if (instance.pty) {
      try {
        instance.pty.kill();
      } catch {
        // Already dead
      }
    }

    if (instance.process) {
      try {
        instance.process.kill();
      } catch {
        // Already dead
      }
    }

    // Fire onClosed before deleting so listeners can still query session info
    this.onClosed?.(sessionId);
    this.terminals.delete(sessionId);
  }

  /**
   * Get the aggregate agent state for a work item.
   */
  getAgentState(itemId: string): AgentState {
    const states: AgentState[] = [];
    for (const instance of this.terminals.values()) {
      if (instance.itemId === itemId && instance.stateDetector) {
        states.push(instance.stateDetector.state);
      }
    }
    return aggregateState(states);
  }

  /**
   * Get all session IDs for a work item.
   */
  getSessionsForItem(itemId: string): string[] {
    const sessions: string[] = [];
    for (const [sessionId, instance] of this.terminals) {
      if (instance.itemId === itemId) {
        sessions.push(sessionId);
      }
    }
    return sessions;
  }

  /**
   * Get session info for building session state messages.
   */
  getSessionInfo(sessionId: string): { label: string; sessionType: SessionType; agentSessionId: string } | undefined {
    const instance = this.terminals.get(sessionId);
    if (!instance) return undefined;
    return { label: instance.label, sessionType: instance.sessionType, agentSessionId: instance.agentSessionId };
  }

  /**
   * Get full info for all active terminal instances (for session persistence).
   */
  getAllSessionInfo(): Array<{
    sessionId: string;
    itemId: string | null;
    label: string;
    sessionType: SessionType;
    agentSessionId: string;
    cwd?: string;
    commandArgs?: string[];
    profileColor?: string;
  }> {
    const result: Array<{
      sessionId: string;
      itemId: string | null;
      label: string;
      sessionType: SessionType;
      agentSessionId: string;
      cwd?: string;
      commandArgs?: string[];
      profileColor?: string;
    }> = [];
    for (const instance of this.terminals.values()) {
      result.push({
        sessionId: instance.sessionId,
        itemId: instance.itemId,
        label: instance.label,
        sessionType: instance.sessionType,
        agentSessionId: instance.agentSessionId,
      });
    }
    return result;
  }

  /**
   * Rename a terminal tab.
   */
  renameTerminal(sessionId: string, label: string): void {
    const instance = this.terminals.get(sessionId);
    if (instance) {
      instance.label = label;
    }
  }

  /**
   * Close all terminals for a work item.
   */
  closeAllForItem(itemId: string): void {
    const sessionIds = this.getSessionsForItem(itemId);
    for (const sid of sessionIds) {
      this.destroyTerminal(sid);
    }
  }

  /**
   * Get the number of active terminal sessions.
   */
  get activeSessionCount(): number {
    return this.terminals.size;
  }

  /**
   * Dispose all terminals.
   */
  disposeAll(): void {
    for (const sessionId of [...this.terminals.keys()]) {
      this.destroyTerminal(sessionId);
    }
  }

  private getLabelForType(sessionType: SessionType): string {
    switch (sessionType) {
      case "shell":
        return "Shell";
      case "claude":
        return "Claude";
      case "claude-with-context":
        return "Claude (ctx)";
      case "copilot":
        return "Copilot";
      case "copilot-with-context":
        return "Copilot (ctx)";
      case "strands":
        return "Strands";
      case "strands-with-context":
        return "Strands (ctx)";
    }
  }
}
