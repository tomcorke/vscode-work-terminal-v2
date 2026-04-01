/**
 * AgentLaunchModal - multi-step QuickPick flow for launching agent sessions.
 *
 * Two modes:
 * 1. Launch - pick a profile, optionally override CWD/label/args, then launch
 * 2. Restore Recent - pick a recently closed session to resume or relaunch
 */

import * as vscode from "vscode";
import type { AgentProfile } from "../core/agents/types";
import type { AgentProfileManager } from "./AgentProfileManager";
import type { ClosedSessionEntry } from "../session/RecentlyClosedStore";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface LaunchResult {
  mode: "launch";
  profile: AgentProfile;
  cwdOverride?: string;
  labelOverride?: string;
  extraArgs?: string;
}

export interface RestoreResult {
  mode: "restore";
  entry: ClosedSessionEntry;
  recoveryMode: "resume" | "relaunch";
}

export type LaunchModalResult = LaunchResult | RestoreResult | undefined;

// ---------------------------------------------------------------------------
// Modal implementation
// ---------------------------------------------------------------------------

export async function showLaunchModal(options: {
  profileManager: AgentProfileManager;
  recentlyClosed: ClosedSessionEntry[];
  defaultCwd: string;
}): Promise<LaunchModalResult> {
  const { profileManager, recentlyClosed, defaultCwd } = options;

  // Step 1: Choose mode - Launch or Restore Recent
  const modeItems: Array<vscode.QuickPickItem & { id: string }> = [
    {
      id: "launch",
      label: "$(rocket) Launch Profile",
      description: "Start a new agent session from a profile",
    },
  ];

  if (recentlyClosed.length > 0) {
    const latest = recentlyClosed[0];
    const latestAgo = formatTimeAgo(latest.closedAt);
    const latestType = formatSessionType(latest.sessionType);
    modeItems.push({
      id: "restore",
      label: "$(history) Restore Recent",
      description: `${recentlyClosed.length} session(s) - latest: ${latest.label} (${latestType}, ${latestAgo})`,
    });
  }

  // If only launch mode available, skip the mode picker
  if (modeItems.length === 1) {
    return showLaunchFlow(profileManager, defaultCwd);
  }

  const modeChoice = await vscode.window.showQuickPick(modeItems, {
    title: "Agent Session",
    placeHolder: "Launch a new session or restore a recent one",
  });

  if (!modeChoice) return undefined;

  if (modeChoice.id === "restore") {
    return showRestoreFlow(recentlyClosed);
  }

  return showLaunchFlow(profileManager, defaultCwd);
}

// ---------------------------------------------------------------------------
// Launch flow
// ---------------------------------------------------------------------------

async function showLaunchFlow(
  profileManager: AgentProfileManager,
  defaultCwd: string,
): Promise<LaunchResult | undefined> {
  const profiles = profileManager.getProfiles();

  if (profiles.length === 0) {
    vscode.window.showInformationMessage("No agent profiles configured. Create one first.");
    return undefined;
  }

  // Step 1: Pick a profile
  const profileItems = profiles.map((p) => {
    const badges: string[] = [];
    if (p.useContext) badges.push("ctx");
    if (p.button.enabled) badges.push("button");
    const badgeStr = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
    const command = profileManager.resolveCommand(p);
    const cwd = profileManager.resolveCwd(p);

    return {
      label: `$(${getCodiconForProfile(p)}) ${p.name}`,
      description: `${p.agentType}${badgeStr}`,
      detail: `Command: ${command} | CWD: ${cwd}`,
      profile: p,
    };
  });

  const profileChoice = await vscode.window.showQuickPick(profileItems, {
    title: "Launch Agent - Select Profile",
    placeHolder: "Choose an agent profile to launch",
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!profileChoice) return undefined;

  const selectedProfile = profileChoice.profile;

  // Step 2: Ask for overrides (multi-step)
  const overrideItems: Array<vscode.QuickPickItem & { id: string }> = [
    {
      id: "launch-now",
      label: "$(play) Launch Now",
      description: "Use profile defaults",
    },
    {
      id: "override-cwd",
      label: "$(folder) Override Working Directory",
      description: profileManager.resolveCwd(selectedProfile),
    },
    {
      id: "override-label",
      label: "$(tag) Override Tab Label",
      description: selectedProfile.name,
    },
    {
      id: "override-args",
      label: "$(terminal) Override Extra Arguments",
      description: profileManager.resolveArguments(selectedProfile) || "(none)",
    },
  ];

  const overrideChoice = await vscode.window.showQuickPick(overrideItems, {
    title: `Launch Agent - ${selectedProfile.name}`,
    placeHolder: "Launch now or customize before launching",
  });

  if (!overrideChoice) return undefined;

  if (overrideChoice.id === "launch-now") {
    return { mode: "launch", profile: selectedProfile };
  }

  // Handle specific overrides
  let cwdOverride: string | undefined;
  let labelOverride: string | undefined;
  let extraArgs: string | undefined;

  if (overrideChoice.id === "override-cwd") {
    const folders = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(profileManager.resolveCwd(selectedProfile) || defaultCwd),
      title: "Select working directory",
    });
    if (folders && folders.length > 0) {
      cwdOverride = folders[0].fsPath;
    }
  } else if (overrideChoice.id === "override-label") {
    const input = await vscode.window.showInputBox({
      title: "Tab Label Override",
      prompt: "Enter a custom tab label for this session",
      value: selectedProfile.name,
    });
    if (input !== undefined) {
      labelOverride = input;
    }
  } else if (overrideChoice.id === "override-args") {
    const input = await vscode.window.showInputBox({
      title: "Extra Arguments Override",
      prompt: "Enter additional CLI arguments",
      value: profileManager.resolveArguments(selectedProfile),
    });
    if (input !== undefined) {
      extraArgs = input;
    }
  }

  return {
    mode: "launch",
    profile: selectedProfile,
    cwdOverride,
    labelOverride,
    extraArgs,
  };
}

// ---------------------------------------------------------------------------
// Restore flow
// ---------------------------------------------------------------------------

async function showRestoreFlow(
  recentlyClosed: ClosedSessionEntry[],
): Promise<RestoreResult | undefined> {
  if (recentlyClosed.length === 0) {
    vscode.window.showInformationMessage("No recently closed sessions.");
    return undefined;
  }

  const items = recentlyClosed.map((entry) => {
    const ago = formatTimeAgo(entry.closedAt);
    const hasResume = entry.recoveryMode === "resume" && entry.claudeSessionId;
    const typeName = formatSessionType(entry.sessionType);

    const detailParts: string[] = [];
    if (hasResume) {
      detailParts.push("$(debug-continue) Resume available");
    } else {
      detailParts.push("$(refresh) Relaunch only");
    }
    if (entry.cwd) {
      detailParts.push(`$(folder) ${entry.cwd}`);
    }

    return {
      label: `$(${getCodiconForSessionType(entry.sessionType)}) ${entry.label}`,
      description: `${typeName} - closed ${ago}`,
      detail: detailParts.join("  |  "),
      entry,
    };
  });

  const choice = await vscode.window.showQuickPick(items, {
    title: "Restore Recent Session",
    placeHolder: "Select a recently closed session to restore",
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!choice) return undefined;

  const entry = choice.entry;

  // If resumable, ask for recovery mode
  if (entry.recoveryMode === "resume" && entry.claudeSessionId) {
    const modeItems: Array<vscode.QuickPickItem & { id: "resume" | "relaunch" }> = [
      {
        id: "resume",
        label: "$(debug-continue) Resume Exact Session",
        description: "Continue where you left off",
      },
      {
        id: "relaunch",
        label: "$(refresh) Relaunch Fresh",
        description: "Start a new session with the same settings",
      },
    ];

    const modeChoice = await vscode.window.showQuickPick(modeItems, {
      title: `Restore - ${entry.label}`,
      placeHolder: "Choose how to restore this session",
    });

    if (!modeChoice) return undefined;

    return { mode: "restore", entry, recoveryMode: modeChoice.id };
  }

  return { mode: "restore", entry, recoveryMode: "relaunch" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCodiconForProfile(profile: AgentProfile): string {
  switch (profile.agentType) {
    case "claude":
      return "sparkle";
    case "copilot":
      return "copilot";
    case "strands":
      return "beaker";
    case "shell":
      return "terminal";
    default:
      return "terminal";
  }
}

function getCodiconForSessionType(sessionType: string): string {
  if (sessionType.startsWith("claude")) return "sparkle";
  if (sessionType.startsWith("copilot")) return "copilot";
  if (sessionType.startsWith("strands")) return "beaker";
  return "terminal";
}

/** Human-friendly label for a session type. */
export function formatSessionType(sessionType: string): string {
  const map: Record<string, string> = {
    shell: "Shell",
    claude: "Claude",
    "claude-with-context": "Claude (context)",
    copilot: "Copilot",
    "copilot-with-context": "Copilot (context)",
    strands: "Strands",
    "strands-with-context": "Strands (context)",
  };
  return map[sessionType] ?? sessionType;
}

export function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
