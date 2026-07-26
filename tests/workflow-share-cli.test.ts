import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { CONFIG_FILENAME } from "../src/config";
import { BUNDLED_WORKFLOWS, exportWorkflow, userWorkflowsPath } from "../src/workflow";

function capture(home?: string) {
  let stdout = "";
  let stderr = "";
  const cwd = mkdtempSync(join(tmpdir(), "steamtrain-share-cli-"));
  return {
    io: {
      cwd,
      home: home ?? mkdtempSync(join(tmpdir(), "steamtrain-share-home-")),
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
    get cwd() {
      return cwd;
    },
  };
}

describe("workflow export", () => {
  it("writes a .steamtrain.json package for a bundled workflow", async () => {
    const c = capture();
    const code = await runCli(["workflow", "export", "tour"], c.io);
    expect(code).toBe(0);
    expect(c.stdout).toMatch(/exported 'tour'/);
    const path = join(c.cwd, "tour.steamtrain.json");
    const envelope = JSON.parse(readFileSync(path, "utf8"));
    expect(envelope.steamtrainWorkflow).toBe(1);
    expect(envelope.workflow.name).toBe("tour");
    expect(envelope.source).toBe("bundled");
    expect(envelope.checksum).toMatch(/^sha256:/);
  });

  it("prints to stdout with --stdout", async () => {
    const c = capture();
    const code = await runCli(["workflow", "export", "tour", "--stdout"], c.io);
    expect(code).toBe(0);
    const envelope = JSON.parse(c.stdout);
    expect(envelope.workflow.name).toBe("tour");
  });

  it("suggests a close name for unknown workflows", async () => {
    const c = capture();
    const code = await runCli(["workflow", "export", "tours"], c.io);
    expect(code).toBe(1);
    expect(c.stderr).toMatch(/did you mean 'tour'/);
  });

  it("emits machine-readable --json metadata", async () => {
    const c = capture();
    const code = await runCli(["workflow", "export", "tour", "--json"], c.io);
    expect(code).toBe(0);
    const payload = JSON.parse(c.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.name).toBe("tour");
    expect(payload.path).toContain("tour.steamtrain.json");
  });
});

describe("workflow import", () => {
  it("previews without saving by default and shows text surfaces", async () => {
    const c = capture();
    const path = join(c.cwd, "echo.steamtrain.json");
    writeFileSync(
      path,
      exportWorkflow({
        name: "echo-share",
        description: "Import preview fixture.",
        phases: [
          {
            id: "split",
            title: "Split",
            steps: [{ id: "areas", kind: "distributor", items: ["x: {{input}}"] }],
          },
        ],
      }).text,
    );

    const code = await runCli(["workflow", "import", path], c.io);
    expect(code).toBe(0);
    expect(c.stdout).toContain("echo-share");
    expect(c.stdout).toContain("not saved");
    expect(c.stdout).toContain("security review");
  });

  it("saves to the user layer with --save", async () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-share-home-"));
    const c = capture(home);
    const path = join(c.cwd, "echo.steamtrain.json");
    writeFileSync(
      path,
      exportWorkflow({
        name: "imported-echo",
        phases: [
          {
            id: "split",
            title: "Split",
            steps: [{ id: "areas", kind: "distributor", items: ["x: {{input}}"] }],
          },
        ],
      }).text,
    );

    const code = await runCli(["workflow", "import", path, "--save"], c.io);
    expect(code).toBe(0);
    expect(c.stdout).toMatch(/saved 'imported-echo'/);
    const onDisk = JSON.parse(readFileSync(userWorkflowsPath(home), "utf8"));
    expect(onDisk.workflows["imported-echo"]).toBeTruthy();
  });

  it("saves to the project layer with --scope project", async () => {
    const c = capture();
    writeFileSync(join(c.cwd, CONFIG_FILENAME), `${JSON.stringify({ workflows: {} }, null, 2)}\n`);
    const path = join(c.cwd, "team.steamtrain.json");
    writeFileSync(
      path,
      exportWorkflow({
        name: "team-check",
        phases: [
          {
            id: "split",
            title: "Split",
            steps: [{ id: "areas", kind: "distributor", items: ["x: {{input}}"] }],
          },
        ],
      }).text,
    );

    const code = await runCli(["workflow", "import", path, "--save", "--scope", "project"], c.io);
    expect(code).toBe(0);
    const project = JSON.parse(readFileSync(join(c.cwd, CONFIG_FILENAME), "utf8"));
    expect(project.workflows["team-check"]).toBeTruthy();
  });

  it("accepts --project as a shorthand for --scope project", async () => {
    const c = capture();
    writeFileSync(join(c.cwd, CONFIG_FILENAME), `${JSON.stringify({ workflows: {} }, null, 2)}\n`);
    const path = join(c.cwd, "shorthand.steamtrain.json");
    writeFileSync(
      path,
      exportWorkflow({
        name: "shorthand-check",
        phases: [
          {
            id: "split",
            title: "Split",
            steps: [{ id: "areas", kind: "distributor", items: ["x: {{input}}"] }],
          },
        ],
      }).text,
    );

    const code = await runCli(["workflow", "import", path, "--save", "--project"], c.io);
    expect(code).toBe(0);
    const project = JSON.parse(readFileSync(join(c.cwd, CONFIG_FILENAME), "utf8"));
    expect(project.workflows["shorthand-check"]).toBeTruthy();
  });

  it("emits full review JSON with --json --save", async () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-share-home-"));
    const c = capture(home);
    const path = join(c.cwd, "json-save.steamtrain.json");
    writeFileSync(
      path,
      exportWorkflow({
        name: "json-saved",
        phases: [
          {
            id: "split",
            title: "Split",
            steps: [{ id: "areas", kind: "distributor", items: ["x: {{input}}"] }],
          },
        ],
      }).text,
    );

    const code = await runCli(["workflow", "import", path, "--save", "--json"], c.io);
    expect(code).toBe(0);
    const payload = JSON.parse(c.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.saved).toBe(true);
    expect(payload.name).toBe("json-saved");
    expect(payload.review.summary.commands).toBe(0);
  });

  it("refuses to overwrite without --force", async () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-share-home-"));
    const c = capture(home);
    const path = join(c.cwd, "echo.steamtrain.json");
    const payload = exportWorkflow({
      name: "once",
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [{ id: "areas", kind: "distributor", items: ["x: {{input}}"] }],
        },
      ],
    }).text;
    writeFileSync(path, payload);

    expect(await runCli(["workflow", "import", path, "--save"], c.io)).toBe(0);
    const again = await runCli(["workflow", "import", path, "--save"], c.io);
    expect(again).toBe(1);
    expect(c.stderr).toMatch(/already exists|--force/);

    const forced = await runCli(["workflow", "import", path, "--save", "--force"], c.io);
    expect(forced).toBe(0);
    expect(c.stdout).toMatch(/updated 'once'/);
  });

  it("requires --yes when command steps are present", async () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-share-home-"));
    const c = capture(home);
    const path = join(c.cwd, "cmd.steamtrain.json");
    writeFileSync(
      path,
      exportWorkflow({
        name: "cmd-flow",
        phases: [
          {
            id: "verify",
            title: "Verify",
            steps: [{ id: "tests", kind: "command", cmd: "npm test" }],
          },
        ],
      }).text,
    );

    const blocked = await runCli(["workflow", "import", path, "--save"], c.io);
    expect(blocked).toBe(1);
    expect(c.stderr).toMatch(/--yes/);

    const allowed = await runCli(["workflow", "import", path, "--save", "--yes"], c.io);
    expect(allowed).toBe(0);
  });

  it("rejects invalid schemas before saving", async () => {
    const c = capture();
    const path = join(c.cwd, "bad.json");
    writeFileSync(path, `${JSON.stringify({ name: "bad", phases: [] })}\n`);
    const code = await runCli(["workflow", "import", path, "--save"], c.io);
    expect(code).toBe(1);
    expect(c.stderr).toMatch(/import rejected|invalid/);
  });

  it("imports from --stdin", async () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-share-home-"));
    const c = capture(home);
    const text = exportWorkflow({
      name: "stdin-flow",
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [{ id: "areas", kind: "distributor", items: ["x: {{input}}"] }],
        },
      ],
    }).text;
    const { Readable } = await import("node:stream");
    const code = await runCli(["workflow", "import", "--stdin", "--save"], {
      ...c.io,
      stdin: Readable.from([text]),
    });
    expect(code).toBe(0);
    const onDisk = JSON.parse(readFileSync(userWorkflowsPath(home), "utf8"));
    expect(onDisk.workflows["stdin-flow"]).toBeTruthy();
  });

  it("round-trips export → import for a bundled workflow under a new name", async () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-share-home-"));
    const c = capture(home);
    expect(await runCli(["workflow", "export", "tour", "--out", "tour-share.json"], c.io)).toBe(0);
    const code = await runCli(
      ["workflow", "import", "tour-share.json", "--name", "my-tour", "--save", "--yes"],
      c.io,
    );
    expect(code).toBe(0);
    const onDisk = JSON.parse(readFileSync(userWorkflowsPath(home), "utf8"));
    expect(onDisk.workflows["my-tour"].phases).toEqual(BUNDLED_WORKFLOWS.tour!.phases);
  });

  it("lists export/import in help", async () => {
    const c = capture();
    const code = await runCli(["help"], c.io);
    expect(code).toBe(0);
    expect(c.stdout).toContain("workflow export");
    expect(c.stdout).toContain("workflow import");
  });
});
