/**
 * Mock of the vscode module for test environments.
 * VS Code extensions can't import the real module outside the extension host.
 */
import { vi } from "vitest";

export const Uri = {
  file: (path: string) => ({ fsPath: path, scheme: "file", path }),
  parse: (uri: string) => ({ fsPath: uri, scheme: "file", path: uri }),
};

export const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
};

export const workspace = {
  fs: {
    readFile: vi.fn().mockResolvedValue(new Uint8Array()),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readDirectory: vi.fn().mockResolvedValue([]),
    rename: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockRejectedValue(new Error("Not found")),
    createDirectory: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    copy: vi.fn().mockResolvedValue(undefined),
  },
  workspaceFolders: [],
  getConfiguration: vi.fn().mockReturnValue({
    get: vi.fn(),
    update: vi.fn(),
  }),
};

export const env = {
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(""),
  },
};

export const window = {
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  createOutputChannel: vi.fn().mockReturnValue({
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  }),
};

export const commands = {
  registerCommand: vi.fn(),
  executeCommand: vi.fn(),
};
