import { describe, expect, it } from "vitest";
import { DEFAULT_KEYS, actionFor, rebind } from "./ttml-keys";

describe("TTML Creator timing keys", () => {
  it("swaps a key that another action already uses", () => {
    const keys = rebind(DEFAULT_KEYS, "start", "g");
    expect(keys.start).toBe("g");
    expect(keys.next).toBe("f");
    expect(actionFor(keys, "g")).toBe("start");
  });

  it("frees the old key when the new one is unused", () => {
    const keys = rebind(DEFAULT_KEYS, "replay", "q");
    expect(keys.replay).toBe("q");
    expect(actionFor(keys, "t")).toBeUndefined();
  });
});
