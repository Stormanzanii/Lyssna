import { expect, test } from "vitest";
import {
  colourIndex,
  noteName,
  paletteTable,
  rulerStep,
} from "./ttml-spectrogram";

test("gain scales a level onto the palette and stops at the top", () => {
  const quarter = Math.round(65535 / 4);
  expect(colourIndex(0, 3)).toBe(0);
  expect(colourIndex(quarter, 1)).toBe(255);
  expect(colourIndex(quarter / 4, 1)).toBe(64);
  expect(colourIndex(quarter / 4, 2)).toBe(128);
  expect(colourIndex(65535, 8)).toBe(255);
});

test("Icy Blue runs from black through blue to white", () => {
  const table = paletteTable("icy");
  const at = (index: number) => [...table.subarray(index * 4, index * 4 + 3)];
  expect(at(0)).toEqual([0, 0, 0]);
  const [r, g, b] = at(40);
  expect(b).toBeGreaterThan(r);
  expect(b).toBeGreaterThan(g);
  expect(at(255).every((part) => part > 240)).toBe(true);
});

test("hover readout names notes and the ruler keeps labels apart", () => {
  expect(noteName(440)).toBe("A4");
  expect(noteName(261.63)).toBe("C4");
  expect(rulerStep(200)).toBe(500);
  expect(rulerStep(2000)).toBe(50);
});
