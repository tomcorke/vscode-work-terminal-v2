import { describe, expect, it } from "vitest";
import {
  createNodePtyRebuildPlan,
  formatNodePtyLoadWarning,
  type NativePtyStatus,
} from "./nodePtySupport";

describe("createNodePtyRebuildPlan", () => {
  it("builds a pnpm rebuild plan targeting VS Code Electron", () => {
    const plan = createNodePtyRebuildPlan("35.1.0");

    expect(plan.args).toEqual(["rebuild", "node-pty"]);
    expect(plan.env).toEqual({
      npm_config_runtime: "electron",
      npm_config_target: "35.1.0",
      npm_config_disturl: "https://electronjs.org/headers",
    });
  });

  it("fails clearly when Electron is unavailable", () => {
    expect(() => createNodePtyRebuildPlan("")).toThrow(
      "VS Code Electron version is unavailable in this process.",
    );
  });
});

describe("formatNodePtyLoadWarning", () => {
  it("includes the Electron version and load error", () => {
    const status: NativePtyStatus = {
      available: false,
      modulePath: null,
      electronVersion: "35.1.0",
      loadError: "Cannot find module ../build/Debug/pty.node",
    };

    const message = formatNodePtyLoadWarning(status);
    expect(message).toContain("VS Code Electron 35.1.0");
    expect(message).toContain("Cannot find module ../build/Debug/pty.node");
  });
});
