import { Fragment, type ReactNode, useEffect, useState } from "react";
import { Keyboard, RotateCcw, X } from "lucide-react";
import { IS_MAC, MODIFIER } from "./platform";

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
  clear: "c",
};
// Arrows, Space, Backspace, Delete and Ctrl shortcuts stay fixed.
const RESERVED = new Set([
  "delete",
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
      if (
        typeof saved?.[action] === "string" &&
        saved[action] &&
        !RESERVED.has(saved[action])
      )
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

const GROUPS: Record<string, KeyAction[]> = {
  Timing: ["start", "next", "end", "clear"],
  Moving: [
    "previous",
    "following",
    "lineUp",
    "lineDown",
    "jumpBack",
    "jumpForward",
    "replay",
  ],
  Speed: ["slower", "faster", "normalSpeed"],
};
const LABELS = Object.fromEntries(KEY_ACTIONS) as Record<KeyAction, string>;

const caps = (...names: string[]) =>
  names.map((name, index) => <kbd key={index}>{name}</kbd>);
const plus = <i key="+">+</i>;

const or = <i key="or">or</i>;
const modClick = [
  ...caps(MODIFIER),
  <i key="/">/</i>,
  ...caps("Shift"),
  <em key="c">+ click</em>,
];

const FIXED_KEYS: [string, ReactNode][] = [
  ["Play or pause", caps("Space")],
  ["Move around", caps("←", "→", "↑", "↓")],
  ["Seek 3 seconds", [...caps("Shift"), plus, ...caps("←", "→")]],
  ["Clear the word's timing", caps("Backspace")],
  ["Undo", [...caps(MODIFIER), plus, ...caps("Z")]],
  [
    "Redo",
    IS_MAC
      ? [...caps("Cmd"), plus, ...caps("Shift"), plus, ...caps("Z")]
      : [...caps("Ctrl"), plus, ...caps("Y")],
  ],
];

// Typing only goes into the edit bar's fields, so letter keys stay free for
// timing everywhere else.
const EDIT_TIPS: [string, ReactNode][] = [
  ["Select a word", <em>Click</em>],
  ["Replay from a word", <em>Double-click</em>],
  ["Split, replace, join or move a word", <em>Right-click</em>],
  ["Play only that word", <em>Right-click spectrogram</em>],
  [
    "Edit the selected word",
    [...caps("F2"), or, ...caps(MODIFIER), plus, ...caps("E")],
  ],
  ["Keep or undo the edit", [...caps("Enter"), or, ...caps("Esc")]],
  ["Add a line below", caps("Enter")],
  [
    "Delete the selected word",
    IS_MAC ? [...caps("Cmd"), plus, ...caps("Backspace")] : caps("Del"),
  ],
  ["Split a word into syllables", [<em key="t">type</em>, ...caps("|")]],
  ["Pick several words or lines", modClick],
  ["Move words or lines", <em>Drag</em>],
];

function Rows({ title, rows }: { title: string; rows: ReactNode }) {
  return (
    <section className="ttml-settings-group">
      <h4>{title}</h4>
      <div className="ttml-settings-rows">{rows}</div>
    </section>
  );
}

const comboRows = (rows: [string, ReactNode][]) =>
  rows.map(([label, combo]) => (
    <div key={label} className="ttml-settings-row">
      <span>{label}</span>
      <span className="ttml-settings-combo">
        {Array.isArray(combo)
          ? combo.map((part, index) => <Fragment key={index}>{part}</Fragment>)
          : combo}
      </span>
    </div>
  ));

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
  const changed = KEY_ACTIONS.some(
    ([action]) => keys[action] !== DEFAULT_KEYS[action],
  );
  return (
    <div className="ttml-dialog-backdrop" onClick={onClose}>
      <div
        className="ttml-dialog ttml-metadata ttml-settings"
        role="dialog"
        aria-label="Controls"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && !listening && onClose()}
      >
        <header>
          <span className="ttml-meta-icon">
            <Keyboard size={18} />
          </span>
          <div>
            <h3>Controls</h3>
            <p>Keyboard and mouse shortcuts</p>
          </div>
          <button
            className="ttml-meta-close"
            onClick={onClose}
            aria-label="Close controls"
          >
            <X size={16} />
          </button>
        </header>
        <div className="ttml-meta-body ttml-settings-body">
          {[["Timing", "Always"], ["Moving", "Speed"], ["Editing"]].map(
            (column) => (
              <div key={column[0]} className="ttml-settings-col">
                {column.map((title) =>
                  title === "Editing" ? (
                    <Rows
                      key={title}
                      title={title}
                      rows={comboRows(EDIT_TIPS)}
                    />
                  ) : title === "Always" ? (
                    <Rows
                      key={title}
                      title={title}
                      rows={comboRows(FIXED_KEYS)}
                    />
                  ) : (
                    <Rows
                      key={title}
                      title={title}
                      rows={GROUPS[title].map((action) => (
                        <div key={action} className="ttml-settings-row">
                          <span>{LABELS[action]}</span>
                          <button
                            className={`ttml-keycap${listening === action ? " listening" : ""}${keys[action] !== DEFAULT_KEYS[action] ? " custom" : ""}`}
                            aria-label={`${LABELS[action]} key`}
                            title="Click, then press a new key"
                            onClick={() =>
                              setListening(listening === action ? null : action)
                            }
                          >
                            {listening === action
                              ? "Press a key"
                              : keyLabel(keys[action])}
                          </button>
                        </div>
                      ))}
                    />
                  ),
                )}
              </div>
            ),
          )}
        </div>
        <footer className="ttml-meta-actions">
          <span className="ttml-settings-note">
            Click a key to change it. A key in use swaps over.
          </span>
          <span className="ttml-meta-spacer" />
          <button
            className="ttml-meta-quiet"
            disabled={!changed}
            onClick={() => onChange({ ...DEFAULT_KEYS })}
          >
            <RotateCcw size={14} />
            Reset keys
          </button>
        </footer>
      </div>
    </div>
  );
}
