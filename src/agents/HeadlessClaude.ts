/**
 * Spawn a headless (non-interactive) Claude CLI process and capture its output.
 *
 * Used for background operations like generating summaries, extracting context,
 * or running one-shot prompts without a visible terminal.
 */
import * as cp from "child_process";
import { augmentPath, resolveCommand, parseExtraArgs } from "../terminal/AgentLauncher";

const TIMEOUT_MS = 120_000;

export interface HeadlessClaudeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export function spawnHeadlessClaude(
  prompt: string,
  cwd: string,
  claudeCommand = "claude",
  extraArgs = "",
): Promise<HeadlessClaudeResult> {
  return new Promise((resolve) => {
    const resolvedCmd = resolveCommand(claudeCommand);
    const args: string[] = [];

    if (extraArgs) {
      args.push(...parseExtraArgs(extraArgs));
    }

    args.push("-p", prompt, "--output-format", "text");

    const proc = cp.spawn(resolvedCmd, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: augmentPath(),
        TERM: "dumb",
      },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    proc.stdout?.on("data", (data: Buffer) => {
      stdoutChunks.push(data);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderrChunks.push(data);
    });

    const timeout = setTimeout(() => {
      if (!settled && !proc.killed) {
        settled = true;
        proc.kill("SIGTERM");
        resolve({
          exitCode: -1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: "Headless Claude timed out after 120s",
          timedOut: true,
        });
      }
    }, TIMEOUT_MS);

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      console.error("[work-terminal] Headless Claude error:", err);
      resolve({
        exitCode: -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: err.message,
      });
    });

    proc.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });

    // Close stdin immediately since we pass the prompt via args
    proc.stdin?.end();
  });
}
