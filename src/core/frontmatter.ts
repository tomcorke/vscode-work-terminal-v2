/**
 * Lightweight YAML frontmatter parser and updater.
 * Works with raw markdown string content - no editor dependencies.
 */

/**
 * Extract a string value from YAML frontmatter by key.
 * Uses a simple regex-based parser to avoid a YAML library dependency.
 * Returns null if the key is missing, empty, or frontmatter is absent.
 */
export function extractFrontmatterString(content: string, key: string): string | null {
  const frontmatter = extractFrontmatterBlock(content);
  if (frontmatter === null) return null;

  const line = extractFrontmatterLine(frontmatter, key);
  if (!line) return null;

  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return null;

  const raw = line.slice(colonIdx + 1).trim();
  if (!raw) return null;

  // Strip surrounding quotes if present
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1) || null;
  }
  return raw;
}

/**
 * Extract all frontmatter key-value pairs as a Record.
 * Only handles simple scalar values (strings, numbers, booleans).
 */
export function extractFrontmatter(content: string): Record<string, string> | null {
  const block = extractFrontmatterBlock(content);
  if (block === null) return null;

  const result: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const k = line.slice(0, colonIdx).trim();
    const v = line.slice(colonIdx + 1).trim();
    if (k && v) {
      // Strip surrounding quotes
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        result[k] = v.slice(1, -1);
      } else {
        result[k] = v;
      }
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Update a frontmatter field value in markdown content.
 * If the key exists, its value is replaced. If not, the key is appended
 * to the end of the frontmatter block. If no frontmatter block exists,
 * one is created at the start of the content.
 */
export function updateFrontmatterField(content: string, key: string, value: string): string {
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(^---(?:\r?\n|$))/m);

  if (!fmMatch) {
    // No frontmatter - create one
    return `---\n${key}: ${value}\n---\n${content}`;
  }

  const [fullMatch, openFence, block, closeFence] = fmMatch;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lineRegex = new RegExp(`^(${escapedKey}[ \\t]*:)[ \\t]*[^\\r\\n]*$`, "m");
  const lineMatch = block.match(lineRegex);

  if (lineMatch) {
    // Replace existing value
    const updatedBlock = block.replace(lineRegex, `$1 ${value}`);
    return content.replace(fullMatch, openFence + updatedBlock + closeFence);
  }

  // Append new key
  const newLine = `${key}: ${value}\n`;
  const updatedBlock = block.endsWith("\n") ? block + newLine : block + "\n" + newLine;
  return content.replace(fullMatch, openFence + updatedBlock + closeFence);
}

function extractFrontmatterBlock(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)^---(?:\r?\n|$)/m);
  return match ? match[1] : null;
}

function extractFrontmatterLine(frontmatter: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = frontmatter.match(new RegExp(`^${escapedKey}[ \\t]*:[ \\t]*[^\\r\\n]*$`, "m"));
  return match?.[0] ?? null;
}
