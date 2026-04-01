import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { WebviewMessage, ExtensionMessage } from "../webview/messages";
import { WorkItemService } from "../services/WorkItemService";
import { FileWatcher } from "../services/FileWatcher";
import type { AdapterBundle } from "../core/interfaces";
import { getNonce, expandTilde } from "../core/utils";
import { TerminalManager } from "../terminal/TerminalManager";
import { isSessionType, type SessionType } from "../core/session/types";
import { SessionManager } from "../session/SessionManager";
import { AgentProfileManager } from "../agents/AgentProfileManager";
import { AgentSessionTracker } from "../agents/AgentSessionTracker";
import { agentTypeToSessionType } from "../core/agents/types";
import type { AgentProfile } from "../core/agents/types";
import { showLaunchModal, type LaunchModalResult } from "../agents/AgentLaunchModal";
import { parseExtraArgs } from "../terminal/AgentLauncher";

/**
 * Singleton panel that hosts the 2-panel webview layout.
 * Wires up FileWatcher and WorkItemService to drive the list panel.
 */
export class WorkTerminalPanel {
  public static current: WorkTerminalPanel | undefined;
  public static onItemsUpdated:
    | ((items: import("../webview/messages").WorkItemDTO[], columns: string[]) => void)
    | null = null;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposed = false;

  private _workItemService: WorkItemService | null = null;
  private _fileWatcher: FileWatcher | null = null;
  private _adapter: AdapterBundle | null = null;
  private _globalState: vscode.Memento | null = null;
  private readonly _terminalManager: TerminalManager;
  private _sessionManager: SessionManager | null = null;
  private _profileManager: AgentProfileManager | null = null;
  private readonly _sessionTrackers = new Map<string, AgentSessionTracker>();

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
      WorkTerminalPanel.current = undefined;
    });

    this._panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      this._handleMessage(message);
    });

    this._panel.webview.html = this._getHtml(this._panel.webview);

    // Wire up terminal manager callbacks
    this._terminalManager.onOutput = (sessionId, data) => {
      this.postMessage({ type: "terminalOutput", sessionId, data });
    };
    this._terminalManager.onCreated = (sessionId, label, sessionType) => {
      this.postMessage({ type: "terminalCreated", sessionId, label, sessionType });
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
        }).catch((err) => {
          console.error("[work-terminal] Session close tracking failed:", err);
        });
      }
      // Notify webview of updated session state for the item
      if (closingItemId) {
        this._postSessionStateForItem(closingItemId);
      }
    };
    this._terminalManager.onAgentStateChanged = (sessionId, state) => {
      this.postMessage({ type: "agentStateChanged", sessionId, state });
    };
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

    // Resolve base path against workspace (only if relative)
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const resolvedBase = path.isAbsolute(basePath)
      ? basePath
      : workspaceFolder
        ? path.join(workspaceFolder.uri.fsPath, basePath)
        : basePath;
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
    );

    // Initial load
    await this._refreshItems();
  }

  reveal(): void {
    if (!this._disposed) {
      this._panel.reveal();
    }
  }

  dispose(): void {
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

    const config = vscode.workspace.getConfiguration("workTerminal");
    const keepAlive = config.get<boolean>("keepSessionsAlive", true);
    if (!keepAlive) {
      this._terminalManager.disposeAll();
    }

    this._panel.dispose();
  }

  /**
   * Post a typed message to the webview.
   */
  postMessage(message: ExtensionMessage): void {
    if (!this._disposed) {
      this._panel.webview.postMessage(message);
    }
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
    this.postMessage({ type: "sessionStateChanged", itemId, sessions });
  }

  // ---------------------------------------------------------------------------
  // Item refresh
  // ---------------------------------------------------------------------------

  private async _refreshItems(): Promise<void> {
    if (!this._workItemService) return;

    await this._workItemService.loadAll();
    const items = this._workItemService.toDTOs();
    const columns = this._workItemService.getColumns();

    this.postMessage({ type: "updateItems", items, columns });

    // Notify sidebar of updated items
    WorkTerminalPanel.onItemsUpdated?.(items, columns);
  }

  /**
   * Called when workTerminal.* settings change. Re-initializes the
   * WorkItemService with updated configuration.
   */
  async onSettingsChanged(adapter: AdapterBundle): Promise<void> {
    if (!this._workItemService || !this._globalState) return;

    const config = vscode.workspace.getConfiguration("workTerminal");
    const basePath = config.get<string>("taskBasePath", "2 - Areas/Tasks");

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const resolvedBase = path.isAbsolute(basePath)
      ? basePath
      : workspaceFolder
        ? path.join(workspaceFolder.uri.fsPath, basePath)
        : basePath;

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
    );

    await this._refreshItems();
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private _handleMessage(message: WebviewMessage): void {
    switch (message.type) {
      case "ready":
        this._refreshItems();
        break;
      case "itemSelected":
        // Selection is tracked in webview; extension can react here
        // (e.g. open terminals for the selected item)
        break;
      case "createItem":
        this._handleCreateItem(message.title, message.column);
        break;
      case "deleteItem":
        this._handleDeleteItem(message.id);
        break;
      case "moveItem":
        this._handleMoveItem(message.id, message.toColumn, message.index);
        break;
      case "dragDrop":
        this._handleDragDrop(message.itemId, message.toColumn, message.index);
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
        this._handleSaveProfile(message.profile);
        break;
      case "deleteProfile":
        this._handleDeleteProfile(message.profileId);
        break;
      case "reorderProfiles":
        this._handleReorderProfiles(message.orderedIds);
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
        this._handleImportProfiles();
        break;
      case "exportProfiles":
        this._handleExportProfiles();
        break;
      case "moveProfileUp":
        this._handleMoveProfile(message.profileId, "up");
        break;
      case "moveProfileDown":
        this._handleMoveProfile(message.profileId, "down");
        break;
      default:
        break;
    }
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
    await this._workItemService.createItem(title, column);
    await this._refreshItems();
  }

  private async _handleDeleteItem(id: string): Promise<void> {
    if (!this._workItemService) return;
    await this._workItemService.deleteItem(id);
    await this._refreshItems();
  }

  private async _handleMoveItem(id: string, toColumn: string, index: number): Promise<void> {
    if (!this._workItemService) return;
    await this._workItemService.moveItem(id, toColumn, index);
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
    this._terminalManager.createTerminal({
      sessionType: entry.sessionType,
      itemId: entry.itemId,
      label: entry.label,
      cwd: entry.cwd,
      command: entry.command,
      args: entry.commandArgs,
    });
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
  }

  private async _handleDeleteProfile(profileId: string): Promise<void> {
    if (!this._profileManager) return;
    await this._profileManager.deleteProfile(profileId);
    this.postMessage({ type: "profileDeleted", profileId });
    this.postMessage({ type: "profileList", profiles: this._profileManager.getProfiles() });
  }

  private async _handleReorderProfiles(orderedIds: string[]): Promise<void> {
    if (!this._profileManager) return;
    await this._profileManager.reorderProfiles(orderedIds);
    this.postMessage({ type: "profileList", profiles: this._profileManager.getProfiles() });
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
          command: entry.command,
          args: entry.commandArgs,
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
