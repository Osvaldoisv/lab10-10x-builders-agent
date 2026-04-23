import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration } from "@agents/types";
import { TOOL_CATALOG } from "./catalog";
import { createToolCall, updateToolCallStatus } from "@agents/db";

export async function executeApprovedToolCall(
  db: DbClient,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  githubToken?: string,
  googleAccessToken?: string | null
): Promise<Record<string, unknown>> {
  try {
    let result: Record<string, unknown>;

    if (toolName === "github_create_repo") {
      if (!githubToken) throw new Error("GitHub not connected");
      const data = await githubFetch(
        "/user/repos",
        githubToken,
        {
          method: "POST",
          body: JSON.stringify({
            name: args.name,
            description: args.description ?? "",
            private: args.private ?? false,
          }),
        }
      ) as { full_name: string; html_url: string };
      result = { full_name: data.full_name, url: data.html_url };
    } else if (toolName === "github_create_issue") {
      if (!githubToken) throw new Error("GitHub not connected");
      const data = await githubFetch(
        `/repos/${args.owner}/${args.repo}/issues`,
        githubToken,
        {
          method: "POST",
          body: JSON.stringify({ title: args.title, body: args.body ?? "" }),
        }
      ) as { number: number; html_url: string };
      result = { issue_number: data.number, url: data.html_url };
    } else if (toolName === "google_calendar_confirm_attendance") {
      if (!googleAccessToken) throw new Error("Google Calendar not connected");
      const userEmail = process.env.USER_EMAIL;
      const res = await googleCalendarFetch(
        `/calendars/primary/events/${args.event_id}?sendUpdates=all`,
        googleAccessToken,
        {
          method: "PATCH",
          body: JSON.stringify({
            attendees: [{ email: userEmail ?? "", responseStatus: "accepted" }],
          }),
        }
      ) as { id: string; summary: string };
      result = { event_id: res.id, summary: res.summary, status: "accepted" };
    } else if (toolName === "bash") {
      const { executeBash } = await import("./bashExec");
      result = await executeBash(
        (args.terminal as string) ?? "default",
        args.prompt as string
      ) as unknown as Record<string, unknown>;
    } else if (toolName === "write_file") {
      const { executeWriteFile } = await import("./fileTools");
      result = await executeWriteFile({
        path: args.path as string,
        content: args.content as string,
      }) as unknown as Record<string, unknown>;
    } else if (toolName === "edit_file") {
      const { executeEditFile } = await import("./fileTools");
      result = await executeEditFile({
        path: args.path as string,
        old_string: args.old_string as string,
        new_string: args.new_string as string,
      }) as unknown as Record<string, unknown>;
    } else if (toolName === "schedule_task") {
      const { data: tcSession } = await db
        .from("tool_calls")
        .select("agent_sessions!inner(user_id)")
        .eq("id", toolCallId)
        .single();
      if (!tcSession) throw new Error("Tool call session not found");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const userId = (tcSession as any).agent_sessions.user_id as string;

      const { createScheduledTask, nextRunFromCron } = await import("@agents/db");
      const schedType = args.schedule_type as "one_time" | "recurring";
      const tz = (args.timezone as string | undefined) ?? "UTC";

      let nextRunAt: string;
      if (schedType === "one_time") {
        if (!args.run_at) throw new Error("run_at is required for one_time tasks");
        nextRunAt = args.run_at as string;
      } else {
        if (!args.cron_expr) throw new Error("cron_expr is required for recurring tasks");
        nextRunAt = nextRunFromCron(args.cron_expr as string, tz).toISOString();
      }

      const task = await createScheduledTask(db, userId, {
        prompt:        args.prompt as string,
        schedule_type: schedType,
        run_at:        (args.run_at as string | undefined) ?? null,
        cron_expr:     (args.cron_expr as string | undefined) ?? null,
        timezone:      tz,
        next_run_at:   nextRunAt,
      });

      result = {
        task_id:       task.id,
        schedule_type: task.schedule_type,
        next_run_at:   task.next_run_at,
        message: schedType === "one_time"
          ? `Tarea programada para ${nextRunAt}.`
          : `Tarea recurrente creada. Próxima ejecución: ${nextRunAt}.`,
      };
    } else {
      throw new Error(`Tool not executable post-confirmation: ${toolName}`);
    }

    await updateToolCallStatus(db, toolCallId, "executed", result);
    return result;
  } catch (err) {
    await updateToolCallStatus(db, toolCallId, "failed", { error: String(err) });
    throw err;
  }
}

interface ToolContext {
  db: DbClient;
  userId: string;
  sessionId: string;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  githubToken?: string;
  googleAccessToken?: string | null;
}

function isToolAvailable(toolId: string, ctx: ToolContext): boolean {
  const setting = ctx.enabledTools.find((t) => t.tool_id === toolId);
  if (!setting?.enabled) return false;

  const def = TOOL_CATALOG.find((t) => t.id === toolId);
  if (def?.requires_integration) {
    const hasIntegration = ctx.integrations.some(
      (i) => i.provider === def.requires_integration && i.status === "active"
    );
    if (!hasIntegration) return false;
  }
  return true;
}

async function githubFetch(
  path: string,
  token: string,
  options: RequestInit = {}
): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${body}`);
  }
  return res.json();
}

async function googleCalendarFetch(
  path: string,
  token: string,
  options: RequestInit = {}
): Promise<unknown> {
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Calendar API error ${res.status}: ${body}`);
  }
  return res.json();
}

export function buildLangChainTools(ctx: ToolContext) {
  const tools = [];

  if (isToolAvailable("get_user_preferences", ctx)) {
    tools.push(
      tool(
        async () => {
          const { getProfile } = await import("@agents/db");
          const profile = await getProfile(ctx.db, ctx.userId);
          return JSON.stringify({
            name: profile.name,
            timezone: profile.timezone,
            language: profile.language,
            agent_name: profile.agent_name,
          });
        },
        {
          name: "get_user_preferences",
          description: "Returns the current user preferences and agent configuration.",
          schema: z.object({}),
        }
      )
    );
  }

  if (isToolAvailable("list_enabled_tools", ctx)) {
    tools.push(
      tool(
        async () => {
          const enabled = ctx.enabledTools
            .filter((t) => t.enabled)
            .map((t) => t.tool_id);
          return JSON.stringify(enabled);
        },
        {
          name: "list_enabled_tools",
          description: "Lists all tools the user has currently enabled.",
          schema: z.object({}),
        }
      )
    );
  }

  if (isToolAvailable("github_list_repos", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "github_list_repos", input, false
          );
          try {
            if (!ctx.githubToken) throw new Error("GitHub not connected");
            const data = await githubFetch(
              `/user/repos?per_page=${input.per_page ?? 10}&sort=updated`,
              ctx.githubToken
            ) as Array<{ full_name: string; description: string | null; private: boolean; html_url: string }>;
            const repos = data.map((r) => ({
              full_name: r.full_name,
              description: r.description,
              private: r.private,
              url: r.html_url,
            }));
            const result = { repos };
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            return JSON.stringify(result);
          } catch (err) {
            await updateToolCallStatus(ctx.db, record.id, "failed", { error: String(err) });
            return JSON.stringify({ error: String(err) });
          }
        },
        {
          name: "github_list_repos",
          description: "Lists the user's GitHub repositories.",
          schema: z.object({
            per_page: z.number().max(30).optional().default(10),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_list_issues", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "github_list_issues", input, false
          );
          try {
            if (!ctx.githubToken) throw new Error("GitHub not connected");
            const data = await githubFetch(
              `/repos/${input.owner}/${input.repo}/issues?state=${input.state ?? "open"}&per_page=20`,
              ctx.githubToken
            ) as Array<{ number: number; title: string; state: string; html_url: string; body: string | null }>;
            const issues = data.map((i) => ({
              number: i.number,
              title: i.title,
              state: i.state,
              url: i.html_url,
            }));
            const result = { issues };
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            return JSON.stringify(result);
          } catch (err) {
            await updateToolCallStatus(ctx.db, record.id, "failed", { error: String(err) });
            return JSON.stringify({ error: String(err) });
          }
        },
        {
          name: "github_list_issues",
          description: "Lists issues for a given repository.",
          schema: z.object({
            owner: z.string(),
            repo: z.string(),
            state: z.enum(["open", "closed", "all"]).optional().default("open"),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_create_issue", ctx)) {
    tools.push(
      tool(
        async () => JSON.stringify({ status: "pending_hitl" }),
        {
          name: "github_create_issue",
          description: "Creates a new issue in a GitHub repository. Requires confirmation.",
          schema: z.object({
            owner: z.string(),
            repo: z.string(),
            title: z.string(),
            body: z.string().optional().default(""),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_create_repo", ctx)) {
    tools.push(
      tool(
        async () => JSON.stringify({ status: "pending_hitl" }),
        {
          name: "github_create_repo",
          description: "Creates a new GitHub repository for the authenticated user. Requires confirmation.",
          schema: z.object({
            name: z.string(),
            description: z.string().optional().default(""),
            private: z.boolean().optional().default(false),
          }),
        }
      )
    );
  }

  if (isToolAvailable("bash", ctx)) {
    tools.push(
      tool(
        async () => JSON.stringify({ status: "pending_hitl" }),
        {
          name: "bash",
          description: "Ejecuta un comando de shell en el servidor. Requiere confirmación.",
          schema: z.object({
            terminal: z.string().optional().default("default"),
            prompt: z.string().max(4096),
          }),
        }
      )
    );
  }

  if (isToolAvailable("read_file", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "read_file", input as Record<string, unknown>, false
          );
          try {
            const { executeReadFile } = await import("./fileTools");
            const result = await executeReadFile(input);
            await updateToolCallStatus(ctx.db, record.id, "executed", result as unknown as Record<string, unknown>);
            return JSON.stringify(result);
          } catch (err) {
            await updateToolCallStatus(ctx.db, record.id, "failed", { error: String(err) });
            return JSON.stringify({ ok: false, tool: "read_file", path: input.path, error: { code: "UNEXPECTED", message: String(err) } });
          }
        },
        {
          name: "read_file",
          description: "Reads an existing text file under the configured workspace root. Returns file content and line metadata.",
          schema: z.object({
            path: z.string().describe("Ruta relativa al workspace root (sin ..)"),
            offset: z.number().int().positive().optional().describe("Línea inicial 1-based"),
            limit: z.number().int().positive().max(2000).optional().describe("Número máximo de líneas"),
          }),
        }
      )
    );
  }

  if (isToolAvailable("write_file", ctx)) {
    tools.push(
      tool(
        async () => JSON.stringify({ status: "pending_hitl" }),
        {
          name: "write_file",
          description: "Creates a new file with the given UTF-8 content. Fails if the file already exists. Requires confirmation.",
          schema: z.object({
            path: z.string().describe("Ruta relativa al workspace root (sin ..)"),
            content: z.string().max(500_000).describe("Contenido completo del archivo a crear"),
          }),
        }
      )
    );
  }

  if (isToolAvailable("edit_file", ctx)) {
    tools.push(
      tool(
        async () => JSON.stringify({ status: "pending_hitl" }),
        {
          name: "edit_file",
          description: "Edits an existing file by replacing exactly one occurrence of old_string with new_string. Requires confirmation.",
          schema: z.object({
            path: z.string().describe("Ruta relativa al workspace root (sin ..)"),
            old_string: z.string().max(100_000).describe("Fragmento literal exacto a reemplazar"),
            new_string: z.string().max(100_000).describe("Texto de reemplazo"),
          }),
        }
      )
    );
  }

  if (isToolAvailable("google_calendar_get_events", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "google_calendar_get_events", input, false
          );
          try {
            if (!ctx.googleAccessToken) throw new Error("Google Calendar not connected");
            const now = new Date().toISOString();
            const params = new URLSearchParams({
              timeMin: now,
              maxResults: "10",
              singleEvents: "true",
              orderBy: "startTime",
            });
            const data = await googleCalendarFetch(
              `/calendars/primary/events?${params.toString()}`,
              ctx.googleAccessToken
            ) as { items: Array<{
              id: string;
              summary: string;
              start: { dateTime?: string; date?: string };
              attendees?: Array<{ email: string; responseStatus: string; self?: boolean }>;
            }> };
            const events = (data.items ?? []).map((e) => ({
              id: e.id,
              summary: e.summary,
              start: e.start.dateTime ?? e.start.date,
              responseStatus: e.attendees?.find((a) => a.self)?.responseStatus ?? "unknown",
            }));
            const result = { events };
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            return JSON.stringify(result);
          } catch (err) {
            await updateToolCallStatus(ctx.db, record.id, "failed", { error: String(err) });
            return JSON.stringify({ error: String(err) });
          }
        },
        {
          name: "google_calendar_get_events",
          description: "Lista los próximos eventos del calendario de Google del usuario.",
          schema: z.object({}),
        }
      )
    );
  }

  if (isToolAvailable("schedule_task", ctx)) {
    tools.push(
      tool(
        async () => JSON.stringify({ status: "pending_hitl" }),
        {
          name: "schedule_task",
          description: "Crea una tarea programada que ejecutará un prompt del agente en un momento específico. Requiere confirmación.",
          schema: z.object({
            prompt:        z.string().describe(
              "Instrucción que ejecutará el agente en segundo plano cuando llegue el momento. " +
              "Para recordatorios simples, usa el formato: 'Notifica al usuario: <mensaje del recordatorio>'. " +
              "Ejemplo: 'Notifica al usuario: ¡Es hora de tomar agua!'."
            ),
            schedule_type: z.enum(["one_time", "recurring"]),
            run_at:        z.string().optional().describe("ISO timestamp para tareas de una sola vez"),
            cron_expr:     z.string().optional().describe("Expresión cron de 5 campos para tareas recurrentes"),
            timezone:      z.string().optional().default("UTC").describe("Zona horaria IANA"),
          }),
        }
      )
    );
  }

  if (isToolAvailable("google_calendar_confirm_attendance", ctx)) {
    tools.push(
      tool(
        async () => JSON.stringify({ status: "pending_hitl" }),
        {
          name: "google_calendar_confirm_attendance",
          description: "Confirma la asistencia del usuario a un evento del calendario de Google. Requiere confirmación.",
          schema: z.object({
            event_id: z.string(),
          }),
        }
      )
    );
  }

  return tools;
}
