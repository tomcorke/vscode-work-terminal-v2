import { describe, it, expect } from "vitest";
import { expandTilde, stripAnsi, slugify, normalizeDisplayText } from "./utils";

describe("expandTilde", () => {
  it("expands ~ alone to home directory", () => {
    const result = expandTilde("~");
    expect(result).not.toBe("~");
    expect(result.length).toBeGreaterThan(0);
  });

  it("expands ~/path to home + path", () => {
    const result = expandTilde("~/Documents/file.md");
    expect(result).toMatch(/\/Documents\/file\.md$/);
    expect(result).not.toMatch(/^~/);
  });

  it("does not expand paths without leading tilde", () => {
    expect(expandTilde("/usr/local")).toBe("/usr/local");
    expect(expandTilde("relative/path")).toBe("relative/path");
  });

  it("does not expand tilde in the middle of a path", () => {
    expect(expandTilde("/home/~user")).toBe("/home/~user");
  });
});

describe("stripAnsi", () => {
  it("strips CSI color sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("replaces cursor-forward with spaces", () => {
    expect(stripAnsi("a\x1b[3Cb")).toBe("a   b");
  });

  it("strips OSC sequences (BEL terminated)", () => {
    expect(stripAnsi("\x1b]0;title\x07text")).toBe("text");
  });

  it("preserves tabs and newlines", () => {
    expect(stripAnsi("line1\n\tline2")).toBe("line1\n\tline2");
  });

  it("returns plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });
});

describe("slugify", () => {
  it("converts to lowercase kebab-case", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("strips special characters", () => {
    expect(slugify("Fix: bug #123!")).toBe("fix-bug-123");
  });

  it("truncates to 40 characters without trailing hyphen", () => {
    const long = "a".repeat(50);
    const result = slugify(long);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).not.toMatch(/-$/);
  });

  it("returns empty string for empty input", () => {
    expect(slugify("")).toBe("");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("--hello--")).toBe("hello");
  });
});

describe("normalizeDisplayText", () => {
  it("converts [[Doc]] to Doc", () => {
    expect(normalizeDisplayText("see [[MyDoc]] here")).toBe("see MyDoc here");
  });

  it("uses alias from [[Doc|Alias]]", () => {
    expect(normalizeDisplayText("[[Target|Display Name]]")).toBe("Display Name");
  });

  it("leaves plain text unchanged", () => {
    expect(normalizeDisplayText("no links here")).toBe("no links here");
  });
});
