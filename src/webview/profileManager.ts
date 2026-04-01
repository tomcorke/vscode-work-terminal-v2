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

  const rows = profiles.map((p) => {
    const typeBadge = AGENT_TYPE_LABELS[p.agentType] || p.agentType;
    const badges = [
      `<span class="wt-profile-type-badge">${escapeHtml(typeBadge)}</span>`,
      p.useContext ? `<span class="wt-profile-ctx-badge">ctx</span>` : "",
      p.button.enabled ? `<span class="wt-profile-button-badge">button</span>` : "",
    ]
      .filter(Boolean)
      .join("");

    const colorSwatch = p.button.color
      ? `<div class="wt-profile-color-swatch" style="background-color:${escapeHtml(p.button.color)}"></div>`
      : "";

    return `
      <div class="wt-profile-row" data-profile-id="${escapeHtml(p.id)}">
        ${colorSwatch}
        <div class="wt-profile-info">
          <div class="wt-profile-name">${escapeHtml(p.name)}</div>
          <div class="wt-profile-meta">${badges}</div>
        </div>
        <button class="wt-profile-edit-btn" data-action="editProfile" data-profile-id="${escapeHtml(p.id)}">Edit</button>
        <button class="wt-profile-delete-btn" data-action="deleteProfile" data-profile-id="${escapeHtml(p.id)}">Delete</button>
      </div>`;
  });

  return `<div class="wt-profile-list">${rows.join("")}</div>`;
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
        <textarea name="contextPrompt" placeholder="Placeholders: $title, $state, $filePath, $id">${escapeHtml(p.contextPrompt)}</textarea>
      </label>

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
        <input type="text" name="buttonColor" value="${escapeHtml(p.button.color || "")}" placeholder="(default)" />
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
