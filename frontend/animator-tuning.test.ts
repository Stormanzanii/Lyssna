import { describe, expect, it } from "vitest";
import {
  ANIMATOR_DEFAULTS,
  animatorValues,
  choosePreset,
  DEFAULT_PRESET_ID,
  deletePreset,
  idleScale,
  importCode,
  loadPreset,
  randomize,
  savePreset,
  setValue,
  shareCode,
  visibleParameters,
} from "./animator-tuning";
import { MOTION, tuneMotion } from "./lyric-motion";

describe("animator presets", () => {
  it("plays upstream values under Default and rests text at full size", () => {
    expect(animatorValues({})).toEqual(ANIMATOR_DEFAULTS);
    // Unsung words keep the spacing sung ones have.
    expect(idleScale({})).toBe(1);
    expect(idleScale({ preset: "Custom" })).toBe(1);
    // Default ignores Custom values.
    expect(
      animatorValues({ preset: "Default", custom: { wordPeakScale: 2 } })
        .wordPeakScale,
    ).toBe(1.0505);
  });
  it("copies the playing values the first time Custom is chosen", () => {
    const custom = choosePreset({ preset: "Default" }, "Custom");
    expect(custom.custom).toEqual(ANIMATOR_DEFAULTS);
    const kept = choosePreset(
      { preset: "Default", custom: { glowStrength: 2 } },
      "Custom",
    );
    expect(kept.custom).toEqual({ glowStrength: 2 });
  });
  it("switches to Custom on edit and clamps typed values", () => {
    const edited = setValue({ preset: "Default" }, "glowStrength", 1e9);
    expect(edited.preset).toBe("Custom");
    expect(animatorValues(edited).glowStrength).toBe(100);
    expect(animatorValues(edited).wordPeakScale).toBe(1.0505);
  });
  it("saves, overwrites by name, loads and deletes presets", () => {
    let settings = setValue({}, "scaleDamping", 0.9);
    settings = savePreset(settings, "Mine");
    const id = settings.selected!;
    settings = savePreset(setValue(settings, "scaleDamping", 0.3), "mine");
    expect(settings.saved).toHaveLength(1);
    expect(settings.saved![0].values.scaleDamping).toBe(0.3);
    settings = loadPreset({ ...settings, custom: {} }, id);
    expect(settings.custom?.scaleDamping).toBe(0.3);
    expect(deletePreset(settings, id)).toMatchObject({
      saved: [],
      selected: null,
    });
  });
  it("loads the built-in Default entry as upstream values", () => {
    const loaded = loadPreset(
      setValue({}, "glowStrength", 3),
      DEFAULT_PRESET_ID,
    );
    expect(loaded).toMatchObject({ preset: "Custom", selected: "default" });
    expect(loaded.custom).toEqual(ANIMATOR_DEFAULTS);
  });
  it("round-trips SLP1 share codes and renames duplicates", () => {
    const code = shareCode("Bouncy", { verticalDamping: 0.2 });
    expect(code).toMatch(/^SLP1:Bouncy\|1\.0505,1\.175,/);
    const first = importCode({}, code);
    expect(first.name).toBe("Bouncy");
    expect(first.settings.custom?.verticalDamping).toBe(0.2);
    const second = importCode(first.settings, code);
    expect(second.name).toBe("Bouncy (2)");
    expect(() => importCode({}, "SLP1:x|1,2")).toThrow(/missing/);
    expect(() => importCode({}, "hello")).toThrow(/Not a Spicy Lyrics/);
  });
  it("reads the fork's legacy SLAP1 codes", () => {
    const json = JSON.stringify({ name: "Old", values: { glowStrength: 2 } });
    const code = `SLAP1:${btoa(json).replace(/=+$/, "")}`;
    expect(importCode({}, code).settings.custom?.glowStrength).toBe(2);
  });
  it("randomizes shown parameters on slider steps", () => {
    const ids = visibleParameters("Basic").map((item) => item.id);
    expect(ids).toHaveLength(5);
    expect(visibleParameters("Advanced")).toHaveLength(11);
    const random = randomize({}, ids, () => 0.999999);
    expect(random.preset).toBe("Custom");
    expect(random.custom?.wordPeakScale).toBe(2);
    expect(random.custom?.scaleFrequency).toBe(0.88);
  });
  it("tunes the motion curves", () => {
    tuneMotion({ preset: "Default" });
    expect(MOTION.scale(0)).toBeCloseTo(1);
    expect(MOTION.scale(0.7)).toBeCloseTo(1.0505);
    tuneMotion(setValue({}, "wordPeakScale", 1.2));
    expect(MOTION.scale(0)).toBeCloseTo(1);
    expect(MOTION.scale(0.7)).toBeCloseTo(1.2);
    tuneMotion(setValue({}, "blurStrength", 2));
    expect(MOTION.blurPerLine).toBeCloseTo(2.5);
    // Stronger motion rises further; unsung text stays level with the line.
    tuneMotion(setValue({}, "verticalStrength", 15));
    expect(MOTION.lift(0)).toBeCloseTo(0.01);
    expect(MOTION.lift(0.9)).toBeCloseTo(-0.25);
    tuneMotion({});
  });
});
