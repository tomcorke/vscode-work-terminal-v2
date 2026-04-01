import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { WebviewMessage, ExtensionMessage } from "../webview/messages";

/**
 * Singleton panel that hosts the 2-panel webview layout.
 */
export class WorkTerminalPanel {
  public static current: WorkTerminalPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposed = false;

  private constructor(extensionUri: vscode.Uri) {
    this._extensionUri = extensionUri;

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
      WorkTerminalPanel.current = undefined;
    });

    this._panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      this._handleMessage(message);
    });

    this._panel.webview.html = this._getHtml(this._panel.webview);
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

  reveal(): void {
    if (!this._disposed) {
      this._panel.reveal();
    }
  }

  dispose(): void {
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
  // Message handling
  // ---------------------------------------------------------------------------

  private _handleMessage(message: WebviewMessage): void {
    switch (message.type) {
      case "ready":
        // Webview is initialized - send initial data
        break;
      case "itemSelected":
        // Will be implemented in list panel feature
        break;
      case "createItem":
        // Will be implemented in list panel feature
        break;
      case "filterChanged":
        // Will be implemented in list panel feature
        break;
      case "launchTerminal":
        // Will be implemented in terminal integration feature
        break;
      case "terminalInput":
        // Will be implemented in terminal integration feature
        break;
      default:
        break;
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

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
