import { expect, it } from "vitest";
import { idleTrim } from "./memory-trim";

it("trims once after a minute of rest following activity", () => {
  const trim = idleTrim(60_000);
  expect(trim.due(100_000)).toBe(false);
  trim.activity(0);
  expect(trim.due(59_000)).toBe(false);
  expect(trim.due(60_000)).toBe(true);
  expect(trim.due(200_000)).toBe(false);
  trim.activity(300_000);
  trim.activity(350_000);
  expect(trim.due(400_000)).toBe(false);
  expect(trim.due(410_000)).toBe(true);
});
