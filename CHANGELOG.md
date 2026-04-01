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
