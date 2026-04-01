import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture watcher event handlers registered during construction
let onDidCreateHandler: ((uri: { fsPath: string }) => void) | null = null;
let onDidChangeHandler: ((uri: { fsPath: string }) => void) | null = null;
let onDidDeleteHandler: ((uri: { fsPath: string }) => void) | null = null;

const { mockReadFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn().mockResolvedValue(new Uint8Array()),
}));

vi.mock("vscode", () => ({
  workspace: {
    fs: {
      readFile: mockReadFile,
    },
    createFileSystemWatcher: vi.fn().mockReturnValue({
      onDidCreate: vi.fn((handler: (uri: { fsPath: string }) => void) => {
        onDidCreateHandler = handler;
        return { dispose: vi.fn() };
      }),
      onDidChange: vi.fn((handler: (uri: { fsPath: string }) => void) => {
        onDidChangeHandler = handler;
        return { dispose: vi.fn() };
      }),
      onDidDelete: vi.fn((handler: (uri: { fsPath: string }) => void) => {
        onDidDeleteHandler = handler;
        return { dispose: vi.fn() };
      }),
      dispose: vi.fn(),
    }),
  },
  RelativePattern: vi.fn().mockImplementation((base: string, pattern: string) => ({
    base,
    pattern,
  })),
}));

import { FileWatcher, type RenameEvent } from "./FileWatcher";

// Helper to build frontmatter content
function mdWithId(uuid: string): Uint8Array {
  return new TextEncoder().encode(`---\nid: ${uuid}\ntitle: Test\n---\n\nBody`);
}

function mdWithoutId(): Uint8Array {
  return new TextEncoder().encode(`---\ntitle: Test\n---\n\nBody`);
}

describe("FileWatcher rename detection", () => {
  let watcher: FileWatcher;
  let onChanged: ReturnType<typeof vi.fn>;
  let onRenamed: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    onChanged = vi.fn();
    onRenamed = vi.fn();

    // Reset handlers
    onDidCreateHandler = null;
    onDidChangeHandler = null;
    onDidDeleteHandler = null;

    mockReadFile.mockReset();
    mockReadFile.mockResolvedValue(new Uint8Array());

    watcher = new FileWatcher(
      "/base",
      () => true,
      onChanged,
      onRenamed,
    );
  });

  afterEach(() => {
    watcher.dispose();
    vi.useRealTimers();
  });

  it("buffers delete events for RENAME_BUFFER_MS before firing refresh", () => {
    onDidDeleteHandler!({ fsPath: "/base/active/test.md" });

    // Refresh should not fire immediately
    expect(onChanged).not.toHaveBeenCalled();

    // Advance past debounce but within rename buffer
    vi.advanceTimersByTime(FileWatcher.DEBOUNCE_MS + 50);
    expect(onChanged).not.toHaveBeenCalled();

    // Advance past rename buffer - now the delete fires refresh
    vi.advanceTimersByTime(FileWatcher.RENAME_BUFFER_MS);
    // The buffered delete callback fires, then scheduleRefresh debounce
    vi.advanceTimersByTime(FileWatcher.DEBOUNCE_MS + 50);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("detects rename via UUID match (delete then create with same UUID)", async () => {
    const uuid = "abc-123-def";

    // Pre-cache the UUID for the old path
    watcher.cacheUuid("/base/active/test.md", uuid);

    // Simulate the new file having the same UUID
    mockReadFile.mockResolvedValue(mdWithId(uuid));

    // Delete old path
    onDidDeleteHandler!({ fsPath: "/base/active/test.md" });

    // Create new path (within rename buffer window)
    vi.advanceTimersByTime(100);
    onDidCreateHandler!({ fsPath: "/base/todo/test.md" });

    // Flush the async readFile promise
    await vi.waitFor(() => {
      expect(onRenamed).toHaveBeenCalledTimes(1);
    });

    const event: RenameEvent = onRenamed.mock.calls[0][0];
    expect(event.oldPath).toBe("/base/active/test.md");
    expect(event.newPath).toBe("/base/todo/test.md");
    expect(event.uuid).toBe(uuid);

    // Should schedule a single refresh (not the buffered delete one)
    vi.advanceTimersByTime(FileWatcher.DEBOUNCE_MS + 50);
    expect(onChanged).toHaveBeenCalledTimes(1);

    // The buffered delete timer should have been cancelled
    vi.advanceTimersByTime(FileWatcher.RENAME_BUFFER_MS);
    // Extra debounce wait
    vi.advanceTimersByTime(FileWatcher.DEBOUNCE_MS + 50);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("detects rename via folder heuristic (same filename, no UUID)", async () => {
    // No UUID cached, no UUID in file
    mockReadFile.mockResolvedValue(mdWithoutId());

    // Delete from one folder
    onDidDeleteHandler!({ fsPath: "/base/active/my-task.md" });

    // Create in another folder with same filename
    vi.advanceTimersByTime(50);
    onDidCreateHandler!({ fsPath: "/base/done/my-task.md" });

    await vi.waitFor(() => {
      expect(onRenamed).toHaveBeenCalledTimes(1);
    });

    const event: RenameEvent = onRenamed.mock.calls[0][0];
    expect(event.oldPath).toBe("/base/active/my-task.md");
    expect(event.newPath).toBe("/base/done/my-task.md");
    expect(event.uuid).toBeNull();
  });

  it("does not match rename when UUIDs differ", async () => {
    watcher.cacheUuid("/base/active/test.md", "uuid-old");
    mockReadFile.mockResolvedValue(mdWithId("uuid-different"));

    onDidDeleteHandler!({ fsPath: "/base/active/test.md" });

    vi.advanceTimersByTime(100);
    onDidCreateHandler!({ fsPath: "/base/todo/other.md" });

    // Wait for async
    await vi.waitFor(() => {
      // The create should have triggered a refresh schedule
      vi.advanceTimersByTime(FileWatcher.DEBOUNCE_MS + 50);
      expect(onChanged).toHaveBeenCalled();
    });

    expect(onRenamed).not.toHaveBeenCalled();
  });

  it("does not use folder heuristic when UUID is available on delete side", async () => {
    // Deleted file has a UUID cached, but new file has no UUID
    watcher.cacheUuid("/base/active/my-task.md", "cached-uuid");
    mockReadFile.mockResolvedValue(mdWithoutId());

    onDidDeleteHandler!({ fsPath: "/base/active/my-task.md" });

    vi.advanceTimersByTime(50);
    onDidCreateHandler!({ fsPath: "/base/done/my-task.md" });

    // Wait for async resolution
    await vi.waitFor(() => {
      vi.advanceTimersByTime(FileWatcher.DEBOUNCE_MS + 50);
      expect(onChanged).toHaveBeenCalled();
    });

    // No rename: folder heuristic only fires when neither side has UUID
    expect(onRenamed).not.toHaveBeenCalled();
  });

  it("processes delete normally when no create arrives within buffer window", () => {
    onDidDeleteHandler!({ fsPath: "/base/active/test.md" });

    // Wait for full buffer window + debounce
    vi.advanceTimersByTime(FileWatcher.RENAME_BUFFER_MS + FileWatcher.DEBOUNCE_MS + 50);

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onRenamed).not.toHaveBeenCalled();
  });

  it("fires onChanged for regular update events without delay", () => {
    onDidChangeHandler!({ fsPath: "/base/active/test.md" });

    // Just debounce delay, no rename buffer
    vi.advanceTimersByTime(FileWatcher.DEBOUNCE_MS + 50);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("fires onChanged for create events that have no matching delete", async () => {
    mockReadFile.mockResolvedValue(mdWithId("some-uuid"));

    onDidCreateHandler!({ fsPath: "/base/active/new-file.md" });

    await vi.waitFor(() => {
      vi.advanceTimersByTime(FileWatcher.DEBOUNCE_MS + 50);
      expect(onChanged).toHaveBeenCalledTimes(1);
    });

    expect(onRenamed).not.toHaveBeenCalled();
  });

  it("cacheUuid and evictUuid manage the internal cache", async () => {
    const uuid = "test-uuid";

    watcher.cacheUuid("/base/active/test.md", uuid);

    // After caching, a delete + create with matching UUID should detect rename
    mockReadFile.mockResolvedValue(mdWithId(uuid));

    onDidDeleteHandler!({ fsPath: "/base/active/test.md" });
    vi.advanceTimersByTime(50);
    onDidCreateHandler!({ fsPath: "/base/todo/test.md" });

    await vi.waitFor(() => {
      expect(onRenamed).toHaveBeenCalledTimes(1);
    });

    // Now evict and try again - should not match
    onRenamed.mockClear();
    watcher.evictUuid("/base/todo/test.md");

    mockReadFile.mockResolvedValue(mdWithId("another-uuid"));

    onDidDeleteHandler!({ fsPath: "/base/todo/test.md" });
    vi.advanceTimersByTime(50);
    onDidCreateHandler!({ fsPath: "/base/active/test.md" });

    // Wait for async resolution
    await vi.waitFor(() => {
      vi.advanceTimersByTime(FileWatcher.DEBOUNCE_MS + 50);
      expect(onChanged).toHaveBeenCalled();
    });

    // No rename because the delete had no cached UUID, and new file has a different UUID
    expect(onRenamed).not.toHaveBeenCalled();
  });

  it("cleans up timers on dispose", () => {
    onDidDeleteHandler!({ fsPath: "/base/active/test.md" });

    // Dispose before buffer timeout
    watcher.dispose();

    // Advance past buffer window
    vi.advanceTimersByTime(FileWatcher.RENAME_BUFFER_MS + FileWatcher.DEBOUNCE_MS + 100);

    // onChanged should not have been called since we disposed
    expect(onChanged).not.toHaveBeenCalled();
  });
});
