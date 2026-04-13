-- Migration 002: Drop auth.users FK constraints + user_tokens table
-- FK constraints are dropped to support next-auth without the Supabase auth adapter.
-- When the Supabase adapter is properly configured, these FK constraints can be restored.

alter table voice_profiles drop constraint if exists voice_profiles_user_id_fkey;
alter table emails drop constraint if exists emails_user_id_fkey;
alter table read_receipts drop constraint if exists read_receipts_user_id_fkey;
alter table scheduled_sends drop constraint if exists scheduled_sends_user_id_fkey;

-- Store OAuth access tokens so Inngest background jobs can send email on behalf of users
create table if not exists user_tokens (
  user_id uuid primary key,
  access_token text not null,
  updated_at timestamptz not null default now()
);
