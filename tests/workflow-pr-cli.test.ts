import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli";

describe("workflow pr CLI", () => {
  it("prints help for workflow pr", async () => {
    let out = "";
    const code = await runCli(["workflow", "pr", "--help"], {
      stdout: (t) => {
        out += t;
      },
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(out).toContain("wait-checks");
    expect(out).toContain("merge-when-ready");
    expect(out).toContain("statusCheckRollup");
  });

  it("rejects unknown pr subcommands", async () => {
    let err = "";
    const code = await runCli(["workflow", "pr", "explode"], {
      stdout: () => {},
      stderr: (t) => {
        err += t;
      },
    });
    expect(code).toBe(1);
    expect(err).toContain("unknown workflow pr command");
  });

  it("requires a PR ref for wait-checks", async () => {
    let err = "";
    const code = await runCli(["workflow", "pr", "wait-checks"], {
      stdout: () => {},
      stderr: (t) => {
        err += t;
      },
    });
    expect(code).toBe(1);
    expect(err).toContain("requires a PR ref");
  });

  it("rejects invalid flag values", async () => {
    const cases: { args: string[]; needle: string }[] = [
      { args: ["wait-checks", "1", "--timeout-sec", "0"], needle: "--timeout-sec" },
      { args: ["wait-checks", "1", "--poll-sec", "abc"], needle: "--poll-sec" },
      { args: ["merge-when-ready", "1", "--strategy", "fast-forward"], needle: "--strategy" },
      { args: ["wait-checks", "1", "--empty-grace-sec", "-1"], needle: "--empty-grace-sec" },
      { args: ["wait-checks", "1", "--nope"], needle: "unknown flag" },
    ];
    for (const { args, needle } of cases) {
      let err = "";
      const code = await runCli(["workflow", "pr", ...args], {
        stdout: () => {},
        stderr: (t) => {
          err += t;
        },
      });
      expect(code, args.join(" ")).toBe(1);
      expect(err, args.join(" ")).toContain(needle);
    }
  });
});
