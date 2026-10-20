import { describe, expect, it } from "vitest";
import { contextRoute, groupRecents } from "./recents";
import type { Track } from "./types";

const play = (name: string, at: string, context = ""): Track => ({
  uri: `spotify:track:${name}`,
  name,
  artists: [],
  album: { name: "", images: [] } as unknown as Track["album"],
  duration_ms: 1,
  is_local: false,
  added_at: at,
  played_context: context,
});

describe("groupRecents", () => {
  const now = new Date(2026, 9, 20, 12);
  const at = (day: number, hour: number) =>
    new Date(2026, 9, day, hour).toISOString();

  it("splits by local day and merges consecutive plays from one context", () => {
    const days = groupRecents(
      [
        play("a", at(20, 11), "spotify:album:A"),
        play("b", at(20, 10), "spotify:album:A"),
        play("c", at(20, 9), "spotify:playlist:P"),
        play("d", at(19, 22), "spotify:album:A"),
        play("e", at(18, 8)),
        play("f", at(18, 7)),
      ],
      now,
    );
    expect(days.map((day) => day.label.length > 0)).toEqual([true, true, true]);
    expect(days[0].label).toBe("Today");
    expect(days[1].label).toBe("Yesterday");
    expect(days[0].groups.map((group) => group.tracks.length)).toEqual([2, 1]);
    expect(days[1].groups[0].context).toBe("spotify:album:A");
    expect(days[2].groups).toHaveLength(1);
    expect(days[2].groups[0].tracks.map((track) => track.name)).toEqual([
      "e",
      "f",
    ]);
  });

  it("does not merge the same context across a different one", () => {
    const days = groupRecents(
      [
        play("a", at(20, 11), "spotify:album:A"),
        play("b", at(20, 10), "spotify:album:B"),
        play("c", at(20, 9), "spotify:album:A"),
      ],
      now,
    );
    expect(days[0].groups).toHaveLength(3);
  });

  it("skips plays without a valid time", () => {
    expect(groupRecents([play("a", "")], now)).toEqual([]);
  });
});

describe("contextRoute", () => {
  it("maps supported contexts and rejects others", () => {
    expect(contextRoute("spotify:user:me:collection")).toBe("liked");
    expect(contextRoute("spotify:album:0123456789abcdefghijkl")).toBe(
      "album:0123456789abcdefghijkl",
    );
    expect(contextRoute("spotify:show:0123456789abcdefghijkl")).toBeUndefined();
    expect(contextRoute("")).toBeUndefined();
  });
});
