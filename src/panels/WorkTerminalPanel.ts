import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { WebviewMessage, ExtensionMessage } from "../webview/messages";
import { WorkItemService } from "../services/WorkItemService";
import { FileWatcher } from "../services/FileWatcher";
import type { AdapterBundle } from "../core/interfaces";
import { TerminalManager } from "../terminal/TerminalManager";
import type { SessionType } from "../core/session/types";

/**
 * Singleton panel that hosts the 2-panel webview layout.
 * Wires up FileWatcher and WorkItemService to drive the list panel.
 */
export class WorkTerminalPanel {
  public static current: WorkTerminalPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposed = false;

  private _workItemService: WorkItemService | null = null;
  private _fileWatcher: FileWatcher | null = null;
  private _adapter: AdapterBundle | null = null;
  private readonly _terminalManager: TerminalManager;

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
      this._disposed = true;
      this._fileWatcher?.dispose();
      this._terminalManager.disposeAll();
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
    };
    this._terminalManager.onClosed = (sessionId) => {
      this.postMessage({ type: "terminalClosed", sessionId });
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
   * Initialize the work item service and file watcher with the given adapter.
   */
  async initServices(
    adapter: AdapterBundle,
    globalState: vscode.Memento,
  ): Promise<void> {
    this._adapter = adapter;
    const config = vscode.workspace.getConfiguration("workTerminal");
    const basePath = config.get<string>("taskBasePath", "2 - Areas/Tasks");

    // Resolve base path against workspace
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const resolvedBase = workspaceFolder
      ? path.join(workspaceFolder.uri.fsPath, basePath)
      : basePath;

    const settings: Record<string, unknown> = {
      "adapter.taskBasePath": basePath,
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
    this._fileWatcher?.dispose();
    this._terminalManager.disposeAll();
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
  // Item refresh
  // ---------------------------------------------------------------------------

  private async _refreshItems(): Promise<void> {
    if (!this._workItemService) return;

    await this._workItemService.loadAll();
    const items = this._workItemService.toDTOs();
    const columns = this._workItemService.getColumns();

    this.postMessage({ type: "updateItems", items, columns });
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
      default:
        break;
    }
  }

  private async _handleCreateItem(title: string, column?: string): Promise<void> {
    if (!this._workItemService) return;
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

    const currentColumn = item.state === "done" ? "done" : item.state;
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

  private _handleLaunchTerminal(itemId: string, profile?: string): void {
    const sessionType: SessionType = (profile as SessionType) || "shell";
    this._terminalManager.createTerminal({ sessionType, itemId });
  }

  private _handleCreateTerminal(terminalType: string, itemId?: string): void {
    const typeMap: Record<string, SessionType> = {
      shell: "shell",
      claude: "claude",
      copilot: "copilot",
    };
    const sessionType = typeMap[terminalType] || "shell";
    this._terminalManager.createTerminal({ sessionType, itemId });
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

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
