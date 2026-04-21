// Shared OAuth token handling so both next-auth and background jobs
// (Inngest, sync fallback) can refresh access tokens consistently.

import { createServiceRoleClient } from "./supabase";

export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresAt: number; // seconds since epoch
} | null> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!res.ok || data.error || !data.access_token) return null;
    return {
      accessToken: data.access_token,
      expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
    };
  } catch {
    return null;
  }
}

/**
 * Return a valid (not-yet-expired) Gmail access token for the given user.
 * Background jobs (Inngest, sync fallback) call this instead of trusting
 * whatever is currently in user_tokens, because tokens expire in ~1 hour
 * and jobs can run arbitrarily later than the row was written.
 *
 * Falls back to the stored access_token if refresh can't happen (e.g. no
 * refresh_token on the row yet — in that case the caller will still get
 * the stale token and Gmail will 401; log the warning and continue).
 */
export async function getUsableAccessToken(userId: string): Promise<string | null> {
  const supabase = createServiceRoleClient();

  // Try to pull the full row including optional refresh fields.
  // refresh_token / expires_at may not exist on the table yet — handled
  // by the schema-tolerant SELECT fallback below.
  const fullResult = await supabase
    .from("user_tokens")
    .select("access_token, refresh_token, expires_at")
    .eq("user_id", userId)
    .maybeSingle();

  let row: {
    access_token: string;
    refresh_token: string | null;
    expires_at: number | null;
  } | null = null;

  if (fullResult.error) {
    // Fall back to legacy schema (access_token only)
    const legacy = await supabase
      .from("user_tokens")
      .select("access_token")
      .eq("user_id", userId)
      .maybeSingle();
    if (legacy.error || !legacy.data) return null;
    row = {
      access_token: legacy.data.access_token as string,
      refresh_token: null,
      expires_at: null,
    };
  } else if (fullResult.data) {
    row = {
      access_token: fullResult.data.access_token as string,
      refresh_token: (fullResult.data.refresh_token as string | null) ?? null,
      expires_at: (fullResult.data.expires_at as number | null) ?? null,
    };
  }

  if (!row) return null;

  // If the token is still valid (with 60s buffer), use it as-is.
  const nowSec = Math.floor(Date.now() / 1000);
  if (row.expires_at && nowSec < row.expires_at - 60) {
    return row.access_token;
  }

  // Token expired or expiry unknown — try to refresh if we have the refresh_token.
  if (!row.refresh_token) {
    // Legacy row without refresh_token stored. Return the (possibly stale)
    // access_token and let Gmail fail if it's expired — the caller logs it.
    return row.access_token;
  }

  const refreshed = await refreshAccessToken(row.refresh_token);
  if (!refreshed) {
    console.warn("[gmail-auth] refresh failed, returning stale token for user", userId);
    return row.access_token;
  }

  // Persist the refreshed token (best-effort; ignore schema errors if the
  // user_tokens table doesn't have expires_at yet).
  await supabase
    .from("user_tokens")
    .update({
      access_token: refreshed.accessToken,
      expires_at: refreshed.expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .then(({ error }) => {
      if (error && !/column|schema cache/i.test(error.message)) {
        console.error("[gmail-auth] token update failed:", error.message);
      }
    });

  return refreshed.accessToken;
}
