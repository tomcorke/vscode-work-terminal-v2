import * as vscode from "vscode";
import type { WorkItemDTO, ExtensionMessage } from "../webview/messages";
import { getNonce } from "../core/utils";

/**
 * Sidebar webview provider showing a condensed work item list.
 * Shares WorkItemService data via extension messages rather than
 * duplicating item loading.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "workTerminal.sidebarView";

  private _view: vscode.WebviewView | undefined;
  private _items: WorkItemDTO[] = [];
  private _columns: string[] = [];

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, "dist"),
      ],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.type) {
        case "ready":
          this._sendItems();
          break;
        case "openPanel":
          vscode.commands.executeCommand("workTerminal.openPanel");
          break;
        case "selectItem":
          vscode.commands.executeCommand("workTerminal.openPanel");
          setTimeout(() => {
            vscode.commands.executeCommand(
              "workTerminal.selectItem",
              message.id,
            );
          }, 200);
          break;
      }
    });

    webviewView.onDidDispose(() => {
      this._view = undefined;
    });
  }

  /**
   * Update the sidebar with fresh item data (called by extension when items change).
   */
  updateItems(items: WorkItemDTO[], columns: string[]): void {
    this._items = items;
    this._columns = columns;
    this._sendItems();
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
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "dist", "sidebar.css"),
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Work Items</title>
</head>
<body>
  <div class="wt-sb-container">
    <div class="wt-sb-toolbar">
      <input type="text" class="wt-sb-filter" id="sb-filter" placeholder="Filter items..." />
    </div>
    <div class="wt-sb-list" id="sb-list"></div>
    <div class="wt-sb-footer">
      <button class="wt-sb-open-btn" id="sb-open-panel">Open Panel</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
