import { render } from "ink-testing-library";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { PromptTextInput } from "../src/tui/PromptTextInput";

/** useInput subscribes in an effect; yield to the event loop before/after writes. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function type(stdin: { write: (data: string) => void }, ...inputs: string[]): Promise<void> {
  await tick();
  for (const input of inputs) {
    stdin.write(input);
    await tick();
  }
}

function Harness({ onChange }: { onChange?: (v: string) => void } = {}) {
  const [value, setValue] = useState("");
  return (
    <PromptTextInput
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      onSubmit={() => {}}
      focus
      placeholder="type here"
    />
  );
}

describe("PromptTextInput", () => {
  it("accepts ordinary typing", async () => {
    const { stdin, lastFrame } = render(<Harness />);
    await type(stdin, "h", "i");
    expect(lastFrame()).toContain("hi");
  });

  it("does not insert Option+` CSI leftovers", async () => {
    const values: string[] = [];
    const { stdin } = render(<Harness onChange={(v) => values.push(v)} />);
    await type(stdin, "o", "k");
    await type(stdin, "\x1b[27;3;96~");
    expect(values.at(-1)).toBe("ok");
    expect(values.some((v) => v.includes("[27;3;96~"))).toBe(false);
  });

  it("does not insert Kitty CSI-u Option leftovers", async () => {
    const values: string[] = [];
    const { stdin } = render(<Harness onChange={(v) => values.push(v)} />);
    await type(stdin, "x");
    await type(stdin, "\x1b[96;3u");
    expect(values.at(-1)).toBe("x");
    expect(values.some((v) => v.includes("[96;3u"))).toBe(false);
  });

  it("does not insert meta+letter chords", async () => {
    const values: string[] = [];
    const { stdin } = render(<Harness onChange={(v) => values.push(v)} />);
    await type(stdin, "z");
    await type(stdin, "\x1bb");
    expect(values.at(-1)).toBe("z");
  });
});
