import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";
import { type KeyAction, type KeyMap, keyLabel } from "./ttml-keys";
import { IS_MAC, MODIFIER } from "./platform";

export const TOUR_KEY = "lyssna.ttml-tour-done";

interface Step {
  title: string;
  body: ReactNode;
  target?: string;
  // Steps with a try-it check move on by themselves once it passes.
  tryIt?: ReactNode;
  passes?: (event: Event) => boolean;
}

const K = ({ children }: { children: ReactNode }) => <kbd>{children}</kbd>;
const pressed = (event: Event, keys: string[]) =>
  event.type === "keydown" &&
  keys.includes((event as KeyboardEvent).key.toLowerCase());

function steps(keys: KeyMap): Step[] {
  const key = (action: KeyAction) => <K>{keyLabel(keys[action])}</K>;
  const bound = (...actions: KeyAction[]) =>
    actions.map((action) => keys[action]);
  return [
    {
      title: "Welcome to the TTML Creator",
      body: (
        <>
          A quick tour of timing and editing lyrics. Press Next, or try each key
          when asked and the tour moves on by itself.
        </>
      ),
    },
    {
      title: "Your lyrics",
      target: ".ttml-lines",
      body: (
        <>
          Each word gets a start and an end time. Click a word to select it,
          double-click to edit it, or to replay from it while the song plays,
          and drag to move it.
        </>
      ),
    },
    {
      title: "Play and pause",
      target: ".ttml-transport",
      body: (
        <>
          <K>Space</K> plays or pauses. <K>Shift</K> + <K>←</K> <K>→</K> seeks 3
          seconds. The counter shows how many words have timings.
        </>
      ),
      tryIt: (
        <>
          Press <K>Space</K>
        </>
      ),
      passes: (event) => pressed(event, [" "]),
    },
    {
      title: "Time the words",
      target: ".ttml-unit.selected",
      body: (
        <>
          While the song plays, press {key("start")} as the word starts.{" "}
          {key("next")} ends it and starts the next one. {key("end")} ends a
          word before a pause.
        </>
      ),
      tryIt: (
        <>
          Press {key("start")}, {key("next")} or {key("end")}
        </>
      ),
      passes: (event) => pressed(event, bound("start", "next", "end")),
    },
    {
      title: "Move around",
      target: ".ttml-lines",
      body: (
        <>
          {key("previous")} {key("following")} or <K>←</K> <K>→</K> step between
          words, {key("lineUp")} {key("lineDown")} or <K>↑</K> <K>↓</K> between
          lines. {key("jumpBack")} {key("jumpForward")} jump and seek there, and{" "}
          {key("replay")} replays the line.
        </>
      ),
      tryIt: <>Move to another word</>,
      passes: (event) =>
        pressed(event, [
          "arrowleft",
          "arrowright",
          "arrowup",
          "arrowdown",
          ...bound("previous", "following", "lineUp", "lineDown"),
        ]),
    },
    {
      title: "Fix mistakes",
      target: ".ttml-unit.selected",
      body: (
        <>
          <K>Backspace</K> clears the word's timing.{" "}
          {IS_MAC ? (
            <>
              <K>Cmd</K> + <K>Backspace</K>
            </>
          ) : (
            <K>Del</K>
          )}{" "}
          deletes the word. <K>{MODIFIER}</K> + <K>Z</K> undoes anything.
        </>
      ),
    },
    {
      title: "Edit a word",
      target: ".ttml-field-word",
      body: (
        <>
          {IS_MAC ? (
            <>
              <K>Cmd</K> + <K>E</K>
            </>
          ) : (
            <>
              <K>F2</K> or <K>Ctrl</K> + <K>E</K>
            </>
          )}{" "}
          jumps here. <K>Enter</K> keeps the change and <K>Esc</K> drops it.
          Type <K>|</K> to split syllables, like <code>beau|ti|ful</code>.
        </>
      ),
      tryIt: <>Open the word field</>,
      passes: (event) =>
        event.type === "focusin" &&
        (event.target as Element).matches?.('[aria-label="Selected word"]'),
    },
    {
      title: "Word options",
      target: ".ttml-unit.selected",
      body: (
        <>
          Right-click a word to split it, replace it everywhere, join it to the
          word before, or move it to a new line.
        </>
      ),
      tryIt: <>Right-click a word</>,
      passes: (event) =>
        event.type === "contextmenu" &&
        !!(event.target as Element).closest?.(".ttml-unit"),
    },
    {
      title: "Lines",
      target: ".ttml-line.current",
      body: (
        <>
          <K>Enter</K> adds a line below. Type into <em>Type word here</em> to
          add words. BG marks a background vocal, v2 the second singer, and{" "}
          <K>{MODIFIER}</K> or <K>Shift</K> + click picks several lines or
          words.
        </>
      ),
    },
    {
      title: "Waveform",
      target: ".ttml-bar-wave, .ttml-spectrogram",
      body: (
        <>
          Click or drag to seek. The current line is shaded. The arrow on the
          right opens the spectrogram, where right-clicking a word plays only
          that word.
        </>
      ),
    },
    {
      title: "Speed and volume",
      target: '[aria-label="Playback controls"]',
      body: (
        <>
          Slow the song down for fast parts. {key("slower")} and {key("faster")}{" "}
          change speed and {key("normalSpeed")} resets it.
        </>
      ),
    },
    {
      title: "Save and share",
      target: ".ttml-actions",
      body: (
        <>
          Drafts save by themselves. Use for this song puts your lyrics in
          Lyssna, the download button exports TTML and other formats, and the
          tag button edits song details.
        </>
      ),
    },
    {
      title: "Every control",
      target: 'button[title="Controls"]',
      body: (
        <>
          All shortcuts are listed here and every timing key can be changed. You
          can start this walkthrough again from there.
        </>
      ),
    },
  ];
}

const CARD = 340;

// The part of a target that can be seen: lines scroll inside their list as
// the song plays, so a word can sit far outside it.
function visible(target: Element | null) {
  if (!target) return null;
  let box = target.getBoundingClientRect();
  const frame = target.closest(".ttml-lines")?.getBoundingClientRect();
  const left = Math.max(box.left, frame?.left ?? 0, 0);
  const top = Math.max(box.top, frame?.top ?? 0, 0);
  const right = Math.min(box.right, frame?.right ?? innerWidth, innerWidth);
  const bottom = Math.min(
    box.bottom,
    frame?.bottom ?? innerHeight,
    innerHeight,
  );
  if (right - left < 4 || bottom - top < 4) return null;
  box = new DOMRect(left, top, right - left, bottom - top);
  return box;
}
// Tour buttons never take focus, so Space and Enter keep reaching the
// creator's shortcuts.
const keepFocus = (event: { preventDefault: () => void }) =>
  event.preventDefault();
const GAP = 12;

export function TtmlTour({
  keys,
  onClose,
}: {
  keys: KeyMap;
  onClose: () => void;
}) {
  const all = steps(keys);
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [height, setHeight] = useState(200);
  const card = useRef<HTMLDivElement>(null);
  const step = all[index];
  const last = index === all.length - 1;

  useEffect(() => {
    setDone(false);
    const find = () =>
      step.target ? document.querySelector(step.target) : null;
    const target = find();
    target?.scrollIntoView({
      block: target.closest(".ttml-lines") ? "center" : "nearest",
      behavior: "smooth",
    });
    let shown = "";
    const update = () => {
      const box = visible(find());
      const key = box
        ? `${box.left}:${box.top}:${box.width}:${box.height}`
        : "";
      if (key === shown) return;
      shown = key;
      setRect(box && box.width ? box : null);
    };
    update();
    // Targets move as lines centre and the song plays.
    const timer = setInterval(update, 200);
    window.addEventListener("resize", update);
    return () => {
      clearInterval(timer);
      window.removeEventListener("resize", update);
    };
  }, [index, step.target]);

  useLayoutEffect(() => {
    if (card.current) setHeight(card.current.offsetHeight);
  }, [index, rect]);

  // One listener for the whole tour: the creator re-renders between
  // listeners of the same key press, and a listener swapped out mid-event
  // would never hear it.
  const passes = useRef(step.passes);
  passes.current = done ? undefined : step.passes;
  useEffect(() => {
    const check = (event: Event) => {
      if (passes.current?.(event)) setDone(true);
    };
    const kinds = ["keydown", "focusin", "contextmenu"];
    kinds.forEach((kind) => window.addEventListener(kind, check, true));
    return () =>
      kinds.forEach((kind) => window.removeEventListener(kind, check, true));
  }, []);

  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(
      () => (last ? onClose() : setIndex((at) => at + 1)),
      900,
    );
    return () => clearTimeout(timer);
  }, [done, last, onClose]);

  const pad = 6;
  let style: { left: number; top: number };
  if (rect) {
    const below = rect.bottom + pad + GAP;
    const top =
      below + height < innerHeight - 16
        ? below
        : rect.top - pad - GAP - height >= 16
          ? rect.top - pad - GAP - height
          : innerHeight - height - 16;
    style = {
      left: Math.min(Math.max(16, rect.left), innerWidth - CARD - 16),
      top: Math.max(16, Math.min(top, innerHeight - height - 16)),
    };
  } else
    style = {
      left: (innerWidth - CARD) / 2,
      top: (innerHeight - height) / 2,
    };

  return createPortal(
    <div className="ttml-tour">
      {rect ? (
        <div
          className="ttml-tour-spot"
          style={{
            left: rect.left - pad,
            top: rect.top - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
          }}
        />
      ) : (
        <div className="ttml-tour-shade" />
      )}
      <div
        ref={card}
        className="ttml-tour-card"
        role="dialog"
        aria-label="Walkthrough"
        style={{ ...style, width: CARD }}
      >
        <header>
          <small>
            {index + 1} of {all.length}
          </small>
          <button
            className="ttml-tour-close"
            onMouseDown={keepFocus}
            onClick={onClose}
            aria-label="Close walkthrough"
          >
            <X size={15} />
          </button>
        </header>
        <h4>{step.title}</h4>
        <p>{step.body}</p>
        {step.tryIt && (
          <p className={`ttml-tour-try${done ? " done" : ""}`}>
            {done ? <Check size={14} /> : <span>Try it:</span>} {step.tryIt}
          </p>
        )}
        <footer>
          <div className="ttml-tour-dots" aria-hidden>
            {all.map((_, at) => (
              <i key={at} className={at === index ? "on" : ""} />
            ))}
          </div>
          {index > 0 && (
            <button onMouseDown={keepFocus} onClick={() => setIndex(index - 1)}>
              Back
            </button>
          )}
          <button
            className="primary"
            onMouseDown={keepFocus}
            onClick={() => (last ? onClose() : setIndex(index + 1))}
          >
            {last ? "Finish" : "Next"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
