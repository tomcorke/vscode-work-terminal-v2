/**
 * Core adapter interfaces for the VS Code Work Terminal extension.
 *
 * Ported from the Obsidian plugin with platform-specific types removed:
 * - TFile -> FileRef
 * - App -> removed (adapters receive settings directly)
 * - WorkspaceLeaf -> removed (VS Code webview panels used instead)
 * - MenuItem -> removed (VS Code contributes menus via package.json)
 * - DOM types (HTMLElement) -> removed (webview renders via message passing)
 */

import type { FileRef } from "./types";

/**
 * A work item that owns terminal tabs. Adapters parse domain-specific files
 * into WorkItems; the framework manages terminals, layout, and persistence
 * using only this interface.
 */
export interface WorkItem {
  /** Unique identifier used as the session map key. */
  id: string;
  /** Workspace-relative file path. */
  path: string;
  /** Display title shown on cards and in prompts. */
  title: string;
  /** Current state/column (e.g. "active", "todo", "done"). */
  state: string;
  /** Adapter-specific metadata (scores, tags, deadlines, etc.). */
  metadata: Record<string, unknown>;
}

/** A column in the kanban list panel. Optionally maps to a folder on disk. */
export interface ListColumn {
  /** Column identifier used as group key. */
  id: string;
  /** Display label shown in the section header. */
  label: string;
  /** Folder name within the base path. Optional for API-backed adapters. */
  folderName?: string;
}

/** A column available for item creation via the PromptBox. */
export interface CreationColumn {
  /** Column identifier matching a ListColumn.id. */
  id: string;
  /** Display label shown in the column selector. */
  label: string;
  /** If true, this column is pre-selected in the PromptBox. */
  default?: boolean;
}

/** Schema for a single setting field rendered in the settings tab. */
export interface SettingField {
  /** Namespaced key (e.g. "adapter.taskBasePath"). */
  key: string;
  /** Human-readable label. */
  name: string;
  /** Help text shown below the setting. */
  description: string;
  /** Input type. */
  type: "text" | "toggle" | "dropdown";
  /** Default value. */
  default: unknown;
}

/**
 * Adapter-provided plugin configuration. Defines the kanban columns,
 * creation options, settings schema, and display name for items.
 */
export interface PluginConfig {
  /** Kanban columns rendered as collapsible sections. */
  columns: ListColumn[];
  /** Columns available in the PromptBox for new item creation. */
  creationColumns: CreationColumn[];
  /** Adapter-specific settings rendered in the settings tab. */
  settingsSchema: SettingField[];
  /** Default values for adapter settings. */
  defaultSettings: Record<string, unknown>;
  /** Singular noun for items (e.g. "task", "ticket"). Used in UI labels. */
  itemName: string;
}

/**
 * Parses workspace files into WorkItems and groups them by column.
 * Created by the adapter via `createParser()`.
 */
export interface WorkItemParser {
  /** Root workspace path for item files. */
  basePath: string;
  /** Parse a single file into a WorkItem, or null if not a valid item. */
  parse(file: FileRef): WorkItem | null;
  /** Parse raw data into a WorkItem without requiring a FileRef. */
  parseData?(data: Record<string, unknown>): WorkItem | null;
  /** Load all items from the workspace. */
  loadAll(): Promise<WorkItem[]>;
  /** Group items by column ID for kanban rendering. */
  groupByColumn(items: WorkItem[]): Record<string, WorkItem[]>;
  /** Check if a workspace path belongs to this adapter's item files. */
  isItemFile(path: string): boolean;
  /** Backfill a durable item ID when the current ID is only a path fallback. */
  backfillItemId?(item: WorkItem): Promise<WorkItem | null>;
}

/**
 * Moves a work item between columns (states). Handles frontmatter updates,
 * file renames, and activity log entries.
 */
export interface WorkItemMover {
  /** Move an item file to the target column. Returns true on success. */
  move(file: FileRef, targetColumnId: string): Promise<boolean>;
}

/**
 * Framework-provided callbacks for standard card actions. Passed to
 * CardRenderer so adapters can trigger framework operations without
 * coupling to framework internals.
 */
export interface CardActionContext {
  /** Select this item in the list and show its terminals. */
  onSelect(): void;
  /** Move this item to the top of its current section. */
  onMoveToTop(): void;
  /** Move this item to a different column (triggers WorkItemMover). */
  onMoveToColumn(columnId: string): void;
  /** Insert a new item immediately after an existing one in custom order. */
  onInsertAfter(existingId: string, newItem: WorkItem): void;
  /** Split this item: create a new task with a related reference. */
  onSplitTask(sourceItem: WorkItem): void;
  /** Delete this item (moves to trash). */
  onDelete(): void;
  /** Close all terminal sessions for this item. */
  onCloseSessions(): void;
  /** Build the exact prompt used by "Claude (ctx)" for this item, or null when unavailable. */
  getContextPrompt(): Promise<string | null>;
}

/**
 * Describes a card's rendered content for the webview.
 * Replaces direct DOM manipulation (HTMLElement) since
 * VS Code webviews communicate via message passing.
 */
export interface CardRenderData {
  /** HTML string or structured data the webview can render. */
  html: string;
  /** CSS classes to apply to the card container. */
  classes?: string[];
}

/**
 * Menu item descriptor for context menus.
 * Replaces Obsidian's MenuItem since VS Code uses a different menu system.
 */
export interface ContextMenuItem {
  /** Display label. */
  label: string;
  /** Callback when the item is selected. */
  action: () => void;
  /** Whether to show a separator before this item. */
  separator?: boolean;
}

/**
 * Renders a work item as card data and provides context menu items.
 * Adapters control the visual appearance of cards (badges, icons, layout).
 */
export interface CardRenderer {
  /** Create the card render data for a work item. */
  render(item: WorkItem, ctx: CardActionContext): CardRenderData;
  /** Return context menu items for right-click on a card. */
  getContextMenuItems(item: WorkItem, ctx: CardActionContext): ContextMenuItem[];
}

/**
 * Builds the context prompt sent to Claude when launching a
 * "Claude (with context)" session for a work item.
 */
export interface WorkItemPromptBuilder {
  /** Build a prompt string including item title, state, path, and any relevant metadata. */
  buildPrompt(item: WorkItem, fullPath: string): string;
}

/**
 * The adapter bundle is the single extension point for adapters.
 * Implement all required factory methods; optional methods have defaults
 * in BaseAdapter.
 */
export interface AdapterBundle {
  /** Plugin configuration (columns, settings, item name). */
  config: PluginConfig;
  /**
   * Optional async initialization hook called once during view setup,
   * before createParser/createMover. Use for async setup like credential
   * fetching, API client initialization, or initial data sync.
   */
  onLoad?(settings: Record<string, unknown>): Promise<void>;
  /** Create a parser for loading/parsing work items from the workspace. */
  createParser(basePath: string, settings?: Record<string, unknown>): WorkItemParser;
  /** Create a mover for state transitions between columns. */
  createMover(basePath: string, settings?: Record<string, unknown>): WorkItemMover;
  /** Create a card renderer for the list panel. */
  createCardRenderer(): CardRenderer;
  /** Create a prompt builder for Claude context sessions. */
  createPromptBuilder(): WorkItemPromptBuilder;
  /**
   * Called after a new item is created via the PromptBox. Creates the file
   * and kicks off background enrichment. Returns the new item's UUID, column,
   * and an enrichmentDone promise for tracking when background work finishes.
   */
  onItemCreated?(
    title: string,
    settings: Record<string, unknown>,
  ): Promise<{ id: string; columnId: string; enrichmentDone?: Promise<void> } | void>;
  /**
   * Split an existing item: create a new task file with a related reference
   * to the source item. Returns the path and UUID of the new file.
   */
  onSplitItem?(
    sourceItem: WorkItem,
    columnId: string,
    settings: Record<string, unknown>,
  ): Promise<{ path: string; id: string } | null>;
  /**
   * Transform a detected agent session rename label before applying it.
   * Return the label to use (default: return detectedLabel unchanged).
   */
  transformSessionLabel?(oldLabel: string, detectedLabel: string): string;
  /**
   * Framework-set callback that triggers a debounced UI refresh.
   * API-backed adapters can call this after fetching external data.
   */
  requestRefresh?: () => void;
  /**
   * Called before deleting an item. Return false to prevent default
   * deletion behavior (e.g. for API-backed items with custom deletion).
   */
  onDelete?(item: WorkItem): Promise<boolean>;
  /**
   * Return adapter-specific CSS to inject into the webview.
   * Called once during view setup.
   */
  getStyles?(): string;
}

/**
 * Base class with sensible defaults for optional AdapterBundle methods.
 * Extend this and implement the 5 abstract methods to create an adapter.
 */
export abstract class BaseAdapter implements AdapterBundle {
  abstract config: PluginConfig;
  abstract createParser(basePath: string, settings?: Record<string, unknown>): WorkItemParser;
  abstract createMover(basePath: string, settings?: Record<string, unknown>): WorkItemMover;
  abstract createCardRenderer(): CardRenderer;
  abstract createPromptBuilder(): WorkItemPromptBuilder;

  async onLoad(_settings: Record<string, unknown>): Promise<void> {
    // no-op by default
  }

  async onItemCreated(
    _title: string,
    _settings: Record<string, unknown>,
  ): Promise<{ id: string; columnId: string; enrichmentDone?: Promise<void> } | void> {
    // no-op by default
  }

  async onSplitItem(
    _sourceItem: WorkItem,
    _columnId: string,
    _settings: Record<string, unknown>,
  ): Promise<{ path: string; id: string } | null> {
    return null;
  }

  transformSessionLabel(_oldLabel: string, detectedLabel: string): string {
    return detectedLabel;
  }

  async onDelete(_item: WorkItem): Promise<boolean> {
    return true;
  }
}
