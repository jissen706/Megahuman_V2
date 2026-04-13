#!/usr/bin/env npx tsx
/**
 * Clears all rows from app tables without dropping them.
 * Reads env from .env.local automatically.
 *
 * Usage: npx tsx scripts/reset-db.ts
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env.local manually (tsx doesn't load it automatically)
try {
  const env = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
  for (const line of env.split("\n")) {
    const [key, ...rest] = line.split("=");
    if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
  }
} catch { /* no .env.local, rely on shell env */ }

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const db = createClient(url, key);

// Table name → column to use as the always-true delete filter
const TABLES: Array<{ name: string; col: string }> = [
  { name: "emails",           col: "id" },
  { name: "voice_profiles",   col: "user_id" },
  { name: "read_receipts",    col: "token" },
  { name: "scheduled_sends",  col: "id" },
];

console.log("Resetting database…\n");

for (const { name, col } of TABLES) {
  // gte with min possible value matches every row
  const { error, count } = await db
    .from(name)
    .delete({ count: "exact" })
    .gte(col as never, "" as never);

  if (error) {
    console.error(`  ✗ ${name}: ${error.message}`);
  } else {
    console.log(`  ✓ ${name} — ${count ?? 0} rows deleted`);
  }
}

console.log("\nDone.");
