import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, decryptToken } from "@agents/db";
import { executeApprovedToolCall } from "@agents/agent";

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

  if (action === "reject") {
    await supabase
      .from("tool_calls")
      .update({ status: "rejected" })
      .eq("id", tool_call_id);
    return NextResponse.json({ ok: true, status: "rejected" });
  }

  await supabase
    .from("tool_calls")
    .update({ status: "approved" })
    .eq("id", tool_call_id);

  const { data: integrations } = await supabase
    .from("user_integrations")
    .select("*")
    .eq("user_id", user.id)
    .eq("provider", "github")
    .eq("status", "active")
    .limit(1);

  const encryptionKey = process.env.OAUTH_ENCRYPTION_KEY ?? "";
  let githubToken: string | undefined;
  const githubIntegration = integrations?.[0];
  if (githubIntegration?.encrypted_tokens && encryptionKey) {
    try {
      githubToken = decryptToken(githubIntegration.encrypted_tokens as string, encryptionKey);
    } catch {
      // token decryption failed
    }
  }

  try {
    const db = createServerClient();
    const result = await executeApprovedToolCall(
      db,
      tool_call_id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (toolCall as any).tool_name as string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (toolCall as any).arguments_json as Record<string, unknown>,
      githubToken
    );
    return NextResponse.json({ ok: true, status: "executed", result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, status: "failed", error: String(err) },
      { status: 500 }
    );
  }
}
