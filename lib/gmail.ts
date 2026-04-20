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

async function gmailPut<T>(accessToken: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${GMAIL_BASE}${path}`, {
    method: "PUT",
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail PUT ${path} failed ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function gmailDelete(accessToken: string, path: string): Promise<void> {
  const res = await fetch(`${GMAIL_BASE}${path}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail DELETE ${path} failed ${res.status}: ${text}`);
  }
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

// -----------------------------------------------------------------------------
// Drafts API
// -----------------------------------------------------------------------------

export interface DraftAttachmentInput {
  filename: string;
  mimeType: string;
  data: Buffer; // raw bytes
}

export interface DraftSummary {
  draftId: string;
  messageId: string;
  threadId: string;
  to: string;
  subject: string;
  snippet: string;
  updatedAt: Date;
  hasAttachment: boolean;
  attachmentNames: string[];
}

export interface DraftDetail extends DraftSummary {
  bodyPlain: string;
  bodyHtml: string;
  attachments: GmailAttachment[];
}

// Wrap base64 data at 76 chars per line (RFC 2045)
function base64Wrap(data: string): string {
  return data.replace(/(.{76})/g, "$1\r\n");
}

function escapeHtmlBody(body: string): string {
  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return escaped.replace(/\n/g, "<br>");
}

/**
 * Build a raw RFC 2822 MIME message suitable for base64url-encoding into
 * Gmail's `raw` field. Supports a single HTML body plus zero or more
 * file attachments encoded as multipart/mixed.
 */
export function buildMimeMessage(opts: {
  to: string;
  subject: string;
  bodyHtml: string;
  attachments?: DraftAttachmentInput[];
  inReplyTo?: string;
  references?: string;
}): string {
  const { to, subject, bodyHtml, attachments = [], inReplyTo, references } = opts;
  const baseHeaders = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
  ];
  if (inReplyTo) baseHeaders.push(`In-Reply-To: ${inReplyTo}`);
  if (references) baseHeaders.push(`References: ${references}`);

  if (attachments.length === 0) {
    // Simple HTML email
    return [
      ...baseHeaders,
      "Content-Type: text/html; charset=utf-8",
      "",
      bodyHtml,
    ].join("\r\n");
  }

  // multipart/mixed: html body + each attachment
  const boundary = `mh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const parts: string[] = [];

  parts.push(
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    bodyHtml
  );

  for (const att of attachments) {
    const encoded = base64Wrap(att.data.toString("base64"));
    parts.push(
      `--${boundary}`,
      `Content-Type: ${att.mimeType}; name="${att.filename}"`,
      `Content-Disposition: attachment; filename="${att.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      encoded
    );
  }
  parts.push(`--${boundary}--`);

  return [
    ...baseHeaders,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    ...parts,
  ].join("\r\n");
}

/**
 * Create a Gmail draft. Returns the new draft's ID and its underlying
 * message ID.
 */
export async function createDraft(
  accessToken: string,
  opts: {
    to: string;
    subject: string;
    bodyHtml: string;
    attachments?: DraftAttachmentInput[];
  }
): Promise<{ draftId: string; messageId: string; threadId: string }> {
  const raw = buildMimeMessage(opts);
  const encoded = Buffer.from(raw).toString("base64url");
  const data = await gmailPost<{ id: string; message: { id: string; threadId: string } }>(
    accessToken,
    "/drafts",
    { message: { raw: encoded } }
  );
  return {
    draftId: data.id,
    messageId: data.message.id,
    threadId: data.message.threadId,
  };
}

function summarizeDraft(draftId: string, raw: GmailApiMessage): DraftSummary {
  const headers = raw.payload?.headers ?? [];
  const attachments = collectAttachments(raw.payload);
  // Gmail message has internalDate in ms since epoch (not in our GmailApiMessage type,
  // but we cast to access it)
  const internal = (raw as unknown as { internalDate?: string }).internalDate;
  const updatedAt = internal ? new Date(Number(internal)) : new Date();
  return {
    draftId,
    messageId: raw.id,
    threadId: raw.threadId,
    to: getHeader(headers, "To"),
    subject: getHeader(headers, "Subject"),
    snippet: raw.snippet ?? "",
    updatedAt,
    hasAttachment: attachments.length > 0,
    attachmentNames: attachments.map((a) => a.filename),
  };
}

/**
 * List Gmail drafts (most recent first), fetching full metadata for each.
 * Returns up to `maxResults` (default 50).
 */
export async function listDrafts(
  accessToken: string,
  maxResults = 50
): Promise<DraftSummary[]> {
  const params = new URLSearchParams({ maxResults: String(maxResults) });
  const data = await gmailGet<{ drafts?: Array<{ id: string; message: { id: string; threadId: string } }> }>(
    accessToken,
    `/drafts?${params}`
  );
  const drafts = data.drafts ?? [];
  if (drafts.length === 0) return [];

  // Fetch each draft's full payload in small batches
  const results: DraftSummary[] = [];
  const batchSize = 5;
  for (let i = 0; i < drafts.length; i += batchSize) {
    const batch = drafts.slice(i, i + batchSize);
    const fetched = await Promise.all(
      batch.map((d) =>
        gmailGet<{ id: string; message: GmailApiMessage }>(
          accessToken,
          `/drafts/${d.id}?format=metadata&metadataHeaders=To&metadataHeaders=Subject`
        )
          .then((full) => ({ ok: true as const, draftId: d.id, message: full.message }))
          .catch((err) => ({ ok: false as const, draftId: d.id, err }))
      )
    );
    for (const r of fetched) {
      if (r.ok) results.push(summarizeDraft(r.draftId, r.message));
    }
    if (i + batchSize < drafts.length) await new Promise((r) => setTimeout(r, 150));
  }

  // Sort by updatedAt descending
  results.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return results;
}

/**
 * Fetch a single draft in full (body + attachment list).
 */
export async function getDraft(
  accessToken: string,
  draftId: string
): Promise<DraftDetail> {
  const data = await gmailGet<{ id: string; message: GmailApiMessage }>(
    accessToken,
    `/drafts/${draftId}?format=full`
  );
  const summary = summarizeDraft(draftId, data.message);
  const attachments = collectAttachments(data.message.payload);
  const bodyHtml = extractHtml(data.message.payload, data.message.id, attachments);
  const bodyPlain = findPart(data.message.payload, "text/plain");
  return { ...summary, attachments, bodyHtml, bodyPlain };
}

/**
 * Update an existing draft's to/subject/body. Attachments are preserved
 * only if re-supplied — this mirrors Gmail's own behavior where PUT
 * replaces the full message.
 *
 * Returns the draft's new internal messageId (Gmail assigns a new one
 * on each PUT because the underlying message is replaced).
 */
export async function updateDraft(
  accessToken: string,
  draftId: string,
  opts: {
    to: string;
    subject: string;
    bodyHtml: string;
    attachments?: DraftAttachmentInput[];
  }
): Promise<{ messageId: string; threadId: string }> {
  const raw = buildMimeMessage(opts);
  const encoded = Buffer.from(raw).toString("base64url");
  const data = await gmailPut<{ id: string; message: { id: string; threadId: string } }>(
    accessToken,
    `/drafts/${draftId}`,
    { message: { raw: encoded } }
  );
  return { messageId: data.message.id, threadId: data.message.threadId };
}

/**
 * Send an existing draft. Returns the delivered message ID.
 */
export async function sendDraft(
  accessToken: string,
  draftId: string
): Promise<string> {
  const data = await gmailPost<{ id: string }>(
    accessToken,
    "/drafts/send",
    { id: draftId }
  );
  return data.id;
}

/**
 * Permanently delete a draft.
 */
export async function deleteDraft(
  accessToken: string,
  draftId: string
): Promise<void> {
  await gmailDelete(accessToken, `/drafts/${draftId}`);
}

/**
 * Helper: turn a plain-text body into HTML with the same line-break handling
 * used for sending. Callers pass plain text from UI; we store HTML in Gmail.
 */
export function plainTextToHtml(body: string): string {
  return escapeHtmlBody(body);
}
