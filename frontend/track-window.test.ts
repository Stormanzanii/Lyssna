import { expect, it } from "vitest";
import { rowRange } from "./track-window";

it("renders the visible rows plus padding, in blocks", () => {
  // 900 px viewport, list starting 400 px down, 56 px rows, 800 songs.
  expect(rowRange(0, 900, 400, 56, 800)).toEqual([0, 40]);
  const [start, end] = rowRange(20_000, 900, 400, 56, 800);
  expect(start % 8).toBe(0);
  expect(start).toBeLessThanOrEqual(Math.floor((20_000 - 400) / 56) - 24);
  expect(end).toBeGreaterThanOrEqual(Math.ceil((20_900 - 400) / 56) + 24);
  expect(end - start).toBeLessThan(90);
});
it("stays inside the list", () => {
  expect(rowRange(1e6, 900, 400, 56, 800)[1]).toBe(800);
  const [start, end] = rowRange(1e6, 900, 400, 56, 800);
  expect(start).toBeLessThanOrEqual(end);
});
