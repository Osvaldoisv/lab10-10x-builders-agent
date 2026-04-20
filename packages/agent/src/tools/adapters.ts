import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration } from "@agents/types";
import { TOOL_CATALOG, toolRequiresConfirmation } from "./catalog";
import { createToolCall, updateToolCallStatus } from "@agents/db";

export async function executeApprovedToolCall(
  db: DbClient,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  githubToken?: string
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
        async (input) => {
          const needsConfirm = toolRequiresConfirmation("github_create_issue");
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "github_create_issue", input, needsConfirm
          );
          if (needsConfirm) {
            return JSON.stringify({
              pending_confirmation: true,
              tool_call_id: record.id,
              message: `Crear issue "${input.title}" en ${input.owner}/${input.repo}.`,
            });
          }
          try {
            if (!ctx.githubToken) throw new Error("GitHub not connected");
            const data = await githubFetch(
              `/repos/${input.owner}/${input.repo}/issues`,
              ctx.githubToken,
              {
                method: "POST",
                body: JSON.stringify({ title: input.title, body: input.body ?? "" }),
              }
            ) as { number: number; html_url: string };
            const result = { issue_number: data.number, url: data.html_url };
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            return JSON.stringify(result);
          } catch (err) {
            await updateToolCallStatus(ctx.db, record.id, "failed", { error: String(err) });
            return JSON.stringify({ error: String(err) });
          }
        },
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
        async (input) => {
          const needsConfirm = toolRequiresConfirmation("github_create_repo");
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "github_create_repo", input, needsConfirm
          );
          if (needsConfirm) {
            const visibility = input.private ? "privado" : "público";
            return JSON.stringify({
              pending_confirmation: true,
              tool_call_id: record.id,
              message: `Crear repositorio ${visibility} "${input.name}"${input.description ? `: ${input.description}` : ""}.`,
            });
          }
          try {
            if (!ctx.githubToken) throw new Error("GitHub not connected");
            const data = await githubFetch(
              "/user/repos",
              ctx.githubToken,
              {
                method: "POST",
                body: JSON.stringify({
                  name: input.name,
                  description: input.description ?? "",
                  private: input.private ?? false,
                }),
              }
            ) as { full_name: string; html_url: string };
            const result = { full_name: data.full_name, url: data.html_url };
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            return JSON.stringify(result);
          } catch (err) {
            await updateToolCallStatus(ctx.db, record.id, "failed", { error: String(err) });
            return JSON.stringify({ error: String(err) });
          }
        },
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

  return tools;
}
