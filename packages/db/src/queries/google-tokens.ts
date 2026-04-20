import { createServerClient } from "../client";
import { decryptToken, encryptToken } from "../crypto";

interface GoogleTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
}

export async function getValidGoogleTokens(
  userId: string
): Promise<{ access_token: string } | null> {
  const encryptionKey = process.env.OAUTH_ENCRYPTION_KEY;
  if (!encryptionKey) return null;

  const db = createServerClient();
  const { data, error } = await db
    .from("user_integrations")
    .select("encrypted_tokens")
    .eq("user_id", userId)
    .eq("provider", "google_calendar")
    .eq("status", "active")
    .single();

  if (error || !data?.encrypted_tokens) return null;

  let tokens: GoogleTokens;
  try {
    tokens = JSON.parse(decryptToken(data.encrypted_tokens, encryptionKey)) as GoogleTokens;
  } catch {
    return null;
  }

  // Refresh if expiring within 5 minutes
  if (tokens.expires_at > Date.now() + 5 * 60 * 1000) {
    return { access_token: tokens.access_token };
  }

  if (!tokens.refresh_token) return null;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) return null;

  const refreshed = await res.json() as {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
  };
  if (!refreshed.access_token) return null;

  const updatedTokens: GoogleTokens = {
    access_token: refreshed.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
    token_type: refreshed.token_type ?? "Bearer",
  };

  const encrypted = encryptToken(JSON.stringify(updatedTokens), encryptionKey);
  await db
    .from("user_integrations")
    .update({ encrypted_tokens: encrypted })
    .eq("user_id", userId)
    .eq("provider", "google_calendar");

  return { access_token: updatedTokens.access_token };
}
