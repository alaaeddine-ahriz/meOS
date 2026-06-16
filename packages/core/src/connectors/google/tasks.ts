import type { DeltaResult, TaskItem, TaskList } from "../types.js";
import { googleGet, googleWrite } from "./http.js";

/**
 * Thin Google Tasks REST client. Unlike the other Google kinds this one is
 * READ + WRITE: it incrementally syncs tasks from the enabled task lists, and it
 * can CREATE a task back in Google Tasks (the write capability that makes this
 * meOS's first read/write connector). Google Tasks has no sync-token delta, so we
 * fall back to `updatedMin` for incremental pulls and page through with
 * `pageToken`. The cursor we persist is the highest `updated` timestamp we saw.
 */

const BASE = "https://www.googleapis.com/tasks/v1";
const DEEP_LINK = "https://tasks.google.com/";

interface RawTask {
  id: string;
  title?: string;
  notes?: string;
  status?: string;
  due?: string;
  updated?: string;
  deleted?: boolean;
  hidden?: boolean;
}
interface TasksResponse {
  items?: RawTask[];
  nextPageToken?: string;
}
interface RawTaskList {
  id: string;
  title?: string;
}
interface TaskListsResponse {
  items?: RawTaskList[];
  nextPageToken?: string;
}

function normalize(task: RawTask, list: TaskList): TaskItem {
  const status = task.status === "completed" ? "completed" : "needsAction";
  return {
    externalId: task.id,
    title: task.title?.trim() || "(untitled task)",
    notes: task.notes?.trim() || undefined,
    due: task.due ?? null,
    status,
    completed: status === "completed",
    taskListId: list.id,
    taskListTitle: list.title,
    updated: task.updated ?? null,
    deepLink: DEEP_LINK,
  };
}

/** List the account's task lists (used for selection + the create-task default). */
export async function listTaskLists(accessToken: string): Promise<TaskList[]> {
  const lists: TaskList[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ maxResults: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await googleGet<TaskListsResponse>(
      `${BASE}/users/@me/lists?${params.toString()}`,
      accessToken,
    );
    for (const l of data.items ?? []) lists.push({ id: l.id, title: l.title?.trim() || l.id });
    pageToken = data.nextPageToken;
  } while (pageToken);
  return lists;
}

/** Page through one task list, returning its tasks (changed since `updatedMin`). */
async function fetchListTasks(
  accessToken: string,
  list: TaskList,
  updatedMin: string | null,
): Promise<{ items: TaskItem[]; deletions: string[] }> {
  const items: TaskItem[] = [];
  const deletions: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      maxResults: "100",
      showCompleted: "true",
      showHidden: "true",
      showDeleted: "true",
    });
    if (updatedMin) params.set("updatedMin", updatedMin);
    if (pageToken) params.set("pageToken", pageToken);
    const data = await googleGet<TasksResponse>(
      `${BASE}/lists/${encodeURIComponent(list.id)}/tasks?${params.toString()}`,
      accessToken,
    );
    for (const task of data.items ?? []) {
      if (task.deleted) deletions.push(task.id);
      else items.push(normalize(task, list));
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return { items, deletions };
}

/**
 * Pull tasks changed since the saved cursor across the configured task lists (or
 * all lists when none are pinned). The cursor is the latest `updated` timestamp
 * we've seen; on the next run we pass it as `updatedMin` so Google returns only
 * newer changes. Returns the new high-water mark as `nextSyncToken`.
 */
export async function fetchTasksDelta(
  accessToken: string,
  cursor?: string | null,
  opts?: { taskListIds?: string[] },
): Promise<DeltaResult<TaskItem>> {
  const allLists = await listTaskLists(accessToken);
  const wanted = opts?.taskListIds?.length
    ? allLists.filter((l) => opts.taskListIds!.includes(l.id))
    : allLists;

  const items: TaskItem[] = [];
  const deletions: string[] = [];
  // Google's updatedMin is exclusive of nothing — bump it by 1ms so we don't
  // re-fetch the boundary task on every run.
  const updatedMin = cursor ? new Date(Date.parse(cursor) + 1).toISOString() : null;
  let highWater = cursor ?? null;

  for (const list of wanted) {
    const page = await fetchListTasks(accessToken, list, updatedMin);
    items.push(...page.items);
    deletions.push(...page.deletions);
    for (const t of page.items) {
      if (t.updated && (!highWater || t.updated > highWater)) highWater = t.updated;
    }
  }

  return { items, deletions, nextSyncToken: highWater };
}

/** Create a new task in `taskListId`. Returns the created task, normalized. */
export async function createTask(
  accessToken: string,
  taskListId: string,
  input: { title: string; notes?: string; due?: string | null },
): Promise<TaskItem> {
  const body: Record<string, unknown> = { title: input.title };
  if (input.notes) body.notes = input.notes;
  if (input.due) body.due = input.due;
  const created = await googleWrite<RawTask>(
    `${BASE}/lists/${encodeURIComponent(taskListId)}/tasks`,
    accessToken,
    "POST",
    body,
  );
  // Resolve the owning list's title for a complete normalized item.
  const lists = await listTaskLists(accessToken);
  const list = lists.find((l) => l.id === taskListId) ?? { id: taskListId, title: taskListId };
  return normalize(created, list);
}

/** Mark a task completed (or reopen it). Returns the updated task, normalized. */
export async function completeTask(
  accessToken: string,
  taskListId: string,
  taskId: string,
  completed = true,
): Promise<TaskItem> {
  const updated = await googleWrite<RawTask>(
    `${BASE}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`,
    accessToken,
    "PATCH",
    { status: completed ? "completed" : "needsAction" },
  );
  const lists = await listTaskLists(accessToken);
  const list = lists.find((l) => l.id === taskListId) ?? { id: taskListId, title: taskListId };
  return normalize(updated, list);
}
