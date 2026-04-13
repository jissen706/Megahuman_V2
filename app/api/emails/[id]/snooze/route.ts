import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/app/api/auth/[...nextauth]/route";
import { createServiceRoleClient } from "@/lib/supabase";

const snoozeSchema = z.object({
  snoozedUntil: z.string().datetime().optional(),
  followUpAt: z.string().datetime().optional(),
});

/**
 * PATCH /api/emails/[id]/snooze
 * Set snoozed_until or follow_up_at on an email.
 * Pass snoozedUntil to snooze, followUpAt for follow-up reminder.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = snoozeSchema.safeParse(await req.json());
  if (!body.success) {
    return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
  }

  const { snoozedUntil, followUpAt } = body.data;

  const supabase = createServiceRoleClient();

  const update: Record<string, string | null> = {};
  if (snoozedUntil !== undefined) update.snoozed_until = snoozedUntil;
  if (followUpAt !== undefined) update.follow_up_at = followUpAt;

  const { error } = await supabase
    .from("emails")
    .update(update)
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
