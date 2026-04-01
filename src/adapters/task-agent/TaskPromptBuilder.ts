import type { WorkItem, WorkItemPromptBuilder } from "../../core/interfaces";

export class TaskPromptBuilder implements WorkItemPromptBuilder {
  buildPrompt(item: WorkItem, fullPath: string): string {
    const meta = (item.metadata || {}) as Record<string, unknown>;
    const priority = (meta.priority || {}) as Record<string, unknown>;

    let prompt = `Task: ${item.title}\nState: ${item.state}\nFile: ${fullPath}`;

    if (priority.deadline) {
      prompt += `\nDeadline: ${priority.deadline}`;
    }

    if (priority["has-blocker"] && priority["blocker-context"]) {
      prompt += `\nBlocker: ${priority["blocker-context"]}`;
    }

    return prompt;
  }
}
