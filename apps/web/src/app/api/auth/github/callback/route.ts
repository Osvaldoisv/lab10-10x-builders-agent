import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, encryptToken, upsertIntegration } from "@agents/db";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  if (!code || !state) {
    return NextResponse.redirect(`${BASE_URL}/settings?github=error`);
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.id !== state) {
    return NextResponse.redirect(`${BASE_URL}/settings?github=error`);
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const encryptionKey = process.env.OAUTH_ENCRYPTION_KEY;

  if (!clientId || !clientSecret || !encryptionKey) {
    return NextResponse.redirect(`${BASE_URL}/settings?github=error`);
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });

  if (!tokenRes.ok) {
    return NextResponse.redirect(`${BASE_URL}/settings?github=error`);
  }

  const tokenData = await tokenRes.json() as { access_token?: string; scope?: string; error?: string };
  if (!tokenData.access_token) {
    return NextResponse.redirect(`${BASE_URL}/settings?github=error`);
  }

  const scopes = (tokenData.scope ?? "").split(",").filter(Boolean);
  const encrypted = encryptToken(tokenData.access_token, encryptionKey);

  const db = createServerClient();
  await upsertIntegration(db, user.id, "github", scopes, encrypted);

  return NextResponse.redirect(`${BASE_URL}/settings?github=connected`);
}
