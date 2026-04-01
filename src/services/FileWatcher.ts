import * as vscode from "vscode";

/**
 * Extension-host side file watcher.
 * Watches the task base path for .md file changes and fires a debounced
 * callback. Works with any adapter - does not hardcode paths.
 */
export class FileWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private recentDeletes: Map<string, number> = new Map();
  private disposables: vscode.Disposable[] = [];

  private static DEBOUNCE_MS = 300;
  private static RENAME_WINDOW_MS = 500;

  constructor(
    basePath: string,
    private isItemFile: (path: string) => boolean,
    private onChanged: () => void,
  ) {
    const pattern = new vscode.RelativePattern(basePath, "**/*.md");
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.disposables.push(
      this.watcher.onDidCreate((uri) => this.handleChange(uri, "create")),
      this.watcher.onDidChange((uri) => this.handleChange(uri, "update")),
      this.watcher.onDidDelete((uri) => this.handleChange(uri, "delete")),
    );
  }

  private handleChange(uri: vscode.Uri, kind: "create" | "update" | "delete"): void {
    const fsPath = uri.fsPath;

    // Delete-create rename detection: if a file is created shortly after
    // a delete at a similar path, treat it as a rename (single refresh).
    if (kind === "delete") {
      this.recentDeletes.set(fsPath, Date.now());
      setTimeout(() => this.recentDeletes.delete(fsPath), FileWatcher.RENAME_WINDOW_MS);
    }

    if (kind === "create") {
      // Check if this looks like the second half of a rename
      for (const [deletedPath, ts] of this.recentDeletes) {
        if (Date.now() - ts < FileWatcher.RENAME_WINDOW_MS && deletedPath !== fsPath) {
          this.recentDeletes.delete(deletedPath);
          // Still triggers refresh, just don't double-fire
          break;
        }
      }
    }

    this.scheduleRefresh();
  }

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
    this.watcher.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
