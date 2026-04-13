import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest";
import {
  triageEmails,
  sendScheduledEmail,
  checkSnoozed,
  checkFollowUps,
} from "@/inngest/functions";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [triageEmails, sendScheduledEmail, checkSnoozed, checkFollowUps],
});
