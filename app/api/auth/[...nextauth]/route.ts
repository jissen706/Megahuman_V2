import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { createServiceRoleClient, emailToUserId } from "@/lib/supabase";

async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresAt: number;
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
    const data = await res.json() as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || data.error) return null;
    return {
      accessToken: data.access_token!,
      expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
    };
  } catch {
    return null;
  }
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
        createServiceRoleClient().from("user_tokens").upsert({
          user_id: userId,
          access_token: account.access_token,
          updated_at: new Date().toISOString(),
        }).then(({ error }) => {
          if (error) console.error("Failed to store access token:", error);
        });
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
      createServiceRoleClient().from("user_tokens").upsert({
        user_id: token.userId as string,
        access_token: refreshed.accessToken,
        updated_at: new Date().toISOString(),
      }).then(({ error }) => {
        if (error) console.error("Failed to refresh token:", error);
      });

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
