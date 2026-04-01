import { describe, it, expect } from "vitest";
import { extractFrontmatterString, extractFrontmatter, updateFrontmatterField } from "./frontmatter";

const sampleDoc = `---
title: My Document
state: active
tags: "work, project"
---

# Content here
`;

describe("extractFrontmatterString", () => {
  it("extracts a simple string value", () => {
    expect(extractFrontmatterString(sampleDoc, "title")).toBe("My Document");
  });

  it("extracts quoted values without quotes", () => {
    expect(extractFrontmatterString(sampleDoc, "tags")).toBe("work, project");
  });

  it("returns null for missing key", () => {
    expect(extractFrontmatterString(sampleDoc, "missing")).toBeNull();
  });

  it("returns null when no frontmatter", () => {
    expect(extractFrontmatterString("# Just markdown", "title")).toBeNull();
  });

  it("returns null for empty value", () => {
    const doc = "---\nempty:\n---\n";
    expect(extractFrontmatterString(doc, "empty")).toBeNull();
  });
});

describe("extractFrontmatter", () => {
  it("extracts all key-value pairs", () => {
    const result = extractFrontmatter(sampleDoc);
    expect(result).toEqual({
      title: "My Document",
      state: "active",
      tags: "work, project",
    });
  });

  it("returns null when no frontmatter", () => {
    expect(extractFrontmatter("no frontmatter")).toBeNull();
  });
});

describe("updateFrontmatterField", () => {
  it("updates an existing field", () => {
    const result = updateFrontmatterField(sampleDoc, "state", "done");
    expect(extractFrontmatterString(result, "state")).toBe("done");
    expect(extractFrontmatterString(result, "title")).toBe("My Document");
  });

  it("appends a new field", () => {
    const result = updateFrontmatterField(sampleDoc, "priority", "high");
    expect(extractFrontmatterString(result, "priority")).toBe("high");
    expect(extractFrontmatterString(result, "title")).toBe("My Document");
  });

  it("creates frontmatter when none exists", () => {
    const result = updateFrontmatterField("# Hello", "state", "active");
    expect(result).toMatch(/^---\nstate: active\n---\n# Hello/);
  });
});
