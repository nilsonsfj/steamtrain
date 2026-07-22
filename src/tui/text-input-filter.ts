/**
 * Ink's parseKeypress does not understand modern Option/Alt encodings
 * (xterm modifyOtherKeys / Kitty CSI u). It strips the leading ESC and
 * text inputs then treat the residual CSI payload as ordinary characters —
 * e.g. Option+` arrives as "\x1b[27;3;96~" and becomes "[27;3;96~" in the
 * draft. Detect those remnants so callers can drop them.
 */
export function isEscapeSequenceRemnant(text: string): boolean {
  if (text.length < 2) return false;
  // xterm modifyOtherKeys: CSI 27 ; modifier ; code ~
  if (/^\[27;\d+;\d+~$/.test(text)) return true;
  // Kitty / CSI u: CSI codepoint ; modifier u
  if (/^\[\d+(?:;\d+)*u$/.test(text)) return true;
  // Other CSI with numeric params + letter/~ final (unparsed modified keys).
  if (/^\[[0-9;]+[A-Za-z~]$/.test(text)) return true;
  // SS3 leftovers (F-keys are usually named; belt-and-suspenders).
  if (/^O[A-Za-z]$/.test(text)) return true;
  return false;
}

/** True when `text` contains C0 controls or DEL (not printable drafting text). */
export function hasDisallowedControlChars(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Whether a keystroke's `input` payload should be inserted into a text field.
 * Rejects modifier chords, escape-sequence leftovers, and control characters.
 * Multi-character pastes of normal text still pass.
 */
export function shouldAcceptTextInput(
  input: string,
  key: { ctrl?: boolean; meta?: boolean; escape?: boolean },
): boolean {
  if (!input) return false;
  if (key.ctrl || key.meta || key.escape) return false;
  if (hasDisallowedControlChars(input)) return false;
  if (isEscapeSequenceRemnant(input)) return false;
  return true;
}

/**
 * True when an onChange from a text field only inserted an escape-sequence
 * remnant or control characters and should be ignored.
 */
export function shouldRejectTextInputChange(prev: string, next: string): boolean {
  const inserted = insertedChunk(prev, next);
  if (inserted === null) return false;
  if (hasDisallowedControlChars(inserted)) return true;
  if (isEscapeSequenceRemnant(inserted)) return true;
  return false;
}

/**
 * Single-hunk insert between `prev` and `next`, or null when the edit is not a
 * pure insertion (deletions / replacements return null so callers passthrough).
 */
export function insertedChunk(prev: string, next: string): string | null {
  if (next.length <= prev.length) return null;
  let prefix = 0;
  while (prefix < prev.length && prev[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < prev.length - prefix &&
    suffix < next.length - prefix &&
    prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  if (prefix + suffix !== prev.length) return null;
  return next.slice(prefix, next.length - suffix);
}
