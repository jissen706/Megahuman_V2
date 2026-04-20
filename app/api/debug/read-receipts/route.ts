import { NextResponse } from "next/server";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { createServiceRoleClient, emailToUserId } from "@/lib/supabase";
import { getPublicBaseUrl } from "@/lib/read-receipt";

type ExtendedSession = {
  user: { email: string };
  userId?: string;
};

/**
 * GET /api/debug/read-receipts
 * Self-diagnosis endpoint. Hit this while signed in to see exactly why
 * read receipts aren't firing. Reports:
 *  - Public base URL used for the tracking pixel (and whether it's localhost)
 *  - Whether migration 005 is applied (new columns + email_opens table)
 *  - Your 5 most recent receipt rows
 *  - Every open-log hit for those receipts
 */
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ext = session as unknown as ExtendedSession;
  const userId = ext.userId ?? emailToUserId(ext.user.email);

  const publicUrl = getPublicBaseUrl();
  const isLocalhost = /localhost|127\.0\.0\.1/i.test(publicUrl);

  const supabase = createServiceRoleClient();

  // Probe schema without failing the response
  const { error: colErr } = await supabase
    .from("read_receipts")
    .select("token, sent_at, sender_ip, sender_user_agent")
    .limit(1);
  const hasNewColumns = !colErr;

  const { error: tblErr } = await supabase
    .from("email_opens")
    .select("id")
    .limit(1);
  const hasEmailOpens = !tblErr;

  const migrationApplied = hasNewColumns && hasEmailOpens;

  // Recent data
  const { data: recent } = await supabase
    .from("read_receipts")
    .select("token, email_message_id, recipient_email, sent_at, opened_at, sender_ip, sender_user_agent")
    .eq("user_id", userId)
    .order("sent_at", { ascending: false, nullsFirst: false })
    .limit(5);

  const tokens = (recent ?? []).map((r) => r.token);
  const { data: opens } = tokens.length && hasEmailOpens
    ? await supabase
        .from("email_opens")
        .select("token, opened_at, classification, is_real_open, ip_address, user_agent")
        .in("token", tokens)
        .order("opened_at", { ascending: false })
    : { data: [] as Array<Record<string, unknown>> };

  return NextResponse.json({
    config: {
      public_base_url: publicUrl,
      is_localhost: isLocalhost,
      sample_pixel_url: `${publicUrl}/api/track/<TOKEN>`,
      warning: isLocalhost
        ? "Public URL is localhost — recipient mail clients cannot reach the tracking pixel. Set NEXT_PUBLIC_APP_URL to a publicly reachable URL and restart."
        : null,
    },
    schema: {
      has_new_columns_on_read_receipts: hasNewColumns,
      email_opens_table_exists: hasEmailOpens,
      migration_applied: migrationApplied,
      column_probe_error: colErr?.message ?? null,
      table_probe_error: tblErr?.message ?? null,
      warning: !migrationApplied
        ? "Migration 005 not applied. Run supabase/migrations/005_read_receipt_v2.sql in the Supabase SQL editor."
        : null,
    },
    recent_receipts: recent ?? [],
    recent_opens: opens ?? [],
  });
}
