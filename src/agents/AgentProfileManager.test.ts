import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProfile } from "../core/agents/types";

const { getConfigurationMock } = vi.hoisted(() => ({
  getConfigurationMock: vi.fn(),
}));

vi.mock("vscode", () => {
  class EventEmitter<T> {
    public event = vi.fn();
    public fire = vi.fn();
    public dispose = vi.fn();
  }

  return {
    EventEmitter,
    workspace: {
      getConfiguration: getConfigurationMock,
    },
  };
});

import { AgentProfileManager } from "./AgentProfileManager";
import { createDefaultProfile } from "../core/agents/types";

class FakeMemento {
  private store = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
}

function createConfig(values: Record<string, string>) {
  return {
    get<T>(key: string, defaultValue?: T): T {
      return (values[key] as T | undefined) ?? (defaultValue as T);
    },
  };
}

function createCopilotProfile(overrides?: Partial<AgentProfile>): AgentProfile {
  return createDefaultProfile({
    id: "copilot-profile",
    name: "Copilot",
    agentType: "copilot",
    sortOrder: 0,
    ...overrides,
  });
}

describe("AgentProfileManager copilot defaults", () => {
  beforeEach(() => {
    getConfigurationMock.mockReset();
  });

  it("defaults copilot profiles to the copilot executable", () => {
    const manager = new AgentProfileManager(new FakeMemento() as never);

    expect(manager.resolveCommand(createCopilotProfile())).toBe("copilot");
  });

  it("migrates an explicit copilotCommand override into copilot profiles", async () => {
    getConfigurationMock.mockReturnValue(
      createConfig({
        claudeCommand: "claude",
        claudeExtraArgs: "",
        copilotCommand: "gh",
        copilotExtraArgs: "--model gpt-5",
        strandsCommand: "",
        strandsExtraArgs: "",
      }),
    );

    const globalState = new FakeMemento();
    await globalState.update("agentProfiles", [createCopilotProfile()]);

    const manager = new AgentProfileManager(globalState as never);
    const profiles = await manager.load();
    const copilotProfile = profiles.find((profile) => profile.id === "copilot-profile");

    expect(copilotProfile?.command).toBe("gh");
    expect(copilotProfile?.arguments).toBe("--model gpt-5");
  });
});
