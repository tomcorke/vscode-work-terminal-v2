# VS Code Debugging Capabilities vs Obsidian CDP

Research into VS Code extension debugging equivalents for the obsidian-work-terminal CDP-based development workflow.

## Capability mapping

| Obsidian approach | VS Code equivalent | Notes |
|---|---|---|
| `--remote-debugging-port=9222` | `--remote-debugging-port=9222` | Identical - both are Electron apps |
| `--user-data-dir` for isolation | `--user-data-dir` + `--extensions-dir` | VS Code also needs separate extensions dir |
| `node cdp.js '<expr>'` (eval) | Same CDP protocol works | Connect to renderer, evaluate JS |
| `node cdp.js screenshot` | `Page.captureScreenshot` via CDP | Identical CDP command |
| `node cdp.js click/type/wait-for` | `Input.dispatch*` via CDP | Identical CDP commands |
| `window.electron.remote.getCurrentWindow().hide()` | No equivalent - VS Code removed `remote` module | See limitations below |
| Obsidian `app.plugins.disablePlugin/enablePlugin` | `vscode.commands.executeCommand('workbench.action.reloadWindow')` | No graceful per-extension reload in VS Code |
| Seed vault with sample tasks | Seed workspace folder with test files | Simpler - just files, no vault config needed |
| `dismissTrustDialog()` via CDP | `--disable-workspace-trust` CLI flag | VS Code has a flag for this |
| Plugin symlink to repo dir | `--extensionDevelopmentPath=/path` | VS Code has native support, no symlink needed |

## Key differences from Obsidian

### Better in VS Code

- **No symlink dance** - `--extensionDevelopmentPath` loads extension directly from source
- **No trust dialog** - `--disable-workspace-trust` flag eliminates it
- **No singleton problem** - VS Code supports multiple instances natively with `--user-data-dir`
- **Built-in test framework** - `@vscode/test-electron` downloads/manages test VS Code binaries
- **E2E page objects** - `vscode-extension-tester` provides Selenium-based automation with pre-built page objects for every VS Code UI element including webviews
- **Extension host debugging** - `--inspect-extensions=<port>` gives V8 inspector access to extension code specifically (separate from renderer)

### Worse in VS Code

- **No hiding the window on macOS** - Obsidian uses `window.electron.remote.getCurrentWindow().hide()`, but VS Code removed the Electron `remote` module. No equivalent CDP trick to hide the window. On macOS, the window will always appear briefly.
- **No hot reload of extensions** - must reload the entire window (`Developer: Reload Window` / Ctrl+R). No equivalent to the Obsidian "reload plugin preserve terminals" command.
- **Webview debugging is indirect** - webviews live in separate iframes. Need to enumerate CDP targets and find the right one, or use `Developer: Open Webview Developer Tools`.

## Recommended architecture

### Development helper (`vsc.js` - equivalent to `cdp.js`)

```
vsc.js                    # CLI entry point
vsc.js '<expr>'           # eval in renderer
vsc.js screenshot [path]  # capture screenshot
vsc.js click '.selector'  # click element
vsc.js wait-for '.sel'    # wait for selector
vsc.js webview '<expr>'   # eval inside webview iframe
vsc.js reload             # trigger workbench.action.reloadWindow
```

### Isolated instance launcher (`vsc-test.js`)

```bash
# Launch isolated VS Code with extension loaded
node vsc-test.js open \
  --workspace ./test-fixtures \
  --port 9222

# Equivalent to:
code \
  --extensionDevelopmentPath=$PWD \
  --user-data-dir=/tmp/vsc-wt-test-XXXX \
  --extensions-dir=/tmp/vsc-wt-ext-XXXX \
  --disable-extensions \
  --disable-workspace-trust \
  --skip-welcome \
  --skip-release-notes \
  --disable-updates \
  --remote-debugging-port=9222 \
  ./test-fixtures
```

### Key flags for full isolation

- `--user-data-dir` - separate settings/state
- `--extensions-dir` - separate extension install dir
- `--disable-extensions` - only load ours via `--extensionDevelopmentPath`
- `--remote-debugging-port` - CDP access for automation
- `--inspect-extensions` - V8 debugger for extension code

### Window hiding limitation

On macOS, the window will flash briefly. No workaround exists without the Electron `remote` module. For CI, use `xvfb-run` on Linux. For local dev, the window appearing is acceptable since VS Code supports multiple windows natively (unlike Obsidian's singleton).

## Testing stack recommendation

| Layer | Tool | Purpose |
|---|---|---|
| Unit tests | Vitest | Pure logic, parsers, state machines |
| Integration tests | `@vscode/test-electron` | Tests with real VS Code API access |
| E2E / UI tests | CDP helper (`vsc.js`) | Screenshot, click, eval in webview |
| CI | `@vscode/test-electron` + xvfb | Headless on Linux runners |
