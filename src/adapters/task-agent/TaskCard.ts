import * as vscode from "vscode";
import type {
  WorkItem,
  CardRenderer,
  CardActionContext,
  CardRenderData,
  ContextMenuItem,
} from "../../core/interfaces";
import { normalizeDisplayText } from "../../core/utils";
import { KANBAN_COLUMNS, COLUMN_LABELS, SOURCE_LABELS } from "./types";

export class TaskCard implements CardRenderer {
  render(item: WorkItem, _ctx: CardActionContext): CardRenderData {
    const meta = (item.metadata || {}) as Record<string, unknown>;
    const source = (meta.source || { type: "other" }) as Record<string, unknown>;
    const priority = (meta.priority || { score: 0 }) as Record<string, unknown>;
    const goal: string[] = (meta.goal || []) as string[];
    const taskColor: string | undefined = meta.color as string | undefined;

    const classes: string[] = ["wt-card"];

    let html = "";

    // Title row
    html += `<div class="wt-card-title-row">`;
    html += `<div class="wt-card-title">${escapeHtml(item.title)}</div>`;
    html += `<div class="wt-card-actions"></div>`;
    html += `</div>`;

    // Meta row
    html += `<div class="wt-card-meta">`;

    // Source badge
    if (source.type !== "prompt") {
      if (source.type === "jira" && source.id) {
        html += `<span class="wt-card-source wt-card-source--jira">${escapeHtml(String(source.id).toUpperCase())}</span>`;
      } else {
        const label = SOURCE_LABELS[source.type as string] || "---";
        html += `<span class="wt-card-source">${escapeHtml(label)}</span>`;
      }
    }

    // Priority score badge
    const score = (priority.score as number) || 0;
    if (score > 0) {
      let scoreClass = "score-low";
      if (score >= 60) scoreClass = "score-high";
      else if (score >= 30) scoreClass = "score-medium";
      html += `<span class="wt-card-score ${scoreClass}">${score}</span>`;
    }

    // Goal tags (max 2)
    for (const g of goal.slice(0, 2)) {
      const displayGoal = normalizeDisplayText(g);
      const displayText = displayGoal.replace(/-/g, " ");
      html += `<span class="wt-card-goal" title="${escapeAttr(displayGoal)}">${escapeHtml(displayText)}</span>`;
    }

    // Blocker indicator
    if (priority["has-blocker"]) {
      const blockerContext = priority["blocker-context"]
        ? normalizeDisplayText(String(priority["blocker-context"]))
        : "";
      html += `<span class="wt-card-source" style="background:#e5484d;color:white"`;
      if (blockerContext) {
        html += ` title="${escapeAttr(blockerContext)}"`;
      }
      html += `>BLOCKED</span>`;
    }

    html += `</div>`;

    if (taskColor) {
      html = `<div style="--wt-task-color:${escapeAttr(taskColor)}">${html}</div>`;
    }

    return { html, classes };
  }

  getContextMenuItems(item: WorkItem, ctx: CardActionContext): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];

    items.push({
      label: "Move to Top",
      action: () => ctx.onMoveToTop(),
    });

    items.push({
      label: "Split Task",
      action: () => ctx.onSplitTask(item),
    });

    items.push({ label: "", action: () => {}, separator: true });

    for (const col of KANBAN_COLUMNS) {
      if (col === item.state) continue;
      items.push({
        label: `Move to ${COLUMN_LABELS[col]}`,
        action: () => ctx.onMoveToColumn(col),
      });
      if (col === "done") {
        items.push({
          label: "Done & Close Sessions",
          action: () => {
            ctx.onMoveToColumn("done");
            try {
              ctx.onCloseSessions();
            } catch (err) {
              console.error("[work-terminal] Failed to close sessions:", err);
            }
          },
        });
      }
    }

    items.push({ label: "", action: () => {}, separator: true });

    items.push({
      label: "Copy Name",
      action: () => vscode.env.clipboard.writeText(item.title),
    });
    items.push({
      label: "Copy Path",
      action: () => vscode.env.clipboard.writeText(item.path),
    });
    items.push({
      label: "Copy Context Prompt",
      action: async () => {
        const prompt = await ctx.getContextPrompt();
        if (!prompt) return;
        await vscode.env.clipboard.writeText(prompt);
      },
    });

    items.push({ label: "", action: () => {}, separator: true });

    items.push({
      label: "Delete Task",
      action: () => ctx.onDelete(),
    });

    return items;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
