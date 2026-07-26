/**
 * Async outbound URL safety (SSRF defense) with DNS resolution.
 * Sync helpers live in {@link ./safe-url-sync.ts} so browser bundles can import
 * hostname checks without pulling in `node:dns` / `node:net`.
 */

import { lookup } from "node:dns/promises";
import { type SafeUrlOptions, isBlockedHostname, isBlockedIp, isIP } from "./safe-url-sync";

export {
  isAllowedOutboundUrl,
  isBlockedHostname,
  isBlockedIp,
  isIP,
  type SafeUrlOptions,
} from "./safe-url-sync";

export type SafeUrlResult = { ok: true; url: URL } | { ok: false; error: string };

async function resolveAddresses(
  hostname: string,
  resolveHostname?: SafeUrlOptions["resolveHostname"],
): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  if (resolveHostname) return resolveHostname(hostname);
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

/**
 * Resolve `url` and reject private / reserved destinations. Call before each
 * hop in a redirect loop. Never throws — returns `{ ok: false, error }`.
 */
export async function assertSafeOutboundUrl(
  value: string | URL,
  options: SafeUrlOptions = {},
): Promise<SafeUrlResult> {
  let url: URL;
  try {
    url = typeof value === "string" ? new URL(value) : new URL(value.href);
  } catch {
    return { ok: false, error: `invalid URL '${String(value)}'` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      error: `unsupported URL scheme '${url.protocol}' (only http: and https: are allowed)`,
    };
  }
  const host = url.hostname;
  if (!host) return { ok: false, error: "URL is missing a hostname" };

  if (isBlockedHostname(host, options)) {
    return {
      ok: false,
      error: `refusing to fetch private/reserved host '${host}'`,
    };
  }

  let addresses: string[];
  try {
    addresses = await resolveAddresses(host, options.resolveHostname);
  } catch (err) {
    return {
      ok: false,
      error: `could not resolve host '${host}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (addresses.length === 0) {
    return { ok: false, error: `could not resolve host '${host}'` };
  }
  for (const addr of addresses) {
    if (isBlockedIp(addr, options)) {
      return {
        ok: false,
        error: `refusing to fetch private/reserved address ${addr} for host '${host}'`,
      };
    }
  }
  return { ok: true, url };
}
