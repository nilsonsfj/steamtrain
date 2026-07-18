import { describe, expect, it } from "vitest";
import { isSpuriousLetterInsert } from "../src/tui/PromptInput";

/**
 * ink dispatches every keystroke to all mounted `useInput` handlers with no
 * propagation stop, so a bare-letter hotkey consumed by the app-level handler
 * (Ctrl-chord letters, and the Arrival receipt's r/n/h/i) still reaches the
 * prompt's TextInput as a one-character insert. `isSpuriousLetterInsert`
 * detects that lone insert so the caller can drop it.
 */
describe("isSpuriousLetterInsert", () => {
  it("flags a single hotkey letter appended to an empty draft", () => {
    expect(isSpuriousLetterInsert("", "r", "r")).toBe(true);
    expect(isSpuriousLetterInsert("", "n", "n")).toBe(true);
  });

  it("is case-insensitive on the letter", () => {
    expect(isSpuriousLetterInsert("", "R", "r")).toBe(true);
  });

  it("flags the letter inserted at the cursor within existing text", () => {
    // Caret after "de" in "design": pressing the hotkey 'r' inserts there.
    expect(isSpuriousLetterInsert("design", "dersign", "r")).toBe(true);
  });

  it("does not flag a genuine multi-character change", () => {
    expect(isSpuriousLetterInsert("re", "ref", "r")).toBe(false);
  });

  it("does not flag an insert of a different letter", () => {
    expect(isSpuriousLetterInsert("", "n", "r")).toBe(false);
  });

  it("does not flag a deletion or same-length edit", () => {
    expect(isSpuriousLetterInsert("run", "ru", "r")).toBe(false);
    expect(isSpuriousLetterInsert("run", "rxn", "r")).toBe(false);
  });
});
