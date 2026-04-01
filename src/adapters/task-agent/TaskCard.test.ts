import { describe, expect, it, vi } from "vitest";
import type { CardActionContext, WorkItem } from "../../core/interfaces";

const mockWriteText = vi.fn().mockResolvedValue(undefined);

vi.mock("vscode", () => ({
  env: {
    clipboard: {
      writeText: (...args: unknown[]) => mockWriteText(...args),
    },
  },
}));

import { TaskCard } from "./TaskCard";

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "task-1",
    path: "2 - Areas/Tasks/priority/task.md",
    title: "Fix context prompt",
    state: "priority",
    metadata: {},
    ...overrides,
  };
}

function makeContext(overrides: Partial<CardActionContext> = {}): CardActionContext {
  return {
    onSelect: vi.fn(),
    onMoveToTop: vi.fn(),
    onMoveToColumn: vi.fn(),
    onInsertAfter: vi.fn(),
    onSplitTask: vi.fn(),
    onDelete: vi.fn(),
    onCloseSessions: vi.fn(),
    getContextPrompt: vi.fn().mockResolvedValue("Task: Fix context prompt\nState: priority"),
    ...overrides,
  };
}

describe("TaskCard", () => {
  describe("render", () => {
    it("includes title in HTML output", () => {
      const item = makeItem();
      const ctx = makeContext();
      const card = new TaskCard();

      const result = card.render(item, ctx);
      expect(result.html).toContain("Fix context prompt");
    });

    it("includes Jira badge with key when source is jira", () => {
      const item = makeItem({
        metadata: {
          source: { type: "jira", id: "PROJ-123", url: "", captured: "" },
        },
      });
      const ctx = makeContext();
      const card = new TaskCard();

      const result = card.render(item, ctx);
      expect(result.html).toContain("PROJ-123");
      expect(result.html).toContain("wt-card-source--jira");
    });

    it("does not include jira class for non-jira sources", () => {
      const item = makeItem({
        metadata: {
          source: { type: "slack", id: "", url: "", captured: "" },
        },
      });
      const ctx = makeContext();
      const card = new TaskCard();

      const result = card.render(item, ctx);
      expect(result.html).toContain("SLK");
      expect(result.html).not.toContain("wt-card-source--jira");
    });

    it("includes priority score badge", () => {
      const item = makeItem({
        metadata: { priority: { score: 75 } },
      });
      const ctx = makeContext();
      const card = new TaskCard();

      const result = card.render(item, ctx);
      expect(result.html).toContain("75");
      expect(result.html).toContain("score-high");
    });

    it("includes goal badges", () => {
      const item = makeItem({
        metadata: { goal: ["ship-feature"] },
      });
      const ctx = makeContext();
      const card = new TaskCard();

      const result = card.render(item, ctx);
      expect(result.html).toContain("ship feature");
    });

    it("strips wiki link brackets from goal badges", () => {
      const item = makeItem({
        metadata: { goal: ["[[Ship Feature]]"] },
      });
      const ctx = makeContext();
      const card = new TaskCard();

      const result = card.render(item, ctx);
      expect(result.html).toContain("Ship Feature");
      expect(result.html).not.toContain("[[");
    });

    it("uses wiki link alias text when present", () => {
      const item = makeItem({
        metadata: { goal: ["[[Ship Feature|Readable Goal]]"] },
      });
      const ctx = makeContext();
      const card = new TaskCard();

      const result = card.render(item, ctx);
      expect(result.html).toContain("Readable Goal");
    });

    it("includes blocker indicator", () => {
      const item = makeItem({
        metadata: {
          priority: {
            "has-blocker": true,
            "blocker-context": "Waiting on API",
          },
        },
      });
      const ctx = makeContext();
      const card = new TaskCard();

      const result = card.render(item, ctx);
      expect(result.html).toContain("BLOCKED");
      expect(result.html).toContain("Waiting on API");
    });

    it("applies task color via CSS variable", () => {
      const item = makeItem({ metadata: { color: "#ff0000" } });
      const ctx = makeContext();
      const card = new TaskCard();

      const result = card.render(item, ctx);
      expect(result.html).toContain("--wt-task-color:#ff0000");
    });

    it("does not include color wrapper when no color is set", () => {
      const item = makeItem({ metadata: {} });
      const ctx = makeContext();
      const card = new TaskCard();

      const result = card.render(item, ctx);
      expect(result.html).not.toContain("--wt-task-color");
    });
  });

  describe("getContextMenuItems", () => {
    it("includes move to column options", () => {
      const item = makeItem();
      const ctx = makeContext();
      const card = new TaskCard();

      const menuItems = card.getContextMenuItems(item, ctx);
      const labels = menuItems.map((mi) => mi.label);

      expect(labels).toContain("Move to Active");
      expect(labels).toContain("Move to To Do");
      expect(labels).toContain("Move to Done");
      // Should not include current column
      expect(labels).not.toContain("Move to Priority");
    });

    it("includes split task option", () => {
      const item = makeItem();
      const ctx = makeContext();
      const card = new TaskCard();

      const menuItems = card.getContextMenuItems(item, ctx);
      const labels = menuItems.map((mi) => mi.label);
      expect(labels).toContain("Split Task");
    });

    it("includes delete option", () => {
      const item = makeItem();
      const ctx = makeContext();
      const card = new TaskCard();

      const menuItems = card.getContextMenuItems(item, ctx);
      const labels = menuItems.map((mi) => mi.label);
      expect(labels).toContain("Delete Task");
    });

    it("includes copy context prompt option", () => {
      const item = makeItem();
      const ctx = makeContext();
      const card = new TaskCard();

      const menuItems = card.getContextMenuItems(item, ctx);
      const labels = menuItems.map((mi) => mi.label);
      expect(labels).toContain("Copy Context Prompt");
    });
  });
});
