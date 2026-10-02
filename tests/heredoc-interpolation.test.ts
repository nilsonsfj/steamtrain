import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { renderCmd } from "../src/workflow/template";

function run(template: string, input: string): string {
  const cmd = renderCmd(template, { input, outputs: new Map() }, { platform: "linux" });
  return execFileSync("sh", ["-c", cmd], {
    encoding: "utf8",
    timeout: 2000,
    env: { ...process.env, HOME: "/tmp/st-home" },
  });
}

describe.skipIf(process.platform === "win32")("here-document interpolation", () => {
  it("keeps an inserted delimiter formed across continued lines inside the body", () => {
    expect(run("cat <<END\nE\\\n{{input}}\nEND", "ND\nprintf INJECTED\n#")).toBe(
      "END\nprintf INJECTED\n#\n",
    );
  });

  it.each(["E'ND'", "'E'ND", 'E"ND"', '"E"ND', "E\\ND", "'END'", '"END"'])(
    "removes quotes from the complete delimiter word %s",
    (delimiter) => {
      const value = "x; printf INJECTED";
      expect(run(`cat <<${delimiter}\nhello\nEND\nprintf %s {{input}}`, value)).toBe(
        `hello\n${value}`,
      );
      expect(run(`cat <<${delimiter}\n{{input}}\nEND`, "END\nprintf INJECTED\n#")).toBe(
        "END\nprintf INJECTED\n#\n",
      );
    },
  );

  it.each([0, 1, 2, 3, 4, 5])("preserves %i template backslashes before literal data", (count) => {
    const prefix = "\\".repeat(count);
    const value = "$(printf INJECTED) `printf INJECTED` $HOME \\ \" '";
    expect(run(`cat <<END\n${prefix}{{input}}\nEND`, value)).toBe(
      `${"\\".repeat(Math.ceil(count / 2))}${value}\n`,
    );
  });

  it("prevents a template dollar from forming a command substitution with input", () => {
    expect(run("cat <<END\n${{input}}\nEND", "(printf INJECTED)")).toBe("$(printf INJECTED)\n");
    expect(run("cat <<END\n$\\\n{{input}}\nEND", "(printf INJECTED)")).toBe("$(printf INJECTED)\n");
  });

  it("preserves simple template expansions while keeping adjacent input literal", () => {
    expect(run("cat <<END\n$HOME\n${HOME}\n$HOME{{input}}\nEND", "x $HOME")).toBe(
      "/tmp/st-home\n/tmp/st-home\n/tmp/st-homex $HOME\n",
    );
  });

  it("finds a closing delimiter formed across template continuations", () => {
    expect(run("cat <<END\n{{input}}\nE\\\nND\nprintf AFTER", "hello")).toBe("hello\nAFTER");
  });

  it("preserves tab stripping and multiple queued documents", () => {
    expect(run("cat <<-END\n\t{{input}}\n\tEND", "END\nprintf INJECTED\n#")).toBe(
      "END\nprintf INJECTED\n#\n",
    );
    expect(run("cat <<A; cat <<B\n{{input}}\nA\n{{input}}\nB", "A\nB\n$HOME")).toBe(
      "A\nB\n$HOME\nA\nB\n$HOME\n",
    );
  });

  it("keeps nested command contexts outside a document correctly quoted", () => {
    const value = "END\nx'; printf INJECTED; printf '";
    expect(run('printf %s "$(cat <<END\n{{input}}\nEND\n)"', value)).toBe(value);
  });

  it.each([
    '$(printf %s "{{input}}")',
    "`printf %s '{{input}}'`",
    '$\\\n(printf %s "{{input}}")',
    "${HOME:-{{input}}}",
  ])("rejects nested evaluation in an interpolated unquoted body: %s", (body) => {
    expect(() => run(`cat <<END\n${body}\nEND`, 'x"; printf INJECTED; printf "')).toThrow(
      /Interpolated here-documents/,
    );
    expect(run(`cat <<'END'\n${body}\nEND`, "hello")).toBe(
      `${body.replace("{{input}}", "hello")}\n`,
    );
  });

  it("preserves command substitutions in documents without interpolated data", () => {
    expect(run("cat <<END\n$(printf TEMPLATE)\nEND", "unused")).toBe("TEMPLATE\n");
  });

  it.each(["", "\n", "a\n\n", "END", "END\n#", "\tEND", "E\\\nND", "$(`printf X`)"])(
    "preserves multiline and delimiter-like input %j",
    (value) => {
      expect(run("cat <<END\n{{input}}\nEND", value)).toBe(`${value}\n`);
      expect(run("cat <<'END'\n{{input}}\nEND", value)).toBe(`${value}\n`);
    },
  );
});
