import type { DbClient } from "../client";

export interface ScheduledTask {
  id: string;
  user_id: string;
  prompt: string;
  schedule_type: "one_time" | "recurring";
  run_at: string | null;
  cron_expr: string | null;
  timezone: string;
  status: "active" | "running" | "completed" | "failed" | "cancelled";
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduledTaskRun {
  id: string;
  task_id: string;
  status: "running" | "completed" | "failed";
  started_at: string;
  finished_at: string | null;
  error: string | null;
  agent_session_id: string | null;
  notified: boolean;
  notified_skip_reason: string | null;
}

/**
 * Calculates the next occurrence of a 5-field cron expression after `after`.
 * Brute-forces minute by minute — correct for all standard cron patterns.
 */
export function nextRunFromCron(cronExpr: string, timezone = "UTC", after = new Date()): Date {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron expression (need 5 fields): ${cronExpr}`);
  const [minF, hourF, domF, monthF, dowF] = parts;

  function parseField(field: string, lo: number, hi: number): Set<number> {
    const result = new Set<number>();
    for (const seg of field.split(",")) {
      if (seg === "*") {
        for (let i = lo; i <= hi; i++) result.add(i);
      } else if (seg.includes("/")) {
        const [range, step] = seg.split("/");
        const s = parseInt(step);
        let rFrom = lo;
        let rTo = hi;
        if (range !== "*") {
          if (range.includes("-")) {
            [rFrom, rTo] = range.split("-").map(Number) as [number, number];
          } else {
            rFrom = parseInt(range);
          }
        }
        for (let i = rFrom; i <= rTo; i += s) result.add(i);
      } else if (seg.includes("-")) {
        const [a, b] = seg.split("-").map(Number);
        for (let i = a; i <= b; i++) result.add(i);
      } else {
        result.add(parseInt(seg));
      }
    }
    return result;
  }

  const mins   = parseField(minF,   0, 59);
  const hours  = parseField(hourF,  0, 23);
  const doms   = parseField(domF,   1, 31);
  const months = parseField(monthF, 1, 12);
  const dows   = parseField(dowF,   0,  7);
  if (dows.has(7)) dows.add(0); // 7 = Sunday alias for 0

  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "long",
    hour12: false,
  });

  function getParts(d: Date) {
    const p: Record<string, string> = {};
    for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
    return {
      month:  parseInt(p.month),
      day:    parseInt(p.day),
      hour:   p.hour === "24" ? 0 : parseInt(p.hour),
      minute: parseInt(p.minute),
      dow:    ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].indexOf(p.weekday),
    };
  }

  let current = new Date(after);
  current.setSeconds(0, 0);
  current = new Date(current.getTime() + 60_000);

  const limit = new Date(after.getTime() + 366 * 24 * 60 * 60 * 1000);

  while (current < limit) {
    const { month, day, hour, minute, dow } = getParts(current);
    if (
      months.has(month) &&
      doms.has(day) &&
      (dowF === "*" || dows.has(dow)) &&
      hours.has(hour) &&
      mins.has(minute)
    ) {
      return current;
    }
    current = new Date(current.getTime() + 60_000);
  }

  throw new Error(`No next run found within 1 year for cron: ${cronExpr}`);
}

export async function createScheduledTask(
  db: DbClient,
  userId: string,
  params: {
    prompt: string;
    schedule_type: "one_time" | "recurring";
    run_at: string | null;
    cron_expr: string | null;
    timezone: string;
    next_run_at: string;
  }
): Promise<ScheduledTask> {
  const { data, error } = await db
    .from("scheduled_tasks")
    .insert({
      user_id:       userId,
      prompt:        params.prompt,
      schedule_type: params.schedule_type,
      run_at:        params.run_at,
      cron_expr:     params.cron_expr,
      timezone:      params.timezone,
      status:        "active",
      next_run_at:   params.next_run_at,
    })
    .select()
    .single();
  if (error) throw error;
  return data as ScheduledTask;
}

export async function getOverdueTasks(db: DbClient): Promise<ScheduledTask[]> {
  const { data, error } = await db
    .from("scheduled_tasks")
    .select("*")
    .eq("status", "active")
    .lte("next_run_at", new Date().toISOString())
    .order("next_run_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as ScheduledTask[];
}

export async function markTaskRunning(db: DbClient, taskId: string): Promise<boolean> {
  const { data } = await db
    .from("scheduled_tasks")
    .update({ status: "running", updated_at: new Date().toISOString() })
    .eq("id", taskId)
    .eq("status", "active")
    .select("id");
  return (data?.length ?? 0) > 0;
}

export async function createTaskRun(db: DbClient, taskId: string): Promise<ScheduledTaskRun> {
  const { data, error } = await db
    .from("scheduled_task_runs")
    .insert({ task_id: taskId, status: "running" })
    .select()
    .single();
  if (error) throw error;
  return data as ScheduledTaskRun;
}

export async function completeTaskRun(
  db: DbClient,
  runId: string,
  taskId: string,
  opts: {
    agentSessionId?: string;
    notified: boolean;
    notifiedSkipReason?: string;
    task: ScheduledTask;
  }
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .from("scheduled_task_runs")
    .update({
      status:               "completed",
      finished_at:          now,
      agent_session_id:     opts.agentSessionId ?? null,
      notified:             opts.notified,
      notified_skip_reason: opts.notifiedSkipReason ?? null,
    })
    .eq("id", runId);

  if (opts.task.schedule_type === "recurring" && opts.task.cron_expr) {
    const nextRun = nextRunFromCron(opts.task.cron_expr, opts.task.timezone);
    await db
      .from("scheduled_tasks")
      .update({
        status:      "active",
        last_run_at: now,
        next_run_at: nextRun.toISOString(),
        updated_at:  now,
      })
      .eq("id", taskId);
  } else {
    await db
      .from("scheduled_tasks")
      .update({ status: "completed", last_run_at: now, updated_at: now })
      .eq("id", taskId);
  }
}

export async function failTaskRun(
  db: DbClient,
  runId: string,
  taskId: string,
  error: string,
  task: ScheduledTask
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .from("scheduled_task_runs")
    .update({ status: "failed", finished_at: now, error })
    .eq("id", runId);

  if (task.schedule_type === "recurring" && task.cron_expr) {
    try {
      const nextRun = nextRunFromCron(task.cron_expr, task.timezone);
      await db
        .from("scheduled_tasks")
        .update({
          status:      "active",
          last_run_at: now,
          next_run_at: nextRun.toISOString(),
          updated_at:  now,
        })
        .eq("id", taskId);
    } catch {
      await db
        .from("scheduled_tasks")
        .update({ status: "failed", last_run_at: now, updated_at: now })
        .eq("id", taskId);
    }
  } else {
    await db
      .from("scheduled_tasks")
      .update({ status: "failed", last_run_at: now, updated_at: now })
      .eq("id", taskId);
  }
}
