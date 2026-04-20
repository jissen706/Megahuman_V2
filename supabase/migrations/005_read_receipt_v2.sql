-- Read receipt v2: Superhuman-style tracking pixel with classification.
-- Adds send-time context and a per-hit log so false positives (Apple MPP
-- preloads, security scanners, sender self-opens, Gmail proxy caching) can
-- be filtered out without losing data.

-- Send-time context on the receipt row
alter table read_receipts
  add column if not exists sent_at timestamptz,
  add column if not exists sender_ip text,
  add column if not exists sender_user_agent text;

-- Per-hit open log. Every pixel hit is stored with classification — we
-- never drop hits at write time so classification rules can be tuned later
-- without data loss. The UI filters by is_real_open.
create table if not exists email_opens (
  id uuid primary key default gen_random_uuid(),
  token uuid not null references read_receipts(token) on delete cascade,
  opened_at timestamptz not null default now(),
  ip_address text,
  user_agent text,
  is_real_open boolean not null default false,
  classification text not null
);

create index if not exists email_opens_token_idx
  on email_opens (token, opened_at);

create index if not exists email_opens_real_idx
  on email_opens (token, opened_at)
  where is_real_open = true;
