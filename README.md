# Work Terminal

A VS Code extension that combines a kanban board for managing work items with per-item tabbed terminals and AI agent integration.

## Features

### Kanban Board
Visual kanban board for organising work items with collapsible columns, drag-and-drop reordering, and filtering. Work items are backed by markdown files with YAML frontmatter, so they stay in your project and work with version control.

### Tabbed Terminals
Each work item gets its own set of tabbed terminals - shell, Claude Code, and GitHub Copilot sessions - all powered by xterm.js. Switch between items and pick up exactly where you left off.

### AI Agent Integration
First-class support for AI coding agents. Launch Claude Code or Copilot sessions directly from work items, with automatic agent state detection so you can see at a glance which agents are active, idle, or waiting for input.

### Session Persistence
Terminal sessions survive VS Code restarts. Reopen closed terminals and recover agent sessions without losing context.

### Agent Profile Management
Create and manage reusable agent profiles to configure how AI agents are launched for different types of work.

## Requirements

- VS Code 1.85 or later
- Python 3 (required by node-pty for terminal emulation)
- **Optional:** [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) for Claude agent terminals
- **Optional:** [GitHub Copilot](https://github.com/features/copilot) extension for Copilot agent terminals

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `workTerminal.taskBasePath` | `2 - Areas/Tasks` | Path containing task folders |

## Keybindings

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+W` / `Ctrl+Shift+W` | Toggle Work Terminal panel |
| `Ctrl+Shift+N` | New Work Item (when panel focused) |
| `` Ctrl+` `` | New Shell Terminal (when panel focused) |

## Known Issues

This extension is in early development. Expect rough edges and breaking changes.

## Release Notes

### 0.1.0

Initial release with kanban board, tabbed terminals, AI agent integration, session persistence, and profile management.
