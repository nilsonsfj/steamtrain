/**
 * Best-effort redaction of high-confidence secret shapes before values flow
 * into subsequent agent prompts via templates. Conservative on purpose —
 * never strips short generic tokens.
 */

const SECRET_PATTERNS: RegExp[] = [
  // GitHub / GitLab / Slack-style tokens
  /\b(gh[pousr]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  // AWS access key ids
  /\b(AKIA[0-9A-Z]{16})\b/g,
  // OpenAI / Anthropic / generic sk- keys
  /\b(sk-[A-Za-z0-9_-]{20,})\b/g,
  // Bearer tokens in headers/text
  /\bBearer\s+[A-Za-z0-9._\-+=/]{20,}/gi,
  // PEM private key blocks
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

/** Replace high-confidence secret shapes with a placeholder. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}
