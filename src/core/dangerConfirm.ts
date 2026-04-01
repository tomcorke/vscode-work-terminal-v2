import * as vscode from "vscode";

/**
 * Show a modal warning dialog for destructive operations.
 * Returns true if the user confirms, false if they cancel.
 */
export async function dangerConfirm(label: string): Promise<boolean> {
  const confirm = "Confirm";
  const result = await vscode.window.showWarningMessage(
    `Are you sure you want to: ${label}?`,
    { modal: true },
    confirm,
  );
  return result === confirm;
}
