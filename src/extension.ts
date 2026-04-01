import * as vscode from "vscode";
import { spawn } from "child_process";
import { WorkTerminalPanel } from "./panels/WorkTerminalPanel";
import { SidebarProvider } from "./panels/SidebarProvider";
import { TaskAgentAdapter } from "./adapters/task-agent/index";
import { checkHookStatus, installHooks, removeHooks } from "./agents/ClaudeHookManager";
import { createNodePtyRebuildPlan } from "./terminal/nodePtySupport";

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

  // Wire sidebar message forwarding (session state, agent state, etc.)
  WorkTerminalPanel.onSidebarPost = (message) => {
    sidebarProvider.postMessage(message);
  };

  // Wire sidebar -> panel forwarding (replaces runtime require() in SidebarProvider)
  sidebarProvider.onForwardToPanel = (message) => {
    WorkTerminalPanel.current?.handleSidebarMessage(message);
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
    vscode.commands.registerCommand("workTerminal.selectItem", async (itemId: string) => {
      await vscode.commands.executeCommand("workTerminal.openPanel");
      const panel = WorkTerminalPanel.current;
      if (panel) {
        await panel.selectItemFromSidebar(itemId);
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
    vscode.commands.registerCommand("workTerminal.resetTour", async () => {
      // Clear extension-tracked tour completion state
      await context.globalState.update("tourCompleted", undefined);
      // Re-open the walkthrough so the user can go through it again
      await vscode.commands.executeCommand(
        "workbench.action.openWalkthrough",
        "tomcorke.vscode-work-terminal-v2#workTerminal.gettingStarted",
        false,
      );
      vscode.window.showInformationMessage("Guided tour has been reset.");
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

  context.subscriptions.push(
    vscode.commands.registerCommand("workTerminal.rebuildNodePty", async () => {
      const extension = vscode.extensions.getExtension("tomcorke.vscode-work-terminal-v2");
      const canRepairLocally =
        extension?.extensionMode === vscode.ExtensionMode.Development
        || extension?.extensionMode === vscode.ExtensionMode.Test;
      if (!canRepairLocally) {
        vscode.window.showInformationMessage(
          "node-pty rebuild is only available from a local Extension Development Host.",
        );
        return;
      }

      let plan;
      try {
        plan = createNodePtyRebuildPlan(process.versions.electron);
      } catch (err) {
        vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
        return;
      }

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Rebuilding node-pty for Electron ${process.versions.electron}`,
          },
          () => new Promise<void>((resolve, reject) => {
            const child = spawn(plan.command, plan.args, {
              cwd: context.extensionPath,
              env: {
                ...process.env,
                ...plan.env,
              },
              stdio: "pipe",
            });

            let stdout = "";
            let stderr = "";
            child.stdout?.on("data", (chunk: Buffer) => {
              stdout += chunk.toString("utf8");
            });
            child.stderr?.on("data", (chunk: Buffer) => {
              stderr += chunk.toString("utf8");
            });

            child.on("error", reject);
            child.on("exit", (code, signal) => {
              if (code === 0) {
                resolve();
                return;
              }

              const combinedOutput = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n\n");
              const fallbackReason =
                signal != null
                  ? `node-pty rebuild failed due to signal ${signal}.`
                  : `node-pty rebuild failed with exit code ${code ?? "unknown"}.`;
              reject(new Error(combinedOutput || fallbackReason));
            });
          }),
        );

        const action = await vscode.window.showInformationMessage(
          "node-pty rebuilt successfully. Reload VS Code to pick up the new native module.",
          "Reload Window",
        );
        if (action === "Reload Window") {
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to rebuild node-pty: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );

  // Hook management commands (work without the panel open)
  context.subscriptions.push(
    vscode.commands.registerCommand("workTerminal.hookStatus", () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? require("os").homedir();
      const status = checkHookStatus(cwd);
      const installed = status.scriptExists && status.hooksConfigured;
      if (installed) {
        vscode.window.showInformationMessage("Claude hooks: installed and configured.");
      } else if (status.scriptExists) {
        vscode.window.showWarningMessage("Claude hooks: script exists but settings entries are missing.");
      } else if (status.hooksConfigured) {
        vscode.window.showWarningMessage("Claude hooks: settings entries exist but hook script is missing.");
      } else {
        vscode.window.showWarningMessage("Claude hooks: not installed.");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("workTerminal.installHooks", async () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? require("os").homedir();
      try {
        await installHooks(cwd);
        vscode.window.showInformationMessage("Claude hooks installed successfully.");
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to install hooks: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("workTerminal.removeHooks", async () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? require("os").homedir();
      try {
        await removeHooks(cwd);
        vscode.window.showInformationMessage("Claude hooks removed successfully.");
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to remove hooks: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
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
