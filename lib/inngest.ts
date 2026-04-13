import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "megahuman",
  eventKey: process.env.INNGEST_EVENT_KEY,
});

// Event type definitions
export type Events = {
  "email/sync.requested": { data: { userId: string; accessToken: string } };
  "email/triage.requested": { data: { userId: string; emailIds: string[] } };
  "email/send.scheduled": { data: { scheduledSendId: string } };
  "email/snooze.check": { data: Record<string, never> };
};
