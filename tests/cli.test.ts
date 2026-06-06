import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli";

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      cwd: mkdtempSync(join(tmpdir(), "steamtrain-cli-")),
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

describe("runCli", () => {
  it("lists workflows as the primary CLI surface", async () => {
    const c = capture();
    const code = await runCli(["workflows"], c.io);

    expect(code).toBe(0);
    expect(c.stdout).toContain("workflows");
    expect(c.stdout).toContain("multi-plan");
    expect(c.stdout).toContain("distributor");
  });

  it("validates bundled workflows", async () => {
    const c = capture();
    const code = await runCli(["workflow", "validate", "multi-plan"], c.io);

    expect(code).toBe(0);
    expect(c.stdout).toContain("ok  multi-plan");
    expect(c.stderr).toBe("");
  });

  it("reports unknown workflow validation failures", async () => {
    const c = capture();
    const code = await runCli(["workflow", "validate", "missing"], c.io);

    expect(code).toBe(1);
    expect(c.stderr).toContain("unknown workflow 'missing'");
  });

  it("returns non-zero when a headless workflow run fails", async () => {
    const c = capture();
    writeFileSync(
      join(c.io.cwd, "steamtrain.json"),
      JSON.stringify({
        binaries: {
          claude: "/definitely/missing/claude",
          opencode: "/definitely/missing/opencode",
        },
        workflows: {
          "fail-gate": {
            phases: [
              {
                id: "gate",
                title: "Gate",
                steps: [
                  {
                    id: "gate",
                    kind: "gate",
                    condition: { contains: "pass" },
                    onFalse: "fail",
                  },
                ],
              },
            ],
          },
        },
      }),
    );

    const code = await runCli(["workflow", "run", "fail-gate", "--input", "nope"], c.io);

    expect(code).toBe(1);
    expect(c.stdout).toContain("workflow failed");
  });
});
