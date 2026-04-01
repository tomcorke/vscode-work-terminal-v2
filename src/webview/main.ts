import type { WebviewApi } from "../types/vscode";

const vscode: WebviewApi = acquireVsCodeApi();

interface IncomingMessage {
  type: string;
  [key: string]: unknown;
}

function postMessage(type: string, data?: Record<string, unknown>) {
  vscode.postMessage({ type, ...data });
}

window.addEventListener("message", (event: MessageEvent<IncomingMessage>) => {
  const message = event.data;
  switch (message.type) {
    // Message handlers will be added as features are implemented
    default:
      break;
  }
});

postMessage("ready");
