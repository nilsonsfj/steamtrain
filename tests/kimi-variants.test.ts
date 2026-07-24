import { describe, expect, it } from "vitest";
import {
  clearKimiVariantCacheForTests,
  getKimiEfforts,
  getKimiModelName,
  listKimiCachedAgentModels,
  parseKimiProviderList,
  setKimiVariantCacheForTests,
} from "../src/agents/kimi-variants";

const PROVIDER_LIST_JSON = JSON.stringify({
  providers: {
    "managed:kimi-code": { type: "kimi", baseUrl: "https://api.kimi.com/coding/v1" },
  },
  models: {
    "kimi-code/kimi-for-coding": {
      provider: "managed:kimi-code",
      model: "kimi-for-coding",
      maxContextSize: 262144,
      capabilities: ["thinking", "tool_use"],
      displayName: "K2.7 Coding",
    },
    "kimi-code/k3": {
      provider: "managed:kimi-code",
      model: "k3",
      maxContextSize: 262144,
      capabilities: ["thinking", "tool_use"],
      displayName: "K3",
      supportEfforts: ["low", "high", "max"],
      defaultEffort: "high",
    },
  },
});

describe("parseKimiProviderList", () => {
  it("parses aliases, display names, and declared efforts", () => {
    const models = parseKimiProviderList(PROVIDER_LIST_JSON);
    expect([...models.keys()]).toEqual(["kimi-code/kimi-for-coding", "kimi-code/k3"]);
    expect(models.get("kimi-code/kimi-for-coding")).toEqual({
      name: "K2.7 Coding",
      efforts: [],
    });
    expect(models.get("kimi-code/k3")).toEqual({
      name: "K3",
      efforts: ["low", "high", "max"],
    });
  });

  it("returns an empty map for malformed output", () => {
    expect(parseKimiProviderList("not json")).toEqual(new Map());
    expect(parseKimiProviderList('{"providers":{}}')).toEqual(new Map());
  });
});

describe("kimi variant cache", () => {
  it("lists cached models when fresh", () => {
    clearKimiVariantCacheForTests();
    expect(listKimiCachedAgentModels()).toEqual([]);

    setKimiVariantCacheForTests(
      new Map([
        ["kimi-code/k3", { name: "K3", efforts: ["low", "high", "max"] }],
        ["kimi-code/kimi-for-coding", { name: "K2.7 Coding", efforts: [] }],
      ]),
    );

    expect(listKimiCachedAgentModels()).toEqual([
      { id: "kimi-code/k3", name: "K3" },
      { id: "kimi-code/kimi-for-coding", name: "K2.7 Coding" },
    ]);
    expect(getKimiEfforts("kimi-code/k3")).toEqual(["low", "high", "max"]);

    clearKimiVariantCacheForTests();
    expect(getKimiEfforts("kimi-code/k3")).toEqual(["low", "high", "max"]); // static fallback
    expect(getKimiEfforts("kimi-code/kimi-for-coding")).toEqual([]);
  });

  it("resolves display names from the fresh cache only", () => {
    clearKimiVariantCacheForTests();
    expect(getKimiModelName("kimi-code/k3")).toBeUndefined();

    setKimiVariantCacheForTests(
      new Map([["kimi-code/k3", { name: "K3", efforts: ["low", "high", "max"] }]]),
    );
    expect(getKimiModelName("kimi-code/k3")).toBe("K3");
    expect(getKimiModelName("kimi-code/kimi-for-coding")).toBeUndefined();

    clearKimiVariantCacheForTests();
  });
});
