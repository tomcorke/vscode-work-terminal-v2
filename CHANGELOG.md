# Changelog

All notable changes to the "Work Terminal" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Consolidated agent-specific global settings (claudeCommand, claudeExtraArgs, copilotCommand, copilotExtraArgs, strandsCommand, strandsExtraArgs) into agent profiles
- AgentProfileManager now uses sensible defaults per agent type instead of reading removed global settings
- TerminalManager no longer reads agent-specific settings from VS Code config - callers resolve commands via AgentProfileManager

### Removed

- Removed 6 redundant global settings: `claudeCommand`, `claudeExtraArgs`, `copilotCommand`, `copilotExtraArgs`, `strandsCommand`, `strandsExtraArgs`
- Kept `additionalAgentContext` as a cross-cutting global setting

### Added

- One-time migration in AgentProfileManager.load() that copies non-default values from deprecated global settings into existing agent profiles
- Danger confirmation modal for destructive operations (Delete Item, Done & Close Sessions) using VS Code's native warning dialog
- Debug API (`window.__workTerminalDebug`) exposed in webview when `workTerminal.exposeDebugApi` setting is enabled, with `getSnapshot()`, `getAllActiveTabs()`, `findTabsByLabel()`, `getActiveSessionIds()`, `getPersistedSessions()`, and `getSessionDiagnostics()` methods for development and troubleshooting (Closes #79)
- `Copy Session Diagnostics` command (`workTerminal.copyDiagnostics`) - copies extension state snapshot to clipboard for debugging
- ID backfilling for path-only work items: when a selected item has no frontmatter UUID, asynchronously writes a durable UUID and rekeys all internal maps (terminals, custom order, sessions) to the new ID (Closes #80)
- Rename detection for shell `mv` operations: FileWatcher buffers delete events for 2 seconds and matches subsequent creates by UUID (with folder heuristic fallback), treating them as renames instead of delete+create cycles (Closes #81)

## [0.1.0] - 2026-04-01

### Added

- Initial release
- Kanban board with collapsible columns and drag-drop reordering
- Tabbed terminal integration with xterm.js
- AI agent support (Claude Code, GitHub Copilot)
- Session persistence and recovery
- Agent state detection (active, idle, waiting)
- Agent profile management
- File-backed work items with YAML frontmatter
- Sidebar view with filtering and search
- Configurable task base path
