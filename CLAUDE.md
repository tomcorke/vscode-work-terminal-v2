# vscode-work-terminal-v2

VS Code extension: work item kanban board with per-item tabbed terminals and adapter-based extensibility.

## Architecture

Three-layer design. Each layer has clear responsibilities and boundaries:

```
src/
  core/              # Shared types, interfaces, utilities
    interfaces.ts    # AdapterBundle, BaseAdapter, WorkItem, all extension point interfaces
    types.ts         # FileRef (platform-agnostic file reference, replaces Obsidian TFile)
    utils.ts         # expandTilde, stripAnsi, slugify, getNonce, normalizeDisplayText
    frontmatter.ts   # YAML frontmatter parse/serialise
    dataStore.ts     # VS Code globalState wrapper
    session/types.ts # SessionType, StoredSession, PersistedSession
    agents/types.ts  # AgentProfile, AgentType, ProfileButton, brand colours

  panels/            # VS Code webview panels (singleton editor panel + sidebar)
    WorkTerminalPanel.ts  # 2-panel webview (list | terminals), message routing, service init
    SidebarProvider.ts    # Activity bar sidebar webview provider

  services/          # Extension host services
    WorkItemService.ts    # Item CRUD, column grouping, custom ordering
    FileWatcher.ts        # Workspace file system watcher for item changes

  session/           # Session lifecycle
    SessionManager.ts     # Terminal creation, resume, persistence orchestration
    SessionStore.ts       # In-memory session state (survives panel hide)
    SessionPersistence.ts # Disk persistence via globalState (7-day retention)
    RecentlyClosedStore.ts# Recently-closed stack for reopen

  terminal/          # Terminal process management
    TerminalManager.ts    # node-pty spawn, I/O routing to webview, resize
    AgentLauncher.ts      # Agent launch args, session ID generation, PATH augmentation
    AgentStateDetector.ts # Buffer-based agent state detection (active/idle/waiting)

  agents/            # Agent integration
    AgentLaunchModal.ts   # Quick-pick modal with profile selection
    AgentProfileManager.ts# Profile CRUD persisted in globalState
    AgentSessionTracker.ts# Per-session state tracking and aggregation
    AgentSessionRename.ts # Detects agent-chosen session names from terminal output
    AgentContextPrompt.ts # Builds context prompts from adapter + settings
    ClaudeHookManager.ts  # Hook scripts for Claude session resume tracking
    HeadlessClaude.ts     # Headless Claude for background enrichment

  webview/           # Browser-side webview code (IIFE bundles)
    main.ts          # Main panel entry point
    sidebarMain.ts   # Sidebar entry point
    listPanel.ts     # Kanban columns, drag-drop, card rendering
    terminalPanel.ts # Terminal tab bar, xterm.js integration
    profileManager.ts# Profile editor UI
    messages.ts      # Typed message protocol (webview <-> extension host)

  adapters/
    task-agent/      # Task-agent adapter (reference implementation)
      index.ts       # TaskAgentAdapter extending BaseAdapter
      types.ts       # TaskFile, TaskState, KanbanColumn, STATE_FOLDER_MAP
      TaskAgentConfig.ts   # PluginConfig: columns, creation columns, settings schema
      TaskParser.ts        # File-based parsing, frontmatter extraction, goal normalisation
      TaskMover.ts         # Frontmatter state updates, file moves, activity logging
      TaskCard.ts          # Card rendering with source/score/goal/blocker badges
      TaskFileTemplate.ts  # UUID + YAML frontmatter + slug filename generation
      TaskPromptBuilder.ts # Context prompt for agent sessions
      BackgroundEnrich.ts  # Headless Claude enrichment on item creation

  extension.ts       # Entry point: activate/deactivate, command registration
```

### Extension model

The adapter provides 5 required implementations (parser, mover, card renderer, prompt builder, config) plus optional hooks (item creation, split, session label transform, deletion, custom styles). The framework handles everything else: terminals, agent integration, session persistence, drag-drop, state detection.

To create a custom adapter: extend `BaseAdapter`, implement the abstract methods, change the import in `extension.ts`.

### Key design decisions

- **Agent integration owned by framework, not adapter** - AgentLauncher, AgentStateDetector, AgentSessionRename, and AgentProfileManager are framework code. Adapters only provide a `WorkItemPromptBuilder` for context prompts.
- **UUID-based keying** - Sessions, custom order, and selection all use frontmatter UUIDs, not file paths. Survives renames without re-keying.
- **2-panel webview layout** - Editor panel with list (kanban) on the left and terminals on the right. Communication is via typed message passing (`WebviewMessage` / `ExtensionMessage`), not direct DOM access.
- **CSS prefix `wt-`** - All extension CSS classes use the `wt-` prefix. No CSS modules.
- **Three esbuild bundles** - Extension host (CJS/Node), main webview (IIFE/browser), sidebar webview (IIFE/browser). Static CSS assets copied to `dist/` during build.
- **node-pty for terminals** - Real PTY sessions via node-pty. Falls back to child_process if node-pty is unavailable.
- **globalState for persistence** - Session metadata, agent profiles, and custom order stored in VS Code's globalState (survives restarts). No external files.

## Development workflow

- **Build**: `pnpm build` (production, minified) or `pnpm run watch` (incremental rebuilds)
- **Test**: `pnpm test` (vitest - 8 test files covering utils, frontmatter, state detection, parser, mover, template, prompt builder, card renderer)
- **Lint**: `pnpm run lint` (ESLint)
- **Package**: `pnpm run package` (VSIX via vsce)
- **Debug**: Press F5 in VS Code to launch an Extension Development Host with the extension loaded

### Build output

esbuild produces three bundles in `dist/`:
- `extension.js` - Extension host (Node.js, CJS). Externals: `vscode`, `node-pty`.
- `webview.js` - Main panel webview (browser, IIFE).
- `sidebar.js` - Sidebar webview (browser, IIFE).

## Known constraints

- **node-pty** - Required for real PTY terminal sessions. Native module that needs rebuild per platform/Electron version.
- **xterm.js CSS** - Full CSS embedded inline via the webview HTML since webviews cannot load node_modules CSS directly.
- **Tilde expansion** - Always expand `~` via `os.homedir()` before passing paths to spawn or file operations.
- **Webview isolation** - Webviews run in an iframe sandbox. All communication with the extension host is via `postMessage`. No shared memory, no direct DOM access from extension code.
- **State detection reads terminal output, not stdout** - Immune to status line redraws. Checks recent lines from the raw output buffer.
- **Session persistence** - Two tiers: in-memory SessionStore (survives panel hide/show), disk persistence via globalState (7-day retention, UUID-based resume). Copilot resume uses native `--resume`; Claude uses hook-based session ID tracking.

## Development rules

### Commits
Commit each discrete change individually with a clear message. Do not batch unrelated changes.

### Issue tracking
Use GitHub Issues as the project TODO list (`gh issue list`, `gh issue create`, `gh issue close`).
- Log new TODOs, feature requests, and bugs as GitHub issues.
- When starting work on something, find or create the matching issue and reference it in commits.
- Use `Closes #N` or `Fixes #N` in commit messages to auto-close issues on push.
- After committing, push to origin so issue references take effect.

### Testing
Run `pnpm test` after changes to verify nothing is broken. Build with `pnpm build` to catch type/bundle errors.
