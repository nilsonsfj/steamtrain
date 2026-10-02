import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { renderCmd } from "../src/workflow/template";

function run(template: string, input: string): string {
  // bash, not sh: several cases (ANSI-C quotes, `[[`, array and offset
  // expansions) are bash syntax, and `sh` is dash on Linux CI.
  return execFileSync(
    "bash",
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

  it("rejects placeholders in every bash arithmetic context, not just $((…))", () => {
    const payload = "a[$(printf INJECTED >&2)]+1";
    const templates = [
      'str=abcdef; printf %s "${str:{{input}}}"',
      'str=abcdef; printf %s "${str:0:{{input}}}"',
      'arr=(a b); printf %s "${arr[{{input}}]}"',
      'printf %s "$[{{input}}]"',
      "(( x = {{input}} ))",
      "for ((i=0; i<{{input}}; i++)); do :; done",
      "arr[{{input}}]=1",
      'let "x={{input}}"',
      "declare -i n={{input}}",
      '[[ 1 -eq "{{input}}" ]]',
      "[[ {{input}} -lt 3 ]]",
    ];
    for (const template of templates) {
      expect(() => run(template, payload), template).toThrow(/arithmetic substitutions/);
    }
    // Non-arithmetic uses of the same syntax stay allowed.
    expect(run('str=abcdef; printf %s "${str:-{{input}}}"', "x")).toBe("abcdef");
    expect(run('[[ "{{input}}" == x ]] && printf yes', "x")).toBe("yes");
    expect(run('[ "{{input}}" -eq 1 ] && printf yes', "1")).toBe("yes");
  });

  it("does not treat arithmetic left shifts as here-documents", () => {
    expect(run('printf %s "$((\n1 << 2\n))"', "")).toBe("4");
    expect(run('printf %s "$[1 << 2]"', "")).toBe("4");
  });

  it("rejects placeholders in ANSI-C quotes instead of silently changing their values", () => {
    expect(() => run("printf %s $'{{input}}'", "hello")).toThrow(/ANSI-C quoted strings/);
  });
});
