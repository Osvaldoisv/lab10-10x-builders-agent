import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, encryptToken, upsertIntegration } from "@agents/db";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  if (!code || !state) {
    return NextResponse.redirect(`${BASE_URL}/settings?google=error`);
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.id !== state) {
    return NextResponse.redirect(`${BASE_URL}/settings?google=error`);
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const encryptionKey = process.env.OAUTH_ENCRYPTION_KEY;

  if (!clientId || !clientSecret || !encryptionKey) {
    return NextResponse.redirect(`${BASE_URL}/settings?google=error`);
  }

  const redirectUri = `${BASE_URL}/api/auth/google/callback`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    return NextResponse.redirect(`${BASE_URL}/settings?google=error`);
  }

  const tokenData = await tokenRes.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    error?: string;
  };

  if (!tokenData.access_token) {
    return NextResponse.redirect(`${BASE_URL}/settings?google=error`);
  }

  const tokens = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token ?? "",
    expires_at: Date.now() + (tokenData.expires_in ?? 3600) * 1000,
    token_type: tokenData.token_type ?? "Bearer",
  };

  const encrypted = encryptToken(JSON.stringify(tokens), encryptionKey);
  const db = createServerClient();
  await upsertIntegration(db, user.id, "google_calendar", ["calendar.events"], encrypted);

  // Auto-enable Google Calendar tools so they're immediately available to the agent
  for (const toolId of ["google_calendar_get_events", "google_calendar_confirm_attendance"]) {
    await db.from("user_tool_settings").upsert(
      { user_id: user.id, tool_id: toolId, enabled: true, config_json: {} },
      { onConflict: "user_id,tool_id" }
    );
  }

  return NextResponse.redirect(`${BASE_URL}/settings?google=connected`);
}
