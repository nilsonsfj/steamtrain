import { describe, expect, it } from "vitest";
import {
  RECENTS_LIMIT,
  addRecent,
  labelRecents,
  pruneRecents,
  removeRecent,
} from "../electron/main/recents";

describe("desktop recents", () => {
  it("puts a new project at the front", () => {
    expect(addRecent(["/a", "/b"], "/c")).toEqual(["/c", "/a", "/b"]);
  });

  it("moves a re-opened project up rather than duplicating it", () => {
    expect(addRecent(["/a", "/b", "/c"], "/c")).toEqual(["/c", "/a", "/b"]);
  });

  it("keeps the list at the limit, dropping the oldest", () => {
    const full = Array.from({ length: RECENTS_LIMIT }, (_, i) => `/p${i}`);
    const next = addRecent(full, "/new");
    expect(next).toHaveLength(RECENTS_LIMIT);
    expect(next[0]).toBe("/new");
    expect(next).not.toContain(`/p${RECENTS_LIMIT - 1}`);
  });

  it("does not mutate the list it was given", () => {
    const original = ["/a", "/b"];
    addRecent(original, "/c");
    expect(original).toEqual(["/a", "/b"]);
  });

  it("removes a named project", () => {
    expect(removeRecent(["/a", "/b"], "/a")).toEqual(["/b"]);
    expect(removeRecent(["/a"], "/missing")).toEqual(["/a"]);
  });

  it("prunes entries that are no longer on disk", () => {
    const exists = (path: string): boolean => path !== "/gone";
    expect(pruneRecents(["/here", "/gone", "/also-here"], exists)).toEqual(["/here", "/also-here"]);
  });

  describe("labels", () => {
    it("uses the folder name when it is unambiguous", () => {
      expect(labelRecents(["/home/me/steamtrain", "/home/me/camelo"])).toEqual([
        { label: "steamtrain", path: "/home/me/steamtrain" },
        { label: "camelo", path: "/home/me/camelo" },
      ]);
    });

    it("disambiguates same-named projects with their parent", () => {
      const labels = labelRecents(["/work/steamtrain", "/scratch/steamtrain"]);
      expect(labels.map((l) => l.label)).toEqual(["work/steamtrain", "scratch/steamtrain"]);
    });

    it("only disambiguates the entries that collide", () => {
      const labels = labelRecents(["/work/app", "/scratch/app", "/work/other"]);
      expect(labels.map((l) => l.label)).toEqual(["work/app", "scratch/app", "other"]);
    });

    it("falls back to the full path when there is no parent to name", () => {
      // Two projects at the filesystem root collide and have nothing to
      // disambiguate them with; the path is then the only honest label.
      const labels = labelRecents(["/app", "/app/"]);
      expect(labels.every((l) => l.label.includes("app"))).toBe(true);
    });
  });
});
