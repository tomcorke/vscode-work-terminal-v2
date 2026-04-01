/**
 * Shared types used across the VS Code extension.
 * Replaces Obsidian-specific types (TFile, App, WorkspaceLeaf) with
 * platform-agnostic equivalents.
 */

/**
 * Platform-agnostic file reference. Replaces Obsidian's TFile.
 */
export interface FileRef {
  /** VS Code URI string (e.g. "file:///path/to/file.md"). */
  uri: string;
  /** Workspace-relative file path. */
  path: string;
  /** File name without extension. */
  basename: string;
}
