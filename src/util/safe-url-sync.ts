/**
 * Sync outbound URL / IP denylist (SSRF defense), free of Node builtins so the
 * browser-bundled reducer can import callers that only need hostname checks.
 *
 * Async DNS resolution lives in {@link ./safe-url.ts} (Node-only).
 */

/** Cloud metadata / link-local hostnames that must never receive credentials. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

export interface SafeUrlOptions {
  /**
   * Allow loopback (127.0.0.0/8, ::1) and the hostname `localhost`.
   * Used for user-configured local LLM proxies (Ollama, LiteLLM).
   * Default: false.
   */
  allowLoopback?: boolean;
  /**
   * Allow RFC 1918 / unique-local LAN addresses (10/8, 172.16/12, 192.168/16,
   * fc00::/7). Still never allows link-local or cloud metadata.
   * Default: false.
   */
  allowPrivateLan?: boolean;
  /** Override DNS lookup (tests). Receives a hostname, returns IPv4/IPv6 strings. */
  resolveHostname?: (hostname: string) => Promise<string[]>;
}

/** Return 4, 6, or 0 — mirrors `node:net.isIP` without importing it. */
export function isIP(ip: string): 0 | 4 | 6 {
  if (isIpv4(ip)) return 4;
  if (isIpv6(ip)) return 6;
  return 0;
}

function isIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    if (n > 255) return false;
    // Reject leading zeros like 01.02.03.04 (not a canonical IPv4 form we use).
    if (part.length > 1 && part.startsWith("0")) return false;
  }
  return true;
}

function isIpv6(ip: string): boolean {
  // Accept compressed forms via URL parser — browsers and Node both support it.
  if (!ip.includes(":")) return false;
  try {
    // `new URL` requires a scheme; hostname brackets for v6.
    const url = new URL(`http://[${ip}]`);
    return Boolean(url.hostname);
  } catch {
    // Also accept IPv4-mapped without brackets via explicit pattern.
    return /^:?ffff:(\d+\.\d+\.\d+\.\d+)$/i.test(ip);
  }
}

/**
 * True when `ip` is in a range that must not be reached by untrusted
 * outbound fetches (loopback / private / link-local / CGNAT / multicast /
 * documentation / unspecified), subject to {@link SafeUrlOptions}.
 */
export function isBlockedIp(ip: string, options: SafeUrlOptions = {}): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4(ip, options);
  if (version === 6) return isBlockedIpv6(ip, options);
  return true;
}

function ipv4Octets(ip: string): number[] | undefined {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return undefined;
  }
  return parts;
}

function isBlockedIpv4(ip: string, options: SafeUrlOptions): boolean {
  const o = ipv4Octets(ip);
  if (!o) return true;
  const [a, b] = o as [number, number, number, number];

  // Unspecified / broadcast
  if (a === 0) return true;
  if (a === 255 && b === 255 && o[2] === 255 && o[3] === 255) return true;

  // Loopback 127.0.0.0/8
  if (a === 127) return !options.allowLoopback;

  // Link-local / cloud metadata 169.254.0.0/16 — always blocked
  if (a === 169 && b === 254) return true;

  // CGNAT 100.64.0.0/10
  if (a === 100 && b >= 64 && b <= 127) return true;

  // Multicast / reserved 224.0.0.0/4 and 240.0.0.0/4
  if (a >= 224) return true;

  // RFC 1918
  const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  if (isPrivate) return !options.allowPrivateLan;

  return false;
}

function isBlockedIpv6(ip: string, options: SafeUrlOptions): boolean {
  const normalized = ip.toLowerCase();
  // IPv4-mapped IPv6 (:ffff:x.x.x.x)
  const mapped = /^:?ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(normalized);
  if (mapped?.[1]) return isBlockedIpv4(mapped[1], options);
  const mappedHex = /^:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(normalized);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1]!, 16);
    const lo = Number.parseInt(mappedHex[2]!, 16);
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isBlockedIpv4(v4, options);
  }

  // Unspecified
  if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") return true;

  // Loopback ::1
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return !options.allowLoopback;
  }

  // Expand a bit for prefix checks — strip zone id.
  const bare = normalized.split("%")[0] ?? normalized;

  // Link-local fe80::/10 — always blocked (includes metadata on some clouds)
  if (
    bare.startsWith("fe8") ||
    bare.startsWith("fe9") ||
    bare.startsWith("fea") ||
    bare.startsWith("feb")
  ) {
    return true;
  }

  // Unique local fc00::/7
  if (bare.startsWith("fc") || bare.startsWith("fd")) {
    return !options.allowPrivateLan;
  }

  // Multicast ff00::/8
  if (bare.startsWith("ff")) return true;

  return false;
}

/**
 * Sync hostname denylist (no DNS). Rejects `localhost`, metadata hostnames,
 * and literal blocked IPs. Named hosts that are not literals pass — callers
 * that need DNS rebinding defense must use {@link assertSafeOutboundUrl}.
 */
export function isBlockedHostname(hostname: string, options: SafeUrlOptions = {}): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) {
    // localhost is loopback-class; honour allowLoopback.
    if (host === "localhost") return !options.allowLoopback;
    return true;
  }
  // Bare "metadata" shortcut some clouds use.
  if (host === "metadata") return true;
  if (isIP(host)) return isBlockedIp(host, options);
  return false;
}

/**
 * Scheme + host checks without DNS. Suitable for config-time validation
 * where the user intentionally points at a local LLM (`allowLoopback`).
 * Always rejects non-http(s), metadata hostnames, and link-local literals.
 */
export function isAllowedOutboundUrl(value: string, options: SafeUrlOptions = {}): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (isBlockedHostname(url.hostname, options)) return false;
    return true;
  } catch {
    return false;
  }
}
