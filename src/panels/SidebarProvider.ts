import * as vscode from "vscode";
import type { WorkItemDTO, ExtensionMessage, WebviewMessage } from "../webview/messages";
import { getNonce } from "../core/utils";

/**
 * Sidebar webview provider showing full-fidelity work item cards.
 * Clicking a card opens the panel with the terminal focused on that item.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "workTerminal.sidebarView";

  private _view: vscode.WebviewView | undefined;
  private _ready = false;
  private _items: WorkItemDTO[] = [];
  private _columns: string[] = [];
  private _pendingMessages: ExtensionMessage[] = [];

  /** Callback to forward messages to the main panel. Set by extension.ts. */
  public onForwardToPanel: ((message: WebviewMessage) => void) | null = null;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    this._ready = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, "dist"),
      ],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      switch (message.type) {
        case "ready":
          this._ready = true;
          this._sendItems();
          // Flush any messages that arrived before webview was ready
          for (const msg of this._pendingMessages) {
            this._view?.webview.postMessage(msg);
          }
          this._pendingMessages = [];
          break;
        case "itemSelected":
          // Open the panel and focus the terminal for this item
          (async () => {
            await vscode.commands.executeCommand("workTerminal.openPanel");
            await vscode.commands.executeCommand(
              "workTerminal.selectItem",
              message.id,
            );
          })();
          break;
        case "createItem":
          // Forward to panel
          this._forwardToPanel(message);
          break;
        case "contextMenuMove":
        case "contextMenuDelete":
        case "doneAndCloseSessions":
        case "moveToTop":
        case "dragDrop":
        case "copyToClipboard":
        case "resumeItem":
          // Forward these messages to the panel's message handler
          this._forwardToPanel(message);
          break;
      }
    });

    webviewView.onDidDispose(() => {
      this._view = undefined;
      this._ready = false;
    });
  }

  /**
   * Forward a webview message from the sidebar to the main panel.
   * Opens the panel first if it is not already open, ensuring sidebar
   * actions (move, delete, drag-drop, etc.) are never silently dropped.
   */
  private async _forwardToPanel(message: WebviewMessage): Promise<void> {
    if (!this.onForwardToPanel) return;

    // Ensure the panel is open before forwarding mutating actions
    await vscode.commands.executeCommand("workTerminal.openPanel");

    this.onForwardToPanel(message);
  }

  /**
   * Update the sidebar with fresh item data (called by extension when items change).
   */
  updateItems(items: WorkItemDTO[], columns: string[]): void {
    this._items = items;
    this._columns = columns;
    this._sendItems();
  }

  /**
   * Post a typed message to the sidebar webview.
   */
  postMessage(message: ExtensionMessage): void {
    if (this._view && this._ready) {
      this._view.webview.postMessage(message);
    } else if (this._view) {
      // Queue only while view exists but hasn't sent "ready" yet.
      // Don't queue when view is undefined (sidebar never opened) to
      // avoid unbounded memory growth in long sessions.
      this._pendingMessages.push(message);
    }
  }

  private _sendItems(): void {
    if (this._view) {
      this._view.webview.postMessage({
        type: "updateItems",
        items: this._items,
        columns: this._columns,
      } satisfies ExtensionMessage);
    }
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "dist", "sidebar.js"),
    );
    const mainStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "dist", "styles.css"),
    );
    const sidebarStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "dist", "sidebar.css"),
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${mainStyleUri}">
  <link rel="stylesheet" href="${sidebarStyleUri}">
  <title>Work Items</title>
</head>
<body>
  <div class="wt-sb-container">
    <div class="wt-sb-toolbar">
      <button class="wt-toolbar-icon-btn" id="sb-filter-toggle" title="Toggle filter" aria-label="Toggle filter">F</button>
      <button class="wt-toolbar-btn" id="sb-new-item">+ New</button>
    </div>
    <div class="wt-sb-filter-row" id="sb-filter-container" style="display: none;">
      <input type="text" class="wt-filter-input" id="sb-filter" placeholder="Filter items..." />
    </div>
    <div class="wt-sb-list" id="sb-list"></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
