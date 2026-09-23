import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fallbackGrokEfforts } from "../src/agents/grok-efforts-fallback";
import {
  clearGrokVariantCacheForTests,
  getGrokEfforts,
  getGrokModelName,
  listGrokCachedAgentModels,
  parseGrokModelsOutput,
  refreshGrokVariantCache,
  setGrokVariantCacheForTests,
} from "../src/agents/grok-variants";
import {
  defaultModelForAgent,
  effortsForModel,
  modelIdsForAgent,
  modelNameForAgent,
} from "../src/agents/models";

const SAMPLE = `
You are logged in with grok.com.

Default model: grok-4.7

Available models:
  * grok-4.7 (default)
  - grok-4.7-build-fast
  - grok-4.6
  - grok-4.5
  - custom-extra
`;

const scratch: string[] = [];

afterEach(() => {
  clearGrokVariantCacheForTests();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeBinary(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "steamtrain-grok-models-"));
  scratch.push(dir);
  const binary = join(dir, "grok");
  writeFileSync(binary, script, { mode: 0o755 });
  return binary;
}

describe("parseGrokModelsOutput", () => {
  it("reads starred and dashed ids, keeping CLI order and static names", () => {
    const map = parseGrokModelsOutput(SAMPLE);
    expect([...map.keys()]).toEqual([
      "grok-4.7",
      "grok-4.7-build-fast",
      "grok-4.6",
      "grok-4.5",
      "custom-extra",
    ]);
    expect(map.get("grok-4.7")).toEqual({
      name: "Grok 4.7",
      efforts: ["low", "medium", "high", "xhigh"],
    });
    expect(map.get("grok-4.5")?.efforts).toEqual(["low", "medium", "high"]);
    expect(map.get("grok-4.7-build-fast")?.name).toBe("Grok 4.7 Fast");
    expect(map.get("custom-extra")).toEqual({ name: "custom-extra", efforts: [] });
  });

  it("ignores headers and blank lines", () => {
    expect(parseGrokModelsOutput("Default model: grok-4.7\n\nAvailable models:\n").size).toBe(0);
  });
});

describe("fallbackGrokEfforts", () => {
  it("gives 4.5 the three-step menu and later Grok models xhigh", () => {
    expect(fallbackGrokEfforts("grok-4.5")).toEqual(["low", "medium", "high"]);
    expect(fallbackGrokEfforts("grok-4.6")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(fallbackGrokEfforts("grok-4.7-build-fast")).toContain("xhigh");
    expect(fallbackGrokEfforts("grok-5")).toContain("xhigh");
    expect(fallbackGrokEfforts("custom-extra")).toEqual([]);
  });
});

describe("grok variant cache", () => {
  it("refreshes from grok models and replaces the static catalog", async () => {
    const binary = fakeBinary(`#!/bin/sh
if [ "$1" != "models" ]; then
  echo "unexpected $1" >&2
  exit 2
fi
cat <<'EOF'
${SAMPLE}
EOF
`);
    expect(await refreshGrokVariantCache(binary)).toBe(true);
    expect(modelIdsForAgent("grok")).toEqual([
      "grok-4.7",
      "grok-4.7-build-fast",
      "grok-4.6",
      "grok-4.5",
      "custom-extra",
    ]);
    expect(modelNameForAgent("grok", "grok-4.7")).toBe("Grok 4.7");
    expect(modelNameForAgent("grok", "custom-extra")).toBe("custom-extra");
    expect(effortsForModel("grok", "grok-4.7")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(effortsForModel("grok", "custom-extra")).toEqual([]);
    expect(defaultModelForAgent("grok")).toBe("grok-4.7");
    expect(listGrokCachedAgentModels().map((model) => model.id)).toContain("grok-4.6");
  });

  it("keeps the static catalog when grok models fails or prints nothing", async () => {
    const missing = fakeBinary("#!/bin/sh\necho 'not logged in' >&2\nexit 1\n");
    expect(await refreshGrokVariantCache(missing)).toBe(false);
    expect(modelIdsForAgent("grok")).toEqual([
      "grok-4.7",
      "grok-4.7-build-fast",
      "grok-4.6",
      "grok-4.5",
    ]);

    const empty = fakeBinary("#!/bin/sh\necho 'Available models:'\nexit 0\n");
    expect(await refreshGrokVariantCache(empty)).toBe(false);
    expect(getGrokModelName("grok-4.6")).toBe("Grok 4.6");
    expect(getGrokEfforts("grok-4.5")).toEqual(["low", "medium", "high"]);
  });

  it("serves an injected cache and hides efforts for models it does not list", () => {
    setGrokVariantCacheForTests(
      new Map([["grok-4.7", { name: "Grok 4.7 (live)", efforts: ["high"] }]]),
    );
    expect(getGrokModelName("grok-4.7")).toBe("Grok 4.7 (live)");
    expect(getGrokEfforts("grok-4.7")).toEqual(["high"]);
    expect(getGrokEfforts("grok-4.5")).toEqual([]);
    expect(modelIdsForAgent("grok")).toEqual(["grok-4.7"]);
  });
});
