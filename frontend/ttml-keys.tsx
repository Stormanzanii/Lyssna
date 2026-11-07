import { type ReactNode, useEffect, useState } from "react";
import { Keyboard, RotateCcw, X } from "lucide-react";

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

const GROUPS: [string, KeyAction[]][] = [
  ["Timing", ["start", "next", "end", "clear"]],
  [
    "Moving",
    [
      "previous",
      "following",
      "lineUp",
      "lineDown",
      "jumpBack",
      "jumpForward",
      "replay",
    ],
  ],
  ["Speed", ["slower", "faster", "normalSpeed"]],
];
const LABELS = Object.fromEntries(KEY_ACTIONS) as Record<KeyAction, string>;

const caps = (...names: string[]) =>
  names.map((name, index) => <kbd key={index}>{name}</kbd>);
const plus = <i key="+">+</i>;

const FIXED_KEYS: [string, ReactNode][] = [
  ["Play or pause", caps("Space")],
  ["Move around", caps("←", "→", "↑", "↓")],
  ["Seek 3 seconds", [...caps("Shift"), plus, ...caps("←", "→")]],
  ["Undo", [...caps("Ctrl"), plus, ...caps("Z")]],
  ["Redo", [...caps("Ctrl"), plus, ...caps("Y")]],
];

const LYRIC_TIPS: [string, ReactNode][] = [
  ["Select a word", <em>Click</em>],
  ["Edit a word", <em>Double-click</em>],
  ["Delete the selected word", caps("Del")],
  ["Move the selection", caps("←", "→")],
  ["Split a word into syllables", caps("|")],
  ["Join two words", <em>Click the gap</em>],
  [
    "Pick several lines",
    [
      ...caps("Ctrl"),
      <i key="/">/</i>,
      ...caps("Shift"),
      <em key="c">+ click</em>,
    ],
  ],
  ["Undo, redo", [...caps("Ctrl"), plus, ...caps("Z", "Y")]],
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
      <span className="ttml-settings-combo">{combo}</span>
    </div>
  ));

export function KeysDialog({
  mode,
  keys,
  onChange,
  onClose,
}: {
  mode: "sync" | "lyrics";
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
        className={`ttml-dialog ttml-metadata ttml-settings ${mode}`}
        role="dialog"
        aria-label={mode === "sync" ? "Sync settings" : "Lyrics settings"}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && !listening && onClose()}
      >
        <header>
          <span className="ttml-meta-icon">
            <Keyboard size={18} />
          </span>
          <div>
            <h3>{mode === "sync" ? "Sync settings" : "Lyrics settings"}</h3>
            <p>Keyboard and mouse shortcuts</p>
          </div>
          <button
            className="ttml-meta-close"
            onClick={onClose}
            aria-label="Close settings"
          >
            <X size={16} />
          </button>
        </header>
        <div className="ttml-meta-body ttml-settings-body">
          {mode === "sync" ? (
            <>
              {GROUPS.map(([title, actions]) => (
                <Rows
                  key={title}
                  title={title}
                  rows={actions.map((action) => (
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
              ))}
              <Rows title="Always" rows={comboRows(FIXED_KEYS)} />
            </>
          ) : (
            <Rows title="Lyrics tab" rows={comboRows(LYRIC_TIPS)} />
          )}
        </div>
        {mode === "sync" && (
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
        )}
      </div>
    </div>
  );
}
