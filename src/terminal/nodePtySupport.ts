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
