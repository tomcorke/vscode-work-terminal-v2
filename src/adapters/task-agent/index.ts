import {
  BaseAdapter,
  type WorkItem,
  type WorkItemParser,
  type WorkItemMover,
  type CardRenderer,
  type WorkItemPromptBuilder,
  type PluginConfig,
} from "../../core/interfaces";
import { TASK_AGENT_CONFIG } from "./TaskAgentConfig";
import { TaskParser } from "./TaskParser";
import { TaskMover } from "./TaskMover";
import { TaskCard } from "./TaskCard";
import { TaskPromptBuilder } from "./TaskPromptBuilder";
import { handleItemCreated, handleSplitTaskCreated } from "./BackgroundEnrich";
import type { KanbanColumn } from "./types";

export class TaskAgentAdapter extends BaseAdapter {
  config: PluginConfig = TASK_AGENT_CONFIG;

  createParser(basePath: string, settings?: Record<string, unknown>): WorkItemParser {
    return new TaskParser(basePath, settings || {});
  }

  createMover(basePath: string, settings?: Record<string, unknown>): WorkItemMover {
    return new TaskMover(basePath, settings || {});
  }

  createCardRenderer(): CardRenderer {
    return new TaskCard();
  }

  createPromptBuilder(): WorkItemPromptBuilder {
    return new TaskPromptBuilder();
  }

  async onItemCreated(
    title: string,
    settings: Record<string, unknown>,
  ): Promise<{ id: string; columnId: string; enrichmentDone?: Promise<void> }> {
    return handleItemCreated(title, settings);
  }

  async onSplitItem(
    sourceItem: WorkItem,
    columnId: string,
    settings: Record<string, unknown>,
  ): Promise<{ path: string; id: string } | null> {
    const basePath = (settings["adapter.taskBasePath"] as string) || "2 - Areas/Tasks";
    const sourceFilename = sourceItem.path.split("/").pop() || sourceItem.path;
    const title = `Split from: ${sourceItem.title}`;

    return handleSplitTaskCreated(title, columnId as KanbanColumn, basePath, {
      filename: sourceFilename,
      title: sourceItem.title,
    });
  }

  transformSessionLabel(_oldLabel: string, detectedLabel: string): string {
    return detectedLabel;
  }
}
