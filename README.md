# Work Terminal

A VS Code extension that combines a kanban board with per-item tabbed terminals and AI agent integration. Manage work items visually while launching shell sessions, Claude Code, GitHub Copilot, and AWS Strands agents - all from a single panel.

## Features

- **Kanban board** - Collapsible columns (Priority, Active, To Do, Done) with drag-and-drop reordering and filtering. Work items are markdown files with YAML frontmatter, so they version-control naturally.
- **Tabbed terminals** - Each work item owns a set of tabbed terminal sessions powered by xterm.js. Switch items and pick up where you left off.
- **AI agent integration** - Launch Claude Code, GitHub Copilot, or Strands agent sessions directly from work items. Context-aware mode injects item metadata into the agent prompt automatically.
- **Agent state detection** - Real-time detection of agent state (active, idle, waiting for input) by reading terminal buffer content. Status badges update live on cards and tabs.
- **Session persistence** - Terminal sessions survive VS Code restarts. Resumable agent sessions (Claude, Copilot) can be recovered with their original session IDs.
- **Agent profiles** - Reusable launch configurations with custom commands, arguments, working directories, context prompts, and tab-bar button styling (icons, colours, border styles).
- **Sidebar view** - Compact list of work items with search/filter, accessible from the activity bar.
- **Guided tour** - Built-in walkthrough to get started quickly.

## Installation

### From VSIX

```sh
code --install-extension work-terminal-0.1.0.vsix
```

### From source

```sh
git clone https://github.com/tomcorke/vscode-work-terminal-v2.git
cd vscode-work-terminal-v2
pnpm install
pnpm build
# Press F5 in VS Code to launch an Extension Development Host
```

## Development

### Commands

| Command | Description |
|---------|-------------|
| `pnpm install` | Install dependencies |
| `pnpm build` | Production build (esbuild, minified) |
| `pnpm run watch` | Watch mode with incremental rebuilds |
| `pnpm test` | Run tests (vitest) |
| `pnpm run lint` | Lint with ESLint |
| `pnpm run package` | Package as VSIX |

### Debugging

Press **F5** in VS Code to launch an Extension Development Host with the extension loaded. The `watch` script provides incremental rebuilds during development.

If the Extension Development Host reports that `node-pty` could not load `pty.node`, run **Work Terminal: Rebuild node-pty Native Module** from the command palette, then reload the window.

### Build output

esbuild produces three bundles in `dist/`:

- `extension.js` - Extension host (Node.js, CJS)
- `webview.js` - Main panel webview (browser, IIFE)
- `sidebar.js` - Sidebar webview (browser, IIFE)

Static assets (`styles.css`, `sidebar.css`) are copied from `src/webview/` to `dist/` during build.

## Architecture

Three-layer design with clear boundaries between core logic, UI panels/services, and domain-specific adapters.

```
src/
  core/                  # Shared types, interfaces, utilities
    interfaces.ts        # AdapterBundle, BaseAdapter, WorkItem, all extension points
    types.ts             # FileRef (platform-agnostic file reference)
    utils.ts             # expandTilde, stripAnsi, slugify, getNonce
    frontmatter.ts       # YAML frontmatter parsing/serialisation
    dataStore.ts         # VS Code globalState wrapper
    session/types.ts     # SessionType, StoredSession, PersistedSession
    agents/types.ts      # AgentProfile, AgentType, ProfileButton

  panels/                # VS Code webview panels
    WorkTerminalPanel.ts # Singleton 2-panel webview (list + terminals), message routing
    SidebarProvider.ts   # Activity bar sidebar webview provider

  services/              # Extension host services
    WorkItemService.ts   # Item CRUD, column grouping, custom ordering
    FileWatcher.ts       # Workspace file system watcher for item changes

  session/               # Session lifecycle management
    SessionManager.ts    # Orchestrates terminal creation, resume, persistence
    SessionStore.ts      # In-memory session state (survives panel hide)
    SessionPersistence.ts# Disk persistence via globalState (7-day retention)
    RecentlyClosedStore.ts# Stack of recently closed terminals for reopen

  terminal/              # Terminal process management
    TerminalManager.ts   # node-pty spawning, I/O routing, resize handling
    AgentLauncher.ts     # Agent launch argument building, session ID generation
    AgentStateDetector.ts# Buffer-based agent state detection (active/idle/waiting)

  agents/                # Agent integration
    AgentLaunchModal.ts  # Quick-pick launch modal with profile selection
    AgentProfileManager.ts# Profile CRUD with globalState persistence
    AgentSessionTracker.ts# Tracks agent sessions for state aggregation
    AgentSessionRename.ts# Detects and applies agent-chosen session names
    AgentContextPrompt.ts# Builds context prompts from adapter + settings
    ClaudeHookManager.ts # Claude hook scripts for session resume tracking
    HeadlessClaude.ts    # Headless Claude for background enrichment

  webview/               # Browser-side webview code
    main.ts              # Main panel entry point
    sidebarMain.ts       # Sidebar entry point
    listPanel.ts         # Kanban column rendering, drag-drop
    terminalPanel.ts     # Terminal tab bar, xterm.js integration
    profileManager.ts    # Profile editor UI
    messages.ts          # Typed message protocol (webview <-> extension)
    styles.css           # Main panel styles
    sidebar.css          # Sidebar styles

  adapters/
    task-agent/          # Task-agent adapter (reference implementation)
      index.ts           # TaskAgentAdapter extending BaseAdapter
      types.ts           # TaskFile, TaskState, KanbanColumn, STATE_FOLDER_MAP
      TaskAgentConfig.ts # PluginConfig: columns, creation columns, settings
      TaskParser.ts      # File-based parsing with frontmatter, goal normalisation
      TaskMover.ts       # Frontmatter state updates, file moves, activity logging
      TaskCard.ts        # Card rendering with source/score/goal/blocker badges
      TaskFileTemplate.ts# UUID + YAML frontmatter + slug filename generation
      TaskPromptBuilder.ts# Context prompt builder for agent sessions
      BackgroundEnrich.ts# Headless Claude enrichment on item creation

  extension.ts           # Entry point: activate/deactivate, command registration
```

### Extension model

The adapter provides 5 required implementations (parser, mover, card renderer, prompt builder, config) plus optional hooks (item creation, split, session label transform, deletion, styles). The framework handles everything else: terminals, agent integration, session persistence, drag-drop, state detection.

To create a custom adapter: extend `BaseAdapter`, implement the abstract methods, and change the import in `extension.ts`.

## Keybindings

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+W` / `Ctrl+Shift+W` | Toggle Work Terminal panel |
| `Ctrl+Shift+N` | New Work Item (when panel focused) |
| `` Ctrl+` `` | New Shell Terminal (when panel focused) |

## Requirements

- VS Code 1.85+
- Node.js 20+ (for node-pty)
- **Optional:** [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) for Claude agent sessions
- **Optional:** [GitHub Copilot CLI](https://github.com/features/copilot) for Copilot agent sessions
- **Optional:** AWS Strands agent CLI for Strands sessions

## License

[MIT](LICENSE)
