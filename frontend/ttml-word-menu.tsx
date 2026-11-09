import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Info } from "lucide-react";
import { type LearnedSplits, learnFrom, suggestSplit } from "./ttml-syllables";

export interface MenuAction {
  label: string;
  run: () => void;
  disabled?: boolean;
  checked?: boolean;
}

export function WordMenu({
  x,
  y,
  groups,
  onClose,
}: {
  x: number;
  y: number;
  groups: MenuAction[][];
  onClose: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const box = element.current?.getBoundingClientRect();
    if (!box) return;
    setPlace({
      left: Math.max(8, Math.min(x, innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(y, innerHeight - box.height - 8)),
    });
  }, [x, y]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <>
      <div
        className="popover-dismiss"
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        ref={element}
        className="song-menu popover ttml-menu"
        role="menu"
        aria-label="Word actions"
        style={place}
      >
        {groups.map((group, index) => (
          <div key={index} className="ttml-menu-group">
            {group.map((action) => (
              <button
                key={action.label}
                role="menuitem"
                disabled={action.disabled}
                onClick={() => {
                  onClose();
                  action.run();
                }}
              >
                {action.label}
                {action.checked && <Check size={14} className="menu-chevron" />}
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

const OPTIONS_KEY = "lyssna.ttml-split-options";

function loadOptions() {
  try {
    return {
      applyAll: false,
      remember: true,
      ignoreCase: true,
      ...JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "{}"),
    };
  } catch {
    return { applyAll: false, remember: true, ignoreCase: true };
  }
}

export interface SplitChoice {
  offsets: number[];
  applyAll: boolean;
  ignoreCase: boolean;
  learned?: { key: string; offsets: number[] };
}

export interface ReplaceChoice {
  value: string;
  replaceAll: boolean;
  matchCase: boolean;
}

export function ReplaceDialog({
  word,
  onConfirm,
  onClose,
}: {
  word: string;
  onConfirm: (choice: ReplaceChoice) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(word);
  const [replaceAll, setReplaceAll] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => input.current?.select(), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const confirm = () => onConfirm({ value, replaceAll, matchCase });

  return (
    <div className="ttml-dialog-backdrop" onClick={onClose}>
      <form
        className="ttml-dialog"
        role="dialog"
        aria-label="Replace word"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          confirm();
        }}
      >
        <h3>Replace word</h3>
        <label className="ttml-field">
          New word:
          <input
            ref={input}
            value={value}
            spellCheck={false}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <label className="ttml-check">
          <input
            type="checkbox"
            checked={replaceAll}
            onChange={(event) => setReplaceAll(event.target.checked)}
          />
          Replace all identical words
        </label>
        <label className={`ttml-check${replaceAll ? "" : " off"}`}>
          <input
            type="checkbox"
            checked={matchCase}
            disabled={!replaceAll}
            onChange={(event) => setMatchCase(event.target.checked)}
          />
          Match case
        </label>
        <div className="ttml-dialog-row end">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Confirm
          </button>
        </div>
      </form>
    </div>
  );
}

export function SplitDialog({
  word,
  learned,
  onConfirm,
  onClose,
}: {
  word: string;
  learned: LearnedSplits;
  onConfirm: (choice: SplitChoice) => void;
  onClose: () => void;
}) {
  const chars = Array.from(word);
  const [suggestion] = useState(() => suggestSplit(word, learned));
  const [offsets, setOffsets] = useState<Set<number>>(
    () => new Set(suggestion),
  );
  const [options, setOptions] = useState(loadOptions);
  const suggested =
    offsets.size === suggestion.length &&
    suggestion.every((at) => offsets.has(at));
  const update = (patch: Partial<typeof options>) => {
    const next = { ...options, ...patch };
    setOptions(next);
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(next));
    } catch {
      // The choice still applies to this dialog.
    }
  };
  const toggle = (at: number) =>
    setOffsets((current) => {
      const next = new Set(current);
      if (!next.delete(at)) next.add(at);
      return next;
    });
  const confirm = () => {
    const list = [...offsets].sort((a, b) => a - b);
    onConfirm({
      offsets: list,
      applyAll: options.applyAll,
      ignoreCase: options.ignoreCase,
      learned: options.remember ? learnFrom(word, list) : undefined,
    });
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="ttml-dialog-backdrop" onClick={onClose}>
      <div
        className="ttml-dialog"
        role="dialog"
        aria-label="Split word"
        onClick={(event) => event.stopPropagation()}
      >
        <h3>Split word</h3>
        <p className="ttml-dialog-note">
          <Info size={16} />
          After splitting, the new syllables evenly divide the original word's
          start and end time.
        </p>
        <div className="ttml-splitter" aria-label="Split points">
          {chars.map((char, index) => (
            <span key={index} className="ttml-split-char">
              {index > 0 && (
                <button
                  className={`ttml-split-gap${offsets.has(index) ? " on" : ""}`}
                  aria-label={`Split before letter ${index + 1}`}
                  aria-pressed={offsets.has(index)}
                  onClick={() => toggle(index)}
                />
              )}
              {char}
            </span>
          ))}
        </div>
        <div className="ttml-dialog-row end">
          <button
            disabled={!suggestion.length || suggested}
            onClick={() => setOffsets(new Set(suggestion))}
            title={
              suggestion.length
                ? "Fill in the suggested syllable splits"
                : "No syllable split found for this word"
            }
          >
            Syllable split
          </button>
        </div>
        <label className="ttml-check">
          <input
            type="checkbox"
            checked={options.applyAll}
            onChange={(event) => update({ applyAll: event.target.checked })}
          />
          Apply this split to all identical words
        </label>
        <label className="ttml-check">
          <input
            type="checkbox"
            checked={options.remember}
            onChange={(event) => update({ remember: event.target.checked })}
          />
          Remember this split
        </label>
        <label className={`ttml-check${options.applyAll ? "" : " off"}`}>
          <input
            type="checkbox"
            checked={options.ignoreCase}
            disabled={!options.applyAll}
            onChange={(event) => update({ ignoreCase: event.target.checked })}
          />
          Ignore case
        </label>
        <div className="ttml-dialog-row end">
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!offsets.size}
            onClick={confirm}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
