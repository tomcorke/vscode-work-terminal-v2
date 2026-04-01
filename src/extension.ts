import * as vscode from "vscode";
import { WorkTerminalPanel } from "./panels/WorkTerminalPanel";

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
    vscode.commands.registerCommand("workTerminal.openPanel", async () => {
      const panel = WorkTerminalPanel.createOrShow(context.extensionUri);
      // Initialize session manager if not already done
      if (!panel.sessionManager) {
        await panel.initSessionManager(context);
      }
      // Initialize profile manager if not already done
      if (!panel.profileManager) {
        await panel.initProfileManager(context.globalState);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("workTerminal.manageProfiles", () => {
      const panel = WorkTerminalPanel.current;
      if (!panel?.profileManager) {
        vscode.window.showInformationMessage("Open the Work Terminal panel first.");
        return;
      }
      panel.postMessage({
        type: "profileList",
        profiles: panel.profileManager.getProfiles(),
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("workTerminal.reopenClosedTerminal", () => {
      const panel = WorkTerminalPanel.current;
      if (!panel?.sessionManager) return;
      const entry = panel.sessionManager.popRecentlyClosed();
      if (!entry) {
        vscode.window.showInformationMessage("No recently closed terminals to reopen.");
        return;
      }
      // Send message to panel to reopen
      panel.postMessage({
        type: "terminalCreated",
        sessionId: "",
        label: entry.label,
        sessionType: entry.sessionType,
      });
    })
  );
}

export function deactivate() {
  const panel = WorkTerminalPanel.current;
  if (panel) {
    // Session persistence is handled in panel.dispose()
    panel.dispose();
  }
}
