import * as vscode from "vscode";
import { extractFrontmatterString } from "../core/frontmatter";

/**
 * Buffered delete entry. Holds metadata about a recently deleted file
 * so we can match it against a subsequent create (rename detection).
 */
interface BufferedDelete {
  /** Absolute filesystem path of the deleted file. */
  fsPath: string;
  /** Timestamp of the delete event. */
  timestamp: number;
  /** UUID extracted from the file before deletion (if cached), or null. */
  uuid: string | null;
  /** Timer that fires the actual delete processing after the buffer window. */
  timer: ReturnType<typeof setTimeout>;
}

export interface RenameEvent {
  /** Previous absolute filesystem path. */
  oldPath: string;
  /** New absolute filesystem path. */
  newPath: string;
  /** UUID of the item (if available). */
  uuid: string | null;
}

/**
 * Extension-host side file watcher.
 * Watches the task base path for .md file changes and fires a debounced
 * callback. Buffers delete events to detect shell mv renames via
 * UUID matching with a folder heuristic fallback.
 */
export class FileWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private bufferedDeletes: Map<string, BufferedDelete> = new Map();
  private uuidCache: Map<string, string> = new Map();
  private disposables: vscode.Disposable[] = [];

  static DEBOUNCE_MS = 300;
  static RENAME_BUFFER_MS = 2000;

  constructor(
    private basePath: string,
    private isItemFile: (path: string) => boolean,
    private onChanged: () => void,
    private onRenamed?: (event: RenameEvent) => void,
  ) {
    const pattern = new vscode.RelativePattern(basePath, "**/*.md");
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.disposables.push(
      this.watcher.onDidCreate((uri) => this.handleCreate(uri)),
      this.watcher.onDidChange((uri) => this.handleUpdate(uri)),
      this.watcher.onDidDelete((uri) => this.handleDelete(uri)),
    );
  }

  /**
   * Cache a file's UUID so rename detection can match after deletion.
   * Called externally when items are loaded/parsed and their UUIDs are known.
   */
  cacheUuid(fsPath: string, uuid: string): void {
    this.uuidCache.set(fsPath, uuid);
  }

  /**
   * Remove a cached UUID entry (e.g. when a file is confirmed deleted).
   */
  evictUuid(fsPath: string): void {
    this.uuidCache.delete(fsPath);
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private async handleCreate(uri: vscode.Uri): Promise<void> {
    const fsPath = uri.fsPath;

    // Try to read UUID from the newly created file
    const newUuid = await this.readUuidFromFile(uri);

    // Check buffered deletes for a rename match
    const match = this.findRenameMatch(fsPath, newUuid);

    if (match) {
      // Cancel the buffered delete's timeout - it won't fire as a real delete
      clearTimeout(match.timer);
      this.bufferedDeletes.delete(match.fsPath);

      // Update UUID cache: remove old path, add new path
      if (match.uuid) {
        this.uuidCache.delete(match.fsPath);
      }
      if (newUuid) {
        this.uuidCache.set(fsPath, newUuid);
      }

      console.log(
        `[work-terminal] Rename detected: ${match.fsPath} -> ${fsPath}` +
        (newUuid ? ` (uuid: ${newUuid})` : " (folder heuristic)"),
      );

      this.onRenamed?.({
        oldPath: match.fsPath,
        newPath: fsPath,
        uuid: newUuid ?? match.uuid,
      });

      // Single refresh for the rename
      this.scheduleRefresh();
      return;
    }

    // No rename match - normal create
    if (newUuid) {
      this.uuidCache.set(fsPath, newUuid);
    }
    this.scheduleRefresh();
  }

  private handleUpdate(_uri: vscode.Uri): void {
    // Content change - just refresh. UUID could have been added/changed,
    // but re-reading on every save would be expensive. The parser will
    // pick up changes on the next loadAll().
    this.scheduleRefresh();
  }

  private handleDelete(uri: vscode.Uri): void {
    const fsPath = uri.fsPath;

    // Buffer the delete: wait for a matching create before processing
    const cachedUuid = this.uuidCache.get(fsPath) ?? null;

    const timer = setTimeout(() => {
      // No matching create arrived within the buffer window - real delete
      this.bufferedDeletes.delete(fsPath);
      this.uuidCache.delete(fsPath);
      this.scheduleRefresh();
    }, FileWatcher.RENAME_BUFFER_MS);

    this.bufferedDeletes.set(fsPath, {
      fsPath,
      timestamp: Date.now(),
      uuid: cachedUuid,
      timer,
    });
  }

  // ---------------------------------------------------------------------------
  // Rename matching
  // ---------------------------------------------------------------------------

  /**
   * Find a buffered delete that matches a newly created file.
   *
   * Match strategy (in priority order):
   * 1. UUID match: the deleted file's cached UUID matches the new file's UUID
   * 2. Folder heuristic: same filename, different parent folder (state move)
   */
  private findRenameMatch(newPath: string, newUuid: string | null): BufferedDelete | null {
    const now = Date.now();

    for (const [, entry] of this.bufferedDeletes) {
      // Skip expired entries (shouldn't happen since timer cleans up, but be safe)
      if (now - entry.timestamp > FileWatcher.RENAME_BUFFER_MS) continue;
      // Don't match a file with itself
      if (entry.fsPath === newPath) continue;

      // Strategy 1: UUID match
      if (newUuid && entry.uuid && newUuid === entry.uuid) {
        return entry;
      }

      // Strategy 2: Folder heuristic - same filename, different directory
      if (!newUuid && !entry.uuid) {
        const newFilename = newPath.split("/").pop();
        const oldFilename = entry.fsPath.split("/").pop();
        if (newFilename && oldFilename && newFilename === oldFilename) {
          return entry;
        }
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // UUID reading
  // ---------------------------------------------------------------------------

  /**
   * Read UUID from a file's frontmatter. Returns null if the file can't be
   * read or has no id field.
   */
  private async readUuidFromFile(uri: vscode.Uri): Promise<string | null> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = new TextDecoder().decode(bytes);
      return extractFrontmatterString(content, "id");
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------

  private scheduleRefresh(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.onChanged();
    }, FileWatcher.DEBOUNCE_MS);
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    // Clear all buffered delete timers
    for (const [, entry] of this.bufferedDeletes) {
      clearTimeout(entry.timer);
    }
    this.bufferedDeletes.clear();
    this.uuidCache.clear();
    this.watcher.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
