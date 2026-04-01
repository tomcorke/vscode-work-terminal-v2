import * as vscode from "vscode";
import { WorkTerminalPanel } from "./panels/WorkTerminalPanel";
import { SidebarProvider } from "./panels/SidebarProvider";
import { TaskAgentAdapter } from "./adapters/task-agent/index";
import { checkHookStatus, installHooks, removeHooks } from "./agents/ClaudeHookManager";

export function activate(context: vscode.ExtensionContext) {
  const sidebarProvider = new SidebarProvider(context.extensionUri);
  const adapter = new TaskAgentAdapter();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewType,
      sidebarProvider,
    ),
  );

  // Wire sidebar updates from WorkTerminalPanel item refreshes
  WorkTerminalPanel.onItemsUpdated = (items, columns) => {
    sidebarProvider.updateItems(items, columns);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("workTerminal.openPanel", async () => {
      const panel = WorkTerminalPanel.createOrShow(context.extensionUri);
      // Initialize services (adapter, parser, mover, file watcher) if not already done
      if (!panel.isServicesInitialized) {
        await panel.initServices(adapter, context.globalState);
      }
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
    vscode.commands.registerCommand("workTerminal.launchAgent", async () => {
      const panel = WorkTerminalPanel.current;
      if (!panel?.profileManager) {
        vscode.window.showInformationMessage("Open the Work Terminal panel first.");
        return;
      }
      await panel.showLaunchModal();
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

  context.subscriptions.push(
    vscode.commands.registerCommand("workTerminal.selectItem", (itemId: string) => {
      const panel = WorkTerminalPanel.current;
      if (panel) {
        panel.postMessage({ type: "selectItem", itemId });
      }
    }),
  );

  // Settings change listener
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("workTerminal")) return;
      const panel = WorkTerminalPanel.current;
      if (panel) {
        panel.onSettingsChanged(adapter);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("workTerminal.togglePanel", async () => {
      const current = WorkTerminalPanel.current;
      if (current) {
        if (!(await WorkTerminalPanel.confirmClose())) return;
        current.dispose();
        return;
      }
      // Create and initialize panel (same as openPanel)
      const panel = WorkTerminalPanel.createOrShow(context.extensionUri);
      if (!panel.isServicesInitialized) {
        await panel.initServices(adapter, context.globalState);
      }
      if (!panel.sessionManager) {
        await panel.initSessionManager(context);
      }
      if (!panel.profileManager) {
        await panel.initProfileManager(context.globalState);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("workTerminal.newWorkItem", () => {
      const panel = WorkTerminalPanel.current;
      if (!panel) {
        vscode.window.showInformationMessage("Open the Work Terminal panel first.");
        return;
      }
      panel.postMessage({ type: "requestCreateItem" });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("workTerminal.newShell", () => {
      const panel = WorkTerminalPanel.current;
      if (!panel) {
        vscode.window.showInformationMessage("Open the Work Terminal panel first.");
        return;
      }
      panel.postMessage({ type: "requestCreateTerminal", terminalType: "shell" });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("workTerminal.newClaude", () => {
      const panel = WorkTerminalPanel.current;
      if (!panel) {
        vscode.window.showInformationMessage("Open the Work Terminal panel first.");
        return;
      }
      panel.postMessage({ type: "requestCreateTerminal", terminalType: "claude" });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("workTerminal.closeActiveTerminal", () => {
      const panel = WorkTerminalPanel.current;
      if (!panel) return;
      panel.postMessage({ type: "requestCloseActiveTerminal" });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("workTerminal.focusFilter", () => {
      const panel = WorkTerminalPanel.current;
      if (!panel) {
        vscode.window.showInformationMessage("Open the Work Terminal panel first.");
        return;
      }
      panel.postMessage({ type: "focusFilter" });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("workTerminal.startTour", () => {
      vscode.commands.executeCommand(
        "workbench.action.openWalkthrough",
        "tomcorke.vscode-work-terminal-v2#workTerminal.gettingStarted",
        false,
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("workTerminal.copyDiagnostics", async () => {
      const panel = WorkTerminalPanel.current;
      if (!panel) {
        vscode.window.showInformationMessage("Open the Work Terminal panel first.");
        return;
      }
      const text = await panel.collectDiagnostics();
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage("Session diagnostics copied to clipboard.");
    })
  );
}

export async function deactivate(): Promise<void> {
  const panel = WorkTerminalPanel.current;
  if (panel) {
    // Best-effort: persist sessions before teardown.
    // Cannot show UI here - VS Code is already shutting down.
    panel.dispose();
  }
}
