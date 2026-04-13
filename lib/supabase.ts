import { createBrowserClient, createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Types for our DB tables
export type TriageLabel = "urgent" | "needs_reply" | "fyi" | "newsletter";

export interface EmailAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  inline: boolean;
  contentId: string;
}

export interface Email {
  id: string;
  user_id: string;
  thread_id: string;
  from_email: string;
  to_email: string | null;
  subject: string;
  snippet: string;
  body_plain: string;
  body_html: string;
  attachments: EmailAttachment[];
  received_at: string;
  is_sent: boolean;
  triage_label: TriageLabel | null;
  is_read: boolean;
  is_archived: boolean;
  snoozed_until: string | null;
  follow_up_at: string | null;
}

export interface VoiceProfile {
  user_id: string;
  profile_text: string;
  updated_at: string;
}

export interface ReadReceipt {
  token: string;
  user_id: string;
  email_message_id: string;
  opened_at: string | null;
  recipient_email: string;
}

export interface ScheduledSend {
  id: string;
  user_id: string;
  to_email: string;
  subject: string;
  body: string;
  send_at: string;
  sent: boolean;
}

// Browser client — use in client components
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// Server client — use in route handlers and server components
export async function createServerClientWithCookies() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        },
      },
    }
  );
}

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createHash } from "crypto";

// Service role client — bypasses RLS, server-side only, never expose to client
export function createServiceRoleClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

// Deterministic UUID from email used until Supabase auth adapter is configured.
// MD5(email) formatted as UUID hex string — consistent per user, valid postgres uuid format.
export function emailToUserId(email: string): string {
  const h = createHash("md5").update(email.toLowerCase()).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
