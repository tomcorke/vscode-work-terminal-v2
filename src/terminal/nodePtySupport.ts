export interface NativePtyStatus {
  available: boolean;
  modulePath: string | null;
  loadError: string | null;
  electronVersion: string | null;
}

export interface NodePtyRebuildPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface NodePtyRebuildPreflight {
  isDevelopmentMode: boolean;
  hasNodePtyDependency: boolean;
  pnpmAvailable: boolean;
}

const ELECTRON_HEADERS_URL = "https://electronjs.org/headers";

export function createNodePtyRebuildPlan(electronVersion?: string | null): NodePtyRebuildPlan {
  if (!electronVersion) {
    throw new Error("VS Code Electron version is unavailable in this process.");
  }

  return {
    command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    args: ["rebuild", "node-pty"],
    env: {
      npm_config_runtime: "electron",
      npm_config_target: electronVersion,
      npm_config_disturl: ELECTRON_HEADERS_URL,
    },
  };
}

export function formatNodePtyLoadWarning(status: NativePtyStatus): string {
  const electronSuffix = status.electronVersion
    ? ` for VS Code Electron ${status.electronVersion}`
    : "";
  const detail = status.loadError ? ` (${status.loadError})` : "";
  return `node-pty could not load its native binding${electronSuffix}${detail}. Work Terminal will fall back to basic child_process sessions until you rebuild node-pty.`;
}

export function getNodePtyRebuildUnsupportedReason(
  preflight: NodePtyRebuildPreflight,
): string | null {
  if (!preflight.isDevelopmentMode) {
    return "node-pty rebuild is only supported from a local Extension Development Host. Packaged installs do not expose a writable pnpm-managed dependency tree.";
  }

  if (!preflight.hasNodePtyDependency) {
    return "node-pty rebuild requires a source checkout with node_modules/node-pty installed. Run pnpm install in the repository checkout first.";
  }

  if (!preflight.pnpmAvailable) {
    return "pnpm is not available on PATH. Install pnpm in your development environment, then rerun the rebuild command.";
  }

  return null;
}

export function formatNodePtyRebuildFailure(
  code: number | null,
  signal: NodeJS.Signals | null,
  stdout: string,
  stderr: string,
): string {
  const reason =
    signal != null
      ? `node-pty rebuild failed due to signal ${signal}.`
      : `node-pty rebuild failed with exit code ${code ?? "unknown"}.`;
  const stdoutTrimmed = stdout.trim();
  const stderrTrimmed = stderr.trim();
  const sections = [
    stderrTrimmed ? `stderr:\n${stderrTrimmed}` : null,
    stdoutTrimmed ? `stdout:\n${stdoutTrimmed}` : null,
  ].filter(Boolean);

  return [reason, ...sections].join("\n\n");
}
