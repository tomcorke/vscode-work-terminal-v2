import { describe, it, expect, vi, afterEach } from "vitest";
import { formatTimeAgo, formatSessionType } from "./AgentLaunchModal";

describe("formatTimeAgo", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 'just now' for timestamps less than 60 seconds ago", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000_000);
    expect(formatTimeAgo(1000_000)).toBe("just now");
    expect(formatTimeAgo(1000_000 - 30_000)).toBe("just now");
    expect(formatTimeAgo(1000_000 - 59_000)).toBe("just now");
  });

  it("returns '{n}m ago' for timestamps 1-59 minutes ago", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000_000);
    expect(formatTimeAgo(1000_000 - 60_000)).toBe("1m ago");
    expect(formatTimeAgo(1000_000 - 5 * 60_000)).toBe("5m ago");
    expect(formatTimeAgo(1000_000 - 59 * 60_000)).toBe("59m ago");
  });

  it("returns '{n}h ago' for timestamps 60+ minutes ago", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000_000);
    expect(formatTimeAgo(1000_000 - 60 * 60_000)).toBe("1h ago");
    expect(formatTimeAgo(1000_000 - 3 * 60 * 60_000)).toBe("3h ago");
  });
});

describe("formatSessionType", () => {
  it("formats known session types to friendly labels", () => {
    expect(formatSessionType("shell")).toBe("Shell");
    expect(formatSessionType("claude")).toBe("Claude");
    expect(formatSessionType("claude-with-context")).toBe("Claude (context)");
    expect(formatSessionType("copilot")).toBe("Copilot");
    expect(formatSessionType("copilot-with-context")).toBe("Copilot (context)");
    expect(formatSessionType("strands")).toBe("Strands");
    expect(formatSessionType("strands-with-context")).toBe("Strands (context)");
  });

  it("returns the raw value for unknown session types", () => {
    expect(formatSessionType("custom-agent")).toBe("custom-agent");
  });
});
