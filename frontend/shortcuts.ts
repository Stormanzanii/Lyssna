import { IS_MAC } from "./platform";

export interface Shortcut {
  /** Keys as shown, such as "Ctrl+Shift+N"; several mean any of them. */
  keys: string | string[];
  label: string;
  section: "Basic" | "Playback" | "Navigation" | "Layout";
  /** Listed in the reference only; another handler owns the keys. */
  listed?: boolean;
  /** Works while typing in a text field. */
  whileTyping?: boolean;
  disabled?: boolean;
  run?: () => void;
}

const NAMED: Record<string, string> = {
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  "/": "Slash",
  ",": "Comma",
  "[": "BracketLeft",
  "]": "BracketRight",
  space: "Space",
};

type Keys = Pick<
  KeyboardEvent,
  "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
>;

/** Whether a key press is the written shortcut. Keys are matched by
 * position, so Alt+Shift+H works on layouts where that types a symbol. */
export function matchesShortcut(event: Keys, shortcut: string): boolean {
  const parts = shortcut.split("+").map((part) => part.trim().toLowerCase());
  const key = parts.pop() ?? "";
  const code =
    NAMED[key] ??
    (/^[a-z]$/.test(key)
      ? `Key${key.toUpperCase()}`
      : /^\d$/.test(key)
        ? `Digit${key}`
        : /^f\d{1,2}$/.test(key)
          ? key.toUpperCase()
          : "");
  return (
    !!code &&
    event.code === code &&
    event.ctrlKey === parts.includes("ctrl") &&
    event.metaKey === parts.includes("cmd") &&
    event.altKey === (parts.includes("alt") || parts.includes("option")) &&
    event.shiftKey === parts.includes("shift")
  );
}

/** The shortcut a key press asks for, skipping listed-only and disabled
 * ones; while typing, only those marked for it. */
export function shortcutFor(
  event: Keys,
  shortcuts: Shortcut[],
  typing: boolean,
): Shortcut | undefined {
  return shortcuts.find(
    (shortcut) =>
      !shortcut.listed &&
      !!shortcut.run &&
      (!typing || shortcut.whileTyping) &&
      [shortcut.keys].flat().some((keys) => matchesShortcut(event, keys)),
  );
}

/** Spotify's keys on this platform: Cmd and Option on a Mac. */
export const keys = (windows: string, mac?: string) =>
  IS_MAC
    ? (mac ?? windows.replace("Ctrl", "Cmd").replace("Alt", "Option"))
    : windows;
