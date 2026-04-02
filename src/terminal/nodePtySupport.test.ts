import { describe, expect, it } from "vitest";
import {
  createNodePtyRebuildPlan,
  formatNodePtyRebuildFailure,
  formatNodePtyLoadWarning,
  getNodePtyRebuildUnsupportedReason,
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

describe("getNodePtyRebuildUnsupportedReason", () => {
  it("explains packaged installs are unsupported", () => {
    expect(
      getNodePtyRebuildUnsupportedReason({
        isDevelopmentMode: false,
        hasNodePtyDependency: true,
        pnpmAvailable: true,
      }),
    ).toContain("Packaged installs");
  });

  it("requires node-pty to be installed locally", () => {
    expect(
      getNodePtyRebuildUnsupportedReason({
        isDevelopmentMode: true,
        hasNodePtyDependency: false,
        pnpmAvailable: true,
      }),
    ).toContain("node_modules/node-pty");
  });

  it("requires pnpm on PATH", () => {
    expect(
      getNodePtyRebuildUnsupportedReason({
        isDevelopmentMode: true,
        hasNodePtyDependency: true,
        pnpmAvailable: false,
      }),
    ).toContain("pnpm is not available");
  });

  it("allows supported local development checkouts", () => {
    expect(
      getNodePtyRebuildUnsupportedReason({
        isDevelopmentMode: true,
        hasNodePtyDependency: true,
        pnpmAvailable: true,
      }),
    ).toBeNull();
  });
});

describe("formatNodePtyRebuildFailure", () => {
  it("includes the failure reason plus both stderr and stdout", () => {
    const message = formatNodePtyRebuildFailure(1, null, "stdout detail", "stderr detail");

    expect(message).toContain("exit code 1");
    expect(message).toContain("stderr:\nstderr detail");
    expect(message).toContain("stdout:\nstdout detail");
  });

  it("reports signal-based termination clearly", () => {
    const message = formatNodePtyRebuildFailure(null, "SIGTERM", "", "");

    expect(message).toBe("node-pty rebuild failed due to signal SIGTERM.");
  });
});
