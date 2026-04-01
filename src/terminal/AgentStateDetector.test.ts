import { describe, it, expect } from "vitest";
import {
  hasAgentWaitingIndicator,
  hasAgentActiveIndicator,
  aggregateState,
} from "./AgentStateDetector";

describe("hasAgentWaitingIndicator", () => {
  it("returns false for empty lines", () => {
    expect(hasAgentWaitingIndicator([])).toBe(false);
  });

  it("detects Allow permission prompts", () => {
    const lines = ["Some output", "Allow this tool to run?", "allowOnce"];
    expect(hasAgentWaitingIndicator(lines)).toBe(true);
  });

  it("detects allowOnce/denyOnce prompts", () => {
    const lines = ["output", "allowOnce  denyOnce  allowAlways"];
    expect(hasAgentWaitingIndicator(lines)).toBe(true);
  });

  it("detects Enter to select prompts", () => {
    const lines = ["Some items", "Enter to select, arrows to navigate"];
    expect(hasAgentWaitingIndicator(lines)).toBe(true);
  });

  it("detects numbered selection lists with chevron", () => {
    const lines = ["Choose an option:", "\u276f 1. First option"];
    expect(hasAgentWaitingIndicator(lines)).toBe(true);
  });

  it("detects bare numbered lists with preceding question", () => {
    const lines = [
      "Which file do you want?",
      "1) src/index.ts",
      "2) src/main.ts",
    ];
    expect(hasAgentWaitingIndicator(lines)).toBe(true);
  });

  it("does not detect bare numbered lists without preceding question", () => {
    const lines = [
      "Here are the results:",
      "1) src/index.ts",
      "2) src/main.ts",
    ];
    expect(hasAgentWaitingIndicator(lines)).toBe(false);
  });

  it("detects Yes/No prompts", () => {
    const lines = ["Do you want to continue?", "Yes", "No"];
    expect(hasAgentWaitingIndicator(lines)).toBe(true);
  });

  it("detects questions in the last few lines", () => {
    const lines = ["Some context", "Do you want to proceed with this change?"];
    expect(hasAgentWaitingIndicator(lines)).toBe(true);
  });

  it("ignores short questions", () => {
    const lines = ["Is it ok?"];
    expect(hasAgentWaitingIndicator(lines)).toBe(false);
  });

  it("suppresses waiting when active indicators follow", () => {
    const lines = [
      "Allow this tool to run?",
      "allowOnce",
      // Active indicator after the waiting pattern
      "\u2733 Reading file\u2026",
    ];
    expect(hasAgentWaitingIndicator(lines)).toBe(false);
  });

  it("detects hidden Claude prompt pattern", () => {
    const lines = [
      "Do you want to apply this change to the file?",
      "\u276f",
      "\u279c some-project",
    ];
    expect(hasAgentWaitingIndicator(lines)).toBe(true);
  });

  it("rejects hidden Claude prompt when chevron has text (active input)", () => {
    // When typed text appears before the empty prompt, looksLikeHiddenClaudePrompt
    // rejects it. But we need enough padding lines so the question falls outside
    // the generic question window (last 5 lines).
    const lines = [
      "Some context line",
      "Another context line",
      "More context",
      "Do you want to apply this change to the file?",
      "\u276f some typed text",
      "\u276f",
      "\u279c some-project",
      "extra line 1",
      "extra line 2",
    ];
    expect(hasAgentWaitingIndicator(lines)).toBe(false);
  });
});

describe("hasAgentActiveIndicator", () => {
  it("returns false for empty lines", () => {
    expect(hasAgentActiveIndicator([])).toBe(false);
  });

  it("detects Claude spinner with ellipsis", () => {
    const lines = ["\u2733 Reading file\u2026"];
    expect(hasAgentActiveIndicator(lines)).toBe(true);
  });

  it("detects Claude tool output with ellipsis", () => {
    const lines = ["\u23bf  Running tests\u2026"];
    expect(hasAgentActiveIndicator(lines)).toBe(true);
  });

  it("detects wrapped Claude spinner (char on one line, ellipsis on another)", () => {
    const lines = ["\u2733 Reading", "  a very long file name\u2026"];
    expect(hasAgentActiveIndicator(lines)).toBe(true);
  });

  it("detects Copilot Thinking indicator", () => {
    const lines = ["\u25c9 Thinking"];
    expect(hasAgentActiveIndicator(lines)).toBe(true);
  });

  it("detects Copilot Executing indicator", () => {
    const lines = ["\u25ce Executing"];
    expect(hasAgentActiveIndicator(lines)).toBe(true);
  });

  it("detects Copilot spinner with cancel hint", () => {
    const lines = ["\u25cb Working on it (Esc to cancel)"];
    expect(hasAgentActiveIndicator(lines)).toBe(true);
  });

  it("detects Copilot cancel hint across wrapped lines", () => {
    const lines = ["\u25cf Some status", "(Esc to cancel)"];
    expect(hasAgentActiveIndicator(lines)).toBe(true);
  });

  it("returns false for plain text", () => {
    const lines = ["Hello world", "This is just output"];
    expect(hasAgentActiveIndicator(lines)).toBe(false);
  });
});

describe("aggregateState", () => {
  it("returns inactive for empty array", () => {
    expect(aggregateState([])).toBe("inactive");
  });

  it("returns waiting if any state is waiting", () => {
    expect(aggregateState(["idle", "waiting", "active"])).toBe("waiting");
  });

  it("returns active if any state is active (no waiting)", () => {
    expect(aggregateState(["idle", "active", "inactive"])).toBe("active");
  });

  it("returns idle if any state is idle (no waiting/active)", () => {
    expect(aggregateState(["idle", "inactive"])).toBe("idle");
  });

  it("returns inactive if all inactive", () => {
    expect(aggregateState(["inactive", "inactive"])).toBe("inactive");
  });
});
