// Schema-tolerant DB helpers for the read-receipt pipeline.
//
// Migration 005 adds sent_at/sender_ip/sender_user_agent columns on
// read_receipts and a new email_opens table. These helpers try the
// full-featured path first and fall back to the legacy schema when the
// migration hasn't been applied, so the app keeps working (minus the
// grace-period / sender-self filters / per-hit log) without the SQL being
// run.

import type { SupabaseClient } from "@supabase/supabase-js";

function isMissingSchemaError(err: { message?: string } | null | undefined): boolean {
  if (!err?.message) return false;
  return /column.*(does not exist|of relation)|relation.*does not exist|could not find the .* column|schema cache/i.test(
    err.message
  );
}

export interface ReceiptInsert {
  token: string;
  user_id: string;
  email_message_id: string;
  recipient_email: string;
  opened_at?: string | null;
  sent_at?: string | null;
  sender_ip?: string | null;
  sender_user_agent?: string | null;
}

/**
 * Insert a receipt row. If migration 005 isn't applied, retries with only
 * the legacy columns so sending still works (tracking then runs in
 * degraded mode).
 */
export async function insertReceipt(
  supabase: SupabaseClient,
  row: ReceiptInsert
): Promise<{ legacyMode: boolean; error: { message: string } | null }> {
  // Primary attempt — full v2 schema. Catches both returned errors AND
  // thrown exceptions (e.g. supabase-js throwing on certain network paths).
  let primaryErrorMessage: string | null = null;
  try {
    const { error } = await supabase.from("read_receipts").insert(row);
    if (!error) return { legacyMode: false, error: null };
    primaryErrorMessage = error.message;
    if (!isMissingSchemaError(error)) return { legacyMode: false, error };
  } catch (e) {
    primaryErrorMessage = e instanceof Error ? e.message : String(e);
    if (!isMissingSchemaError({ message: primaryErrorMessage })) {
      console.error("[read-receipts] insert threw:", primaryErrorMessage);
      return {
        legacyMode: false,
        error: { message: primaryErrorMessage ?? "insert threw" },
      };
    }
  }

  // Legacy fallback — retry with only the columns that exist pre-migration.
  console.warn(
    "[read-receipts] migration 005 not applied — falling back to legacy insert"
  );
  try {
    const { error: legacyError } = await supabase.from("read_receipts").insert({
      token: row.token,
      user_id: row.user_id,
      email_message_id: row.email_message_id,
      recipient_email: row.recipient_email,
      opened_at: row.opened_at ?? null,
    });
    return { legacyMode: true, error: legacyError };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[read-receipts] legacy insert threw:", msg);
    return { legacyMode: true, error: { message: msg } };
  }
}

/**
 * Update a receipt row. Drops v2-only columns from the patch if the
 * migration isn't applied.
 */
export async function updateReceipt(
  supabase: SupabaseClient,
  token: string,
  patch: {
    email_message_id?: string;
    recipient_email?: string;
    opened_at?: string | null;
    sent_at?: string | null;
    sender_ip?: string | null;
    sender_user_agent?: string | null;
  }
): Promise<void> {
  let needsLegacy = false;
  try {
    const { error } = await supabase.from("read_receipts").update(patch).eq("token", token);
    if (!error) return;
    if (!isMissingSchemaError(error)) {
      console.error("[read-receipts] update failed:", error.message);
      return;
    }
    needsLegacy = true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!isMissingSchemaError({ message: msg })) {
      console.error("[read-receipts] update threw:", msg);
      return;
    }
    needsLegacy = true;
  }

  if (!needsLegacy) return;

  // Re-run with only legacy columns
  const legacyPatch: Record<string, unknown> = {};
  if (patch.email_message_id !== undefined) legacyPatch.email_message_id = patch.email_message_id;
  if (patch.recipient_email !== undefined) legacyPatch.recipient_email = patch.recipient_email;
  if (patch.opened_at !== undefined) legacyPatch.opened_at = patch.opened_at;
  if (Object.keys(legacyPatch).length === 0) return;
  try {
    await supabase.from("read_receipts").update(legacyPatch).eq("token", token);
  } catch (e) {
    console.error("[read-receipts] legacy update threw:", e);
  }
}

export interface ReceiptRow {
  token: string;
  opened_at: string | null;
  sent_at: string | null;
  sender_ip: string | null;
  sender_user_agent: string | null;
}

/**
 * Fetch a receipt row by token. Falls back to reading only the legacy
 * columns if migration 005 isn't applied.
 */
export async function selectReceipt(
  supabase: SupabaseClient,
  token: string
): Promise<ReceiptRow | null> {
  const full = await supabase
    .from("read_receipts")
    .select("token, opened_at, sent_at, sender_ip, sender_user_agent")
    .eq("token", token)
    .maybeSingle();
  if (!full.error) return (full.data as ReceiptRow | null) ?? null;
  if (!isMissingSchemaError(full.error)) {
    console.error("[read-receipts] select failed:", full.error.message);
    return null;
  }

  const base = await supabase
    .from("read_receipts")
    .select("token, opened_at")
    .eq("token", token)
    .maybeSingle();
  if (!base.data) return null;
  const d = base.data as { token: string; opened_at: string | null };
  return {
    token: d.token,
    opened_at: d.opened_at,
    sent_at: null,
    sender_ip: null,
    sender_user_agent: null,
  };
}

export interface OpenRow {
  token: string;
  opened_at: string;
  ip_address: string | null;
  user_agent: string | null;
  is_real_open: boolean;
  classification: string;
}

/**
 * Fetch prior open hits for a token. Returns [] when the table doesn't
 * exist (migration not applied).
 */
export async function selectOpens(
  supabase: SupabaseClient,
  token: string
): Promise<{ hits: OpenRow[]; legacyMode: boolean }> {
  const { data, error } = await supabase
    .from("email_opens")
    .select("token, opened_at, ip_address, user_agent, is_real_open, classification")
    .eq("token", token)
    .order("opened_at", { ascending: true });
  if (!error) return { hits: (data as OpenRow[]) ?? [], legacyMode: false };
  if (!isMissingSchemaError(error)) {
    console.error("[read-receipts] selectOpens failed:", error.message);
  }
  return { hits: [], legacyMode: true };
}

/**
 * Record a pixel hit. If the email_opens table doesn't exist we fall back
 * to only updating read_receipts.opened_at (legacy behavior) so the UI
 * still shows the open.
 */
export async function recordOpen(
  supabase: SupabaseClient,
  input: OpenRow
): Promise<{ inserted: boolean; legacyMode: boolean }> {
  const { error } = await supabase.from("email_opens").insert(input);
  if (!error) return { inserted: true, legacyMode: false };
  if (!isMissingSchemaError(error)) {
    console.error("[read-receipts] email_opens insert failed:", error.message);
  }

  // Legacy mode: no per-hit log — just stamp opened_at on the receipt
  // row if this is a real open and it hasn't been stamped already.
  if (input.is_real_open) {
    await supabase
      .from("read_receipts")
      .update({ opened_at: input.opened_at })
      .eq("token", input.token)
      .is("opened_at", null);
  }
  return { inserted: false, legacyMode: true };
}
