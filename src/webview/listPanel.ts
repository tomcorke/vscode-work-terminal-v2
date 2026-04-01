import type { WebviewApi } from "../types/vscode";
import type { WorkItemDTO, ExtensionMessage } from "./messages";

/**
 * Webview-side list panel renderer.
 * Renders work items grouped by column with collapsible sections,
 * drag-drop reordering, filtering, selection, session badges, and
 * agent state indicators.
 */

interface SessionInfo {
  count: number;
  kind: "shell" | "agent" | "mixed";
  agentState?: "active" | "idle" | "waiting";
}

interface ListPanelState {
  items: WorkItemDTO[];
  columns: string[];
  selectedId: string | null;
  collapsedColumns: Set<string>;
  filterTerm: string;
  sessionCounts: Map<string, SessionInfo>;
}

// ---------------------------------------------------------------------------
// Drag state (module-level to avoid class complexity)
// ---------------------------------------------------------------------------

let dragSourceId: string | null = null;
let dragSourceColumn: string | null = null;

export class ListPanel {
  private listEl: HTMLElement;
  private vscode: WebviewApi;
  private state: ListPanelState;
  private filterDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor(vscode: WebviewApi) {
    this.vscode = vscode;
    this.listEl = document.getElementById("list-panel")!;
    this.state = {
      items: [],
      columns: [],
      selectedId: null,
      collapsedColumns: new Set(),
      filterTerm: "",
      sessionCounts: new Map(),
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  updateItems(items: WorkItemDTO[], columns: string[]): void {
    this.state.items = items;
    this.state.columns = columns;
    this.render();
  }

  updateSessionState(itemId: string, sessions: Array<{ id: string; label: string; kind: "shell" | "agent" }>): void {
    if (sessions.length === 0) {
      this.state.sessionCounts.delete(itemId);
    } else {
      const hasAgent = sessions.some((s) => s.kind === "agent");
      const hasShell = sessions.some((s) => s.kind === "shell");
      const kind = hasAgent && hasShell ? "mixed" : hasAgent ? "agent" : "shell";
      this.state.sessionCounts.set(itemId, { count: sessions.length, kind });
    }
    this.updateSessionBadge(itemId);
  }

  setAgentState(itemId: string, agentState: "active" | "idle" | "waiting" | null): void {
    const info = this.state.sessionCounts.get(itemId);
    if (info) {
      info.agentState = agentState || undefined;
    }
    this.updateAgentIndicator(itemId);
  }

  applyFilter(query: string): void {
    if (this.filterDebounce) clearTimeout(this.filterDebounce);
    this.filterDebounce = setTimeout(() => {
      this.state.filterTerm = query.toLowerCase();
      this.applyFilterVisibility();
    }, 100);
  }

  getSelectedId(): string | null {
    return this.state.selectedId;
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private render(): void {
    this.listEl.innerHTML = "";

    const grouped = this.groupByColumn();

    for (const colId of this.state.columns) {
      const colItems = grouped[colId] || [];
      const section = document.createElement("div");
      section.className = "wt-section";
      section.dataset.column = colId;

      // Header
      const header = document.createElement("div");
      header.className = `wt-section-header wt-section-header-${colId}`;

      const collapseIcon = document.createElement("span");
      collapseIcon.className = "wt-collapse-icon";
      collapseIcon.textContent = this.state.collapsedColumns.has(colId) ? "\u25B6" : "\u25BC";
      header.appendChild(collapseIcon);

      const label = document.createElement("span");
      label.className = "wt-section-label";
      label.textContent = `${this.formatColumnLabel(colId)} (${colItems.length})`;
      header.appendChild(label);

      header.addEventListener("click", () => {
        if (this.state.collapsedColumns.has(colId)) {
          this.state.collapsedColumns.delete(colId);
        } else {
          this.state.collapsedColumns.add(colId);
        }
        this.render();
      });

      section.appendChild(header);

      // Cards container
      const cardsEl = document.createElement("div");
      cardsEl.className = "wt-section-cards";
      if (this.state.collapsedColumns.has(colId)) {
        cardsEl.style.display = "none";
      }

      this.setupDropZone(cardsEl, colId);

      for (const item of colItems) {
        const card = this.renderCard(item);
        cardsEl.appendChild(card);
      }

      section.appendChild(cardsEl);
      this.listEl.appendChild(section);
    }

    this.applyFilterVisibility();
  }

  private renderCard(item: WorkItemDTO): HTMLElement {
    const card = document.createElement("div");
    card.className = "wt-card-wrapper";
    card.dataset.itemId = item.id;
    card.draggable = true;

    if (item.id === this.state.selectedId) {
      card.classList.add("wt-card-selected");
    }

    // Color from meta
    if (item.meta?.color) {
      card.style.setProperty("--wt-task-color", item.meta.color);
    }

    // Title row
    const titleRow = document.createElement("div");
    titleRow.className = "wt-card-title-row";

    const titleEl = document.createElement("div");
    titleEl.className = "wt-card-title";
    titleEl.textContent = item.title;
    titleRow.appendChild(titleEl);

    // Actions container (session badge goes here)
    const actionsEl = document.createElement("div");
    actionsEl.className = "wt-card-actions";
    titleRow.appendChild(actionsEl);

    card.appendChild(titleRow);

    // Meta row
    const metaRow = document.createElement("div");
    metaRow.className = "wt-card-meta";

    // Jira key as clickable link
    if (item.jiraKey) {
      if (item.jiraBaseUrl) {
        const jiraLink = document.createElement("a");
        jiraLink.className = "wt-card-source wt-card-source--jira";
        jiraLink.textContent = item.jiraKey;
        jiraLink.href = `${item.jiraBaseUrl}/${item.jiraKey}`;
        jiraLink.title = `Open ${item.jiraKey} in Jira`;
        jiraLink.addEventListener("click", (e) => {
          e.stopPropagation();
        });
        metaRow.appendChild(jiraLink);
      } else {
        const jiraBadge = document.createElement("span");
        jiraBadge.className = "wt-card-source wt-card-source--jira";
        jiraBadge.textContent = item.jiraKey;
        metaRow.appendChild(jiraBadge);
      }
    } else if (item.source && item.source !== "prompt") {
      const sourceBadge = document.createElement("span");
      sourceBadge.className = "wt-card-source";
      sourceBadge.textContent = item.source.toUpperCase();
      metaRow.appendChild(sourceBadge);
    }

    // Priority score with color coding
    if (item.meta?.score) {
      const score = parseInt(item.meta.score, 10);
      if (score > 0) {
        let scoreClass = "wt-score-low";
        if (score >= 60) scoreClass = "wt-score-high";
        else if (score >= 30) scoreClass = "wt-score-medium";

        const scoreBadge = document.createElement("span");
        scoreBadge.className = `wt-card-score ${scoreClass}`;
        scoreBadge.textContent = String(score);
        metaRow.appendChild(scoreBadge);
      }
    }

    // Goal tags (max 2)
    if (item.goals?.length) {
      for (const goal of item.goals.slice(0, 2)) {
        const goalEl = document.createElement("span");
        goalEl.className = "wt-card-goal";
        goalEl.textContent = goal.replace(/-/g, " ");
        goalEl.title = goal;
        metaRow.appendChild(goalEl);
      }
    }

    // Tags
    if (item.meta?.tags) {
      const tags = item.meta.tags.split(",").slice(0, 2);
      for (const tag of tags) {
        const tagEl = document.createElement("span");
        tagEl.className = "wt-card-tag";
        tagEl.textContent = tag.replace(/-/g, " ");
        metaRow.appendChild(tagEl);
      }
    }

    // Blocker badge
    if (item.hasBlocker) {
      const blockerBadge = document.createElement("span");
      blockerBadge.className = "wt-card-blocker";
      blockerBadge.textContent = "BLOCKED";
      if (item.blockerContext) {
        blockerBadge.title = item.blockerContext;
      }
      metaRow.appendChild(blockerBadge);
    }

    card.appendChild(metaRow);

    // Session badge
    this.renderSessionBadge(actionsEl, item.id);

    // Click to select
    card.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".wt-card-actions")) return;
      if ((e.target as HTMLElement).closest("a")) return;
      this.selectItem(item.id);
    });

    // Context menu
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showCardContextMenu(item, e.clientX, e.clientY);
    });

    // Drag source
    this.setupDragSource(card, item);

    return card;
  }

  // ---------------------------------------------------------------------------
  // Card context menu
  // ---------------------------------------------------------------------------

  private showCardContextMenu(item: WorkItemDTO, x: number, y: number): void {
    const existing = document.querySelector(".wt-context-menu");
    if (existing) existing.remove();

    const menu = document.createElement("div");
    menu.className = "wt-context-menu";
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const menuItems: Array<{ label: string; action: () => void; separator?: boolean }> = [];

    // Move to columns
    for (const col of this.state.columns) {
      if (col === item.column) continue;
      menuItems.push({
        label: `Move to ${this.formatColumnLabel(col)}`,
        action: () => {
          this.vscode.postMessage({ type: "contextMenuMove", itemId: item.id, toColumn: col });
        },
      });
    }

    menuItems.push({ label: "", action: () => {}, separator: true });

    menuItems.push({
      label: "Copy Name",
      action: () => {
        this.vscode.postMessage({ type: "copyToClipboard", text: item.title });
      },
    });

    menuItems.push({ label: "", action: () => {}, separator: true });

    menuItems.push({
      label: "Delete",
      action: () => {
        this.vscode.postMessage({ type: "contextMenuDelete", itemId: item.id });
      },
    });

    for (const mi of menuItems) {
      if (mi.separator) {
        const sep = document.createElement("div");
        sep.className = "wt-context-menu-separator";
        menu.appendChild(sep);
        continue;
      }
      const itemEl = document.createElement("div");
      itemEl.className = "wt-context-menu-item";
      itemEl.textContent = mi.label;
      itemEl.addEventListener("click", () => {
        menu.remove();
        mi.action();
      });
      menu.appendChild(itemEl);
    }

    document.body.appendChild(menu);

    const dismiss = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        document.removeEventListener("mousedown", dismiss);
      }
    };
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", dismiss);
    });
  }

  // ---------------------------------------------------------------------------
  // Session badges
  // ---------------------------------------------------------------------------

  private renderSessionBadge(container: HTMLElement, itemId: string): void {
    const info = this.state.sessionCounts.get(itemId);
    if (!info || info.count === 0) return;

    const badge = document.createElement("span");
    badge.className = `wt-session-badge wt-badge-${info.kind}`;
    badge.dataset.sessionBadge = itemId;
    badge.textContent = String(info.count);
    container.appendChild(badge);

    // Agent state indicator on the card wrapper
    if (info.agentState === "active") {
      const cardEl = container.closest(".wt-card-wrapper");
      if (cardEl) cardEl.classList.add("wt-agent-active");
    }
  }

  private updateSessionBadge(itemId: string): void {
    const card = this.findCardByItemId(itemId);
    if (!card) return;

    // Remove existing badge
    const existing = card.querySelector(`[data-session-badge="${CSS.escape(itemId)}"]`);
    if (existing) existing.remove();

    const actionsEl = card.querySelector(".wt-card-actions");
    if (actionsEl) {
      this.renderSessionBadge(actionsEl as HTMLElement, itemId);
    }
  }

  private updateAgentIndicator(itemId: string): void {
    const card = this.findCardByItemId(itemId);
    if (!card) return;

    const info = this.state.sessionCounts.get(itemId);
    card.classList.toggle("wt-agent-active", info?.agentState === "active");
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  private selectItem(id: string): void {
    this.state.selectedId = id;

    // Update visual selection
    this.listEl.querySelectorAll(".wt-card-selected").forEach((el) => {
      el.classList.remove("wt-card-selected");
    });
    const card = this.findCardByItemId(id);
    if (card) card.classList.add("wt-card-selected");

    this.vscode.postMessage({ type: "itemSelected", id });
  }

  // ---------------------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------------------

  private applyFilterVisibility(): void {
    const term = this.state.filterTerm;
    const cards = Array.from(this.listEl.querySelectorAll<HTMLElement>(".wt-card-wrapper"));

    for (const card of cards) {
      if (!term) {
        card.style.display = "";
        continue;
      }

      const itemId = card.dataset.itemId || "";
      const item = this.state.items.find((i) => i.id === itemId);
      if (!item) {
        card.style.display = "none";
        continue;
      }

      const searchable = [
        item.title,
        item.source || "",
        item.meta?.tags || "",
        item.jiraKey || "",
        ...(item.goals || []),
      ].join(" ").toLowerCase();

      card.style.display = searchable.includes(term) ? "" : "none";
    }
  }

  // ---------------------------------------------------------------------------
  // Drag and drop
  // ---------------------------------------------------------------------------

  private setupDragSource(card: HTMLElement, item: WorkItemDTO): void {
    card.addEventListener("dragstart", (e) => {
      dragSourceId = item.id;
      dragSourceColumn = item.column;
      card.classList.add("wt-card-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.setData("text/plain", item.id);
        e.dataTransfer.effectAllowed = "move";
      }
    });

    card.addEventListener("dragend", () => {
      card.classList.remove("wt-card-dragging");
      dragSourceId = null;
      dragSourceColumn = null;
      // Clean up any lingering drop indicators
      this.listEl.querySelectorAll(".wt-drop-indicator").forEach((el) => el.remove());
    });
  }

  private setupDropZone(container: HTMLElement, columnId: string): void {
    container.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";

      // Show drop indicator
      this.removeDropIndicators();
      const afterCard = this.getCardAfterDrag(container, e.clientY);
      const indicator = document.createElement("div");
      indicator.className = "wt-drop-indicator";

      if (afterCard) {
        container.insertBefore(indicator, afterCard);
      } else {
        container.appendChild(indicator);
      }
    });

    container.addEventListener("dragleave", (e) => {
      // Only remove if actually leaving the container
      if (!container.contains(e.relatedTarget as Node)) {
        this.removeDropIndicators();
      }
    });

    container.addEventListener("drop", (e) => {
      e.preventDefault();
      this.removeDropIndicators();

      if (!dragSourceId) return;

      const afterCard = this.getCardAfterDrag(container, e.clientY);
      const cards = Array.from(container.querySelectorAll<HTMLElement>(".wt-card-wrapper"));
      let index = cards.length;
      if (afterCard) {
        index = cards.indexOf(afterCard);
        if (index < 0) index = cards.length;
      }

      // Send drag-drop message to extension
      this.vscode.postMessage({
        type: "dragDrop",
        itemId: dragSourceId,
        toColumn: columnId,
        index,
      });
    });
  }

  private getCardAfterDrag(container: HTMLElement, y: number): HTMLElement | null {
    const cards = Array.from(
      container.querySelectorAll<HTMLElement>(".wt-card-wrapper:not(.wt-card-dragging)"),
    );

    let closest: HTMLElement | null = null;
    let closestOffset = Number.NEGATIVE_INFINITY;

    for (const card of cards) {
      const box = card.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;

      if (offset < 0 && offset > closestOffset) {
        closestOffset = offset;
        closest = card;
      }
    }

    return closest;
  }

  private removeDropIndicators(): void {
    this.listEl.querySelectorAll(".wt-drop-indicator").forEach((el) => el.remove());
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private groupByColumn(): Record<string, WorkItemDTO[]> {
    const groups: Record<string, WorkItemDTO[]> = {};
    for (const col of this.state.columns) {
      groups[col] = [];
    }
    for (const item of this.state.items) {
      const col = item.column;
      if (groups[col]) {
        groups[col].push(item);
      }
    }
    return groups;
  }

  private findCardByItemId(itemId: string): HTMLElement | null {
    return this.listEl.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`);
  }

  private formatColumnLabel(colId: string): string {
    // Capitalize first letter
    return colId.charAt(0).toUpperCase() + colId.slice(1);
  }
}
