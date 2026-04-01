import * as vscode from "vscode";
import { generateTaskContent, generatePendingFilename } from "./TaskFileTemplate";
import type { SplitSource } from "./TaskFileTemplate";
import { expandTilde } from "../../core/utils";
import { STATE_FOLDER_MAP, type KanbanColumn } from "./types";

const RENAME_INSTRUCTION =
  `After updating the task, rename the file to match the convention ` +
  `TASK-YYYYMMDD-HHMM-slugified-title.md (use the existing date prefix, ` +
  `replace the "pending-XXXXXXXX" segment with a slug of the final title).`;

export interface ItemCreatedResult {
  id: string;
  columnId: string;
  enrichmentDone: Promise<void>;
}

export async function handleItemCreated(
  title: string,
  settings: Record<string, unknown>,
): Promise<ItemCreatedResult> {
  const columnId = ((settings._columnId as string) || "todo") as KanbanColumn;
  const basePath = (settings["adapter.taskBasePath"] as string) || "2 - Areas/Tasks";

  const id = crypto.randomUUID();
  const content = generateTaskContent(title, columnId, undefined, id);
  const filename = generatePendingFilename();
  const folderName = STATE_FOLDER_MAP[columnId] || "todo";
  const folderPath = `${basePath}/${folderName}`;
  const filePath = `${folderPath}/${filename}`;

  const folderUri = vscode.Uri.file(folderPath);
  try {
    await vscode.workspace.fs.stat(folderUri);
  } catch {
    await vscode.workspace.fs.createDirectory(folderUri);
  }

  const fileUri = vscode.Uri.file(filePath);
  await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));
  console.log(`[work-terminal] Task created: ${filePath}`);

  const enrichmentDone = spawnEnrichment(filePath, settings).catch((err) => {
    console.error("[work-terminal] Background enrich error:", err);
  });

  return { id, columnId, enrichmentDone };
}

export async function handleSplitTaskCreated(
  title: string,
  columnId: KanbanColumn,
  basePath: string,
  splitFrom: SplitSource,
): Promise<{ path: string; id: string }> {
  const id = crypto.randomUUID();
  const content = generateTaskContent(title, columnId, splitFrom, id);
  const filename = generatePendingFilename();
  const folderName = STATE_FOLDER_MAP[columnId] || "todo";
  const folderPath = `${basePath}/${folderName}`;
  const filePath = `${folderPath}/${filename}`;

  const folderUri = vscode.Uri.file(folderPath);
  try {
    await vscode.workspace.fs.stat(folderUri);
  } catch {
    await vscode.workspace.fs.createDirectory(folderUri);
  }

  const fileUri = vscode.Uri.file(filePath);
  await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));
  console.log(`[work-terminal] Split task created: ${filePath} (from ${splitFrom.filename})`);

  return { path: filePath, id };
}

async function spawnEnrichment(
  filePath: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const claudeCommand = (settings["core.claudeCommand"] as string) || "claude";
  const claudeExtraArgs = (settings["core.claudeExtraArgs"] as string) || "";
  const cwd = expandTilde((settings["core.defaultTerminalCwd"] as string) || "~");

  const enrichPrompt =
    `/tc-tasks:task-agent --fast The task file at ${filePath} was just created with minimal data. ` +
    `Review it, run duplicate check, goal alignment, and related task detection. Update the file in place. ` +
    RENAME_INSTRUCTION;

  const args = ["-p", enrichPrompt];
  if (claudeExtraArgs) {
    args.push(...claudeExtraArgs.split(/\s+/).filter(Boolean));
  }

  try {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    const fullCommand = `${claudeCommand} ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`;
    const result = await execAsync(fullCommand, { cwd, timeout: 120000 });

    if (result.stderr) {
      console.warn("[work-terminal] Background enrich stderr:", result.stderr.slice(0, 500));
    }
    console.log(`[work-terminal] Background enrich completed: ${filePath}`);
  } catch (err: unknown) {
    const error = err as { code?: string; stderr?: string };
    if (error.code === "ENOENT") {
      console.warn(
        `[work-terminal] Background enrich skipped: '${claudeCommand}' not found. Install Claude CLI for auto-enrichment.`,
      );
      return;
    }
    throw err;
  }
}

export { RENAME_INSTRUCTION };
