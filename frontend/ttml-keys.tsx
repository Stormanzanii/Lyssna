import { Fragment, type ReactNode, useEffect, useState } from "react";
import { RotateCcw, X } from "lucide-react";

export const KEY_ACTIONS = [
  ["start", "Start word"],
  ["next", "End word and start next"],
  ["end", "End word"],
  ["previous", "Previous word"],
  ["following", "Next word"],
  ["lineUp", "Previous line"],
  ["lineDown", "Next line"],
  ["jumpBack", "Jump to previous word"],
  ["jumpForward", "Jump to next word"],
  ["replay", "Replay line"],
  ["slower", "Slower"],
  ["faster", "Faster"],
  ["normalSpeed", "Normal speed"],
  ["clear", "Clear word"],
] as const;
export type KeyAction = (typeof KEY_ACTIONS)[number][0];
export type KeyMap = Record<KeyAction, string>;

// AMLL TTML Tool's defaults, except replay, which AMLL has no key for.
export const DEFAULT_KEYS: KeyMap = {
  start: "f",
  next: "g",
  end: "h",
  previous: "a",
  following: "d",
  lineUp: "w",
  lineDown: "s",
  jumpBack: "r",
  jumpForward: "y",
  replay: "t",
  slower: "[",
  faster: "]",
  normalSpeed: "'",
  clear: "delete",
};
// Arrows, Space, Backspace and Ctrl shortcuts stay fixed.
const RESERVED = new Set([
  " ",
  "arrowleft",
  "arrowright",
  "arrowup",
  "arrowdown",
  "backspace",
  "escape",
  "tab",
  "enter",
  "shift",
  "control",
  "alt",
  "meta",
]);

const KEYS_STORAGE = "lyssna.ttml-keys";

export function loadKeys(): KeyMap {
  try {
    const saved = JSON.parse(localStorage.getItem(KEYS_STORAGE) ?? "{}");
    const keys = { ...DEFAULT_KEYS };
    for (const [action] of KEY_ACTIONS)
      if (typeof saved?.[action] === "string" && saved[action])
        keys[action] = saved[action];
    return keys;
  } catch {
    return { ...DEFAULT_KEYS };
  }
}
export function saveKeys(keys: KeyMap) {
  try {
    localStorage.setItem(KEYS_STORAGE, JSON.stringify(keys));
  } catch {
    // The bindings still apply until the creator closes.
  }
}

export const actionFor = (keys: KeyMap, key: string) =>
  KEY_ACTIONS.find(([action]) => keys[action] === key)?.[0];

/** Gives `action` the key, swapping with any action that had it. */
export function rebind(keys: KeyMap, action: KeyAction, key: string): KeyMap {
  const holder = actionFor(keys, key);
  const next = { ...keys, [action]: key };
  if (holder && holder !== action) next[holder] = keys[action];
  return next;
}

export const keyLabel = (key: string) =>
  key === "delete" ? "Del" : key.length === 1 ? key.toUpperCase() : key;

const FIXED_KEYS: [string, ReactNode][] = [
  ["Play or pause", <kbd>Space</kbd>],
  [
    "Move between words and lines",
    <>
      <kbd>←</kbd>
      <kbd>→</kbd>
      <kbd>↑</kbd>
      <kbd>↓</kbd>
    </>,
  ],
  [
    "Seek 3 seconds",
    <>
      <kbd>Shift</kbd>+<kbd>←</kbd>
      <kbd>→</kbd>
    </>,
  ],
  [
    "Undo, redo",
    <>
      <kbd>Ctrl</kbd>+<kbd>Z</kbd> <kbd>Ctrl</kbd>+<kbd>Y</kbd>
    </>,
  ],
];

const LYRIC_TIPS: [string, ReactNode][] = [
  ["Select a word", "Click"],
  ["Edit a word", "Double-click"],
  ["Delete the selected word", <kbd>Del</kbd>],
  ["Split a word into syllables", <kbd>|</kbd>],
  ["Join two words", "Click the space between them"],
  [
    "Change several lines",
    <>
      <kbd>Ctrl</kbd>/<kbd>Shift</kbd>+click
    </>,
  ],
];

export function KeysDialog({
  keys,
  onChange,
  onClose,
}: {
  keys: KeyMap;
  onChange: (keys: KeyMap) => void;
  onClose: () => void;
}) {
  const [listening, setListening] = useState<KeyAction | null>(null);
  useEffect(() => {
    if (!listening) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const key = event.key.toLowerCase();
      if (key === "escape") return setListening(null);
      if (RESERVED.has(key) || event.ctrlKey || event.altKey || event.metaKey)
        return;
      onChange(rebind(keys, listening, key));
      setListening(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, keys, onChange]);
  return (
    <div className="ttml-dialog-backdrop" onClick={onClose}>
      <div
        className="ttml-dialog ttml-keys-dialog"
        role="dialog"
        aria-label="Settings"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && !listening && onClose()}
      >
        <header>
          <h3>Settings</h3>
          <button onClick={onClose} aria-label="Close settings">
            <X size={16} />
          </button>
        </header>
        <div className="ttml-settings-body">
          <section>
            <h4>Sync keys</h4>
            <p className="ttml-hint">
              Click a key, then press the new one. A key already in use swaps
              over.
            </p>
            <div className="ttml-keys-grid">
              {KEY_ACTIONS.map(([action, label]) => (
                <Fragment key={action}>
                  <span>{label}</span>
                  <button
                    className={listening === action ? "active" : ""}
                    aria-label={`${label} key`}
                    onClick={() =>
                      setListening(listening === action ? null : action)
                    }
                  >
                    {listening === action ? (
                      "Press a key…"
                    ) : (
                      <kbd>{keyLabel(keys[action])}</kbd>
                    )}
                  </button>
                </Fragment>
              ))}
              {FIXED_KEYS.map(([label, combo]) => (
                <Fragment key={label}>
                  <span>{label}</span>
                  <span className="ttml-fixed-key">{combo}</span>
                </Fragment>
              ))}
            </div>
            <div className="ttml-dialog-row end">
              <button onClick={() => onChange({ ...DEFAULT_KEYS })}>
                <RotateCcw size={14} />
                Reset keys
              </button>
            </div>
          </section>
          <section>
            <h4>Editing lyrics</h4>
            <div className="ttml-keys-grid">
              {LYRIC_TIPS.map(([label, combo]) => (
                <Fragment key={label}>
                  <span>{label}</span>
                  <span className="ttml-fixed-key">{combo}</span>
                </Fragment>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
