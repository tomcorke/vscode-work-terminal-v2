import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileRef } from "../../core/types";

const SAMPLE_CONTENT = `---
id: abc-123
tags:
  - task
  - task/todo
state: todo
title: "Test Task"
priority:
  score: 50
updated: 2026-03-26T00:00:00Z
created: 2026-03-26T00:00:00Z
---
# Test Task

## Activity Log
- **2026-03-26 12:00** - Task created
`;

const encoder = new TextEncoder();

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockRename = vi.fn();
const mockCreateDirectory = vi.fn();
const mockStat = vi.fn();

vi.mock("vscode", () => ({
  Uri: {
    file: (path: string) => ({ fsPath: path, scheme: "file", path }),
  },
  workspace: {
    fs: {
      readFile: (...args: unknown[]) => mockReadFile(...args),
      writeFile: (...args: unknown[]) => mockWriteFile(...args),
      rename: (...args: unknown[]) => mockRename(...args),
      stat: (...args: unknown[]) => mockStat(...args),
      createDirectory: (...args: unknown[]) => mockCreateDirectory(...args),
    },
  },
}));

import { TaskMover } from "./TaskMover";

describe("TaskMover", () => {
  const defaultSettings = { "adapter.taskBasePath": "2 - Areas/Tasks" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockResolvedValue(encoder.encode(SAMPLE_CONTENT));
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockCreateDirectory.mockResolvedValue(undefined);
    mockStat.mockRejectedValue(new Error("Not found"));
  });

  function makeFile(path: string): FileRef {
    return {
      uri: "",
      path,
      basename: path.split("/").pop()?.replace(/\.md$/, "") || "",
    };
  }

  it("updates state field", async () => {
    const mover = new TaskMover("", defaultSettings);
    const file = makeFile("2 - Areas/Tasks/todo/task.md");

    await mover.move(file, "active");

    const content = new TextDecoder().decode(mockWriteFile.mock.calls[0][1]);
    expect(content).toMatch(/^state: active$/m);
  });

  it("updates task tag", async () => {
    const mover = new TaskMover("", defaultSettings);
    const file = makeFile("2 - Areas/Tasks/todo/task.md");

    await mover.move(file, "active");

    const content = new TextDecoder().decode(mockWriteFile.mock.calls[0][1]);
    expect(content).toMatch(/- task\/active/);
    expect(content).not.toMatch(/- task\/todo/);
  });

  it("uses timestamp without milliseconds", async () => {
    const mover = new TaskMover("", defaultSettings);
    const file = makeFile("2 - Areas/Tasks/todo/task.md");

    await mover.move(file, "active");

    const content = new TextDecoder().decode(mockWriteFile.mock.calls[0][1]);
    const match = content.match(/^updated:\s*(.+)$/m);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    expect(match![1]).not.toMatch(/\.\d{3}Z/);
  });

  it("appends activity log entry", async () => {
    const mover = new TaskMover("", defaultSettings);
    const file = makeFile("2 - Areas/Tasks/todo/task.md");

    await mover.move(file, "active");

    const content = new TextDecoder().decode(mockWriteFile.mock.calls[0][1]);
    expect(content).toMatch(/Moved to active \(via kanban board\)/);
  });

  it("inserts activity log before next section", async () => {
    const contentWithNextSection = SAMPLE_CONTENT.trimEnd() + "\n\n## Notes\nSome notes\n";
    mockReadFile.mockResolvedValue(encoder.encode(contentWithNextSection));

    const mover = new TaskMover("", defaultSettings);
    const file = makeFile("2 - Areas/Tasks/todo/task.md");

    await mover.move(file, "active");

    const content = new TextDecoder().decode(mockWriteFile.mock.calls[0][1]);
    const logIdx = content.indexOf("Moved to active");
    const notesIdx = content.indexOf("## Notes");
    expect(logIdx).toBeLessThan(notesIdx);
  });

  it("creates activity log section when missing", async () => {
    const contentNoLog = `---
id: abc-123
tags:
  - task
  - task/todo
state: todo
title: "Test Task"
updated: 2026-03-26T00:00:00Z
created: 2026-03-26T00:00:00Z
---
# Test Task
`;
    mockReadFile.mockResolvedValue(encoder.encode(contentNoLog));

    const mover = new TaskMover("", defaultSettings);
    const file = makeFile("2 - Areas/Tasks/todo/task.md");

    await mover.move(file, "active");

    const content = new TextDecoder().decode(mockWriteFile.mock.calls[0][1]);
    expect(content).toContain("## Activity Log");
    expect(content).toMatch(/Moved to active \(via kanban board\)/);
  });

  it("returns true on successful move", async () => {
    const mover = new TaskMover("", defaultSettings);
    const file = makeFile("2 - Areas/Tasks/todo/task.md");

    const result = await mover.move(file, "active");
    expect(result).toBe(true);
  });

  it("returns true when target is same column (no-op)", async () => {
    const mover = new TaskMover("", defaultSettings);
    const file = makeFile("2 - Areas/Tasks/todo/task.md");

    const result = await mover.move(file, "todo");

    expect(result).toBe(true);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("returns false for invalid target column", async () => {
    const mover = new TaskMover("", defaultSettings);
    const file = makeFile("2 - Areas/Tasks/todo/task.md");

    const result = await mover.move(file, "nonexistent");
    expect(result).toBe(false);
  });

  it("returns false when read fails", async () => {
    mockReadFile.mockRejectedValue(new Error("File not found"));

    const mover = new TaskMover("", defaultSettings);
    const file = makeFile("2 - Areas/Tasks/todo/task.md");

    const result = await mover.move(file, "active");
    expect(result).toBe(false);
  });

  it("writes content before moving file (write-then-move)", async () => {
    const callOrder: string[] = [];
    mockWriteFile.mockImplementation(() => {
      callOrder.push("write");
      return Promise.resolve();
    });
    mockRename.mockImplementation(() => {
      callOrder.push("rename");
      return Promise.resolve();
    });

    const mover = new TaskMover("", defaultSettings);
    const file = makeFile("2 - Areas/Tasks/todo/task.md");

    await mover.move(file, "active");

    expect(callOrder).toEqual(["write", "rename"]);
  });

  it("maps done column to archive folder", async () => {
    const mover = new TaskMover("", defaultSettings);
    const file = makeFile("2 - Areas/Tasks/todo/task.md");

    await mover.move(file, "done");

    expect(mockRename).toHaveBeenCalledWith(
      expect.objectContaining({ path: "2 - Areas/Tasks/todo/task.md" }),
      expect.objectContaining({ path: "2 - Areas/Tasks/archive/task.md" }),
    );
  });

  it("creates target folder if it does not exist", async () => {
    const mover = new TaskMover("", defaultSettings);
    const file = makeFile("2 - Areas/Tasks/todo/task.md");

    await mover.move(file, "active");

    expect(mockCreateDirectory).toHaveBeenCalled();
  });
});
