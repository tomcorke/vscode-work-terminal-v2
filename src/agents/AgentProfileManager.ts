/**
 * AgentProfileManager - CRUD and persistence for agent profiles.
 *
 * Profiles are stored in VS Code ExtensionContext globalState under the key
 * "agentProfiles". On first load, built-in defaults are created.
 */
import * as vscode from "vscode";
import type { AgentProfile, AgentType } from "../core/agents/types";
import {
  createDefaultProfile,
  getBuiltInProfiles,
} from "../core/agents/types";
import { expandTilde } from "../core/utils";

const PROFILES_KEY = "agentProfiles";

export class AgentProfileManager {
  private profiles: AgentProfile[] = [];
  private loaded = false;

  private readonly _onDidChange = new vscode.EventEmitter<AgentProfile[]>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private globalState: vscode.Memento) {}

  // ---------------------------------------------------------------------------
  // Load / Save
  // ---------------------------------------------------------------------------

  async load(): Promise<AgentProfile[]> {
    const stored = this.globalState.get<AgentProfile[]>(PROFILES_KEY);

    if (stored && Array.isArray(stored) && stored.length > 0) {
      this.profiles = stored;
    } else {
      this.profiles = getBuiltInProfiles();
      await this.save();
    }

    await this.migrateGlobalSettings();

    this.loaded = true;
    return this.getProfiles();
  }

  private async save(): Promise<void> {
    await this.globalState.update(PROFILES_KEY, this.profiles);
    this._onDidChange.fire(this.getProfiles());
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  getProfiles(): AgentProfile[] {
    return [...this.profiles].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  getProfile(id: string): AgentProfile | undefined {
    return this.profiles.find((p) => p.id === id);
  }

  getProfilesByType(agentType: AgentType): AgentProfile[] {
    return this.getProfiles().filter((p) => p.agentType === agentType);
  }

  getButtonProfiles(): AgentProfile[] {
    return this.getProfiles().filter((p) => p.button.enabled);
  }

  async addProfile(profile: AgentProfile): Promise<void> {
    this.profiles.push(profile);
    await this.save();
  }

  async updateProfile(id: string, updates: Partial<AgentProfile>): Promise<void> {
    const index = this.profiles.findIndex((p) => p.id === id);
    if (index === -1) return;
    this.profiles[index] = { ...this.profiles[index], ...updates, id };
    await this.save();
  }

  async deleteProfile(id: string): Promise<void> {
    this.profiles = this.profiles.filter((p) => p.id !== id);
    await this.save();
  }

  async reorderProfiles(orderedIds: string[]): Promise<void> {
    for (let i = 0; i < orderedIds.length; i++) {
      const profile = this.profiles.find((p) => p.id === orderedIds[i]);
      if (profile) {
        profile.sortOrder = i;
      }
    }
    await this.save();
  }

  // ---------------------------------------------------------------------------
  // Import / Export
  // ---------------------------------------------------------------------------

  exportProfiles(): string {
    return JSON.stringify(this.getProfiles(), null, 2);
  }

  async importProfiles(json: string): Promise<{ imported: number; errors: string[] }> {
    const errors: string[] = [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { imported: 0, errors: ["Invalid JSON"] };
    }

    if (!Array.isArray(parsed)) {
      return { imported: 0, errors: ["Expected a JSON array of profiles"] };
    }

    const maxOrder = this.profiles.reduce((max, p) => Math.max(max, p.sortOrder), -1);
    let importCount = 0;

    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i];
      if (!item || typeof item !== "object" || !item.name || !item.agentType) {
        errors.push(`Item ${i}: missing required fields (name, agentType)`);
        continue;
      }
      const profile = createDefaultProfile({
        ...item,
        id: crypto.randomUUID(),
        sortOrder: maxOrder + 1 + importCount,
      });
      this.profiles.push(profile);
      importCount++;
    }

    if (importCount > 0) {
      await this.save();
    }
    return { imported: importCount, errors };
  }

  // ---------------------------------------------------------------------------
  // Resolve profile settings to launch parameters
  // ---------------------------------------------------------------------------

  resolveCommand(profile: AgentProfile): string {
    if (profile.command.trim()) {
      return profile.command.trim();
    }
    switch (profile.agentType) {
      case "claude":
        return "claude";
      case "copilot":
        return "copilot";
      case "strands":
        return "strands";
      case "shell": {
        const config = vscode.workspace.getConfiguration("workTerminal");
        return config.get<string>("defaultShell", process.env.SHELL || "/bin/zsh");
      }
    }
  }

  resolveCwd(profile: AgentProfile): string {
    if (profile.defaultCwd.trim()) {
      return expandTilde(profile.defaultCwd.trim());
    }
    const config = vscode.workspace.getConfiguration("workTerminal");
    return expandTilde(config.get<string>("defaultTerminalCwd", "~"));
  }

  resolveArguments(profile: AgentProfile): string {
    return profile.arguments.trim();
  }

  resolveContextPrompt(profile: AgentProfile): string {
    if (profile.contextPrompt.trim()) {
      return profile.contextPrompt.trim();
    }
    const config = vscode.workspace.getConfiguration("workTerminal");
    return config.get<string>("additionalAgentContext", "");
  }

  // ---------------------------------------------------------------------------
  // One-time migration from deprecated global settings to profiles
  // ---------------------------------------------------------------------------

  private static MIGRATED_KEY = "agentProfiles.migratedGlobalSettings";

  private async migrateGlobalSettings(): Promise<void> {
    if (this.globalState.get<boolean>(AgentProfileManager.MIGRATED_KEY)) {
      return;
    }

    const config = vscode.workspace.getConfiguration("workTerminal");
    let migrated = false;

    const claudeCmd = config.get<string>("claudeCommand", "claude");
    const claudeArgs = config.get<string>("claudeExtraArgs", "");
    const copilotCmd = config.get<string>("copilotCommand", "copilot");
    const copilotArgs = config.get<string>("copilotExtraArgs", "");
    const strandsCmd = config.get<string>("strandsCommand", "");
    const strandsArgs = config.get<string>("strandsExtraArgs", "");

    const hasClaudeOverrides =
      (claudeCmd && claudeCmd !== "claude") || (claudeArgs && claudeArgs.trim() !== "");
    const hasCopilotOverrides =
      (copilotCmd && copilotCmd !== "copilot") || (copilotArgs && copilotArgs.trim() !== "");
    const hasStrandsOverrides =
      (strandsCmd && strandsCmd.trim() !== "") || (strandsArgs && strandsArgs.trim() !== "");

    if (hasClaudeOverrides) {
      for (const p of this.profiles) {
        if (p.agentType === "claude") {
          if (claudeCmd && claudeCmd !== "claude" && !p.command.trim()) {
            p.command = claudeCmd;
          }
          if (claudeArgs && claudeArgs.trim() && !p.arguments.trim()) {
            p.arguments = claudeArgs.trim();
          }
        }
      }
      migrated = true;
    }

    if (hasCopilotOverrides) {
      for (const p of this.profiles) {
        if (p.agentType === "copilot") {
          if (copilotCmd && copilotCmd !== "copilot" && !p.command.trim()) {
            p.command = copilotCmd;
          }
          if (copilotArgs && copilotArgs.trim() && !p.arguments.trim()) {
            p.arguments = copilotArgs.trim();
          }
        }
      }
      migrated = true;
    }

    if (hasStrandsOverrides) {
      for (const p of this.profiles) {
        if (p.agentType === "strands") {
          if (strandsCmd && strandsCmd.trim() && !p.command.trim()) {
            p.command = strandsCmd.trim();
          }
          if (strandsArgs && strandsArgs.trim() && !p.arguments.trim()) {
            p.arguments = strandsArgs.trim();
          }
        }
      }
      migrated = true;
    }

    if (migrated) {
      await this.save();
      console.log("[work-terminal] Migrated global agent settings to profiles");
    }

    await this.globalState.update(AgentProfileManager.MIGRATED_KEY, true);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
