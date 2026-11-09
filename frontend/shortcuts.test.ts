import { expect, test } from "vitest";
import { matchesShortcut, shortcutFor, type Shortcut } from "./shortcuts";

const press = (code: string, modifiers: string[] = []) => ({
  code,
  ctrlKey: modifiers.includes("ctrl"),
  metaKey: modifiers.includes("cmd"),
  altKey: modifiers.includes("alt"),
  shiftKey: modifiers.includes("shift"),
});

test("letters, digits, arrows and symbols match by key position", () => {
  expect(matchesShortcut(press("KeyN", ["ctrl"]), "Ctrl+N")).toBe(true);
  expect(matchesShortcut(press("KeyH", ["alt", "shift"]), "Alt+Shift+H")).toBe(
    true,
  );
  expect(
    matchesShortcut(press("Digit1", ["alt", "shift"]), "Alt+Shift+1"),
  ).toBe(true);
  expect(matchesShortcut(press("ArrowLeft", ["shift"]), "Shift+Left")).toBe(
    true,
  );
  expect(matchesShortcut(press("Slash", ["ctrl"]), "Ctrl+/")).toBe(true);
  expect(matchesShortcut(press("KeyN", ["cmd", "shift"]), "Cmd+Shift+N")).toBe(
    true,
  );
});

test("extra or missing modifiers do not match", () => {
  expect(matchesShortcut(press("KeyN", ["ctrl", "shift"]), "Ctrl+N")).toBe(
    false,
  );
  expect(matchesShortcut(press("KeyN"), "Ctrl+N")).toBe(false);
  expect(matchesShortcut(press("ArrowLeft", ["ctrl"]), "Shift+Left")).toBe(
    false,
  );
  expect(matchesShortcut(press("KeyN", ["ctrl"]), "Ctrl+")).toBe(false);
});

test("typing keeps every shortcut that is not marked for it", () => {
  const ran: string[] = [];
  const shortcuts: Shortcut[] = [
    {
      keys: "Shift+Left",
      label: "Seek backward",
      section: "Playback",
      run: () => ran.push("seek"),
    },
    {
      keys: ["Ctrl+P", "Ctrl+,"],
      label: "Settings",
      section: "Basic",
      whileTyping: true,
      run: () => ran.push("settings"),
    },
    { keys: "Space", label: "Play", section: "Playback", listed: true },
  ];
  expect(shortcutFor(press("ArrowLeft", ["shift"]), shortcuts, true)).toBe(
    undefined,
  );
  expect(
    shortcutFor(press("ArrowLeft", ["shift"]), shortcuts, false)?.label,
  ).toBe("Seek backward");
  expect(shortcutFor(press("Comma", ["ctrl"]), shortcuts, true)?.label).toBe(
    "Settings",
  );
  expect(shortcutFor(press("Space"), shortcuts, false)).toBe(undefined);
});
