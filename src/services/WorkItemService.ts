import * as vscode from "vscode";
import type { WorkItem, WorkItemParser, WorkItemMover, AdapterBundle } from "../core/interfaces";
import type { WorkItemDTO } from "../webview/messages";

/**
 * Extension-host side work item management.
 * Loads items via adapter parser, groups by column, handles CRUD,
 * manages custom ordering persisted in extension global state.
 */
export class WorkItemService {
  private items: WorkItem[] = [];
  private parser: WorkItemParser;
  private mover: WorkItemMover;
  private adapter: AdapterBundle;
  private globalState: vscode.Memento;
  private customOrder: Record<string, string[]> = {};
  private settings: Record<string, unknown>;

  private static ORDER_KEY = "workTerminal.customOrder";

  constructor(
    adapter: AdapterBundle,
    basePath: string,
    globalState: vscode.Memento,
    settings: Record<string, unknown>,
  ) {
    this.adapter = adapter;
    this.parser = adapter.createParser(basePath, settings);
    this.mover = adapter.createMover(basePath, settings);
    this.globalState = globalState;
    this.settings = settings;
    this.customOrder = globalState.get(WorkItemService.ORDER_KEY, {});
  }

  async loadAll(): Promise<void> {
    this.items = await this.parser.loadAll();
  }

  getItems(): WorkItem[] {
    return this.items;
  }

  getItemById(id: string): WorkItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  getGrouped(): Record<string, WorkItem[]> {
    return this.parser.groupByColumn(this.items);
  }

  getColumns(): string[] {
    return this.adapter.config.columns.map((c) => c.id);
  }

  getColumnLabels(): Record<string, string> {
    const labels: Record<string, string> = {};
    for (const col of this.adapter.config.columns) {
      labels[col.id] = col.label;
    }
    return labels;
  }

  /**
   * Build DTOs for the webview.
   */
  toDTOs(): WorkItemDTO[] {
    const grouped = this.getGrouped();
    const dtos: WorkItemDTO[] = [];

    for (const col of this.adapter.config.columns) {
      const colItems = grouped[col.id] || [];
      const sorted = this.sortByCustomOrder(colItems, col.id);

      for (const item of sorted) {
        const meta = (item.metadata || {}) as Record<string, unknown>;
        const source = meta.source as { type?: string; id?: string } | undefined;
        const priority = meta.priority as {
          score?: number;
          "has-blocker"?: boolean;
          "blocker-context"?: string;
        } | undefined;
        const tags = meta.tags as string[] | undefined;
        const goals = meta.goal as string[] | undefined;

        const metaStrings: Record<string, string> = {};
        if (priority?.score) metaStrings.score = String(priority.score);
        if (tags?.length) metaStrings.tags = tags.join(",");
        if (meta.color) metaStrings.color = String(meta.color);

        const isJira = source?.type === "jira" && source.id;
        const jiraBaseUrl = typeof this.settings["adapter.jiraBaseUrl"] === "string"
          ? (this.settings["adapter.jiraBaseUrl"] as string).trim()
          : "";

        const dto: WorkItemDTO = {
          id: item.id,
          title: item.title,
          column: item.state === "done" ? "done" : item.state,
          source: isJira ? source!.id : source?.type,
          meta: Object.keys(metaStrings).length > 0 ? metaStrings : undefined,
        };

        if (goals?.length) dto.goals = goals;
        if (priority?.["has-blocker"]) {
          dto.hasBlocker = true;
          if (priority["blocker-context"]) {
            dto.blockerContext = String(priority["blocker-context"]);
          }
        }
        if (isJira) {
          dto.jiraKey = String(source!.id).toUpperCase();
          if (jiraBaseUrl) dto.jiraBaseUrl = jiraBaseUrl;
        }

        dtos.push(dto);
      }
    }

    return dtos;
  }

  private sortByCustomOrder(items: WorkItem[], columnId: string): WorkItem[] {
    const order = this.customOrder[columnId];
    if (!order?.length) return items;

    const orderMap = new Map(order.map((id, idx) => [id, idx]));
    const ordered: WorkItem[] = [];
    const unordered: WorkItem[] = [];

    for (const item of items) {
      if (orderMap.has(item.id)) {
        ordered.push(item);
      } else {
        unordered.push(item);
      }
    }

    ordered.sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0));
    return [...ordered, ...unordered];
  }

  // ---------------------------------------------------------------------------
  // CRUD operations
  // ---------------------------------------------------------------------------

  async createItem(
    title: string,
    columnId?: string,
  ): Promise<{ id: string; columnId: string; enrichmentDone?: Promise<void> } | void> {
    if (!this.adapter.onItemCreated) return;
    const settings: Record<string, unknown> = { ...this.settings };
    if (columnId) settings._columnId = columnId;
    return this.adapter.onItemCreated(title, settings);
  }

  async moveItem(itemId: string, toColumn: string, index: number): Promise<boolean> {
    const item = this.items.find((i) => i.id === itemId);
    if (!item) return false;

    const file = { uri: "", path: item.path, basename: item.path.split("/").pop()?.replace(/\.md$/, "") || "" };
    const success = await this.mover.move(file, toColumn);
    if (success) {
      this.updateCustomOrder(itemId, toColumn, index);
    }
    return success;
  }

  async deleteItem(itemId: string): Promise<boolean> {
    const item = this.items.find((i) => i.id === itemId);
    if (!item) return false;

    if (this.adapter.onDelete) {
      return this.adapter.onDelete(item);
    }
    return false;
  }

  updateCustomOrder(itemId: string, toColumn: string, index: number): void {
    // Remove from all columns
    for (const col of Object.keys(this.customOrder)) {
      this.customOrder[col] = (this.customOrder[col] || []).filter((id) => id !== itemId);
    }

    // Insert at position in target column
    if (!this.customOrder[toColumn]) {
      this.customOrder[toColumn] = [];
    }
    this.customOrder[toColumn].splice(index, 0, itemId);
    this.persistOrder();
  }

  isItemFile(path: string): boolean {
    return this.parser.isItemFile(path);
  }

  private persistOrder(): void {
    this.globalState.update(WorkItemService.ORDER_KEY, this.customOrder);
  }
}
