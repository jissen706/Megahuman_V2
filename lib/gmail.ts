// Gmail API client helpers
// All Gmail API calls go through this module.

import { buildTrackingPixel } from "./read-receipt";

export interface GmailAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  inline: boolean;   // true = inline image referenced via cid:
  contentId: string; // Content-ID value without angle brackets
}

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  bodyPlain: string;
  bodyHtml: string;
  attachments: GmailAttachment[];
  receivedAt: Date;
  isSent: boolean;
  labelIds: string[];
}

interface GmailApiPayload {
  mimeType: string;
  headers: Array<{ name: string; value: string }>;
  body: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailApiPayload[];
  filename?: string;
}

interface GmailApiMessage {
  id: string;
  threadId: string;
  snippet: string;
  labelIds: string[];
  payload: GmailApiPayload;
}

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

function authHeaders(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
}

async function gmailGet<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${GMAIL_BASE}${path}`, { headers: authHeaders(accessToken) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail GET ${path} failed ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function gmailPost<T>(accessToken: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${GMAIL_BASE}${path}`, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail POST ${path} failed ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

function getHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

// Walk the MIME tree to find the first part matching mimeType
function findPart(payload: GmailApiPayload, mimeType: string): string {
  if (payload.mimeType === mimeType && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = findPart(part, mimeType);
      if (text) return text;
    }
  }
  return "";
}

// Collect all attachment parts (both inline images and regular attachments)
function collectAttachments(payload: GmailApiPayload): GmailAttachment[] {
  const result: GmailAttachment[] = [];

  function walk(part: GmailApiPayload) {
    const headers = part.headers ?? [];
    const rawContentId = getHeader(headers, "Content-ID");
    const contentId = rawContentId.replace(/[<>]/g, "").trim();
    const disposition = getHeader(headers, "Content-Disposition").toLowerCase();
    const hasAttachmentId = !!part.body?.attachmentId;

    // Inline: has a Content-ID (used in cid: references) or disposition is inline
    const isInline = !!contentId && (disposition.startsWith("inline") || part.mimeType.startsWith("image/"));
    // Regular attachment: disposition says attachment, or has a filename
    const isAttachment = disposition.startsWith("attachment") || (!!part.filename && !isInline);

    if (hasAttachmentId && (isInline || isAttachment)) {
      result.push({
        attachmentId: part.body.attachmentId!,
        filename: part.filename || contentId || "attachment",
        mimeType: part.mimeType,
        size: part.body.size ?? 0,
        inline: isInline,
        contentId,
      });
    }

    if (part.parts) {
      for (const child of part.parts) walk(child);
    }
  }

  walk(payload);
  return result;
}

// Extract HTML body and replace cid: references with our attachment proxy URLs
function extractHtml(payload: GmailApiPayload, messageId: string, attachments: GmailAttachment[]): string {
  const html = findPart(payload, "text/html");
  if (!html) return "";

  // Replace cid:xxx with /api/emails/{id}/attachment/{attachmentId}?type={mimeType}
  return html.replace(/cid:([^"'\s>]+)/gi, (_, cid) => {
    const match = attachments.find(
      (a) => a.inline && (a.contentId === cid || a.contentId === `<${cid}>`)
    );
    if (match) {
      return `/api/emails/${messageId}/attachment/${match.attachmentId}?type=${encodeURIComponent(match.mimeType)}`;
    }
    return `cid:${cid}`;
  });
}

// Fetch message IDs matching ALL specified label IDs, following pagination until maxResults reached
async function listMessageIds(
  accessToken: string,
  labelIds: string[],
  maxResults: number,
  q?: string
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  while (ids.length < maxResults) {
    const params = new URLSearchParams({ maxResults: String(Math.min(maxResults - ids.length, 500)) });
    for (const id of labelIds) params.append("labelIds", id);
    if (q) params.set("q", q);
    if (pageToken) params.set("pageToken", pageToken);

    const data = await gmailGet<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(
      accessToken,
      `/messages?${params}`
    );

    ids.push(...(data.messages ?? []).map((m) => m.id));
    if (!data.nextPageToken || ids.length >= maxResults) break;
    pageToken = data.nextPageToken;
  }

  return ids.slice(0, maxResults);
}

// Fetch full message details in batches to stay under rate limits
async function fetchMessagesInBatches(
  accessToken: string,
  ids: string[],
  batchSize = 5
): Promise<GmailApiMessage[]> {
  const results: GmailApiMessage[] = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const fetched = await Promise.all(
      batch.map((id) =>
        gmailGet<GmailApiMessage>(accessToken, `/messages/${id}?format=full`)
      )
    );
    results.push(...fetched);
    // Small pause between batches to avoid per-minute quota exhaustion
    if (i + batchSize < ids.length) await new Promise((r) => setTimeout(r, 200));
  }
  return results;
}

export function parseGmailMessage(
  raw: Record<string, unknown>,
  isSent = false
): GmailMessage {
  const msg = raw as unknown as GmailApiMessage;
  const headers = msg.payload?.headers ?? [];
  const get = (name: string) => getHeader(headers, name);

  const attachments = collectAttachments(msg.payload);
  const bodyHtml = extractHtml(msg.payload, msg.id, attachments);
  const bodyPlain = findPart(msg.payload, "text/plain");

  const dateStr = get("Date");
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: get("From"),
    to: get("To"),
    subject: get("Subject"),
    snippet: msg.snippet ?? "",
    bodyPlain,
    bodyHtml,
    attachments,
    receivedAt: dateStr ? new Date(dateStr) : new Date(),
    isSent,
    labelIds: msg.labelIds ?? [],
  };
}

const CATEGORY_LABEL_MAP: Record<string, string> = {
  CATEGORY_PERSONAL:   "personal",
  CATEGORY_UPDATES:    "updates",
  CATEGORY_PROMOTIONS: "promotions",
  CATEGORY_SOCIAL:     "social",
  CATEGORY_FORUMS:     "forums",
};

// Single INBOX fetch — derive category from each message's labelIds.
// This uses 1 list call instead of 5, avoiding per-minute quota exhaustion.
export async function fetchInboxByCategory(
  accessToken: string,
  maxResults = 100,
  afterEpochSec?: number
): Promise<Array<GmailMessage & { triageLabel: string }>> {
  const q = afterEpochSec ? `after:${afterEpochSec}` : undefined;
  const ids = await listMessageIds(accessToken, ["INBOX"], maxResults, q);
  if (ids.length === 0) return [];
  const raw = await fetchMessagesInBatches(accessToken, ids);
  return raw.map((m) => {
    const categoryLabel = (m.labelIds ?? []).find((l) => l.startsWith("CATEGORY_"));
    const triageLabel = categoryLabel ? (CATEGORY_LABEL_MAP[categoryLabel] ?? "personal") : "personal";
    return { ...parseGmailMessage(m as unknown as Record<string, unknown>, false), triageLabel };
  });
}

export async function fetchSentMessages(
  accessToken: string,
  maxResults = 100,
  afterEpochSec?: number
): Promise<GmailMessage[]> {
  const q = afterEpochSec ? `after:${afterEpochSec}` : undefined;
  const ids = await listMessageIds(accessToken, ["SENT"], maxResults, q);
  const raw = await fetchMessagesInBatches(accessToken, ids);
  return raw.map((m) => parseGmailMessage(m as unknown as Record<string, unknown>, true));
}

/**
 * Fetch a single attachment's raw data from Gmail API.
 * Returns base64url-encoded data and size.
 */
export async function fetchAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string
): Promise<{ data: string; size: number }> {
  return gmailGet<{ data: string; size: number }>(
    accessToken,
    `/messages/${messageId}/attachments/${attachmentId}`
  );
}

// Fetch the RFC 2822 Message-ID header of a message (needed for reply threading)
export async function fetchMessageIdHeader(
  accessToken: string,
  messageId: string
): Promise<string> {
  const data = await gmailGet<{ payload: { headers: Array<{ name: string; value: string }> } }>(
    accessToken,
    `/messages/${messageId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`
  );
  const headers = data.payload?.headers ?? [];
  return getHeader(headers, "Message-ID");
}

// Fetch all messages in a Gmail thread
export async function fetchGmailThread(
  accessToken: string,
  threadId: string
): Promise<GmailMessage[]> {
  const data = await gmailGet<{ messages?: GmailApiMessage[] }>(
    accessToken,
    `/threads/${threadId}?format=full`
  );
  return (data.messages ?? []).map((m) =>
    parseGmailMessage(m as unknown as Record<string, unknown>, false)
  );
}

export async function sendEmail(
  accessToken: string,
  opts: {
    to: string;
    subject: string;
    body: string;
    trackingToken?: string;
    // Reply threading — set these to properly thread a reply
    replyThreadId?: string;
    inReplyTo?: string;   // RFC 2822 Message-ID of the email being replied to
    references?: string;  // same value (or chain for longer threads)
  }
): Promise<string> {
  const { to, subject, body, trackingToken, replyThreadId, inReplyTo, references } = opts;
  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  let htmlBody = escaped.replace(/\n/g, "<br>");
  if (trackingToken) {
    htmlBody += buildTrackingPixel(trackingToken);
  }
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  const raw = [...headers, "", htmlBody].join("\r\n");
  const encoded = Buffer.from(raw).toString("base64url");
  const payload: Record<string, string> = { raw: encoded };
  if (replyThreadId) payload.threadId = replyThreadId;
  const data = await gmailPost<{ id: string }>(accessToken, "/messages/send", payload);
  return data.id;
}

export async function archiveMessage(
  accessToken: string,
  messageId: string
): Promise<void> {
  await gmailPost<unknown>(accessToken, `/messages/${messageId}/modify`, {
    removeLabelIds: ["INBOX"],
  });
}
