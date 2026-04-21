import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, decryptToken, getValidGoogleTokens } from "@agents/db";
import { runAgent } from "@agents/agent";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { tool_call_id, action } = await request.json() as {
    tool_call_id: string;
    action: "approve" | "reject";
  };

  if (!tool_call_id || !["approve", "reject"].includes(action)) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { data: toolCall } = await supabase
    .from("tool_calls")
    .select("id, status, session_id, tool_name, arguments_json, agent_sessions!inner(user_id)")
    .eq("id", tool_call_id)
    .eq("status", "pending_confirmation")
    .single();

  if (!toolCall) {
    return NextResponse.json({ error: "Tool call not found" }, { status: 404 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const session = (toolCall as any).agent_sessions;
  if (session?.user_id !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sessionId = (toolCall as any).session_id as string;

  const { data: profile } = await supabase
    .from("profiles")
    .select("agent_system_prompt")
    .eq("id", user.id)
    .single();

  const { data: toolSettings } = await supabase
    .from("user_tool_settings")
    .select("*")
    .eq("user_id", user.id);

  const { data: integrations } = await supabase
    .from("user_integrations")
    .select("*")
    .eq("user_id", user.id)
    .eq("status", "active");

  const encryptionKey = process.env.OAUTH_ENCRYPTION_KEY ?? "";
  let githubToken: string | undefined;
  const githubIntegration = (integrations ?? []).find(
    (i: Record<string, unknown>) => i.provider === "github"
  );
  if (githubIntegration?.encrypted_tokens && encryptionKey) {
    try {
      githubToken = decryptToken(githubIntegration.encrypted_tokens as string, encryptionKey);
    } catch {
      // token decryption failed
    }
  }

  const googleTokens = await getValidGoogleTokens(user.id);
  const googleAccessToken = googleTokens?.access_token ?? null;

  try {
    const db = createServerClient();
    const result = await runAgent({
      resumeDecision: action,
      sessionId,
      userId: user.id,
      systemPrompt: profile?.agent_system_prompt ?? "Eres un asistente útil.",
      db,
      enabledTools: (toolSettings ?? []).map((t: Record<string, unknown>) => ({
        id: t.id as string,
        user_id: t.user_id as string,
        tool_id: t.tool_id as string,
        enabled: t.enabled as boolean,
        config_json: (t.config_json as Record<string, unknown>) ?? {},
      })),
      integrations: (integrations ?? []).map((i: Record<string, unknown>) => ({
        id: i.id as string,
        user_id: i.user_id as string,
        provider: i.provider as string,
        scopes: (i.scopes as string[]) ?? [],
        status: i.status as "active" | "revoked" | "expired",
        created_at: i.created_at as string,
      })),
      githubToken,
      googleAccessToken,
    });

    return NextResponse.json({ ok: true, response: result.response });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: String(err) },
      { status: 500 }
    );
  }
}
