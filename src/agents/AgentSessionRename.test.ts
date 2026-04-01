import { describe, it, expect } from "vitest";
import { AgentSessionRename } from "./AgentSessionRename";

describe("AgentSessionRename", () => {
  it("detects rename from a complete line", () => {
    const rename = new AgentSessionRename();
    const result = rename.processChunk("Session renamed to: my-task\n");
    expect(result).toBe("my-task");
  });

  it("returns null when no rename pattern is present", () => {
    const rename = new AgentSessionRename();
    const result = rename.processChunk("Some normal output\n");
    expect(result).toBeNull();
  });

  it("handles leading whitespace and non-word chars before pattern", () => {
    const rename = new AgentSessionRename();
    const result = rename.processChunk("  > Session renamed to: fix-bug-123\n");
    expect(result).toBe("fix-bug-123");
  });

  it("buffers partial lines across chunks", () => {
    const rename = new AgentSessionRename();
    expect(rename.processChunk("Session renam")).toBeNull();
    const result = rename.processChunk("ed to: buffered-label\n");
    expect(result).toBe("buffered-label");
  });

  it("handles \\r\\n line endings", () => {
    const rename = new AgentSessionRename();
    const result = rename.processChunk("Session renamed to: crlf-label\r\n");
    expect(result).toBe("crlf-label");
  });

  it("handles bare \\r line endings", () => {
    const rename = new AgentSessionRename();
    const result = rename.processChunk("Session renamed to: cr-label\r");
    expect(result).toBe("cr-label");
  });

  it("strips ANSI escape codes before matching", () => {
    const rename = new AgentSessionRename();
    const result = rename.processChunk(
      "\x1b[1mSession renamed to: \x1b[32mstyled-label\x1b[0m\n",
    );
    expect(result).toBe("styled-label");
  });

  it("uses the last rename when multiple appear in one chunk", () => {
    const rename = new AgentSessionRename();
    const result = rename.processChunk(
      "Session renamed to: first\nSession renamed to: second\n",
    );
    expect(result).toBe("second");
  });

  it("trims whitespace from detected label", () => {
    const rename = new AgentSessionRename();
    const result = rename.processChunk("Session renamed to:   padded-label   \n");
    expect(result).toBe("padded-label");
  });

  it("handles split UTF-8 multibyte characters via Buffer", () => {
    const rename = new AgentSessionRename();
    // "Session renamed to: cafe\u00e9\n" in UTF-8 - split the e-acute across chunks
    const full = Buffer.from("Session renamed to: caf\u00e9\n", "utf8");
    // Split at a byte boundary inside the 2-byte e-acute
    const splitPoint = full.indexOf(0xc3); // first byte of e-acute
    const chunk1 = full.subarray(0, splitPoint + 1); // includes first byte of e-acute
    const chunk2 = full.subarray(splitPoint + 1); // second byte + newline

    // StringDecoder buffers the incomplete byte, so chunk1 decodes to
    // "Session renamed to: caf" which matches the incomplete-line check
    expect(rename.processChunk(chunk1)).toBe("caf");
    // chunk2 completes the character and newline; the full line matches
    const result = rename.processChunk(chunk2);
    expect(result).toBe("caf\u00e9");
  });

  it("detects rename from incomplete line buffer (no trailing newline)", () => {
    const rename = new AgentSessionRename();
    const result = rename.processChunk("Session renamed to: no-newline");
    expect(result).toBe("no-newline");
  });

  it("reset clears internal state", () => {
    const rename = new AgentSessionRename();
    rename.processChunk("Session renam");
    rename.reset();
    // After reset, the partial buffer is gone
    const result = rename.processChunk("ed to: after-reset\n");
    expect(result).toBeNull();
  });
});
