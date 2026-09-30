import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { renderCmd } from "../src/workflow/template";

function run(template: string, input: string): string {
  return execFileSync(
    "sh",
    ["-c", renderCmd(template, { input, outputs: new Map() }, { platform: "linux" })],
    {
      encoding: "utf8",
      timeout: 2000,
    },
  );
}

describe.skipIf(process.platform === "win32")("command values transported as data", () => {
  const values = [
    "",
    "hello world",
    "x; printf EXECUTED",
    "$(printf EXECUTED)",
    "`printf EXECUTED`",
    "'\"\\$();|&#",
    "x\nprintf EXECUTED\n#",
    "END\nEND\n",
    "a\r\nb\n\n",
  ];
  const templates = [
    { command: "printf %s {{input}}", substitution: false },
    { command: "printf %s '{{input}}'", substitution: false },
    { command: 'printf %s "{{input}}"', substitution: false },
    { command: 'printf %s "$(printf %s {{input}})"', substitution: true },
    { command: "printf %s \"$(printf %s '{{input}}')\"", substitution: true },
    { command: 'printf %s "`printf %s {{input}}`"', substitution: true },
    { command: "printf %s \"`printf %s '{{input}}'`\"", substitution: true },
    { command: 'printf %s "${UNSET_VALUE:-{{input}}}"', substitution: false },
  ];
  it.each(templates)("preserves arbitrary values in $command", ({ command, substitution }) => {
    for (const value of values) {
      expect(run(command, value)).toBe(substitution ? value.replace(/\n+$/, "") : value);
    }
  });

  it("preserves adjacent literal text as part of the same argument", () => {
    for (const value of values) {
      expect(run("printf %s pre{{input}}post", value)).toBe(`pre${value}post`);
    }
  });

  it("keeps ANSI-C string escapes from changing the following placeholder's context", () => {
    expect(run("printf %s $'q\\'w' {{input}}", "x; printf EXECUTED")).toBe("q'wx; printf EXECUTED");
  });

  it("rejects contexts that would evaluate data as an arithmetic expression", () => {
    expect(() => run('printf %s "$(({{input}}))"', "1")).toThrow(/arithmetic substitutions/);
    expect(() => run('printf %s "$(( $(printf %s {{input}}) ))"', "1")).toThrow(
      /arithmetic substitutions/,
    );
    expect(() => run("printf %s \"$(( $(cat <<'END'\n{{input}}\nEND\n) ))\"", "1")).toThrow(
      /arithmetic substitutions/,
    );
    expect(run('printf %s "$((1+1))" {{input}}', "x")).toBe("2x");
  });

  it("rejects placeholders in ANSI-C quotes instead of silently changing their values", () => {
    expect(() => run("printf %s $'{{input}}'", "hello")).toThrow(/ANSI-C quoted strings/);
  });
});
