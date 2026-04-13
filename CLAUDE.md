# MegaHuman — AI Email Agent

A minimalist, AI-first email client. The core differentiator: Claude learns your writing voice from sent emails and auto-drafts replies that sound like you.

## Features
1. **Voice-matched draft replies** — Claude extracts your style from sent mail, drafts replies that sound like you
2. **Smart triage labels** — AI labels each email: urgent / needs_reply / fyi / newsletter
3. **Read receipts** — tracking pixel in outgoing emails, opened timestamp in sent view
4. **"Handle this" agent** — AI reads email, decides action (draft / snooze / mark FYI), executes it
5. **Snooze + follow-up reminders** — resurface emails at specified time; alert if no reply after X days
6. **Send later** — schedule emails via Inngest background job

## Stack
- **Framework**: Next.js 15 (App Router), TypeScript strict
- **Styling**: Tailwind v4 + shadcn/ui
- **Auth + DB**: Supabase (Postgres + Auth)
- **Email**: Gmail API via OAuth (next-auth v5 beta)
- **AI**: Anthropic Claude (`claude-sonnet-4-6`) via `@anthropic-ai/sdk`
- **Background jobs**: Inngest
- **Validation**: Zod on all API routes

## Project Structure
```
app/
  api/
    auth/[...nextauth]/   # Gmail OAuth (next-auth)
    gmail/sync/           # POST — sync inbox + sent mail to Supabase
    track/[token]/        # GET  — read receipt pixel endpoint
    send/                 # POST — send or schedule email
    ai/triage/            # POST — classify email labels
    ai/draft/             # POST — generate voice-matched reply draft (streaming)
    ai/handle/            # POST — "Handle this" agent action
  (app)/
    inbox/                # Main inbox view
    sent/                 # Sent view with read receipt status
    thread/[id]/          # Thread view
  layout.tsx
  page.tsx                # Redirects to /inbox
components/
  inbox/                  # InboxList, ThreadRow, TriageLabel
  thread/                 # ThreadView, EmailMessage, DraftEditor
  compose/                # ComposeModal, SendLaterPicker
  shared/                 # CommandPalette, KeyboardShortcuts
lib/
  gmail.ts                # Gmail API client helpers
  supabase.ts             # Supabase browser + server clients
  claude.ts               # Claude API helpers (stream, structured output)
  voice-profile.ts        # Voice extraction + prompt building
  read-receipt.ts         # Token generation + tracking logic
supabase/
  migrations/             # SQL migration files
```

## Database Schema

```sql
-- Voice profile per user
create table voice_profiles (
  user_id uuid primary key references auth.users,
  profile_text text,
  updated_at timestamptz
);

-- Email cache
create table emails (
  id text primary key,             -- Gmail message ID
  user_id uuid references auth.users,
  thread_id text,
  from_email text,
  subject text,
  snippet text,
  body_plain text,
  received_at timestamptz,
  is_sent boolean default false,
  triage_label text,               -- urgent | needs_reply | fyi | newsletter
  is_read boolean default false,
  snoozed_until timestamptz,
  follow_up_at timestamptz
);

-- Read receipts
create table read_receipts (
  token uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users,
  email_message_id text,
  opened_at timestamptz,
  recipient_email text
);

-- Scheduled sends
create table scheduled_sends (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users,
  to_email text,
  subject text,
  body text,
  send_at timestamptz,
  sent boolean default false
);
```

## Environment Variables

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=         # Supabase project URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=    # Supabase anon/public key
SUPABASE_SERVICE_ROLE_KEY=        # Supabase service role key (server only)

# Google OAuth (Gmail)
GOOGLE_CLIENT_ID=                 # Google Cloud Console OAuth client ID
GOOGLE_CLIENT_SECRET=             # Google Cloud Console OAuth client secret
NEXTAUTH_SECRET=                  # Random secret for next-auth session signing
NEXTAUTH_URL=                     # App URL (e.g. http://localhost:3000)

# Anthropic
ANTHROPIC_API_KEY=                # Anthropic API key

# Inngest
INNGEST_EVENT_KEY=                # Inngest event key
INNGEST_SIGNING_KEY=              # Inngest signing key

# App
NEXT_PUBLIC_APP_URL=              # Public URL for read receipt pixel (e.g. http://localhost:3000)
```

## Setup

### 1. Google OAuth (Gmail)
1. Go to Google Cloud Console
2. Create a project → Enable Gmail API
3. OAuth consent screen → add scopes: `gmail.readonly`, `gmail.modify`, `gmail.send`, `gmail.compose`
4. Create OAuth 2.0 credentials → Authorized redirect URI: `{NEXTAUTH_URL}/api/auth/callback/google`
5. Copy Client ID + Secret to `.env.local`

### 2. Supabase
1. Create project at supabase.com
2. Copy URL + anon key + service role key to `.env.local`
3. Run migrations: paste SQL from `supabase/migrations/` into Supabase SQL editor

### 3. Inngest
1. Create account at inngest.com
2. Copy event key + signing key to `.env.local`
3. For local dev: `npx inngest-cli@latest dev`

### 4. Run locally
```bash
npm install
cp .env.example .env.local  # fill in values
npm run dev
# In another terminal:
npx inngest-cli@latest dev
```

## Coding Conventions
- TypeScript strict mode — no `any`
- Server Components by default; add `"use client"` only when needed (event handlers, hooks)
- Zod validation on every API route input
- All Claude calls go through `lib/claude.ts` helpers
- All Gmail calls go through `lib/gmail.ts`
- All Supabase calls go through `lib/supabase.ts` (browser client in components, server client in route handlers)

## AI Prompt Patterns

### Voice Profile Extraction
```
Analyze these sent emails and extract a writing style profile. Describe:
- Greeting style (e.g., "Hi [name]," / "Hey," / none)
- Sign-off style (e.g., "Best," / "Thanks," / "Cheers,")
- Average email length (short/medium/long)
- Formality level (1-5)
- Punctuation and capitalization habits
- Common phrases or words they use
- How they handle lists and line breaks
Output as a single concise paragraph a writer could use to mimic this style exactly.
```

### Draft Reply System Prompt
```
You are drafting an email reply on behalf of [user_name].
Match this style exactly: [voice_profile]
Keep the same length, tone, and phrasing patterns.
Do not add sign-offs or greetings the user does not typically use.
Reply to the following thread:
```

### "Handle This" Response Schema
```typescript
{
  action: "draft_reply" | "snooze" | "mark_fyi",
  reasoning: string,
  draft_content?: string,   // present if action === "draft_reply"
  snooze_days?: number,     // present if action === "snooze"
}
```

## Test Cases

Run through these manually after each phase to verify correctness.

### Auth + Sync
- [ ] Gmail OAuth flow completes without error; session is set
- [ ] After login, `emails` table has >0 rows with correct `user_id`
- [ ] Sent emails (`is_sent=true`) are present — needed for voice profile

### Triage
- [ ] Every synced email has a non-null `triage_label` after Inngest job runs
- [ ] Label values are strictly: `urgent`, `needs_reply`, `fyi`, or `newsletter`

### Voice Profile
- [ ] `voice_profiles` table has a row after first sync
- [ ] `profile_text` is >100 characters (not a degenerate output)

### Draft Reply
- [ ] POST `/api/ai/draft` with thread context returns `200` with streaming text
- [ ] Draft reads like the user (correct sign-off, greeting, length) — manual smell test
- [ ] Tone toggle (brief vs detailed) visibly changes output length

### Read Receipts
- [ ] GET `/api/track/[valid-token]` returns `200`, `Content-Type: image/gif`, sets `opened_at` in DB
- [ ] GET `/api/track/[invalid-token]` returns `200` (pixel, no error), does NOT write to DB
- [ ] Sent view shows "Not opened" before receipt hit, "Opened X mins ago" after

### "Handle This" Agent
- [ ] POST `/api/ai/handle` returns valid JSON matching the schema above
- [ ] Newsletter email → action is `mark_fyi`
- [ ] Urgent unanswered email → action is `draft_reply` with content

### Snooze + Follow-ups
- [ ] Snoozed email disappears from inbox immediately
- [ ] Email reappears at top of inbox after `snoozed_until` timestamp passes (Inngest cron)
- [ ] Follow-up badge appears if no reply thread detected after `follow_up_at`

### Send Later
- [ ] Compose → Send Later → row appears in `scheduled_sends` with correct `send_at`
- [ ] Inngest job marks `sent=true` and email is delivered at scheduled time

### Keyboard Navigation
- [ ] `j` / `k` moves selection up/down in inbox
- [ ] `e` archives selected email
- [ ] `r` opens reply/draft view
- [ ] `⌘K` opens command palette
