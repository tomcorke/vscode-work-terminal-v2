import type { WebviewApi } from "../types/vscode";

interface WorkItemDTO {
  id: string;
  title: string;
  column: string;
  source?: string;
  meta?: Record<string, string>;
}

interface SidebarMessage {
  type: string;
  items?: WorkItemDTO[];
  columns?: string[];
}

const vscode: WebviewApi = acquireVsCodeApi();

let items: WorkItemDTO[] = [];
let columns: string[] = [];
let filterTerm = "";
let selectedId: string | null = null;
const collapsedColumns = new Set<string>();
let hasInitialized = false;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(): void {
  const listEl = document.getElementById("sb-list");
  if (!listEl) return;
  listEl.innerHTML = "";

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "wt-sb-empty";
    empty.textContent = "No work items";
    listEl.appendChild(empty);
    return;
  }

  const grouped: Record<string, WorkItemDTO[]> = {};
  for (const col of columns) {
    grouped[col] = [];
  }
  for (const item of items) {
    if (grouped[item.column]) {
      grouped[item.column].push(item);
    }
  }

  for (const colId of columns) {
    const colItems = grouped[colId] || [];
    if (colItems.length === 0) continue;

    const section = document.createElement("div");
    section.className = "wt-sb-section";

    // Header
    const header = document.createElement("div");
    header.className = "wt-sb-section-header";

    const icon = document.createElement("span");
    icon.className = "wt-sb-collapse-icon";
    icon.textContent = collapsedColumns.has(colId) ? "\u25B6" : "\u25BC";
    header.appendChild(icon);

    const label = document.createElement("span");
    label.className = "wt-sb-section-label";
    label.textContent = formatLabel(colId);
    header.appendChild(label);

    const count = document.createElement("span");
    count.className = "wt-sb-section-count";
    count.textContent = String(colItems.length);
    header.appendChild(count);

    header.addEventListener("click", () => {
      if (collapsedColumns.has(colId)) {
        collapsedColumns.delete(colId);
      } else {
        collapsedColumns.add(colId);
      }
      render();
    });

    section.appendChild(header);

    // Cards
    if (!collapsedColumns.has(colId)) {
      for (const item of colItems) {
        const visible = matchesFilter(item);
        if (!visible) continue;

        const card = document.createElement("div");
        card.className = "wt-sb-card";
        if (item.id === selectedId) {
          card.classList.add("wt-sb-card-selected");
        }

        // State dot
        const dot = document.createElement("span");
        dot.className = `wt-sb-state-dot wt-sb-dot-${colId}`;
        card.appendChild(dot);

        // Title
        const title = document.createElement("span");
        title.className = "wt-sb-card-title";
        title.textContent = item.title;
        card.appendChild(title);

        // Click handler
        card.addEventListener("click", () => {
          selectedId = item.id;
          vscode.postMessage({ type: "selectItem", id: item.id });
          render();
        });

        section.appendChild(card);
      }
    }

    listEl.appendChild(section);
  }
}

function matchesFilter(item: WorkItemDTO): boolean {
  if (!filterTerm) return true;
  const searchable = [
    item.title,
    item.source || "",
    item.meta?.tags || "",
  ].join(" ").toLowerCase();
  return searchable.includes(filterTerm);
}

function formatLabel(colId: string): string {
  return colId.charAt(0).toUpperCase() + colId.slice(1);
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

window.addEventListener("message", (event: MessageEvent<SidebarMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "updateItems":
      items = message.items || [];
      columns = message.columns || [];
      // Auto-collapse last column on first render
      if (!hasInitialized && columns.length > 0) {
        hasInitialized = true;
        collapsedColumns.add(columns[columns.length - 1]);
      }
      render();
      break;
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init(): void {
  const filterInput = document.getElementById("sb-filter") as HTMLInputElement | null;
  if (filterInput) {
    filterInput.addEventListener("input", () => {
      filterTerm = filterInput.value.toLowerCase();
      render();
    });
  }

  const openBtn = document.getElementById("sb-open-panel");
  if (openBtn) {
    openBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "openPanel" });
    });
  }

  vscode.postMessage({ type: "ready" });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
