import { describe, expect, it } from "vitest";
import {
  VERSION_INTERVAL_MS,
  newVersionDue,
  parseDraft,
  savedLabel,
  staleVersions,
} from "./ttml-saves";

describe("TTML saves", () => {
  it("keeps a version on leaving or once the interval passes", () => {
    expect(newVersionDue(undefined, 5, false)).toBe(true);
    expect(newVersionDue(1000, 2000, false)).toBe(false);
    expect(newVersionDue(1000, 2000, true)).toBe(true);
    expect(newVersionDue(0, VERSION_INTERVAL_MS, false)).toBe(true);
  });

  it("drops all but the newest versions", () => {
    const versions = Array.from({ length: 12 }, (_, id) => ({
      id,
      uri: "song",
      savedAt: id * 1000,
      lines: [],
      text: "",
    }));
    expect(staleVersions(versions, 10)).toEqual([1, 0]);
    expect(staleVersions(versions.slice(0, 3), 10)).toEqual([]);
  });

  it("reads drafts saved before save times existed", () => {
    expect(parseDraft('{"lines":[],"text":"hi"}')).toEqual({
      lines: [],
      text: "hi",
    });
    expect(parseDraft("{bad")).toBeNull();
    expect(parseDraft('{"lines":1,"text":""}')).toBeNull();
  });

  it("labels today's saves by time and older ones by date", () => {
    const now = new Date(2026, 10, 6, 18, 0).getTime();
    const today = new Date(2026, 10, 6, 16, 5).getTime();
    const earlier = new Date(2026, 10, 2, 9, 30).getTime();
    expect(savedLabel(today, now)).not.toMatch(/Nov|11/);
    expect(savedLabel(earlier, now)).toContain(",");
  });
});
