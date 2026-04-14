# MegaHuman

**Your email, but it sounds like you.**

MegaHuman is an AI-native email client that learns how you write and handles your inbox for you. It reads your sent emails, extracts your voice, and drafts replies that sound exactly like you typed them. No more staring at blank compose windows. No more inbox anxiety.

**Want early access? Email jishnuu at seas.upenn.edu**

---

## The Problem

Email is broken. You spend hours writing the same kinds of replies, triaging newsletters from urgent requests, and forgetting to follow up. Every "AI email tool" just slaps a generic ChatGPT response into your compose box and calls it a day. It doesn't sound like you. It sounds like a robot.

## The Solution

MegaHuman actually learns your writing style — your greetings, your sign-offs, your sentence length, your tone. Then it drafts replies that are indistinguishable from what you'd write yourself. But that's just the start.

### What MegaHuman Does

**AI Chat Assistant** — Talk to your inbox in plain English. "Send a meeting reminder to these 10 people for Friday at 3pm." "What was my last email from Sarah?" "Schedule a follow-up to the marketing team for Monday morning." One message, done.

**Mass Send with Personalization** — Need to send similar emails to 5, 10, 50 people? Tell the chat what to say and who to send it to. Each email gets personalized. Schedule them all for later or send immediately. Every email gets read receipt tracking automatically.

**Voice-Matched Drafts** — MegaHuman analyzes your sent emails and builds a writing profile: greeting style, formality level, paragraph structure, common phrases. Every AI-generated draft matches your voice exactly. Brief mode for quick replies, detailed mode for longer responses.

**Smart Triage** — Every incoming email is automatically classified: urgent, needs reply, FYI, or newsletter. Your inbox is organized into tabs so you see what matters first.

**Read Receipts** — Know exactly when someone opens your email. Tracking pixels are injected into every outgoing message. The sent view shows open status in real time, with bot detection to filter out false positives.

**Snooze & Follow-Up Reminders** — Snooze emails to resurface later. Set follow-up reminders that alert you if someone hasn't replied after X days.

**Send Later** — Schedule emails for the perfect send time. Quick presets (1 hour, tomorrow 9am, Monday morning) or custom datetime.

**Keyboard-First** — Full vim-style navigation. `j`/`k` to move, `e` to archive, `r` to reply, `c` to compose, `Cmd+K` for the command palette. Never touch your mouse.

**Thread Summarization** — Long email chain? One click gives you a 2-4 bullet summary of decisions, action items, and status.

**"Handle This" Agent** — Click one button and the AI reads the email, decides the best action (draft a reply, snooze it, mark as FYI), and executes it.

---

## Tech Stack

- **Framework**: Next.js 15 (App Router), TypeScript
- **AI**: Anthropic Claude (Sonnet for drafts, Haiku for chat)
- **Email**: Gmail API via OAuth 2.0
- **Database**: Supabase (PostgreSQL)
- **Background Jobs**: Inngest (scheduled sends, snooze, follow-ups)
- **Styling**: Tailwind CSS v4 + shadcn/ui
- **Deployment**: Vercel

## Architecture

```
User --> Next.js App --> Gmail API (read/send/modify)
              |
              +--> Claude API (drafts, triage, chat, summarize)
              |
              +--> Supabase (email cache, voice profiles, receipts, scheduled sends)
              |
              +--> Inngest (background crons: snooze, follow-ups, scheduled sends)
```

## Screenshots

*Coming soon*

---

**Want early access? Email jishnuu at seas.upenn.edu**
