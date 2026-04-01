/**
 * Build context prompts for AI agents.
 *
 * Uses the adapter's prompt builder for work item context. Adds optional
 * workspace context (open files, git state). Formats as Claude
 * --context-prompt argument.
 */
import * as vscode from "vscode";
import type { WorkItem, WorkItemPromptBuilder } from "../core/interfaces";

/**
 * Build the full context prompt for an agent session, combining the adapter's
 * prompt builder output with optional workspace context.
 */
export function buildAgentContextPrompt(
  item: WorkItem,
  promptBuilder: WorkItemPromptBuilder,
  fullPath: string,
  additionalContext?: string,
): string {
  const parts: string[] = [];

  // Adapter prompt
  const adapterPrompt = promptBuilder.buildPrompt(item, fullPath);
  if (adapterPrompt) {
    parts.push(adapterPrompt);
  }

  // Additional context from settings or profile
  if (additionalContext?.trim()) {
    const resolved = additionalContext
      .replace(/\$title/g, item.title)
      .replace(/\$state/g, item.state)
      .replace(/\$filePath/g, fullPath)
      .replace(/\$id/g, item.id);
    parts.push(resolved);
  }

  return parts.join("\n\n");
}

/**
 * Build a simple context prompt from template with variable substitution.
 * Standalone version that does not require an adapter.
 */
export function buildContextFromTemplate(
  template: string,
  item: WorkItem,
  fullPath?: string,
): string {
  return template
    .replace(/\$title/g, item.title)
    .replace(/\$state/g, item.state)
    .replace(/\$filePath/g, fullPath ?? item.path)
    .replace(/\$id/g, item.id);
}

/**
 * Collect workspace context: open editor file paths, active file, and
 * the current git branch (if available).
 */
export async function getWorkspaceContext(): Promise<string> {
  const parts: string[] = [];

  // Active editor
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    const relativePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
    parts.push(`Active file: ${relativePath}`);
  }

  // Open editors
  const openDocs = vscode.workspace.textDocuments
    .filter((d) => !d.isUntitled && d.uri.scheme === "file")
    .map((d) => vscode.workspace.asRelativePath(d.uri))
    .slice(0, 10);

  if (openDocs.length > 0) {
    parts.push(`Open files: ${openDocs.join(", ")}`);
  }

  return parts.join("\n");
}
