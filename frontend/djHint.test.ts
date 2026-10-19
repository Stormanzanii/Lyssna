import { describe, expect, it } from "vitest";
import { createDJReminder } from "./djHint";

describe("DJ hold reminder", () => {
  it("appears per account, survives restart, and returns after three days", () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    };
    const first = createDJReminder(storage),
      now = 1000000;
    expect(first("one", now)).toBe(true);
    expect(first("one", now + 1000)).toBe(false);
    expect(first("two", now)).toBe(true);
    const restarted = createDJReminder(storage);
    expect(restarted("one", now + 2 * 86400000)).toBe(false);
    expect(restarted("one", now + 3 * 86400000)).toBe(true);
  });
  it("handles unavailable storage without repeating for each DJ segment", () => {
    const reminder = createDJReminder({
      getItem: () => {
        throw Error();
      },
      setItem: () => {
        throw Error();
      },
    });
    expect(reminder("", 100)).toBe(false);
    expect(reminder("one", 100)).toBe(true);
    expect(reminder("one", 200)).toBe(false);
  });
});
