-- Migration 006: Store refresh_token + expires_at on user_tokens so
-- background jobs (Inngest scheduled sends, sync fallback) can refresh
-- an expired access_token instead of failing.
--
-- Optional: the app degrades gracefully without these columns (uses the
-- stored access_token as-is and relies on the user being logged in for
-- front-end sends).

alter table user_tokens
  add column if not exists refresh_token text,
  add column if not exists expires_at bigint;
