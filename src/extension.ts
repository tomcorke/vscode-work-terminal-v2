import * as vscode from "vscode";

let panel: WorkTerminalPanel | undefined;

class WorkTerminalPanel {
  private readonly _panel: vscode.WebviewPanel;
  private _disposed = false;

  constructor(extensionUri: vscode.Uri) {
    this._panel = vscode.window.createWebviewPanel(
      "workTerminal",
      "Work Terminal",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
      }
    );

    this._panel.onDidDispose(() => {
      this._disposed = true;
      panel = undefined;
    });

    this._panel.webview.onDidReceiveMessage((message) => {
      this._handleMessage(message);
    });

    this._panel.webview.html = this._getHtml(this._panel.webview, extensionUri);
  }

  private _handleMessage(_message: unknown) {
    // Message handling will be implemented as features are added
  }

  private _getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "dist", "webview.js")
    );
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Work Terminal</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  reveal() {
    if (!this._disposed) {
      this._panel.reveal();
    }
  }

  dispose() {
    this._panel.dispose();
  }
}

class WorkTerminalSidebarProvider implements vscode.WebviewViewProvider {
  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, "dist"),
      ],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);
  }

  private _getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "dist", "webview.js")
    );
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Work Items</title>
</head>
<body>
  <div id="sidebar-root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
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

export function activate(context: vscode.ExtensionContext) {
  const sidebarProvider = new WorkTerminalSidebarProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "workTerminal.sidebarView",
      sidebarProvider
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("workTerminal.openPanel", () => {
      if (panel) {
        panel.reveal();
      } else {
        panel = new WorkTerminalPanel(context.extensionUri);
      }
    })
  );
}

export function deactivate() {
  panel?.dispose();
  panel = undefined;
}
