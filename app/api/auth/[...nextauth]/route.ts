import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { createServiceRoleClient, emailToUserId } from "@/lib/supabase";
import { refreshAccessToken } from "@/lib/gmail-auth";

// Best-effort upsert of the full token set (refresh_token + expires_at).
// Falls back to legacy schema (access_token only) if migration 006 isn't
// applied.
async function upsertUserToken(row: {
  user_id: string;
  access_token: string;
  refresh_token?: string | null;
  expires_at?: number | null;
}): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("user_tokens").upsert({
    user_id: row.user_id,
    access_token: row.access_token,
    refresh_token: row.refresh_token ?? null,
    expires_at: row.expires_at ?? null,
    updated_at: new Date().toISOString(),
  });
  if (!error) return;
  if (!/column|schema cache/i.test(error.message)) {
    console.error("Failed to store user token:", error);
    return;
  }
  // Legacy fallback
  await supabase.from("user_tokens").upsert({
    user_id: row.user_id,
    access_token: row.access_token,
    updated_at: new Date().toISOString(),
  });
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          scope: [
            "openid",
            "email",
            "profile",
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.modify",
            "https://www.googleapis.com/auth/gmail.send",
            "https://www.googleapis.com/auth/gmail.compose",
          ].join(" "),
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      // Initial sign-in — store tokens and expiry
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.expiresAt = account.expires_at; // seconds since epoch
        const email = token.email ?? "";
        const userId = emailToUserId(email);
        token.userId = userId;
        // Fire-and-forget — don't block auth on Supabase write
        upsertUserToken({
          user_id: userId,
          access_token: account.access_token!,
          refresh_token: account.refresh_token ?? null,
          expires_at: account.expires_at ?? null,
        }).catch((e) => console.error("Failed to store user token:", e));
        return token;
      }

      // Token still valid — return as-is
      const expiresAt = (token.expiresAt as number | undefined) ?? 0;
      if (Date.now() / 1000 < expiresAt - 60) {
        return token;
      }

      // Token expired — refresh it
      const refreshToken = token.refreshToken as string | undefined;
      if (!refreshToken) return token;

      const refreshed = await refreshAccessToken(refreshToken);
      if (!refreshed) return token; // keep stale token, will fail gracefully

      token.accessToken = refreshed.accessToken;
      token.expiresAt = refreshed.expiresAt;

      // Fire-and-forget — don't block auth on Supabase write
      upsertUserToken({
        user_id: token.userId as string,
        access_token: refreshed.accessToken,
        refresh_token: refreshToken,
        expires_at: refreshed.expiresAt,
      }).catch((e) => console.error("Failed to refresh token:", e));

      return token;
    },
    async session({ session, token }) {
      const s = session as unknown as Record<string, unknown>;
      s.accessToken = token.accessToken;
      s.userId = token.userId;
      return session;
    },
  },
});

export const { GET, POST } = handlers;
