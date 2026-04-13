-- Voice profile per user
create table if not exists voice_profiles (
  user_id uuid primary key references auth.users on delete cascade,
  profile_text text not null,
  updated_at timestamptz not null default now()
);

-- Email cache (inbox + sent)
create table if not exists emails (
  id text primary key,                          -- Gmail message ID
  user_id uuid not null references auth.users on delete cascade,
  thread_id text not null,
  from_email text not null,
  subject text not null default '',
  snippet text not null default '',
  body_plain text not null default '',
  received_at timestamptz not null,
  is_sent boolean not null default false,
  triage_label text check (triage_label in ('urgent', 'needs_reply', 'fyi', 'newsletter')),
  is_read boolean not null default false,
  snoozed_until timestamptz,
  follow_up_at timestamptz
);

create index if not exists emails_user_inbox
  on emails (user_id, received_at desc)
  where is_sent = false;

create index if not exists emails_user_sent
  on emails (user_id, received_at desc)
  where is_sent = true;

create index if not exists emails_thread
  on emails (thread_id, received_at asc);

-- Read receipts (one per sent email)
create table if not exists read_receipts (
  token uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  email_message_id text not null,
  opened_at timestamptz,
  recipient_email text not null
);

create index if not exists read_receipts_email
  on read_receipts (email_message_id);

-- Scheduled sends
create table if not exists scheduled_sends (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  to_email text not null,
  subject text not null default '',
  body text not null,
  send_at timestamptz not null,
  sent boolean not null default false
);

create index if not exists scheduled_sends_pending
  on scheduled_sends (send_at)
  where sent = false;
