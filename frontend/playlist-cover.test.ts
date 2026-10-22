import { expect, it } from "vitest";
import { centreSquare } from "./playlist-cover";

it("keeps the centred square of wide, tall and square images", () => {
  expect(centreSquare(1600, 900)).toEqual({ x: 350, y: 0, side: 900 });
  expect(centreSquare(500, 800)).toEqual({ x: 0, y: 150, side: 500 });
  expect(centreSquare(640, 640)).toEqual({ x: 0, y: 0, side: 640 });
});
