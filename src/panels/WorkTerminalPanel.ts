import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { WebviewMessage, ExtensionMessage, ButtonProfileInfo } from "../webview/messages";
import { WorkItemService } from "../services/WorkItemService";
import { FileWatcher, type RenameEvent } from "../services/FileWatcher";
import type { AdapterBundle } from "../core/interfaces";
import { getNonce, expandTilde } from "../core/utils";
import { dangerConfirm } from "../core/dangerConfirm";
import { TerminalManager } from "../terminal/TerminalManager";
import { isSessionType, type SessionType } from "../core/session/types";
import { SessionManager } from "../session/SessionManager";
import { AgentProfileManager } from "../agents/AgentProfileManager";
import { AgentSessionTracker } from "../agents/AgentSessionTracker";
import { agentTypeToSessionType } from "../core/agents/types";
import type { AgentProfile } from "../core/agents/types";
import { showLaunchModal, type LaunchModalResult } from "../agents/AgentLaunchModal";
import { parseExtraArgs } from "../terminal/AgentLauncher";
import { HookBannerService } from "../agents/HookBannerService";
import { installHooks, removeHooks, checkHookStatus } from "../agents/ClaudeHookManager";

/**
 * Singleton panel that hosts the 2-panel webview layout.
 * Wires up FileWatcher and WorkItemService to drive the list panel.
 */
export class WorkTerminalPanel {
  public static current: WorkTerminalPanel | undefined;
  public static onItemsUpdated:
    | ((items: import("../webview/messages").WorkItemDTO[], columns: string[]) => void)
    | null = null;
  /** Callback to forward extension messages to the sidebar webview. */
  public static onSidebarPost:
    | ((message: ExtensionMessage) => void)
    | null = null;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposed = false;
  private _webviewReady = false;
  private readonly _pendingMessages: ExtensionMessage[] = [];

  private _workItemService: WorkItemService | null = null;
  private _fileWatcher: FileWatcher | null = null;
  private _adapter: AdapterBundle | null = null;
  private _globalState: vscode.Memento | null = null;
  private readonly _terminalManager: TerminalManager;
  private _sessionManager: SessionManager | null = null;
  private _profileManager: AgentProfileManager | null = null;
  private readonly _sessionTrackers = new Map<string, AgentSessionTracker>();
  private readonly _hookBannerService = new HookBannerService();
  /** Tracks when each item last entered idle state (ms timestamp, keyed by itemId). */
  private readonly _idleSinceMap = new Map<string, number>();

  /** URI of the detail editor tab opened by the extension (null if none). */
  private _detailEditorUri: vscode.Uri | null = null;
  private _renameDisposable: vscode.Disposable | null = null;

  private constructor(extensionUri: vscode.Uri) {
    this._extensionUri = extensionUri;
    this._terminalManager = new TerminalManager();

    this._panel = vscode.window.createWebviewPanel(
      "workTerminal",
      "Work Terminal",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
      },
    );

    this._panel.onDidDispose(() => {
      // Panel is already gone (user clicked X or VS Code closed it).
      // Best-effort: persist sessions before tearing down.
      this._teardown();
      WorkTerminalPanel.current = undefined;
      this._webviewReady = false;
      this._pendingMessages.length = 0;
    });

    this._panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      this._handleMessage(message);
    });

    this._panel.webview.html = this._getHtml(this._panel.webview);

    // Wire up terminal manager callbacks
    this._terminalManager.onOutput = (sessionId, data) => {
      this.postMessage({ type: "terminalOutput", sessionId, data });
    };
    this._terminalManager.onCreated = (sessionId, label, sessionType, itemId) => {
      this.postMessage({ type: "terminalCreated", sessionId, label, sessionType, itemId: itemId ?? undefined });
      // Notify webview of updated session state for the item
      this._postSessionStateForTerminal(sessionId);
    };
    this._terminalManager.onClosed = (sessionId) => {
      // Capture item info before the terminal is removed from the map
      const closingInfo = this._terminalManager.getSessionInfo(sessionId);
      const closingItemId = this._getItemIdForSession(sessionId);
      this.postMessage({ type: "terminalClosed", sessionId });
      // Notify session manager of terminal close for recently-closed tracking
      if (closingInfo && this._sessionManager) {
        this._sessionManager.onTerminalClosed({
          sessionId,
          label: closingInfo.label,
          itemId: closingItemId,
          sessionType: closingInfo.sessionType,
          agentSessionId: closingInfo.agentSessionId,
        }).catch((err) => {
          console.error("[work-terminal] Session close tracking failed:", err);
        });
      }
      // Notify webview of updated session state for the item
      if (closingItemId) {
        this._postSessionStateForItem(closingItemId);
      }
      // Update resume badge state after session enters recently-closed store
      this._postResumeItemIds();
    };
    this._terminalManager.onAgentStateChanged = (sessionId, state) => {
      const itemId = this._getItemIdForSession(sessionId) ?? undefined;
      let idleSince: number | undefined;
      if (itemId) {
        if (state === "idle") {
          if (!this._idleSinceMap.has(itemId)) {
            this._idleSinceMap.set(itemId, Date.now());
          }
          idleSince = this._idleSinceMap.get(itemId);
        } else {
          this._idleSinceMap.delete(itemId);
        }
      }
      const agentMsg: ExtensionMessage = { type: "agentStateChanged", sessionId, state, itemId, idleSince };
      this._broadcast(agentMsg);
    };
    this._terminalManager.onRenamed = (sessionId, newLabel) => {
      // Allow adapter to transform the detected label
      const label = this._adapter?.transformSessionLabel?.(
        this._terminalManager.getSessionInfo(sessionId)?.label ?? "",
        newLabel,
      ) ?? newLabel;
      this._terminalManager.renameTerminal(sessionId, label);
      this.postMessage({ type: "terminalRenamed", sessionId, label });
      // Update session state on the sidebar
      const itemId = this._getItemIdForSession(sessionId);
      if (itemId) {
        this._postSessionStateForItem(itemId);
      }
    };

    // Track file renames so the detail editor URI stays current
    this._renameDisposable = vscode.workspace.onDidRenameFiles((e) => {
      if (!this._detailEditorUri) return;
      for (const { oldUri, newUri } of e.files) {
        if (oldUri.toString() === this._detailEditorUri.toString()) {
          this._detailEditorUri = newUri;
          break;
        }
      }
    });

    // Wire up hook banner service to push state to webview
    this._hookBannerService.onStateChanged((state) => {
      this.postMessage({ type: "hookBannerState", visible: state.visible, message: state.message });
    });
  }

  /**
   * Show the panel, creating it if needed (singleton).
   */
  static createOrShow(extensionUri: vscode.Uri): WorkTerminalPanel {
    if (WorkTerminalPanel.current) {
      WorkTerminalPanel.current.reveal();
      return WorkTerminalPanel.current;
    }
    const instance = new WorkTerminalPanel(extensionUri);
    WorkTerminalPanel.current = instance;
    return instance;
  }

  /**
   * Initialize the session manager for persistence and recovery.
   */
  async initSessionManager(context: vscode.ExtensionContext): Promise<void> {
    this._sessionManager = new SessionManager({
      context,
      terminalManager: this._terminalManager,
    });
    const { persisted, stashedState } = await this._sessionManager.activate();
    if (persisted.length > 0) {
      console.log(
        "[work-terminal] Ready to recover",
        persisted.length,
        "persisted sessions",
      );
    }
    if (stashedState) {
      console.log(
        "[work-terminal] Recovered stashed state from hot-reload",
      );
    }
  }

  /**
   * Get the session manager (for use by commands like reopen-closed-terminal).
   */
  get sessionManager(): SessionManager | null {
    return this._sessionManager;
  }

  /**
   * Initialize the agent profile manager.
   */
  async initProfileManager(globalState: vscode.Memento): Promise<void> {
    this._profileManager = new AgentProfileManager(globalState);
    await this._profileManager.load();
    this._sendButtonProfiles();
  }

  get profileManager(): AgentProfileManager | null {
    return this._profileManager;
  }

  get isServicesInitialized(): boolean {
    return this._workItemService !== null;
  }

  /**
   * Initialize the work item service and file watcher with the given adapter.
   */
  async initServices(
    adapter: AdapterBundle,
    globalState: vscode.Memento,
  ): Promise<void> {
    this._adapter = adapter;
    this._globalState = globalState;
    const config = vscode.workspace.getConfiguration("workTerminal");
    const basePath = config.get<string>("taskBasePath", "2 - Areas/Tasks");

    // Resolve base path: expand ~ first, then check if absolute
    const expandedBase = expandTilde(basePath);
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const resolvedBase = path.isAbsolute(expandedBase)
      ? expandedBase
      : workspaceFolder
        ? path.join(workspaceFolder.uri.fsPath, expandedBase)
        : expandedBase;
    console.log("[work-terminal] initServices: resolvedBase =", resolvedBase);

    const settings: Record<string, unknown> = {
      "adapter.taskBasePath": resolvedBase,
    };

    if (adapter.onLoad) {
      await adapter.onLoad(settings);
    }

    this._workItemService = new WorkItemService(
      adapter,
      resolvedBase,
      globalState,
      settings,
    );

    this._fileWatcher = new FileWatcher(
      resolvedBase,
      (p: string) => this._workItemService?.isItemFile(p) ?? false,
      () => this._refreshItems(),
      (event: RenameEvent) => this._handleFileRenamed(event),
    );

    // Initial load
    await this._refreshItems();
  }

  reveal(): void {
    if (!this._disposed) {
      this._panel.reveal();
    }
  }

  /**
   * Whether there are active terminal sessions running.
   */
  get hasActiveSessions(): boolean {
    return this._terminalManager.activeSessionCount > 0;
  }

  /**
   * Show a confirmation dialog if active sessions exist and keepSessionsAlive
   * is disabled. Returns true if the caller should proceed with closing.
   */
  static async confirmClose(): Promise<boolean> {
    const panel = WorkTerminalPanel.current;
    if (!panel || !panel.hasActiveSessions) return true;

    const config = vscode.workspace.getConfiguration("workTerminal");
    const keepAlive = config.get<boolean>("keepSessionsAlive", true);
    if (keepAlive) return true;

    const count = panel._terminalManager.activeSessionCount;
    const label = count === 1 ? "1 active session" : `${count} active sessions`;
    const answer = await vscode.window.showWarningMessage(
      `Work Terminal has ${label}. Close anyway?`,
      { modal: true },
      "Close",
    );
    return answer === "Close";
  }

  /**
   * Internal cleanup shared by dispose() and onDidDispose.
   * Persists sessions and tears down watchers/trackers.
   */
  private _teardown(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._sessionManager?.deactivate().catch((err) => {
      console.error("[work-terminal] Session persist on dispose failed:", err);
    });
    this._profileManager?.dispose();
    for (const tracker of this._sessionTrackers.values()) {
      tracker.dispose();
    }
    this._sessionTrackers.clear();
    this._fileWatcher?.dispose();
    this._renameDisposable?.dispose();
    this._closeDetailEditor();
    this._hookBannerService.dispose();

    const config = vscode.workspace.getConfiguration("workTerminal");
    const keepAlive = config.get<boolean>("keepSessionsAlive", true);
    if (!keepAlive) {
      this._terminalManager.disposeAll();
    }
  }

  dispose(): void {
    this._teardown();
    this._panel.dispose();
  }

  /**
   * Post a typed message to the webview.
   */
  postMessage(message: ExtensionMessage): void {
    if (this._disposed) return;
    if (this._webviewReady) {
      this._panel.webview.postMessage(message);
      return;
    }
    this._pendingMessages.push(message);
  }

  /**
   * Post a message to the sidebar webview (for syncing session state, etc.).
   */
  private _postToSidebar(message: ExtensionMessage): void {
    WorkTerminalPanel.onSidebarPost?.(message);
  }

  /**
   * Post a message to both the main panel and the sidebar webview.
   * Use this for messages that both views need (session state, item changes, etc.).
   */
  private _broadcast(message: ExtensionMessage): void {
    this.postMessage(message);
    this._postToSidebar(message);
  }

  /**
   * Handle a message forwarded from the sidebar webview.
   * Re-uses the same handler as the main panel's message processing.
   */
  handleSidebarMessage(message: WebviewMessage): void {
    this._handleMessage(message);
  }

  // ---------------------------------------------------------------------------
  // Session state notifications
  // ---------------------------------------------------------------------------

  private _getItemIdForSession(sessionId: string): string | null {
    const all = this._terminalManager.getAllSessionInfo();
    const match = all.find((s) => s.sessionId === sessionId);
    return match?.itemId ?? null;
  }

  private _postSessionStateForTerminal(sessionId: string): void {
    const itemId = this._getItemIdForSession(sessionId);
    if (itemId) {
      this._postSessionStateForItem(itemId);
    }
  }

  private _postSessionStateForItem(itemId: string): void {
    const sessionIds = this._terminalManager.getSessionsForItem(itemId);
    const sessions = sessionIds.map((sid) => {
      const info = this._terminalManager.getSessionInfo(sid);
      const kind: "shell" | "agent" = info?.sessionType === "shell" ? "shell" : "agent";
      return { id: sid, label: info?.label ?? "", kind };
    });
    const msg: ExtensionMessage = { type: "sessionStateChanged", itemId, sessions };
    this._broadcast(msg);
  }

  private _postResumeItemIds(): void {
    if (!this._sessionManager) return;
    const ids = this._sessionManager.getResumableItemIds();
    const msg: ExtensionMessage = { type: "resumeItemIds", itemIds: [...ids] };
    this._broadcast(msg);
  }

  // ---------------------------------------------------------------------------
  // Button profile sync
  // ---------------------------------------------------------------------------

  private _sendButtonProfiles(): void {
    if (!this._profileManager) return;
    const buttonProfiles = this._profileManager.getButtonProfiles();
    const infos: ButtonProfileInfo[] = buttonProfiles.map((p) => ({
      profileId: p.id,
      label: p.button.label || p.name,
      icon: p.button.icon,
      color: p.button.color,
      borderStyle: p.button.borderStyle,
    }));
    this.postMessage({ type: "buttonProfiles", profiles: infos });
  }

  // ---------------------------------------------------------------------------
  // Item refresh
  // ---------------------------------------------------------------------------

  private async _refreshItems(): Promise<void> {
    if (!this._workItemService) return;

    await this._workItemService.loadAll();
    const items = this._workItemService.toDTOs();
    const columns = this._workItemService.getColumns();

    // Populate FileWatcher UUID cache from loaded items so rename
    // detection can match deleted files by their frontmatter id.
    if (this._fileWatcher) {
      for (const item of this._workItemService.getItems()) {
        if (item.id && item.id !== item.path) {
          this._fileWatcher.cacheUuid(item.path, item.id);
        }
      }
    }

    this.postMessage({ type: "updateItems", items, columns });

    // Notify sidebar of updated items
    WorkTerminalPanel.onItemsUpdated?.(items, columns);
  }

  /**
   * Handle a file rename detected by the FileWatcher (shell mv).
   * Logs the rename for diagnostics. Session associations survive
   * because they are keyed by UUID, not file path.
   */
  private _handleFileRenamed(event: RenameEvent): void {
    console.log(
      `[work-terminal] File renamed: ${event.oldPath} -> ${event.newPath}` +
      (event.uuid ? ` (uuid: ${event.uuid})` : ""),
    );
  }

  /**
   * Called when workTerminal.* settings change. Re-initializes the
   * WorkItemService with updated configuration.
   */
  async onSettingsChanged(adapter: AdapterBundle): Promise<void> {
    if (!this._workItemService || !this._globalState) return;

    const config = vscode.workspace.getConfiguration("workTerminal");
    const basePath = config.get<string>("taskBasePath", "2 - Areas/Tasks");

    const expandedBase = expandTilde(basePath);
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const resolvedBase = path.isAbsolute(expandedBase)
      ? expandedBase
      : workspaceFolder
        ? path.join(workspaceFolder.uri.fsPath, expandedBase)
        : expandedBase;

    const settings: Record<string, unknown> = {
      "adapter.taskBasePath": resolvedBase,
      "adapter.jiraBaseUrl": config.get<string>("jiraBaseUrl", ""),
    };

    if (adapter.onLoad) {
      await adapter.onLoad(settings);
    }

    this._fileWatcher?.dispose();

    this._workItemService = new WorkItemService(
      adapter,
      resolvedBase,
      this._globalState,
      settings,
    );

    this._fileWatcher = new FileWatcher(
      resolvedBase,
      (p: string) => this._workItemService?.isItemFile(p) ?? false,
      () => this._refreshItems(),
      (event: RenameEvent) => this._handleFileRenamed(event),
    );

    this._hookBannerService.updateAcceptSetting(
      config.get<boolean>("acceptNoResumeHooks", false),
    );

    this.postMessage({
      type: "debugApiState",
      enabled: config.get<boolean>("exposeDebugApi", false),
    });

    await this._refreshItems();
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private _handleMessage(message: WebviewMessage): void {
    switch (message.type) {
      case "ready": {
        this._webviewReady = true;
        this._refreshItems();
        this._sendButtonProfiles();
        this._postResumeItemIds();
        this._refreshHookState();
        const cfg = vscode.workspace.getConfiguration("workTerminal");
        this._hookBannerService.start(cfg.get<boolean>("acceptNoResumeHooks", false));
        if (cfg.get<boolean>("exposeDebugApi", false)) {
          this.postMessage({ type: "debugApiState", enabled: true });
        }
        this._flushPendingMessages();
        break;
      }
      case "itemSelected":
        this.postMessage({ type: "selectItem", itemId: message.id });
        this._runMessageTask(this._handleItemSelected(message.id), "select item");
        break;
      case "createItem":
        this._runMessageTask(
          this._handleCreateItem(message.title, message.column),
          "create item",
        );
        break;
      case "deleteItem":
        this._runMessageTask(this._handleDeleteItem(message.id), "delete item");
        break;
      case "moveItem":
        this._runMessageTask(
          this._handleMoveItem(message.id, message.toColumn, message.index),
          "move item",
        );
        break;
      case "dragDrop":
        this._runMessageTask(
          this._handleDragDrop(message.itemId, message.toColumn, message.index),
          "drag drop",
        );
        break;
      case "filterChanged":
        // Filtering is handled entirely in the webview
        break;
      case "launchTerminal":
        this._handleLaunchTerminal(message.itemId, message.profile);
        break;
      case "terminalInput":
        this._terminalManager.writeToTerminal(message.sessionId, message.data);
        break;
      case "terminalResize":
        this._terminalManager.resizeTerminal(message.sessionId, message.cols, message.rows);
        break;
      case "createTerminal":
        this._handleCreateTerminal(message.terminalType, message.itemId);
        break;
      case "closeTerminal":
        this._terminalManager.destroyTerminal(message.sessionId);
        break;
      case "closeAllTerminalsForItem":
        this._handleCloseAllTerminalsForItem(message.itemId);
        break;
      case "moveTerminalToItem":
        this._handleMoveTerminalToItem(message.sessionId, message.toItemId);
        break;
      case "renameTerminal":
        this._terminalManager.renameTerminal(message.sessionId, message.label);
        break;
      case "reopenClosedTerminal":
        this._handleReopenClosedTerminal();
        break;
      case "getProfiles":
        this._handleGetProfiles();
        break;
      case "saveProfile":
        this._runMessageTask(this._handleSaveProfile(message.profile), "save profile");
        break;
      case "deleteProfile":
        this._runMessageTask(
          this._handleDeleteProfile(message.profileId),
          "delete profile",
        );
        break;
      case "reorderProfiles":
        this._runMessageTask(
          this._handleReorderProfiles(message.orderedIds),
          "reorder profiles",
        );
        break;
      case "launchProfile":
        this._handleLaunchProfile(
          message.profileId,
          message.itemId,
          message.cwdOverride,
          message.labelOverride,
          message.extraArgs,
        );
        break;
      case "importProfiles":
        this._runMessageTask(this._handleImportProfiles(), "import profiles");
        break;
      case "exportProfiles":
        this._runMessageTask(this._handleExportProfiles(), "export profiles");
        break;
      case "moveProfileUp":
        this._runMessageTask(
          this._handleMoveProfile(message.profileId, "up"),
          "move profile up",
        );
        break;
      case "moveProfileDown":
        this._runMessageTask(
          this._handleMoveProfile(message.profileId, "down"),
          "move profile down",
        );
        break;
      case "copyToClipboard":
        vscode.env.clipboard.writeText(message.text);
        break;
      case "contextMenuMove":
        this._runMessageTask(
          this._handleMoveItem(message.itemId, message.toColumn, 0),
          "context move item",
        );
        break;
      case "contextMenuDelete":
        this._runMessageTask(
          this._handleDeleteItem(message.itemId),
          "context delete item",
        );
        break;
      case "doneAndCloseSessions":
        this._runMessageTask(
          this._handleDoneAndCloseSessions(message.itemId),
          "done and close sessions",
        );
        break;
      case "moveToTop":
        this._runMessageTask(this._handleMoveToTop(message.itemId), "move item to top");
        break;
      case "requestLaunchModal":
        this.showLaunchModal(message.itemId);
        break;
      case "resumeItem":
        this._runMessageTask(this._handleResumeItem(message.itemId), "resume item");
        break;
      case "installHooks":
        this._runMessageTask(this._handleInstallHooks(), "install hooks");
        break;
      case "removeHooks":
        this._runMessageTask(this.handleRemoveHooks(), "remove hooks");
        break;
      case "dismissHookBanner":
        this._hookBannerService.dismiss();
        break;
      default:
        break;
    }
  }

  private _flushPendingMessages(): void {
    while (this._pendingMessages.length > 0) {
      const message = this._pendingMessages.shift();
      if (message) {
        this._panel.webview.postMessage(message);
      }
    }
  }

  private _runMessageTask(task: Promise<void>, action: string): void {
    void task.catch((error: unknown) => {
      console.error(`[work-terminal] Failed to ${action}:`, error);
    });
  }

  private async _handleCreateItem(title: string, column?: string): Promise<void> {
    if (!this._workItemService || !this._adapter) return;

    // If no column provided, show column picker using adapter's creation columns
    if (!column) {
      const creationColumns = this._adapter.config.creationColumns;
      if (creationColumns.length > 0) {
        const defaultCol = creationColumns.find((c) => c.default) || creationColumns[0];
        if (creationColumns.length === 1) {
          column = defaultCol.id;
        } else {
          const picked = await vscode.window.showQuickPick(
            creationColumns.map((c) => ({
              label: c.label,
              id: c.id,
              picked: c.id === defaultCol.id,
            })),
            { placeHolder: "Select column for new item" },
          );
          if (!picked) return;
          column = picked.id;
        }
      }
    }

    if (!title) {
      // Show input box for title
      const input = await vscode.window.showInputBox({
        prompt: "Enter item title",
        placeHolder: "New item...",
      });
      if (!input) return;
      title = input;
    }

    // Show placeholder card immediately while file is being created
    const placeholderId = `__pending_${Date.now()}`;
    const targetColumn = column || this._adapter!.config.creationColumns[0]?.id || "";
    const phMsg: ExtensionMessage = { type: "addPlaceholder", placeholderId, title, column: targetColumn };
    this._broadcast(phMsg);

    let result: Awaited<ReturnType<typeof this._workItemService.createItem>>;
    try {
      result = await this._workItemService.createItem(title, column);
    } catch {
      const failMsg: ExtensionMessage = { type: "failPlaceholder", placeholderId };
      this._broadcast(failMsg);
      return;
    }

    // Resolve placeholder to real card
    if (result) {
      const resolveMsg: ExtensionMessage = { type: "resolvePlaceholder", placeholderId, realId: result.id };
      this._broadcast(resolveMsg);
    } else {
      const failMsg: ExtensionMessage = { type: "failPlaceholder", placeholderId };
      this._broadcast(failMsg);
    }

    await this._refreshItems();

    if (result && result.enrichmentDone) {
      const ingestMsg: ExtensionMessage = { type: "setIngesting", itemId: result.id };
      this._broadcast(ingestMsg);
      result.enrichmentDone.then(
        () => {
          const clearMsg: ExtensionMessage = { type: "clearIngesting", itemId: result.id };
          this._broadcast(clearMsg);
          this._refreshItems();
        },
        () => {
          const clearMsg: ExtensionMessage = { type: "clearIngesting", itemId: result.id };
          this._broadcast(clearMsg);
        },
      );
    }
  }

  private async _handleDeleteItem(id: string): Promise<void> {
    if (!this._workItemService) return;
    const item = this._workItemService.getItemById(id);
    const label = item ? `Delete "${item.title}"` : "Delete this item";
    if (!await dangerConfirm(label)) return;
    await this._workItemService.deleteItem(id);
    await this._refreshItems();
  }

  private async _handleDoneAndCloseSessions(itemId: string): Promise<void> {
    if (!this._workItemService) return;
    const item = this._workItemService.getItemById(itemId);
    if (!item) return;

    const sessionCount = this._terminalManager.getSessionsForItem(itemId).length;
    const sessionNote = sessionCount > 0
      ? ` and close ${sessionCount} session${sessionCount > 1 ? "s" : ""}`
      : "";
    if (!await dangerConfirm(`Done & Close "${item.title}"${sessionNote}`)) return;

    await this._workItemService.moveItem(itemId, "done", 0);
    this._terminalManager.closeAllForItem(itemId);
    await this._refreshItems();
  }

  private async _handleItemSelected(id: string): Promise<void> {
    if (!this._workItemService) return;
    const item = this._workItemService.getItemById(id);
    if (!item?.path) return;
    const uri = vscode.Uri.file(item.path);

    // Close the previously opened detail tab (if any) before opening the new one
    this._closeDetailEditor();

    await vscode.window.showTextDocument(uri, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
    });
    this._detailEditorUri = uri;

    // Backfill a durable UUID when the item is keyed by path only
    if (item.id === item.path) {
      this._backfillItemId(item);
    }
  }

  /**
   * Asynchronously backfill a durable UUID for a path-only item.
   * Updates all internal maps (terminals, custom order, sessions) to the new ID
   * and refreshes the UI. Fire-and-forget from _handleItemSelected.
   */
  private async _backfillItemId(item: import("../core/interfaces").WorkItem): Promise<void> {
    if (!this._workItemService) return;
    const updated = await this._workItemService.backfillItemId(item);
    if (!updated || updated.id === item.id) return;

    const oldId = item.id;
    const newId = updated.id;
    console.log(`[work-terminal] Backfilled ID: ${oldId} -> ${newId}`);

    // Rekey terminal sessions
    this._terminalManager.rekeyItem(oldId, newId);

    // Rekey custom order
    this._workItemService.rekeyCustomOrder(oldId, newId);

    // Reload items so the new ID propagates to the in-memory list
    await this._workItemService.loadAll();

    // Persist updated sessions to disk
    this._sessionManager?.persistCurrentSessions();

    // Refresh the webview with updated item IDs
    await this._refreshItems();
  }

  /**
   * Close the detail editor tab opened by this extension, if it is still
   * showing. Uses the VS Code tab API to identify and close only the tab
   * that matches the tracked URI, without affecting user-opened tabs.
   */
  private _closeDetailEditor(): void {
    if (!this._detailEditorUri) return;
    const targetStr = this._detailEditorUri.toString();
    this._detailEditorUri = null;

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (
          tab.input instanceof vscode.TabInputText &&
          tab.input.uri.toString() === targetStr
        ) {
          vscode.window.tabGroups.close(tab).then(undefined, () => {
            // Tab may already be closed - ignore
          });
          return;
        }
      }
    }
  }

  private async _handleMoveItem(id: string, toColumn: string, index: number): Promise<void> {
    if (!this._workItemService) return;
    await this._workItemService.moveItem(id, toColumn, index);
    await this._refreshItems();
  }

  private async _handleMoveToTop(itemId: string): Promise<void> {
    if (!this._workItemService) return;
    const item = this._workItemService.getItemById(itemId);
    if (!item) return;
    this._workItemService.updateCustomOrder(itemId, item.state, 0);
    await this._refreshItems();
  }

  private async _handleDragDrop(itemId: string, toColumn: string, index: number): Promise<void> {
    if (!this._workItemService) return;

    const items = this._workItemService.getItems();
    const item = items.find((i) => i.id === itemId);
    if (!item) return;

    const currentColumn = item.state;
    if (currentColumn !== toColumn) {
      // Cross-column move: use mover to update state
      await this._workItemService.moveItem(itemId, toColumn, index);
    } else {
      // Same-column reorder: just update custom order
      this._workItemService.updateCustomOrder(itemId, toColumn, index);
    }

    await this._refreshItems();
  }

  // ---------------------------------------------------------------------------
  // Terminal launch handlers
  // ---------------------------------------------------------------------------

  /**
   * Resolve CWD for a work item. Checks (in order):
   * 1. `cwd` field in the item's frontmatter metadata
   * 2. The item file's parent directory
   * Returns undefined if the item is not found.
   */
  private _resolveItemCwd(itemId: string): string | undefined {
    if (!this._workItemService) return undefined;
    const item = this._workItemService.getItemById(itemId);
    if (!item) return undefined;

    const meta = (item.metadata || {}) as Record<string, unknown>;
    if (typeof meta.cwd === "string" && meta.cwd.trim()) {
      return expandTilde(meta.cwd.trim());
    }

    // Fall back to the task file's parent directory
    if (item.path) {
      const dir = path.dirname(item.path);
      if (dir && dir !== ".") {
        return dir;
      }
    }

    return undefined;
  }

  private _handleLaunchTerminal(itemId: string, profile?: string): void {
    const sessionType: SessionType = profile && isSessionType(profile) ? profile : "shell";
    const cwd = this._resolveItemCwd(itemId);
    this._terminalManager.createTerminal({ sessionType, itemId, cwd });
  }

  private _handleCreateTerminal(terminalType: string, itemId?: string): void {
    const typeMap: Record<string, SessionType> = {
      shell: "shell",
      claude: "claude",
      copilot: "copilot",
    };
    const sessionType = typeMap[terminalType] || "shell";
    const cwd = itemId ? this._resolveItemCwd(itemId) : undefined;
    this._terminalManager.createTerminal({ sessionType, itemId, cwd });
  }

  // ---------------------------------------------------------------------------
  // Reopen closed terminal
  // ---------------------------------------------------------------------------

  private _handleReopenClosedTerminal(): void {
    if (!this._sessionManager) return;
    const entry = this._sessionManager.popRecentlyClosed();
    if (!entry) {
      return;
    }
    if (entry.recoveryMode === "resume" && entry.claudeSessionId) {
      this._terminalManager.createTerminal({
        sessionType: entry.sessionType,
        itemId: entry.itemId,
        label: entry.label,
        cwd: entry.cwd,
        resumeSessionId: entry.claudeSessionId,
      });
    } else {
      this._terminalManager.createTerminal({
        sessionType: entry.sessionType,
        itemId: entry.itemId,
        label: entry.label,
        cwd: entry.cwd,
        command: entry.command,
        args: entry.commandArgs,
      });
    }
  }

  private _handleResumeItem(itemId: string): void {
    if (!this._sessionManager) return;
    const entry = this._sessionManager.getClosedEntryForItem(itemId);
    if (!entry) return;

    if (entry.recoveryMode === "resume" && entry.claudeSessionId) {
      this._terminalManager.createTerminal({
        sessionType: entry.sessionType,
        itemId: entry.itemId,
        label: entry.label,
        cwd: entry.cwd,
        resumeSessionId: entry.claudeSessionId,
      });
    } else {
      this._terminalManager.createTerminal({
        sessionType: entry.sessionType,
        itemId: entry.itemId,
        label: entry.label,
        cwd: entry.cwd,
        command: entry.command,
        args: entry.commandArgs,
      });
    }

    // After resuming, update the resume badges (entry may still be in store)
    this._postResumeItemIds();
  }

  // ---------------------------------------------------------------------------
  // Tab context menu handlers
  // ---------------------------------------------------------------------------

  private _handleCloseAllTerminalsForItem(itemId: string): void {
    this._terminalManager.closeAllForItem(itemId);
  }

  private _handleMoveTerminalToItem(sessionId: string, toItemId: string): void {
    const oldItemId = this._getItemIdForSession(sessionId);
    this._terminalManager.reassignTerminal(sessionId, toItemId);
    // Notify webview of session state changes for both old and new items
    if (oldItemId) {
      this._postSessionStateForItem(oldItemId);
    }
    this._postSessionStateForItem(toItemId);
  }

  // ---------------------------------------------------------------------------
  // Profile management handlers
  // ---------------------------------------------------------------------------

  private _handleGetProfiles(): void {
    if (!this._profileManager) return;
    this.postMessage({ type: "profileList", profiles: this._profileManager.getProfiles() });
  }

  private async _handleSaveProfile(profile: AgentProfile): Promise<void> {
    if (!this._profileManager) return;
    const existing = this._profileManager.getProfile(profile.id);
    if (existing) {
      await this._profileManager.updateProfile(profile.id, profile);
    } else {
      await this._profileManager.addProfile(profile);
    }
    this.postMessage({ type: "profileSaved", profile });
    this.postMessage({ type: "profileList", profiles: this._profileManager.getProfiles() });
    this._sendButtonProfiles();
  }

  private async _handleDeleteProfile(profileId: string): Promise<void> {
    if (!this._profileManager) return;
    await this._profileManager.deleteProfile(profileId);
    this.postMessage({ type: "profileDeleted", profileId });
    this.postMessage({ type: "profileList", profiles: this._profileManager.getProfiles() });
    this._sendButtonProfiles();
  }

  private async _handleReorderProfiles(orderedIds: string[]): Promise<void> {
    if (!this._profileManager) return;
    await this._profileManager.reorderProfiles(orderedIds);
    this.postMessage({ type: "profileList", profiles: this._profileManager.getProfiles() });
    this._sendButtonProfiles();
  }

  private _handleLaunchProfile(
    profileId: string,
    itemId?: string,
    cwdOverride?: string,
    labelOverride?: string,
    extraArgs?: string,
  ): void {
    if (!this._profileManager) return;
    const profile = this._profileManager.getProfile(profileId);
    if (!profile) return;

    const sessionType = agentTypeToSessionType(profile.agentType, profile.useContext);
    const command = this._profileManager.resolveCommand(profile);
    // CWD resolution: launch override > per-task CWD > profile CWD > global setting
    const itemCwd = itemId ? this._resolveItemCwd(itemId) : undefined;
    const cwd = cwdOverride || itemCwd || this._profileManager.resolveCwd(profile);
    const label = labelOverride || profile.name;
    const contextPrompt = this._profileManager.resolveContextPrompt(profile);

    const resolvedArgs = extraArgs ?? this._profileManager.resolveArguments(profile);
    const args = resolvedArgs ? parseExtraArgs(resolvedArgs) : undefined;

    this._terminalManager.createTerminal({
      sessionType,
      itemId,
      command,
      cwd,
      label,
      args,
      contextPrompt,
    });
  }

  private async _handleImportProfiles(): Promise<void> {
    if (!this._profileManager) return;

    const fileUris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { JSON: ["json"] },
      title: "Import Agent Profiles",
    });

    if (!fileUris || fileUris.length === 0) return;

    const content = await vscode.workspace.fs.readFile(fileUris[0]);
    const json = new TextDecoder().decode(content);
    const result = await this._profileManager.importProfiles(json);

    if (result.errors.length > 0) {
      vscode.window.showWarningMessage(
        `Imported ${result.imported} profile(s) with ${result.errors.length} error(s): ${result.errors.join("; ")}`,
      );
    } else {
      vscode.window.showInformationMessage(`Imported ${result.imported} profile(s).`);
    }

    this.postMessage({ type: "profileList", profiles: this._profileManager.getProfiles() });
    this._sendButtonProfiles();
  }

  private async _handleExportProfiles(): Promise<void> {
    if (!this._profileManager) return;

    const json = this._profileManager.exportProfiles();
    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file("agent-profiles.json"),
      filters: { JSON: ["json"] },
      title: "Export Agent Profiles",
    });

    if (!saveUri) return;

    await vscode.workspace.fs.writeFile(saveUri, new TextEncoder().encode(json));
    vscode.window.showInformationMessage("Profiles exported.");
  }

  private async _handleMoveProfile(profileId: string, direction: "up" | "down"): Promise<void> {
    if (!this._profileManager) return;

    const profiles = this._profileManager.getProfiles();
    const ids = profiles.map((p) => p.id);
    const index = ids.indexOf(profileId);
    if (index === -1) return;

    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= ids.length) return;

    // Swap
    [ids[index], ids[targetIndex]] = [ids[targetIndex], ids[index]];
    await this._profileManager.reorderProfiles(ids);
    this.postMessage({ type: "profileList", profiles: this._profileManager.getProfiles() });
  }

  /**
   * Show the launch modal QuickPick flow and handle the result.
   */
  async showLaunchModal(itemId?: string): Promise<void> {
    if (!this._profileManager) {
      vscode.window.showInformationMessage("Profile manager not initialized.");
      return;
    }

    const recentlyClosed = this._sessionManager
      ? this._sessionManager.getRecentlyClosed(undefined, 10)
      : [];

    const config = vscode.workspace.getConfiguration("workTerminal");
    const defaultCwd = config.get<string>("defaultTerminalCwd", "~");

    const result = await showLaunchModal({
      profileManager: this._profileManager,
      recentlyClosed,
      defaultCwd,
    });

    if (!result) return;

    if (result.mode === "launch") {
      this._handleLaunchProfile(
        result.profile.id,
        itemId,
        result.cwdOverride,
        result.labelOverride,
        result.extraArgs,
      );
    } else if (result.mode === "restore") {
      const entry = result.entry;
      if (result.recoveryMode === "resume" && entry.claudeSessionId) {
        // Resume with existing session ID
        this._terminalManager.createTerminal({
          sessionType: entry.sessionType,
          itemId: entry.itemId,
          label: entry.label,
          cwd: entry.cwd,
          resumeSessionId: entry.claudeSessionId,
        });
      } else {
        // Relaunch fresh
        this._terminalManager.createTerminal({
          sessionType: entry.sessionType,
          itemId: entry.itemId,
          label: entry.label,
          cwd: entry.cwd,
          command: entry.command,
          args: entry.commandArgs,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Hook installation / removal
  // ---------------------------------------------------------------------------

  private _getHookCwd(): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder?.uri.fsPath ?? require("os").homedir();
  }

  private async _handleInstallHooks(): Promise<void> {
    const cwd = this._getHookCwd();
    try {
      await installHooks(cwd);
      vscode.window.showInformationMessage("Claude hooks installed successfully.");
      this._refreshHookState();
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to install hooks: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async handleRemoveHooks(): Promise<void> {
    const cwd = this._getHookCwd();
    try {
      await removeHooks(cwd);
      vscode.window.showInformationMessage("Claude hooks removed successfully.");
      this._refreshHookState();
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to remove hooks: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Push current hook status to the webview and re-check the banner. */
  private _refreshHookState(): void {
    const cwd = this._getHookCwd();
    const status = checkHookStatus(cwd);
    const installed = status.scriptExists && status.hooksConfigured;
    this.postMessage({ type: "hookStatusChanged", installed });
    this._hookBannerService.recheckNow();
  }

  /** Get current hook status (used by commands). */
  getHookStatus(): { scriptExists: boolean; hooksConfigured: boolean } {
    return checkHookStatus(this._getHookCwd());
  }

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  /**
   * Collect a snapshot of extension state for debugging and support.
   */
  async collectDiagnostics(): Promise<string> {
    const lines: string[] = [];
    const ext = vscode.extensions.getExtension("tomcorke.vscode-work-terminal-v2");
    const version = ext?.packageJSON?.version ?? "unknown";
    lines.push(`# Work Terminal Diagnostics`);
    lines.push(`Version: ${version}`);
    lines.push(`Timestamp: ${new Date().toISOString()}`);
    lines.push("");

    // Active sessions
    const allSessions = this._terminalManager.getAllSessionInfo();
    lines.push(`## Active Sessions (${allSessions.length})`);
    if (allSessions.length === 0) {
      lines.push("(none)");
    } else {
      for (const s of allSessions) {
        const state = s.itemId
          ? this._terminalManager.getAgentState(s.itemId)
          : "n/a";
        lines.push(
          `- [${s.sessionType}] "${s.label}" (session: ${s.sessionId}, item: ${s.itemId ?? "unattached"}, agent state: ${state})`,
        );
      }
    }
    lines.push("");

    // Work items
    if (this._workItemService) {
      const items = this._workItemService.getItems();
      const grouped = this._workItemService.getGrouped();
      lines.push(`## Work Items (${items.length})`);
      for (const [column, columnItems] of Object.entries(grouped)) {
        lines.push(`### ${column} (${columnItems.length})`);
        for (const item of columnItems) {
          const sessionCount = this._terminalManager.getSessionsForItem(item.id).length;
          lines.push(`- "${item.title}" (id: ${item.id}, terminals: ${sessionCount})`);
        }
      }
    } else {
      lines.push("## Work Items");
      lines.push("(service not initialized)");
    }
    lines.push("");

    // Recently closed
    if (this._sessionManager) {
      const recentlyClosed = this._sessionManager.getRecentlyClosed(undefined, 10);
      lines.push(`## Recently Closed (${recentlyClosed.length})`);
      if (recentlyClosed.length === 0) {
        lines.push("(none)");
      } else {
        for (const entry of recentlyClosed) {
          const age = Math.round((Date.now() - entry.closedAt) / 1000);
          lines.push(
            `- [${entry.sessionType}] "${entry.label}" (item: ${entry.itemId}, closed: ${age}s ago, recovery: ${entry.recoveryMode})`,
          );
        }
      }
    }
    lines.push("");

    // Agent profiles
    if (this._profileManager) {
      const profiles = this._profileManager.getProfiles();
      lines.push(`## Agent Profiles (${profiles.length})`);
      for (const p of profiles) {
        lines.push(`- "${p.name}" (type: ${p.agentType}, id: ${p.id})`);
      }
    }
    lines.push("");

    // Diagnostics / problem detection
    lines.push("## Derived Diagnostics");
    const problems: string[] = [];

    // Sessions with no item attached
    const unattached = allSessions.filter((s) => !s.itemId);
    if (unattached.length > 0) {
      problems.push(`${unattached.length} session(s) with no work item attached`);
    }

    // Items with active sessions but in non-active columns
    if (this._workItemService) {
      const grouped = this._workItemService.getGrouped();
      for (const [column, columnItems] of Object.entries(grouped)) {
        if (column === "active") continue;
        for (const item of columnItems) {
          const sessions = this._terminalManager.getSessionsForItem(item.id);
          if (sessions.length > 0) {
            problems.push(
              `Item "${item.title}" in "${column}" has ${sessions.length} active terminal(s)`,
            );
          }
        }
      }
    }

    // Orphaned session trackers
    const orphanedTrackers: string[] = [];
    for (const [sessionId] of this._sessionTrackers) {
      if (!this._terminalManager.getSessionInfo(sessionId)) {
        orphanedTrackers.push(sessionId);
      }
    }
    if (orphanedTrackers.length > 0) {
      problems.push(`${orphanedTrackers.length} orphaned session tracker(s)`);
    }

    if (problems.length === 0) {
      lines.push("No problems detected.");
    } else {
      for (const p of problems) {
        lines.push(`- ${p}`);
      }
    }

    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // HTML generation
  // ---------------------------------------------------------------------------

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "dist", "webview.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "dist", "styles.css"),
    );

    const htmlPath = path.join(
      this._extensionUri.fsPath,
      "src",
      "webview",
      "index.html",
    );
    let html = fs.readFileSync(htmlPath, "utf-8");

    html = html
      .replaceAll("{{nonce}}", nonce)
      .replaceAll("{{cspSource}}", webview.cspSource)
      .replaceAll("{{webviewUri}}", scriptUri.toString())
      .replaceAll("{{styleUri}}", styleUri.toString());

    return html;
  }
}
