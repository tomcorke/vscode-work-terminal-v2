import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => ({
  Uri: {
    file: (path: string) => ({ fsPath: path, scheme: "file", path }),
  },
  workspace: {
    fs: {
      readDirectory: vi.fn().mockResolvedValue([]),
      readFile: vi.fn().mockResolvedValue(new Uint8Array()),
      writeFile: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockRejectedValue(new Error("Not found")),
      createDirectory: vi.fn().mockResolvedValue(undefined),
    },
  },
  FileType: { File: 1, Directory: 2 },
}));

import { TaskParser } from "./TaskParser";

const defaultSettings = {
  "adapter.taskBasePath": "2 - Areas/Tasks",
  "adapter.jiraBaseUrl": "https://example.atlassian.net/browse",
};

function makeFullFrontmatter(overrides: Record<string, string> = {}): string {
  const defaults: Record<string, string> = {
    id: "test-uuid",
    state: "active",
    title: "Test Task",
    tags: "task,task/active",
    type: "prompt",
    score: "50",
    deadline: "",
    impact: "medium",
    "has-blocker": "false",
    "blocker-context": "",
    "agent-actionable": "false",
    goal: "improve-perf",
    created: "2026-03-27T00:00:00Z",
    updated: "2026-03-27T12:00:00Z",
    ...overrides,
  };

  const lines = Object.entries(defaults)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\nBody`;
}

describe("TaskParser", () => {
  describe("parseFromContent", () => {
    it("extracts all fields from valid frontmatter", () => {
      const content = makeFullFrontmatter();
      const parser = new TaskParser("2 - Areas/Tasks", defaultSettings);
      const item = parser.parseFromContent(
        "2 - Areas/Tasks/active/task.md",
        "task.md",
        "task",
        content,
      );

      expect(item).not.toBeNull();
      expect(item!.id).toBe("test-uuid");
      expect(item!.title).toBe("Test Task");
      expect(item!.state).toBe("active");
    });

    it("returns null for file outside task folders", () => {
      const content = makeFullFrontmatter({ state: "unknown" });
      const parser = new TaskParser("2 - Areas/Tasks", defaultSettings);
      const item = parser.parseFromContent(
        "3 - Resources/notes.md",
        "notes.md",
        "notes",
        content,
      );

      expect(item).toBeNull();
    });

    it("falls back to path-derived state when frontmatter state is invalid", () => {
      const content = makeFullFrontmatter({ state: "invalid" });
      const parser = new TaskParser("2 - Areas/Tasks", defaultSettings);
      const item = parser.parseFromContent(
        "2 - Areas/Tasks/active/task.md",
        "task.md",
        "task",
        content,
      );

      expect(item).not.toBeNull();
      expect(item!.state).toBe("active");
    });

    it("falls back to folder state when taskBasePath has a trailing slash", () => {
      const content = makeFullFrontmatter({ state: "invalid" });
      const parser = new TaskParser("2 - Areas/Tasks/", {
        "adapter.taskBasePath": "2 - Areas/Tasks/",
      });
      const item = parser.parseFromContent(
        "2 - Areas/Tasks/active/task.md",
        "task.md",
        "task",
        content,
      );

      expect(item).not.toBeNull();
      expect(item!.state).toBe("active");
    });

    it("uses basename when title is missing", () => {
      const content = "---\nstate: active\n---\nBody";
      const parser = new TaskParser("2 - Areas/Tasks", defaultSettings);
      const item = parser.parseFromContent(
        "2 - Areas/Tasks/active/my-task.md",
        "my-task.md",
        "my-task",
        content,
      );

      expect(item!.title).toBe("my-task");
    });

    it("uses file path as the ID when frontmatter id is missing", () => {
      const content = makeFullFrontmatter({ id: "" });
      const parser = new TaskParser("2 - Areas/Tasks", defaultSettings);
      const item = parser.parseFromContent(
        "2 - Areas/Tasks/active/task-without-id.md",
        "task-without-id.md",
        "task-without-id",
        content,
      );

      expect(item).not.toBeNull();
      expect(item!.id).toBe("2 - Areas/Tasks/active/task-without-id.md");
    });

    it("defaults priority.score to 0 when missing", () => {
      const content = "---\nstate: active\ntitle: Test\n---\nBody";
      const parser = new TaskParser("2 - Areas/Tasks", defaultSettings);
      const item = parser.parseFromContent(
        "2 - Areas/Tasks/active/task.md",
        "task.md",
        "task",
        content,
      );

      expect((item!.metadata as Record<string, unknown>).priority).toMatchObject({ score: 0 });
    });
  });

  describe("parse (FileRef fallback)", () => {
    it("returns fallback task from path for files in task folders", () => {
      const parser = new TaskParser("2 - Areas/Tasks", defaultSettings);
      const item = parser.parse({
        uri: "file:///2%20-%20Areas/Tasks/active/task.md",
        path: "2 - Areas/Tasks/active/task.md",
        basename: "task",
      });

      expect(item).not.toBeNull();
      expect(item!.state).toBe("active");
      expect(item!.title).toBe("task");
    });

    it("returns null for files outside task folders", () => {
      const parser = new TaskParser("2 - Areas/Tasks", defaultSettings);
      const item = parser.parse({
        uri: "file:///other/file.md",
        path: "other/file.md",
        basename: "file",
      });

      expect(item).toBeNull();
    });
  });

  describe("groupByColumn", () => {
    it("excludes abandoned tasks", () => {
      const parser = new TaskParser("2 - Areas/Tasks", defaultSettings);
      const items = [
        {
          id: "1",
          path: "a",
          title: "A",
          state: "active",
          metadata: { priority: { score: 0 }, updated: "" },
        },
        {
          id: "2",
          path: "b",
          title: "B",
          state: "abandoned",
          metadata: { priority: { score: 0 }, updated: "" },
        },
      ];
      const groups = parser.groupByColumn(items);
      expect(groups["active"].length).toBe(1);
      expect(groups["priority"].length).toBe(0);
      expect(groups["todo"].length).toBe(0);
      expect(groups["done"].length).toBe(0);
    });

    it("sorts by score descending", () => {
      const parser = new TaskParser("2 - Areas/Tasks", defaultSettings);
      const items = [
        {
          id: "1",
          path: "a",
          title: "Low",
          state: "active",
          metadata: { priority: { score: 20 }, updated: "" },
        },
        {
          id: "2",
          path: "b",
          title: "High",
          state: "active",
          metadata: { priority: { score: 80 }, updated: "" },
        },
      ];
      const groups = parser.groupByColumn(items);
      expect(groups["active"][0].title).toBe("High");
      expect(groups["active"][1].title).toBe("Low");
    });

    it("uses updated timestamp as tiebreaker", () => {
      const parser = new TaskParser("2 - Areas/Tasks", defaultSettings);
      const items = [
        {
          id: "1",
          path: "a",
          title: "Old",
          state: "todo",
          metadata: { priority: { score: 50 }, updated: "2026-03-01" },
        },
        {
          id: "2",
          path: "b",
          title: "New",
          state: "todo",
          metadata: { priority: { score: 50 }, updated: "2026-03-27" },
        },
      ];
      const groups = parser.groupByColumn(items);
      expect(groups["todo"][0].title).toBe("New");
    });
  });

  describe("backfillItemId", () => {
    it("returns the item unchanged when ID is not path-based", async () => {
      const parser = new TaskParser("2 - Areas/Tasks", defaultSettings);
      const item = {
        id: "existing-uuid",
        path: "2 - Areas/Tasks/active/task.md",
        title: "Test",
        state: "active",
        metadata: {},
      };
      const result = await parser.backfillItemId(item);
      expect(result).toEqual(item);
    });

    it("writes a UUID to frontmatter and returns updated item", async () => {
      const vscode = await import("vscode");
      const content = "---\ntitle: Test\nstate: active\n---\nBody";
      const readFile = vi.mocked(vscode.workspace.fs.readFile);
      const writeFile = vi.mocked(vscode.workspace.fs.writeFile);
      readFile.mockResolvedValueOnce(new TextEncoder().encode(content));
      writeFile.mockResolvedValueOnce(undefined);

      const parser = new TaskParser("2 - Areas/Tasks", defaultSettings);
      const filePath = "2 - Areas/Tasks/active/task.md";
      const item = {
        id: filePath,
        path: filePath,
        title: "Test",
        state: "active",
        metadata: {},
      };
      const result = await parser.backfillItemId(item);

      expect(result).not.toBeNull();
      expect(result!.id).not.toBe(filePath);
      expect(result!.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(writeFile).toHaveBeenCalled();
    });

    it("uses existing frontmatter ID if one appeared since last parse", async () => {
      const vscode = await import("vscode");
      const content = "---\nid: pre-existing-uuid\ntitle: Test\nstate: active\n---\nBody";
      const readFile = vi.mocked(vscode.workspace.fs.readFile);
      readFile.mockResolvedValueOnce(new TextEncoder().encode(content));

      const parser = new TaskParser("2 - Areas/Tasks", defaultSettings);
      const filePath = "2 - Areas/Tasks/active/task.md";
      const item = {
        id: filePath,
        path: filePath,
        title: "Test",
        state: "active",
        metadata: {},
      };
      const result = await parser.backfillItemId(item);

      expect(result).not.toBeNull();
      expect(result!.id).toBe("pre-existing-uuid");
    });

    it("deduplicates concurrent backfill calls for the same item", async () => {
      const vscode = await import("vscode");
      const content = "---\ntitle: Test\nstate: active\n---\nBody";
      const readFile = vi.mocked(vscode.workspace.fs.readFile);
      const writeFile = vi.mocked(vscode.workspace.fs.writeFile);

      readFile.mockClear();
      writeFile.mockClear();

      let resolveRead!: (value: Uint8Array) => void;
      readFile.mockImplementationOnce(
        () => new Promise<Uint8Array>((resolve) => { resolveRead = resolve; }),
      );
      writeFile.mockResolvedValueOnce(undefined);

      const parser = new TaskParser("2 - Areas/Tasks", defaultSettings);
      const filePath = "2 - Areas/Tasks/active/task.md";
      const item = {
        id: filePath,
        path: filePath,
        title: "Test",
        state: "active",
        metadata: {},
      };

      const p1 = parser.backfillItemId(item);
      const p2 = parser.backfillItemId(item);

      resolveRead(new TextEncoder().encode(content));

      const [result1, result2] = await Promise.all([p1, p2]);

      expect(result1!.id).toBe(result2!.id);
      expect(readFile).toHaveBeenCalledTimes(1);
    });
  });

  describe("isItemFile", () => {
    it("matches files under basePath", () => {
      const parser = new TaskParser("2 - Areas/Tasks", defaultSettings);
      expect(parser.isItemFile("2 - Areas/Tasks/active/my-task.md")).toBe(true);
    });

    it("rejects files outside basePath", () => {
      const parser = new TaskParser("2 - Areas/Tasks", defaultSettings);
      expect(parser.isItemFile("3 - Resources/notes.md")).toBe(false);
    });

    it("rejects non-md files", () => {
      const parser = new TaskParser("2 - Areas/Tasks", defaultSettings);
      expect(parser.isItemFile("2 - Areas/Tasks/active/data.json")).toBe(false);
    });
  });
});
