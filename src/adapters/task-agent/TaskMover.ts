import * as vscode from "vscode";
import type { FileRef } from "../../core/types";
import type { WorkItemMover } from "../../core/interfaces";
import { type KanbanColumn, STATE_FOLDER_MAP } from "./types";

export class TaskMover implements WorkItemMover {
  private basePath: string;

  constructor(
    _basePath: string,
    private settings: Record<string, unknown>,
  ) {
    const configPath = this.settings["adapter.taskBasePath"];
    this.basePath = typeof configPath === "string" ? configPath : "2 - Areas/Tasks";
  }

  async move(file: FileRef, targetColumnId: string): Promise<boolean> {
    const newColumn = targetColumnId as KanbanColumn;
    const targetFolder = STATE_FOLDER_MAP[newColumn];
    if (!targetFolder) return false;

    try {
      const fileUri = vscode.Uri.file(file.path);
      const raw = await vscode.workspace.fs.readFile(fileUri);
      let content = new TextDecoder().decode(raw);

      // Determine current state from frontmatter
      const stateMatch = content.match(/^state:\s*(.+)$/m);
      const oldState = stateMatch ? stateMatch[1].trim() : "todo";

      if (oldState === newColumn) return true;

      // Update state field
      content = content.replace(/^state:\s*.+$/m, `state: ${newColumn}`);

      // Update task tag
      const oldTagPattern = new RegExp(`(- task/)(?:priority|todo|active|done|abandoned)`, "m");
      content = content.replace(oldTagPattern, `$1${newColumn}`);

      // Update the updated timestamp (no milliseconds)
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      content = content.replace(/^updated:\s*.+$/m, `updated: ${now}`);

      // Append to activity log
      const dateStr = this.formatActivityDate(new Date());
      const logEntry = `- **${dateStr}** - Moved to ${newColumn} (via kanban board)`;

      const logIndex = content.indexOf("## Activity Log");
      if (logIndex !== -1) {
        const afterLog = content.substring(logIndex + "## Activity Log".length);
        const nextSection = afterLog.search(/\n## /);
        const insertPos =
          nextSection !== -1 ? logIndex + "## Activity Log".length + nextSection : content.length;
        content =
          content.substring(0, insertPos).trimEnd() +
          "\n" +
          logEntry +
          "\n" +
          content.substring(insertPos);
      } else {
        content = content.trimEnd() + "\n\n## Activity Log\n" + logEntry + "\n";
      }

      // Write updated content first (write-then-move pattern)
      await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));

      // Move file to target folder
      const filename = file.path.split("/").pop() || "";
      const newFolderPath = `${this.basePath}/${targetFolder}`;
      const newPath = `${newFolderPath}/${filename}`;

      if (file.path !== newPath) {
        const folderUri = vscode.Uri.file(newFolderPath);
        try {
          await vscode.workspace.fs.stat(folderUri);
        } catch {
          await vscode.workspace.fs.createDirectory(folderUri);
        }
        await vscode.workspace.fs.rename(fileUri, vscode.Uri.file(newPath));
      }

      return true;
    } catch (err) {
      console.error("[work-terminal] TaskMover.move failed:", err);
      return false;
    }
  }

  private formatActivityDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const h = String(date.getHours()).padStart(2, "0");
    const min = String(date.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${d} ${h}:${min}`;
  }
}
