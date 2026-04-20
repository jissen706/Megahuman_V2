// Classification logic for tracking-pixel hits.
//
// Every pixel hit flows through classifyOpen(). Output drives two things:
//  - is_real_open: does this hit represent a human actually reading?
//  - classification: what kind of event was it (grace_period, apple_mpp,
//    gmail_proxy, security_scanner, sender_self_open, unknown_bot, real)
//
// Hits are always stored with classification so rules can be tuned later
// without losing data.

export type OpenClassification =
  | "real"
  | "grace_period"
  | "sender_self_open"
  | "apple_mpp"
  | "gmail_proxy"
  | "gmail_proxy_cached"
  | "security_scanner"
  | "unknown_bot";

export interface ClassifyContext {
  now: Date;
  sentAt: Date | null;          // when the email was sent (null for drafts not yet sent)
  senderIp: string | null;      // IP captured at send time
  senderUa: string | null;      // UA captured at send time
  ip: string;                   // pixel-hit IP
  ua: string;                   // pixel-hit UA
  method: string;               // HTTP method (HEAD means scanner)
  priorHits: Array<{            // previous hits for this token
    opened_at: string;
    classification: string;
    is_real_open: boolean;
  }>;
}

export interface ClassifyResult {
  classification: OpenClassification;
  isRealOpen: boolean;
  reason: string;               // short human-readable debug note
}

// 10-second window after send. Virtually no human opens in under 10s;
// hits that fast are sender-side proxies, outbound scanners, or Gmail
// caching the sent copy.
export const SEND_GRACE_PERIOD_MS = 10_000;

// Apple's main /8 block. Apple Mail Privacy Protection proxies
// traffic through Apple-owned ranges — a more complete list is
// published at https://mask-api.icloud.com/egress-ip-ranges.csv but
// 17.0.0.0/8 covers the primary block.
const APPLE_IP_RANGES: string[] = ["17.0.0.0/8"];

// Gmail image proxy egress ranges (partial — UA is the primary signal).
// Google infra IPs rotate; match on UA first, IP as secondary signal.
const GOOGLE_PROXY_IP_RANGES: string[] = ["66.249.84.0/22", "66.102.0.0/20"];

const SECURITY_SCANNER_PATTERNS: RegExp[] = [
  /proofpoint/i,
  /mimecast/i,
  /barracuda/i,
  /microsoft[- ]?office/i,
  /messagesniffer/i,
  /symantec/i,
  /trend ?micro/i,
  /mailscanner/i,
  /forcepoint/i,
  /avanan/i,
  /dpdhl/i,
  /palo ?alto/i,
  /sophos/i,
  /fortinet/i,
  /darktrace/i,
  /\bcheckpoint\b/i,
  /ironport/i,
];

const GENERIC_CRAWLER_PATTERNS: RegExp[] = [
  /googlebot/i,
  /bingbot/i,
  /slurp/i,
  /yandex(?!\s+mail)/i,
  /duckduckbot/i,
  /baiduspider/i,
  /facebookexternalhit/i,
  /linkedinbot/i,
  /telegrambot/i,
  /twitterbot/i,
  /whatsapp/i,
  /\bcrawl(er)?\b/i,
  /\bspider\b/i,
];

const GENERIC_BOT_PATTERNS: RegExp[] = [
  /\bbot\b/i,
  /\bpreview\b/i,
  /\bfetch\b/i,
  /\bscanner\b/i,
  /\bmonitor\b/i,
];

// --- IP helpers -------------------------------------------------------------

function ipToInt(ip: string): number | null {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4) return null;
  for (const p of parts) {
    if (!Number.isInteger(p) || p < 0 || p > 255) return null;
  }
  return (
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  );
}

export function isIpInCidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr, 10);
  if (Number.isNaN(bits) || bits < 0 || bits > 32) return false;
  const ipInt = ipToInt(ip);
  const baseInt = ipToInt(base);
  if (ipInt === null || baseInt === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function inAnyCidr(ip: string, cidrs: string[]): boolean {
  return cidrs.some((c) => isIpInCidr(ip, c));
}

export function isAppleMppIp(ip: string): boolean {
  return inAnyCidr(ip, APPLE_IP_RANGES);
}

export function isGoogleProxyIp(ip: string): boolean {
  return inAnyCidr(ip, GOOGLE_PROXY_IP_RANGES);
}

// Apple MPP image fetcher usually presents very sparse UAs.
function looksLikeAppleMppUa(ua: string): boolean {
  const trimmed = ua.trim();
  if (trimmed === "" || trimmed === "Mozilla/5.0") return true;
  // Standard MPP UA on macOS preload is a plain Safari-ish UA with no device details:
  if (/^Mozilla\/5\.0\s*\(Macintosh[^)]*\)\s*AppleWebKit\/[\d.]+\s*\(KHTML, like Gecko\)$/i.test(trimmed)) {
    return true;
  }
  return false;
}

function looksLikeGmailProxyUa(ua: string): boolean {
  return /googleimageproxy|ggpht\.com|googleusercontent\.com/i.test(ua);
}

function looksLikeSecurityScannerUa(ua: string): boolean {
  return SECURITY_SCANNER_PATTERNS.some((r) => r.test(ua));
}

function looksLikeWebCrawlerUa(ua: string): boolean {
  return GENERIC_CRAWLER_PATTERNS.some((r) => r.test(ua));
}

function looksLikeGenericBotUa(ua: string): boolean {
  return GENERIC_BOT_PATTERNS.some((r) => r.test(ua));
}

// --- classification --------------------------------------------------------

/**
 * Classify a single pixel hit. Pure function — no I/O, no DB.
 * Decision order matters; the first matching rule wins.
 */
export function classifyOpen(ctx: ClassifyContext): ClassifyResult {
  const { now, sentAt, senderIp, senderUa, ip, ua, method, priorHits } = ctx;

  // 0. HEAD requests mean a scanner is checking before retrieving —
  //    not a real read.
  if (method.toUpperCase() === "HEAD") {
    return {
      classification: "security_scanner",
      isRealOpen: false,
      reason: "HEAD request (scanner probe)",
    };
  }

  // 1. Grace period after send. This fixes the "opened immediately on send"
  //    bug — the #1 cause of false positives. Sender-side proxies hit
  //    within 0-5s of send; no human opens that fast.
  if (sentAt) {
    const deltaMs = now.getTime() - sentAt.getTime();
    if (deltaMs < SEND_GRACE_PERIOD_MS) {
      return {
        classification: "grace_period",
        isRealOpen: false,
        reason: `hit within ${deltaMs}ms of send (< ${SEND_GRACE_PERIOD_MS}ms grace)`,
      };
    }
  }

  // 2. Sender self-open — ignore hits that match sender's send-time fingerprint.
  if (senderIp && ip && senderIp === ip) {
    // Same IP is a strong signal; extra confidence if UA matches too.
    return {
      classification: "sender_self_open",
      isRealOpen: false,
      reason: `hit IP matches sender IP at send (${senderIp})`,
    };
  }
  if (senderUa && ua && senderUa === ua && senderIp === null) {
    return {
      classification: "sender_self_open",
      isRealOpen: false,
      reason: "hit UA matches sender UA at send (IP unknown)",
    };
  }

  // 3. Explicit web/social crawlers — never real.
  if (looksLikeWebCrawlerUa(ua)) {
    return {
      classification: "unknown_bot",
      isRealOpen: false,
      reason: `matches web crawler UA: ${ua.slice(0, 80)}`,
    };
  }

  // 4. Security scanners.
  if (looksLikeSecurityScannerUa(ua)) {
    return {
      classification: "security_scanner",
      isRealOpen: false,
      reason: "matches enterprise security scanner UA",
    };
  }

  // 5. Apple Mail Privacy Protection — preloads ALL images at delivery.
  //    Detection: sparse UA + (optional) Apple IP range.
  if (looksLikeAppleMppUa(ua) || isAppleMppIp(ip)) {
    return {
      classification: "apple_mpp",
      isRealOpen: false,
      reason: looksLikeAppleMppUa(ua)
        ? "sparse UA characteristic of Apple MPP preload"
        : `IP in Apple range ${ip}`,
    };
  }

  // 6. Gmail Image Proxy. First hit after grace period = probable real open.
  //    Subsequent hits from proxy within a short window = cached repeats.
  if (looksLikeGmailProxyUa(ua) || isGoogleProxyIp(ip)) {
    const priorRealGmail = priorHits.filter(
      (h) => h.classification === "gmail_proxy" && h.is_real_open
    );
    if (priorRealGmail.length > 0) {
      const last = priorRealGmail[priorRealGmail.length - 1];
      const sinceLastMs = now.getTime() - new Date(last.opened_at).getTime();
      if (sinceLastMs < 60_000) {
        // Cached repeat — real open already counted.
        return {
          classification: "gmail_proxy_cached",
          isRealOpen: false,
          reason: `repeat Gmail proxy fetch within 60s of prior real open`,
        };
      }
    }
    return {
      classification: "gmail_proxy",
      isRealOpen: true,
      reason: "Gmail image proxy fetch past grace period",
    };
  }

  // 7. Generic bot patterns — catches residual noise (preview bots, monitors).
  if (looksLikeGenericBotUa(ua)) {
    return {
      classification: "unknown_bot",
      isRealOpen: false,
      reason: `matches generic bot pattern`,
    };
  }

  // 8. Empty UA — suspicious, flag as bot to be safe.
  if (ua.trim() === "") {
    return {
      classification: "unknown_bot",
      isRealOpen: false,
      reason: "empty User-Agent",
    };
  }

  // Default: treat as a real open.
  return {
    classification: "real",
    isRealOpen: true,
    reason: "default: real open",
  };
}

/**
 * Extract the client IP from an incoming request. Handles x-forwarded-for
 * (first entry = originating client) and x-real-ip fallbacks.
 */
export function extractClientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip") ?? "";
}

/**
 * Collapse many hits into distinct read events. Two real hits from the same
 * (ip, ua) within 30s are one read.
 */
export function countDistinctReads(
  hits: Array<{ opened_at: string; ip_address: string | null; user_agent: string | null; is_real_open: boolean }>
): { count: number; firstOpenedAt: string | null } {
  const real = hits
    .filter((h) => h.is_real_open)
    .sort((a, b) => new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime());
  if (real.length === 0) return { count: 0, firstOpenedAt: null };

  type Last = { ts: number; key: string };
  const lastByKey = new Map<string, Last>();
  let count = 0;
  for (const h of real) {
    const key = `${h.ip_address ?? ""}|${h.user_agent ?? ""}`;
    const ts = new Date(h.opened_at).getTime();
    const prev = lastByKey.get(key);
    if (!prev || ts - prev.ts > 30_000) {
      count += 1;
    }
    lastByKey.set(key, { ts, key });
  }
  return { count, firstOpenedAt: real[0].opened_at };
}
