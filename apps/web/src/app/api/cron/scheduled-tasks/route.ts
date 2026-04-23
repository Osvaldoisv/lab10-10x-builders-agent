import dns from "node:dns";
import { NextResponse } from "next/server";

dns.setDefaultResultOrder("ipv4first");
import {
  createServerClient,
  decryptToken,
  getValidGoogleTokens,
  getOverdueTasks,
  markTaskRunning,
  createTaskRun,
  completeTaskRun,
  failTaskRun,
} from "@agents/db";
import { runAgent } from "@agents/agent";
import { sendTelegramMessage } from "@/lib/telegram";
import { buildSystemPrompt } from "@/lib/system-prompt";

const CRON_SECRET = process.env.CRON_SECRET ?? "";

export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.replace("Bearer ", "");
  if (CRON_SECRET && token !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createServerClient();
  const tasks = await getOverdueTasks(db);

  const results: { taskId: string; status: string; error?: string }[] = [];

  for (const task of tasks) {
    // Atomic lock: only proceed if we won the race to set status=running
    const acquired = await markTaskRunning(db, task.id);
    if (!acquired) {
      results.push({ taskId: task.id, status: "skipped" });
      continue;
    }

    const run = await createTaskRun(db, task.id);

    // Dedicated background session for this execution
    const { data: sessionData } = await db
      .from("agent_sessions")
      .insert({
        user_id:             task.user_id,
        channel:             "background",
        status:              "active",
        budget_tokens_used:  0,
        budget_tokens_limit: 100000,
      })
      .select()
      .single();

    if (!sessionData) {
      await failTaskRun(db, run.id, task.id, "Failed to create agent session", task);
      results.push({ taskId: task.id, status: "failed", error: "session_create_failed" });
      continue;
    }

    const sessionId = sessionData.id as string;

    const [profileRes, toolsRes, integrationsRes] = await Promise.all([
      db.from("profiles").select("agent_system_prompt, timezone").eq("id", task.user_id).single(),
      db.from("user_tool_settings").select("*").eq("user_id", task.user_id),
      db.from("user_integrations").select("*").eq("user_id", task.user_id).eq("status", "active"),
    ]);

    const profile      = profileRes.data;
    const toolSettings = toolsRes.data ?? [];
    const integrations = integrationsRes.data ?? [];

    const encryptionKey = process.env.OAUTH_ENCRYPTION_KEY ?? "";
    const githubIntegration = (integrations as Record<string, unknown>[]).find(
      (i) => i.provider === "github"
    );
    let githubToken: string | undefined;
    if (githubIntegration?.encrypted_tokens && encryptionKey) {
      try {
        githubToken = decryptToken(githubIntegration.encrypted_tokens as string, encryptionKey);
      } catch { /* decryption failed, proceed without it */ }
    }

    const googleTokens    = await getValidGoogleTokens(task.user_id);
    const googleAccessToken = googleTokens?.access_token ?? null;

    try {
      const backgroundPrefix =
        "Estás ejecutando una tarea programada en segundo plano. " +
        "Tu respuesta será enviada directamente al usuario como notificación vía Telegram. " +
        "Responde SOLO con el mensaje de la notificación, de forma clara y directa. " +
        "NO preguntes si el usuario quiere programar algo — la tarea ya está en ejecución.\n\n";

      const result = await runAgent({
        message:    task.prompt,
        userId:     task.user_id,
        sessionId,
        systemPrompt: buildSystemPrompt(
          backgroundPrefix + (profile?.agent_system_prompt ?? "Eres un asistente útil."),
          profile?.timezone ?? "UTC"
        ),
        db,
        enabledTools: (toolSettings as Record<string, unknown>[]).map((t) => ({
          id:          t.id as string,
          user_id:     t.user_id as string,
          tool_id:     t.tool_id as string,
          enabled:     t.enabled as boolean,
          config_json: (t.config_json as Record<string, unknown>) ?? {},
        })),
        integrations: (integrations as Record<string, unknown>[]).map((i) => ({
          id:         i.id as string,
          user_id:    i.user_id as string,
          provider:   i.provider as string,
          scopes:     (i.scopes as string[]) ?? [],
          status:     i.status as "active" | "revoked" | "expired",
          created_at: i.created_at as string,
        })),
        githubToken,
        googleAccessToken,
      });

      // Telegram notification
      const { data: telegramAccount } = await db
        .from("telegram_accounts")
        .select("chat_id")
        .eq("user_id", task.user_id)
        .single();

      let notified = false;
      let notifiedSkipReason: string | undefined;

      if (telegramAccount) {
        try {
          await sendTelegramMessage(
            telegramAccount.chat_id as number,
            result.response
          );
          notified = true;
        } catch (tgErr) {
          console.error(`[cron] Telegram notification failed for task ${task.id}:`, tgErr);
          notifiedSkipReason = `telegram_error: ${String(tgErr)}`;
        }
      } else {
        notifiedSkipReason = "no_telegram_link";
      }

      await db.from("agent_sessions").update({ status: "closed" }).eq("id", sessionId);
      await completeTaskRun(db, run.id, task.id, {
        agentSessionId: sessionId,
        notified,
        notifiedSkipReason,
        task,
      });

      results.push({ taskId: task.id, status: "completed" });
    } catch (err) {
      const errMsg = String(err);
      await db.from("agent_sessions").update({ status: "closed" }).eq("id", sessionId);
      await failTaskRun(db, run.id, task.id, errMsg, task);
      results.push({ taskId: task.id, status: "failed", error: errMsg });
      console.error(`[cron] Task ${task.id} failed:`, err);
    }
  }

  return NextResponse.json({ ok: true, processed: tasks.length, results });
}
