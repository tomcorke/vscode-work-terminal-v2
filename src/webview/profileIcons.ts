import type { ProfileIcon } from "../core/agents/types";

export const PROFILE_ICON_SYMBOLS: Partial<Record<ProfileIcon, string>> = {
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

export function getProfileIconSymbol(icon?: string): string {
  if (!icon) {
    return "";
  }

  return PROFILE_ICON_SYMBOLS[icon as ProfileIcon] || "";
}
