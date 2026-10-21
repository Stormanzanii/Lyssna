import { describe, expect, it } from "vitest";
import {
  ambienceFps,
  ambienceSize,
  onWindowActivity,
  setWindowActivity,
  windowActivity,
} from "./window-activity";

describe("window activity", () => {
  it("notifies only on changes", () => {
    let calls = 0;
    const stop = onWindowActivity(() => calls++);
    setWindowActivity({ minimized: false, focused: true });
    expect(calls).toBe(0);
    setWindowActivity({ minimized: true, focused: false });
    expect(calls).toBe(1);
    expect(windowActivity()).toEqual({ minimized: true, focused: false });
    stop();
    setWindowActivity({ minimized: false, focused: true });
    expect(calls).toBe(1);
  });

  it("stops ambience when minimized and slows it when unfocused", () => {
    expect(ambienceFps({ minimized: true, focused: false })).toBe(0);
    expect(ambienceFps({ minimized: false, focused: false })).toBe(12);
    expect(ambienceFps({ minimized: false, focused: true })).toBe(30);
  });

  it("draws a smaller ambience canvas in the background", () => {
    expect(ambienceSize({ minimized: false, focused: true })).toBe(768);
    expect(ambienceSize({ minimized: false, focused: false })).toBe(320);
    expect(ambienceSize({ minimized: true, focused: false })).toBe(320);
  });
});
