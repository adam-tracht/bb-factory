import type { QueueEntry, RepositoryKey, RepositoryRegistryEntry } from "../contracts.js";
import { repositoryLabel } from "../repository-label.js";
import type { TasksClient, TasksTask } from "../tasks/index.js";

export interface TasksRunCard {
  readonly taskId: string;
  readonly taskKey: string;
}

function trackerPrefix(repositoryKey: RepositoryKey): string {
  const letters = repositoryKey.toUpperCase().replace(/[^A-Z0-9]/gu, "");
  const prefix = letters.length === 0 ? "FACTORY" : letters;
  return (prefix[0] !== undefined && /[A-Z]/u.test(prefix[0]) ? prefix : `F${prefix}`).slice(0, 10);
}

function entryContext(entry: QueueEntry, runId: string): string {
  const list = (items: readonly string[]) => items.length === 0 ? "- none" : items.map((item) => `- ${item}`).join("\n");
  return [
    `Factory run id: ${runId}`,
    `Queue entry id: ${entry.id}`,
    `Plan: ${entry.planPath}`,
    "",
    "## Acceptance",
    list(entry.acceptance),
    "",
    "## Validation",
    list(entry.validate),
    "",
    `Risk: ${entry.risk}`,
    `Priority: ${entry.priority}`,
    `Notes: ${entry.notes ?? "none"}`,
    `Approval: ${entry.approved.kind === "explicit" ? entry.approved.text : "none"}`,
  ].join("\n");
}

function taskFromResult(result: Awaited<ReturnType<TasksClient["createTask"]>>): TasksTask {
  if (result.ok) return result.task;
  throw new Error(`Tasks rejected run card creation: ${result.error.message}`);
}

export async function ensureTasksRunCard(
  client: TasksClient,
  input: {
    readonly repositoryKey: RepositoryKey;
    readonly entry: RepositoryRegistryEntry;
    readonly queueEntry: QueueEntry;
    readonly runId: string;
  },
): Promise<TasksRunCard> {
  const projects = await client.listProjects();
  const linkedProject = projects.find((project) => project.linkedBbProjectId === input.entry.projectId)
    ?? await client.createProject({
      name: `Factory, ${repositoryLabel(input.repositoryKey, input.entry.displayName)}`,
      prefix: trackerPrefix(input.repositoryKey),
      linkedBbProjectId: input.entry.projectId,
    });
  const description = entryContext(input.queueEntry, input.runId);
  const tasks = await client.listAllTasks({ projectId: linkedProject.id });
  const existing = tasks.find((task) => task.description?.includes(`Factory run id: ${input.runId}`));
  if (existing) return { taskId: existing.id, taskKey: existing.key };
  const created = taskFromResult(await client.createTask({
    projectId: linkedProject.id,
    title: input.queueEntry.title,
    description,
    status: "todo",
    priority: "medium",
  }));
  return { taskId: created.id, taskKey: created.key };
}

export function tasksWorkerPrompt(taskKey: string): string {
  return [
    "Factory run. Read plans/factory/foreman.md first, then plans/factory/repo.md, and execute one run following the protocol. Your thread id is in $BB_THREAD_ID.",
    "",
    "In Tasks mode, in_review is the worker status ceiling. Never set this card to done; Factory moves it to done only after settlement verification.",
    `This run is tracked by Tasks card ${taskKey}. Before doing work, run: bb tasks attach ${taskKey}`,
    `Then report start with: bb tasks update ${taskKey} --status in_progress`,
    `Report material progress with: bb tasks comment ${taskKey} --body "<progress>"`,
    `Before finishing, report the result with: bb tasks comment ${taskKey} --body "<result>"`,
    `Then run: bb tasks update ${taskKey} --status in_review`,
    "Write the markdown run record as required for audit. Factory settlement in Tasks mode uses structured task-thread and repository signals, not markdown parsing.",
  ].join("\n");
}
