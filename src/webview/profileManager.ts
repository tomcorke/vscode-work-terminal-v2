/**
 * Webview UI logic for agent profile management.
 *
 * Renders profile list, profile editor form, and launch dialog as HTML
 * fragments sent to the webview via message passing. The webview posts
 * messages back to the extension host for persistence.
 */

import type { AgentProfile, AgentType, BorderStyle, ProfileIcon } from "../core/agents/types";
import {
  AGENT_TYPES,
  BORDER_STYLES,
  BRAND_COLORS,
  PROFILE_ICONS,
} from "../core/agents/types";

// ---------------------------------------------------------------------------
// Label maps
// ---------------------------------------------------------------------------

const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  claude: "Claude",
  copilot: "Copilot",
  strands: "Strands",
  shell: "Shell",
};

const BORDER_STYLE_LABELS: Record<BorderStyle, string> = {
  solid: "Solid",
  dashed: "Dashed",
  dotted: "Dotted",
  thick: "Thick",
};

const ICON_LABELS: Partial<Record<ProfileIcon, string>> = {
  terminal: "Terminal",
  bot: "Bot",
  brain: "Brain",
  code: "Code",
  rocket: "Rocket",
  zap: "Zap",
  cog: "Cog",
  wrench: "Wrench",
  shield: "Shield",
  globe: "Globe",
  search: "Search",
  lightbulb: "Lightbulb",
  flask: "Flask",
  book: "Book",
  puzzle: "Puzzle",
  bee: "Bee",
  claude: "Claude (branded)",
  copilot: "Copilot (branded)",
  aws: "AWS (branded)",
  skyscanner: "Skyscanner (branded)",
};

/**
 * Map profile icons to Unicode symbols for display in the webview.
 * (Codicons are not available without loading the font.)
 */
const ICON_SYMBOLS: Partial<Record<ProfileIcon, string>> = {
  terminal: "\u{1F4BB}",
  bot: "\u{1F916}",
  brain: "\u{1F9E0}",
  code: "\u{1F4DD}",
  rocket: "\u{1F680}",
  zap: "\u26A1",
  cog: "\u2699\uFE0F",
  wrench: "\u{1F527}",
  shield: "\u{1F6E1}\uFE0F",
  globe: "\u{1F310}",
  search: "\u{1F50D}",
  lightbulb: "\u{1F4A1}",
  flask: "\u{1F9EA}",
  book: "\u{1F4D6}",
  puzzle: "\u{1F9E9}",
  bee: "\u{1F41D}",
  claude: "\u2728",
  copilot: "\u2708\uFE0F",
  aws: "\u2601\uFE0F",
  skyscanner: "\u2708\uFE0F",
};

// ---------------------------------------------------------------------------
// HTML builders for the webview
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render the profile list as an HTML string for the webview.
 */
export function renderProfileList(profiles: AgentProfile[]): string {
  if (profiles.length === 0) {
    return `<div class="wt-profile-empty">No profiles configured. Add one to get started.</div>`;
  }

  const cards = profiles.map((p, index) => {
    const typeBadge = AGENT_TYPE_LABELS[p.agentType] || p.agentType;
    const commandBadge = p.command
      ? `<span class="wt-profile-badge wt-profile-cmd-badge" title="Custom command: ${escapeHtml(p.command)}">${escapeHtml(p.command.split("/").pop() || p.command)}</span>`
      : "";
    const badges = [
      `<span class="wt-profile-badge wt-profile-type-badge">${escapeHtml(typeBadge)}</span>`,
      p.useContext ? `<span class="wt-profile-badge wt-profile-ctx-badge">ctx</span>` : "",
      p.button.enabled ? `<span class="wt-profile-badge wt-profile-button-badge">button</span>` : "",
      p.paramPassMode !== "launch-only" ? `<span class="wt-profile-badge wt-profile-param-badge">${escapeHtml(p.paramPassMode)}</span>` : "",
      commandBadge,
    ]
      .filter(Boolean)
      .join("");

    const colorSwatch = p.button.color
      ? `<span class="wt-profile-color-swatch" style="background-color:${escapeHtml(p.button.color)}" title="Button color: ${escapeHtml(p.button.color)}"></span>`
      : "";

    const iconDisplay = p.button.icon
      ? `<span class="wt-profile-icon" title="${escapeHtml(ICON_LABELS[p.button.icon] || p.button.icon)}">${ICON_SYMBOLS[p.button.icon] || ""}</span>`
      : "";

    const isFirst = index === 0;
    const isLast = index === profiles.length - 1;

    return `
      <div class="wt-profile-card" data-profile-id="${escapeHtml(p.id)}">
        <div class="wt-profile-card-left">
          ${colorSwatch}${iconDisplay}
          <div class="wt-profile-info">
            <div class="wt-profile-name">${escapeHtml(p.name)}</div>
            <div class="wt-profile-meta">${badges}</div>
          </div>
        </div>
        <div class="wt-profile-card-actions">
          <div class="wt-profile-reorder">
            <button class="wt-profile-action-btn" data-action="moveProfileUp" data-profile-id="${escapeHtml(p.id)}" ${isFirst ? "disabled" : ""} title="Move up">\u25B2</button>
            <button class="wt-profile-action-btn" data-action="moveProfileDown" data-profile-id="${escapeHtml(p.id)}" ${isLast ? "disabled" : ""} title="Move down">\u25BC</button>
          </div>
          <button class="wt-profile-action-btn wt-profile-edit-btn" data-action="editProfile" data-profile-id="${escapeHtml(p.id)}" title="Edit profile">\u270E</button>
          <button class="wt-profile-action-btn wt-profile-delete-btn" data-action="deleteProfile" data-profile-id="${escapeHtml(p.id)}" title="Delete profile">\u2715</button>
        </div>
      </div>`;
  });

  const toolbar = `
    <div class="wt-profile-toolbar">
      <span class="wt-profile-toolbar-title">Agent Profiles</span>
      <div class="wt-profile-toolbar-actions">
        <button class="wt-profile-toolbar-btn" data-action="addProfile" title="Add new profile">+ New</button>
        <button class="wt-profile-toolbar-btn wt-profile-toolbar-btn--secondary" data-action="importProfiles" title="Import profiles from JSON">Import</button>
        <button class="wt-profile-toolbar-btn wt-profile-toolbar-btn--secondary" data-action="exportProfiles" title="Export profiles as JSON">Export</button>
        <button class="wt-profile-close-btn" data-action="closeOverlay" title="Close">✕</button>
      </div>
    </div>`;

  return `${toolbar}<div class="wt-profile-list">${cards.join("")}</div>`;
}

/**
 * Render the profile editor form as an HTML string.
 */
export function renderProfileEditor(profile: AgentProfile | null): string {
  const p = profile || {
    id: "",
    name: "",
    agentType: "claude" as AgentType,
    command: "",
    defaultCwd: "",
    arguments: "",
    contextPrompt: "",
    useContext: false,
    paramPassMode: "launch-only",
    button: { enabled: false, label: "", icon: undefined, borderStyle: "solid", color: undefined },
    sortOrder: 0,
  };
  const isNew = !profile;
  const title = isNew ? "New Agent Profile" : "Edit Agent Profile";

  const agentTypeOptions = AGENT_TYPES.map(
    (t) => `<option value="${t}" ${t === p.agentType ? "selected" : ""}>${AGENT_TYPE_LABELS[t]}</option>`,
  ).join("");

  const iconOptions = [
    `<option value="">(none)</option>`,
    ...PROFILE_ICONS.map(
      (icon) =>
        `<option value="${icon}" ${icon === p.button.icon ? "selected" : ""}>${escapeHtml(ICON_LABELS[icon] || icon)}</option>`,
    ),
  ].join("");

  const borderOptions = BORDER_STYLES.map(
    (s) =>
      `<option value="${s}" ${s === (p.button.borderStyle || "solid") ? "selected" : ""}>${BORDER_STYLE_LABELS[s]}</option>`,
  ).join("");

  return `
    <div class="wt-profile-editor" data-profile-id="${escapeHtml(p.id)}">
      <h3>${title}</h3>

      <label>Profile name
        <input type="text" name="name" value="${escapeHtml(p.name)}" placeholder="My Agent" />
      </label>

      <label>Agent type
        <select name="agentType">${agentTypeOptions}</select>
      </label>

      <label>Executable path
        <input type="text" name="command" value="${escapeHtml(p.command)}" placeholder="(use global default)" />
      </label>

      <label>Working directory
        <input type="text" name="defaultCwd" value="${escapeHtml(p.defaultCwd)}" placeholder="(use global default)" />
      </label>

      <label>Arguments
        <textarea name="arguments" placeholder="Extra CLI arguments">${escapeHtml(p.arguments)}</textarea>
      </label>

      <label>
        <input type="checkbox" name="useContext" ${p.useContext ? "checked" : ""} />
        Include context prompt
      </label>

      <label>Context prompt template
        <textarea name="contextPrompt" placeholder="Enter context prompt...">${escapeHtml(p.contextPrompt)}</textarea>
      </label>
      <div class="wt-field-hint">
        Available variables:
        <code>$title</code> - work item title,
        <code>$state</code> - work item state,
        <code>$filePath</code> - file path,
        <code>$id</code> - work item ID
      </div>

      <h4>Tab bar button</h4>

      <label>
        <input type="checkbox" name="buttonEnabled" ${p.button.enabled ? "checked" : ""} />
        Show button in tab bar
      </label>

      <label>Button label
        <input type="text" name="buttonLabel" value="${escapeHtml(p.button.label)}" placeholder="${escapeHtml(p.name || "Profile name")}" />
      </label>

      <label>Button icon
        <select name="buttonIcon">${iconOptions}</select>
      </label>

      <label>Border style
        <select name="buttonBorderStyle">${borderOptions}</select>
      </label>

      <label>Button color
        <div class="wt-color-input-row">
          <input type="text" name="buttonColor" value="${escapeHtml(p.button.color || "")}" placeholder="(default)" />
          <input type="color" name="buttonColorPicker" value="${escapeHtml(p.button.color || "#000000")}" class="wt-color-picker" title="Pick a color" />
          <span class="wt-color-preview-swatch" style="background-color:${escapeHtml(p.button.color || "transparent")}"></span>
        </div>
      </label>

      <div class="wt-profile-editor-buttons">
        <button data-action="cancelEdit">Cancel</button>
        <button data-action="saveProfile" class="mod-cta">${isNew ? "Create" : "Save"}</button>
      </div>
    </div>`;
}

/**
 * Render the launch dialog with profile selection.
 */
export function renderLaunchDialog(
  profiles: AgentProfile[],
  defaultCwd: string,
): string {
  const profileOptions = profiles
    .map(
      (p, i) => `<option value="${escapeHtml(p.id)}" ${i === 0 ? "selected" : ""}>${escapeHtml(p.name)}</option>`,
    )
    .join("");

  return `
    <div class="wt-launch-dialog">
      <h3>Launch profile</h3>
      <p>Pick a profile and optionally override settings for this launch.</p>

      <label>Profile
        <select name="profileId">${profileOptions}</select>
      </label>

      <label>Working directory override
        <input type="text" name="cwdOverride" value="" placeholder="${escapeHtml(defaultCwd)}" />
      </label>

      <label>Tab label override
        <input type="text" name="labelOverride" value="" placeholder="(profile default)" />
      </label>

      <label>Extra arguments
        <textarea name="extraArgsOverride" placeholder="Additional CLI arguments"></textarea>
      </label>

      <div class="wt-launch-dialog-buttons">
        <button data-action="cancelLaunch">Cancel</button>
        <button data-action="confirmLaunch" class="mod-cta">Launch</button>
      </div>
    </div>`;
}
