import { expect, it } from "vitest";
import { fontFamily } from "./custom-fonts";

it("accepts installed font names beyond the preset list", () => {
  expect(fontFamily("Bahnschrift")).toBe(
    '"Bahnschrift", "Segoe UI", sans-serif',
  );
  expect(fontFamily("ＭＳ ゴシック")).toContain("ＭＳ ゴシック");
});
it("quotes font names without introducing extra CSS values", () => {
  expect(fontFamily('Font "Quoted"\\Name')).toBe(
    '"Font \\"Quoted\\"\\\\Name", "Segoe UI", sans-serif',
  );
});
it("restores defaults for empty names and rejects invalid font names", () => {
  expect(fontFamily("")).toBeUndefined();
  expect(fontFamily("  ")).toBeUndefined();
  expect(fontFamily("Arial\nGeorgia")).toBeUndefined();
  expect(fontFamily("A".repeat(101))).toBeUndefined();
});
