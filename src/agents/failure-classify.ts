/**
 * Classify agent failure messages so the engine can decide whether to retry
 * the same binding or fail over to another model/agent mid-flight.
 *
 * Providers surface quota / rate-limit / billing exhaustion in many shapes:
 * transport `error` events, failed `result` turns, and stderr from non-zero
 * exits. Adapters may also tag an {@link AgentFailureKind} directly on the
 * event; message heuristics cover the rest.
 */

import type { AgentFailureKind } from "../types/events";

export type { AgentFailureKind };

/** Capacity / provider-budget failures that usually won't clear on the same model. */
export type CapacityFailureKind = Extract<AgentFailureKind, "quota" | "rate_limit">;

export function isCapacityFailure(kind: AgentFailureKind): kind is CapacityFailureKind {
  return kind === "quota" || kind === "rate_limit";
}

/** Failures that are safe to treat as mid-flight model-failover triggers by default. */
export function isDefaultFailoverTrigger(kind: AgentFailureKind): boolean {
  return kind === "quota" || kind === "rate_limit" || kind === "transient";
}

const QUOTA_PATTERNS: RegExp[] = [
  /\bquota\b/i,
  /\bexceeded your (?:current )?quota\b/i,
  /\binsufficient[_\s-]?(?:credits?|quota|balance|funds?)\b/i,
  /\b(?:no|out of|lack of)\s+credits?\b/i,
  /\bpaid credits?\b/i,
  /\bcredit(?:s)?\s+(?:exhausted|depleted|insufficient|balance)\b/i,
  /\badd credits?\b/i,
  /\bbilling\s+(?:error|issue|exceeded|required|problem|limit)\b/i,
  /\bpayment (?:required|failed|due)\b/i,
  /\busage limit\b/i,
  /\b(?:spend|monthly|daily|weekly)\s+limit\b/i,
  /\blimit (?:has been )?reached\b/i,
  /\bresource[_\s-]?exhausted\b/i,
  /\bRESOURCE_EXHAUSTED\b/,
  /\bbudget (?:exceeded|exhausted)\b/i,
  /\bfree tier\b.*\b(?:limit|exceeded|over)\b/i,
  /\b(?:limit|exceeded|over)\b.*\bfree tier\b/i,
];

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /\brate[_\s-]?limits?\b/i,
  /\btoo many requests\b/i,
  /\bthrottl(?:e|ed|ing)\b/i,
  /\bslow down\b/i,
  /\b(?:tokens?|requests?)\s+per\s+(?:minute|hour|day|second)\b/i,
  /\b(?:TPM|RPM|RPD)\b/,
  /\b429\b/,
  /\boverloaded\b/i,
  /\bcapacity(?: temporarily)? (?:unavailable|exceeded)\b/i,
];

const AUTH_PATTERNS: RegExp[] = [
  /\bunauthoriz(?:ed|ation)\b/i,
  /\bauthentication\b/i,
  /\bnot authenticated\b/i,
  /\binvalid[_\s-]?(?:api[_\s-]?)?key\b/i,
  /\bapi[_\s-]?key\b.*\b(?:invalid|missing|expired)\b/i,
  /\b(?:invalid|missing|expired)\b.*\bapi[_\s-]?key\b/i,
  /\bforbidden\b/i,
  /\bpermission denied\b/i,
  /\b(?:HTTP\s*)?401\b/,
  /\b(?:HTTP\s*)?403\b/,
  /\blog\s*in\b.*\b(?:required|again)\b/i,
];

const TRANSIENT_PATTERNS: RegExp[] = [
  /\btimeout\b/i,
  /\btimed?\s*out\b/i,
  /\bECONN(?:RESET|REFUSED|ABORTED)\b/,
  /\bENOTFOUND\b/,
  /\bETIMEDOUT\b/,
  /\bsocket hang up\b/i,
  /\bnetwork\b/i,
  /\btemporar(?:y|ily)\b/i,
  /\bservice\s+unavailable\b/i,
  /\btemporarily\s+unavailable\b/i,
  /\b503\b/,
  /\b502\b/,
  /\b504\b/,
  /\bspawn\b.*\b(?:ENOENT|failed)\b/i,
  /\btransport\b/i,
];

const PERMANENT_PATTERNS: RegExp[] = [
  /\binvalid (?:model|request|argument|parameter)\b/i,
  /\bmodel .+ (?:not found|does not exist|unknown)\b/i,
  /\bcontext(?: length)? (?:exceeded|too long)\b/i,
  /\bprompt (?:too long|is too large)\b/i,
  /\bcontent[_ ]?filter\b/i,
  /\bsafety\b.*\b(?:block|refus)/i,
  /\b400\b/,
  /\b404\b/,
  /\b422\b/,
];

/**
 * Classify a free-text agent failure. Optional `hint` from an adapter wins
 * when present; otherwise message (+ stderr) heuristics decide.
 */
export function classifyAgentFailure(
  message: string | undefined,
  options: { stderr?: string; hint?: AgentFailureKind } = {},
): AgentFailureKind {
  if (options.hint && options.hint !== "unknown") return options.hint;
  const text = [message, options.stderr].filter(Boolean).join("\n").trim();
  if (!text) return "unknown";

  // Capacity first: quota and rate-limit are the reason this module exists.
  if (QUOTA_PATTERNS.some((re) => re.test(text))) return "quota";
  if (RATE_LIMIT_PATTERNS.some((re) => re.test(text))) return "rate_limit";
  if (AUTH_PATTERNS.some((re) => re.test(text))) return "auth";
  if (PERMANENT_PATTERNS.some((re) => re.test(text))) return "permanent";
  if (TRANSIENT_PATTERNS.some((re) => re.test(text))) return "transient";
  return "unknown";
}

/** Human label for narration / UI (short, sentence-friendly). */
export function describeFailureKind(kind: AgentFailureKind): string {
  switch (kind) {
    case "quota":
      return "quota / billing exhausted";
    case "rate_limit":
      return "rate limited";
    case "auth":
      return "authentication failure";
    case "transient":
      return "transient provider failure";
    case "permanent":
      return "permanent failure";
    default:
      return "provider failure";
  }
}
