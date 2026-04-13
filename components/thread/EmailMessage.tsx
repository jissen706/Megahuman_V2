"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { type Email, type EmailAttachment } from "@/lib/supabase";

interface Props {
  email: Email;
  index?: number;
}

function getSenderName(fromEmail: string) {
  const match = fromEmail.match(/^(.+?)\s*</);
  return match ? match[1].replace(/"/g, "").trim() : fromEmail.split("@")[0];
}


function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function AttachmentChip({ attachment, emailId }: { attachment: EmailAttachment; emailId: string }) {
  const isImage = attachment.mimeType.startsWith("image/");
  const href = `/api/emails/${emailId}/attachment/${attachment.attachmentId}?type=${encodeURIComponent(attachment.mimeType)}&download=1`;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-[12px] text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-zinc-50"
    >
      <span className="text-[14px]">{isImage ? "🖼" : "📎"}</span>
      <span className="max-w-[160px] truncate font-medium">{attachment.filename}</span>
      <span className="shrink-0 text-zinc-400">{formatSize(attachment.size)}</span>
    </a>
  );
}

function HtmlBody({ html, emailId }: { html: string; emailId: string }) {
  const [height, setHeight] = useState(200);

  const srcDoc = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 13px;
    line-height: 1.6;
    color: #3f3f46;
    margin: 0;
    padding: 0;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  img { max-width: 100%; height: auto; display: block; }
  a { color: #18181b; }
  table { max-width: 100%; border-collapse: collapse; }
  td, th { word-break: break-word; }
  * { box-sizing: border-box; }
</style>
</head>
<body>${html}</body>
</html>`;

  // emailId is used to scope image proxy URLs (already baked into html at sync time)
  void emailId;

  return (
    <iframe
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-popups"
      className="w-full border-0"
      style={{ height }}
      onLoad={(e) => {
        const iframe = e.currentTarget;
        const h = iframe.contentDocument?.body?.scrollHeight;
        if (h && h > 0) setHeight(h + 24);
      }}
    />
  );
}

export default function EmailMessage({ email, index = 0 }: Props) {
  const senderName = getSenderName(email.from_email);
  const regularAttachments = (email.attachments ?? []).filter((a) => !a.inline);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: index * 0.05, ease: "easeOut" }}
      className="py-6 first:pt-0"
    >
      {/* Sender row */}
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-[13px] font-semibold text-zinc-900 shrink-0">{senderName}</span>
          <span className="truncate text-[12px] text-zinc-400">{email.from_email.match(/<(.+)>/)?.[1] ?? ""}</span>
        </div>
        <span className="shrink-0 text-[12px] text-zinc-400 tabular-nums">
          {new Date(email.received_at).toLocaleString([], {
            month: "short", day: "numeric",
            hour: "numeric", minute: "2-digit",
          })}
        </span>
      </div>

      {/* Body */}
      <div>
        {email.body_html ? (
          <HtmlBody html={email.body_html} emailId={email.id} />
        ) : (
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-zinc-700">
            {email.body_plain || email.snippet}
          </p>
        )}

        {/* Attachment chips */}
        {regularAttachments.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {regularAttachments.map((att) => (
              <AttachmentChip key={att.attachmentId} attachment={att} emailId={email.id} />
            ))}
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="mt-6 border-b border-zinc-100" />
    </motion.div>
  );
}
