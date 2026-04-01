import * as vscode from "vscode";
import type { WorkItem, WorkItemParser } from "../../core/interfaces";
import type { FileRef } from "../../core/types";
import {
  extractFrontmatter,
  extractFrontmatterString,
} from "../../core/frontmatter";
import {
  type TaskFile,
  type TaskSource,
  type TaskState,
  type KanbanColumn,
  KANBAN_COLUMNS,
} from "./types";
import { TASK_AGENT_CONFIG } from "./TaskAgentConfig";

const VALID_STATES: TaskState[] = ["priority", "todo", "active", "done", "abandoned"];
const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/i;

export class TaskParser implements WorkItemParser {
  basePath: string;
  private static loggedFallbackPaths = new Set<string>();
  private transientIdsByPath = new Map<string, string>();
  private backfillPromisesByPath = new Map<string, Promise<WorkItem | null>>();

  constructor(
    _basePath: string,
    private settings: Record<string, unknown>,
  ) {
    const configPath = this.settings["adapter.taskBasePath"];
    this.basePath = this.normaliseBasePath(
      typeof configPath === "string" ? configPath : "2 - Areas/Tasks",
    );
  }

  parse(file: FileRef): WorkItem | null {
    const transientId = this.transientIdsByPath.get(file.path);
    const fallbackState = this.getStateFromPath(file.path);
    if (!fallbackState) return null;

    return this.toWorkItem(
      this.createFallbackTaskFile(
        file.path,
        file.basename,
        fallbackState,
        transientId,
      ),
    );
  }

  /**
   * Parse a WorkItem from raw file content.
   * This is the primary parse path - called by loadAll after reading file content.
   */
  parseFromContent(
    filePath: string,
    filename: string,
    basename: string,
    content: string,
  ): WorkItem | null {
    const fm = extractFrontmatter(content);
    const transientId = this.transientIdsByPath.get(filePath);
    const fallbackState = this.getStateFromPath(filePath);

    if (!fm) {
      if (!fallbackState) return null;
      return this.toWorkItem(
        this.createFallbackTaskFile(filePath, basename, fallbackState, transientId),
      );
    }

    if (typeof fm.id === "string" && fm.id.trim()) {
      this.transientIdsByPath.delete(filePath);
    }

    const state = this.normaliseState(fm.state, fallbackState);
    if (!state) return null;

    // Parse structured fields from the flat frontmatter record
    const priorityScore = fm["score"] ? parseInt(fm["score"], 10) : 0;
    const tags = this.normaliseTags(fm.tags);
    const goal = this.normaliseGoal(fm.goal);

    const taskFile: TaskFile = {
      id: this.resolveTaskId(fm.id, filePath, transientId),
      path: filePath,
      filename,
      state,
      title: fm.title || basename,
      tags,
      source: this.resolveSourceFromFrontmatter(fm, tags),
      priority: {
        score: priorityScore,
        deadline: fm.deadline || "",
        impact: (fm.impact as TaskFile["priority"]["impact"]) || "medium",
        "has-blocker": fm["has-blocker"] === "true",
        "blocker-context": fm["blocker-context"] || "",
      },
      agentActionable: fm["agent-actionable"] === "true",
      goal,
      color: fm.color || undefined,
      created: fm.created || "",
      updated: fm.updated || "",
    };

    return this.toWorkItem(taskFile);
  }

  private resolveTaskId(frontmatterId: unknown, filePath: string, transientId?: string): string {
    if (typeof frontmatterId === "string" && frontmatterId.trim()) {
      return frontmatterId;
    }
    if (transientId) {
      return transientId;
    }
    return filePath;
  }

  private normaliseState(
    frontmatterState: unknown,
    fallbackState: TaskState | null,
  ): TaskState | null {
    if (
      typeof frontmatterState === "string" &&
      VALID_STATES.includes(frontmatterState as TaskState)
    ) {
      return frontmatterState as TaskState;
    }
    return fallbackState;
  }

  private normaliseTags(rawTags: unknown): string[] {
    if (typeof rawTags === "string" && rawTags.trim()) {
      return rawTags.split(",").map((t) => t.trim()).filter(Boolean);
    }
    return [];
  }

  private normaliseGoal(rawGoal: unknown): string[] {
    if (typeof rawGoal === "string" && rawGoal.trim()) {
      if (rawGoal === "[]") return [];
      return [rawGoal.trim()];
    }
    return [];
  }

  private resolveSourceFromFrontmatter(
    fm: Record<string, string>,
    tags: string[],
  ): TaskSource {
    const sourceType = fm.type || "other";
    const sourceId = typeof fm.id === "string" ? fm.id : "";
    const sourceUrl = typeof fm.url === "string" ? fm.url : "";
    const sourceCaptured = typeof fm.captured === "string" ? fm.captured : "";

    const explicit: TaskSource = {
      type: sourceType as TaskSource["type"],
      id: sourceId,
      url: sourceUrl,
      captured: sourceCaptured,
    };

    if (explicit.type === "jira") {
      const explicitJira = this.detectJiraSource([explicit.id, explicit.url, explicit.captured]);
      return {
        type: "jira",
        id: explicitJira?.id || explicit.id || "",
        url: explicitJira?.url || explicit.url || "",
        captured: explicit.captured || explicitJira?.captured || "",
      };
    }

    if (explicit.type !== "other") {
      return explicit;
    }

    if (explicit.id || explicit.url || explicit.captured) {
      const explicitJira = this.detectJiraSource([explicit.id, explicit.url, explicit.captured]);
      if (explicitJira) {
        return { type: "jira", ...explicitJira };
      }
      return explicit;
    }

    const discreteJiraValue = fm.jira;
    const detected = this.detectJiraSource([discreteJiraValue, ...tags]);
    if (detected) {
      return { type: "jira", ...detected };
    }

    return explicit;
  }

  private detectJiraSource(values: unknown[]): Omit<TaskSource, "type"> | null {
    for (const value of values) {
      const raw = this.extractStringValue(value);
      if (!raw) continue;

      const trimmed = raw.trim();
      if (!trimmed) continue;

      const tagMatch = trimmed.match(/^jira(?:[/:_-])(.*)$/i);
      const candidate = (tagMatch?.[1] || trimmed).trim();
      if (!candidate) continue;

      if (/^https?:\/\//i.test(candidate)) {
        const id = this.extractJiraKey(candidate);
        if (!id) continue;
        return { id, url: candidate, captured: trimmed };
      }

      const id = this.extractJiraKey(candidate);
      if (!id) continue;
      return {
        id,
        url: this.buildJiraUrl(id),
        captured: trimmed,
      };
    }
    return null;
  }

  private extractStringValue(value: unknown): string | null {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const firstString = value.find((entry): entry is string => typeof entry === "string");
      return firstString ?? null;
    }
    return null;
  }

  private extractJiraKey(value: string): string {
    const match = value.match(JIRA_KEY_RE);
    return match?.[1]?.toUpperCase() || "";
  }

  private buildJiraUrl(id: string): string {
    const defaultJiraBaseUrl =
      typeof TASK_AGENT_CONFIG.defaultSettings.jiraBaseUrl === "string"
        ? TASK_AGENT_CONFIG.defaultSettings.jiraBaseUrl
        : "";
    const baseUrl =
      typeof this.settings["adapter.jiraBaseUrl"] === "string" &&
      (this.settings["adapter.jiraBaseUrl"] as string).trim()
        ? (this.settings["adapter.jiraBaseUrl"] as string).trim()
        : defaultJiraBaseUrl;
    return `${baseUrl.replace(/\/+$/, "")}/${id}`;
  }

  private getStateFromPath(path: string): TaskState | null {
    const relativePath = path.startsWith(`${this.basePath}/`)
      ? path.slice(this.basePath.length + 1)
      : path;
    const folder = relativePath.split("/")[0];
    switch (folder) {
      case "priority":
      case "todo":
      case "active":
        return folder;
      case "archive":
        return "done";
      default:
        return null;
    }
  }

  private createFallbackTaskFile(
    filePath: string,
    basename: string,
    state: TaskState,
    transientId?: string,
  ): TaskFile {
    if (!TaskParser.loggedFallbackPaths.has(filePath)) {
      TaskParser.loggedFallbackPaths.add(filePath);
      console.debug(
        `[work-terminal] Falling back to path-based task parsing for malformed frontmatter: ${filePath}`,
      );
    }

    return {
      id: transientId || filePath,
      path: filePath,
      filename: filePath.split("/").pop() || "",
      state,
      title: basename,
      tags: ["task", `task/${state}`],
      source: {
        type: "other",
        id: "",
        url: "",
        captured: "",
      },
      priority: {
        score: 0,
        deadline: "",
        impact: "medium",
        "has-blocker": false,
        "blocker-context": "",
      },
      agentActionable: false,
      goal: [],
      color: undefined,
      created: "",
      updated: "",
    };
  }

  private toWorkItem(task: TaskFile): WorkItem {
    return {
      id: task.id,
      path: task.path,
      title: task.title,
      state: task.state,
      metadata: {
        filename: task.filename,
        tags: task.tags,
        source: task.source,
        priority: task.priority,
        agentActionable: task.agentActionable,
        goal: task.goal,
        color: task.color,
        created: task.created,
        updated: task.updated,
      },
    };
  }

  async loadAll(): Promise<WorkItem[]> {
    const items: WorkItem[] = [];
    const folders = ["priority", "todo", "active", "archive"];

    for (const folder of folders) {
      const folderPath = `${this.basePath}/${folder}`;
      const folderUri = vscode.Uri.file(folderPath);

      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(folderUri);
      } catch {
        continue;
      }

      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith(".md")) continue;

        const filePath = `${folderPath}/${name}`;
        const fileUri = vscode.Uri.file(filePath);

        try {
          const raw = await vscode.workspace.fs.readFile(fileUri);
          const content = new TextDecoder().decode(raw);
          const basename = name.replace(/\.md$/, "");
          const item = this.parseFromContent(filePath, name, basename, content);
          if (item) items.push(item);
        } catch {
          continue;
        }
      }
    }

    return items;
  }

  groupByColumn(items: WorkItem[]): Record<string, WorkItem[]> {
    const groups: Record<string, WorkItem[]> = {};
    for (const col of KANBAN_COLUMNS) {
      groups[col] = [];
    }

    for (const item of items) {
      if (item.state === "abandoned") continue;

      const column = item.state === "done" ? "done" : item.state;
      if (KANBAN_COLUMNS.includes(column as KanbanColumn)) {
        groups[column].push(item);
      }
    }

    for (const col of KANBAN_COLUMNS) {
      groups[col].sort((a, b) => {
        const aMeta = a.metadata as Record<string, unknown>;
        const bMeta = b.metadata as Record<string, unknown>;
        const aPriority = (aMeta?.priority as Record<string, unknown>) || {};
        const bPriority = (bMeta?.priority as Record<string, unknown>) || {};
        const aScore = (aPriority.score as number) || 0;
        const bScore = (bPriority.score as number) || 0;
        const scoreDiff = bScore - aScore;
        if (scoreDiff !== 0) return scoreDiff;
        const aUpdated = (aMeta?.updated as string) || "";
        const bUpdated = (bMeta?.updated as string) || "";
        return bUpdated.localeCompare(aUpdated);
      });
    }

    return groups;
  }

  isItemFile(path: string): boolean {
    return path.startsWith(this.basePath + "/") && path.endsWith(".md");
  }

  private normaliseBasePath(path: string): string {
    return path.replace(/\/+$/, "");
  }

  async backfillItemId(item: WorkItem): Promise<WorkItem | null> {
    if (item.id !== item.path) {
      return item;
    }

    const inFlight = this.backfillPromisesByPath.get(item.path);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.performIdBackfill(item).finally(() => {
      this.backfillPromisesByPath.delete(item.path);
    });
    this.backfillPromisesByPath.set(item.path, promise);
    return promise;
  }

  private async performIdBackfill(item: WorkItem): Promise<WorkItem | null> {
    const fileUri = vscode.Uri.file(item.path);

    try {
      const raw = await vscode.workspace.fs.readFile(fileUri);
      const content = new TextDecoder().decode(raw);
      const existingId = extractFrontmatterString(content, "id");
      if (existingId) {
        this.transientIdsByPath.set(item.path, existingId);
        return { ...item, id: existingId };
      }

      const uuid = crypto.randomUUID();
      const updated = this.insertFrontmatterId(content, uuid);
      if (!updated) {
        return item;
      }

      await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(updated));
      this.transientIdsByPath.set(item.path, uuid);
      return { ...item, id: uuid };
    } catch (err) {
      console.error(`[work-terminal] Failed to backfill ID for ${item.path}:`, err);
      return item;
    }
  }

  private insertFrontmatterId(content: string, id: string): string | null {
    const match = content.match(/^(---\r?\n)([\s\S]*?)(^---(?:\r?\n|$))/m);
    if (!match) {
      return null;
    }

    const [, openingFence, frontmatter, closingFence] = match;
    const newline = openingFence.endsWith("\r\n") ? "\r\n" : "\n";
    const updatedFrontmatter = frontmatter.match(/^id:[ \t]*[^\r\n]*$/m)
      ? frontmatter.replace(/^id:[ \t]*[^\r\n]*$/m, `id: ${id}`)
      : frontmatter
        ? `id: ${id}${newline}${frontmatter}`
        : `id: ${id}${newline}`;

    return content.replace(match[0], `${openingFence}${updatedFrontmatter}${closingFence}`);
  }

  async backfillIds(): Promise<number> {
    let count = 0;
    const items = await this.loadAll();
    for (const item of items) {
      if (item.id !== item.path) continue;
      const backfilled = await this.backfillItemId(item);
      if (backfilled?.id && backfilled.id !== item.id) count++;
    }
    return count;
  }
}
