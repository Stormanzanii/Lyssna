import { Fragment, useEffect, useState } from "react";
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
        aria-label="Timing keys"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && !listening && onClose()}
      >
        <header>
          <h3>Timing keys</h3>
          <button onClick={onClose} aria-label="Close timing keys">
            <X size={16} />
          </button>
        </header>
        <p className="ttml-hint">
          Click a key, then press the new one. A key already in use swaps over.
          Arrows, Space, Backspace and Ctrl shortcuts stay fixed.
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
        </div>
        <div className="ttml-dialog-row end">
          <button onClick={() => onChange({ ...DEFAULT_KEYS })}>
            <RotateCcw size={14} />
            Reset to AMLL keys
          </button>
        </div>
      </div>
    </div>
  );
}
