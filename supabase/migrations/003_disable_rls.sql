-- Migration 003: Disable RLS on all tables
-- RLS is bypassed via service role for admin ops, and anon key is used
-- for user-facing reads. No Supabase Auth adapter is configured, so
-- policy-based RLS would block all anon key requests.
-- Re-enable and add policies when Supabase Auth adapter is wired.

alter table emails disable row level security;
alter table voice_profiles disable row level security;
alter table read_receipts disable row level security;
alter table scheduled_sends disable row level security;
alter table user_tokens disable row level security;
