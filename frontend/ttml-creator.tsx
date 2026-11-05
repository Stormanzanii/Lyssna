import {
  type MouseEvent as ReactMouseEvent,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Copy,
  Download,
  Gauge,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Trash2,
  Type,
  Undo2,
  Wand2,
} from "lucide-react";
import { LyricsDisplay, usePlaybackClock } from "./components";
import type { AppState } from "./state";
import type { PlayerRequest, Track } from "./types";
import {
  type CreatorLine,
  type Cursor,
  type SongMeta,
  breakLine,
  clampCursor,
  clearAll,
  clearTiming,
  duplicateLine,
  editUnit,
  fileName,
  formatTime,
  fromLyrics,
  insertLines,
  keepTimings,
  lineSpan,
  markEnd,
  markNext,
  markStart,
  nextCursor,
  parseText,
  previousCursor,
  problems,
  progress,
  removeLine,
  setLineText,
  splitMatching,
  splitUnit,
  timed,
  toLyrics,
  toText,
  toTtml,
  toggleJoin,
  toggleLine,
} from "./ttml-creator-model";
import { type LearnedSplits, cutAt, suggestSplit } from "./ttml-syllables";
import {
  type MenuAction,
  type SplitChoice,
  SplitDialog,
  WordMenu,
} from "./ttml-word-menu";
import "./ttml-creator.css";

type Tab = "write" | "sync" | "preview";
interface Draft {
  lines: CreatorLine[];
  text: string;
}

const MIN_SPEED = 0.25;
const MAX_SPEED = 1.5;
const clampSpeed = (value: number) =>
  Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(value * 20) / 20));
const DRAFT_PREFIX = "lyssna.ttml-draft.";
const SPLITS_KEY = "lyssna.ttml-splits";
const GLIDE_MS = 550;
const OFFSET_KEY = "lyssna.ttml-offset";
const HISTORY_LIMIT = 200;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private storage is a convenience; the draft still lives in memory.
  }
}
function loadDraft(uri: string): Draft | null {
  const raw = readStorage(DRAFT_PREFIX + uri);
  if (!raw) return null;
  try {
    const draft = JSON.parse(raw) as Draft;
    return Array.isArray(draft.lines) ? draft : null;
  } catch {
    return null;
  }
}

const meta = (track: Track): SongMeta => ({
  name: track.name,
  artists: track.artists.map((artist) => artist.name),
  album: track.album?.name,
  spotifyId: track.id,
  durationMs: track.duration_ms,
});

function TimePill({ ms, end }: { ms?: number; end?: boolean }) {
  return (
    <span
      className={`ttml-pill${end ? " end" : ""}${ms === undefined ? " empty" : ""}`}
    >
      {ms === undefined ? "--:--.---" : formatTime(ms)}
    </span>
  );
}

export function TtmlCreator({
  state,
  onPlayer,
  onToggle,
  onSpeed,
  onApply,
  notify,
}: {
  state: AppState;
  onPlayer: (request: PlayerRequest) => void;
  onToggle: () => void;
  onSpeed: (rate: number) => Promise<void>;
  onApply: (filename: string, ttml: string) => Promise<boolean>;
  notify: (message: string, error?: boolean) => void;
}) {
  const playing = state.playback.item;
  const [track, setTrack] = useState<Track | undefined>(playing);
  useEffect(() => {
    if (!track && playing) setTrack(playing);
  }, [track, playing]);

  const [tab, setTab] = useState<Tab>("write");
  const [lines, setLinesRaw] = useState<CreatorLine[]>([]);
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState<Cursor>({ line: 0, unit: 0 });
  const history = useRef<{ past: CreatorLine[][]; future: CreatorLine[][] }>({
    past: [],
    future: [],
  });
  const [offset, setOffset] = useState(
    () => Number(readStorage(OFFSET_KEY)) || 0,
  );
  const { position, read } = usePlaybackClock(state);
  const native = state.playback.device.name === state.local_device_name;
  const here = !!track && playing?.uri === track.uri;
  const rate = state.playback_rate ?? 1;

  useEffect(() => {
    if (!track) return;
    const draft = loadDraft(track.uri);
    setLinesRaw(draft?.lines ?? []);
    setText(draft?.text ?? "");
    setCursor({ line: 0, unit: 0 });
    history.current = { past: [], future: [] };
    setTab(draft?.lines.length ? "sync" : "write");
  }, [track]);

  const editedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    const lyrics = state.lyrics;
    if (
      !track ||
      !here ||
      editedFor.current === track.uri ||
      state.lyrics_uri !== track.uri ||
      !lyrics?.lines.length ||
      lyrics.instrumental
    )
      return;
    if (lines.length || text.trim() || loadDraft(track.uri)) return;
    const seeded = fromLyrics(lyrics);
    if (!seeded.length) return;
    setLinesRaw(seeded);
    setText(toText(seeded));
  }, [track, here, state.lyrics, state.lyrics_uri, lines.length, text]);

  useEffect(() => {
    if (!track) return;
    writeStorage(
      DRAFT_PREFIX + track.uri,
      lines.length || text.trim() ? JSON.stringify({ lines, text }) : null,
    );
  }, [track, lines, text]);

  useEffect(() => () => void onSpeed(1), [onSpeed]);

  const repeatRef = useRef(state.playback.repeat_state);
  repeatRef.current = state.playback.repeat_state;
  const playerRef = useRef(onPlayer);
  playerRef.current = onPlayer;
  useEffect(() => {
    if (!here) return;
    const before = repeatRef.current ?? "off";
    if (before === "track") return;
    playerRef.current({ command: "repeat", repeat: "track" });
    return () => playerRef.current({ command: "repeat", repeat: before });
  }, [here]);

  const lastPosition = useRef(0);
  useEffect(() => {
    const duration = track?.duration_ms ?? 0;
    const wrapped =
      here &&
      state.playback.is_playing &&
      duration > 5000 &&
      lastPosition.current > duration - 2500 &&
      position < 2000;
    lastPosition.current = position;
    if (!wrapped) return;
    onPlayer({ command: "pause" });
    onPlayer({ command: "seek", positionMs: 0 });
  }, [position, here, state.playback.is_playing, track, onPlayer]);

  const setLines = useCallback(
    (next: CreatorLine[] | ((previous: CreatorLine[]) => CreatorLine[])) =>
      setLinesRaw((previous) => {
        const value = typeof next === "function" ? next(previous) : next;
        if (value !== previous) {
          history.current.past = [
            ...history.current.past.slice(-HISTORY_LIMIT),
            previous,
          ];
          history.current.future = [];
        }
        return value;
      }),
    [],
  );
  const undo = useCallback(() => {
    const previous = history.current.past.pop();
    if (!previous) return;
    setLinesRaw((current) => {
      history.current.future.push(current);
      return previous;
    });
  }, []);
  const redo = useCallback(() => {
    const next = history.current.future.pop();
    if (!next) return;
    setLinesRaw((current) => {
      history.current.past.push(current);
      return next;
    });
  }, []);

  const [textMode, setTextMode] = useState(false);
  const [editing, setEditing] = useState<Cursor | null>(null);
  const [adding, setAdding] = useState<{ card: number; after: number } | null>(
    null,
  );
  const applyText = (sync: boolean) => {
    const parsed = keepTimings(lines, parseText(text));
    setLines(parsed);
    setCursor((at) => clampCursor(parsed, at));
    setTextMode(false);
    if (sync && parsed.length) setTab("sync");
  };
  const openText = () => {
    setText(toText(lines));
    setTextMode(true);
  };
  const commitWord = (at: Cursor, value: string) => {
    setEditing(null);
    const next = editUnit(lines, at, value);
    if (next === lines) return;
    setLines(next);
    setCursor((cursor) => clampCursor(next, cursor));
  };

  const [learned, setLearned] = useState<LearnedSplits>(() => {
    try {
      return JSON.parse(readStorage(SPLITS_KEY) ?? "{}") as LearnedSplits;
    } catch {
      return {};
    }
  });
  const [menu, setMenu] = useState<{ x: number; y: number; at: Cursor } | null>(
    null,
  );
  const [splitting, setSplitting] = useState<Cursor | null>(null);
  const openMenu = (event: ReactMouseEvent, at: Cursor) => {
    event.preventDefault();
    setCursor(at);
    setMenu({ x: event.clientX, y: event.clientY, at });
  };
  const restructure = (next: CreatorLine[]) => {
    if (next === lines) return;
    setLines(next);
    setCursor((cursor) => clampCursor(next, cursor));
  };
  const toCards = () => {
    setTab("write");
    setTextMode(false);
  };
  const menuGroups = (at: Cursor): MenuAction[][] => {
    const line = lines[at.line];
    const unit = line?.units[at.unit];
    if (!line || !unit) return [];
    const suggestion = suggestSplit(unit.text, learned);
    return [
      [
        { label: "Split word…", run: () => setSplitting(at) },
        {
          label: "Auto-segment word",
          disabled: !suggestion.length,
          run: () =>
            restructure(splitUnit(lines, at, cutAt(unit.text, suggestion))),
        },
        {
          label: "Replace word…",
          run: () => {
            toCards();
            setEditing(at);
          },
        },
        { label: "Delete word", run: () => commitWord(at, "") },
      ],
      [
        {
          label: "Move following words to new line",
          disabled: at.unit === 0,
          run: () => restructure(breakLine(lines, at, false)),
        },
        {
          label: "Move this word to new line",
          disabled: line.units.length < 2,
          run: () => restructure(breakLine(lines, at, true)),
        },
      ],
      [
        {
          label: "Background line",
          checked: line.background,
          run: () => setLines(toggleLine(lines, at.line, "background")),
        },
        {
          label: "Duet line",
          checked: line.opposite,
          run: () => setLines(toggleLine(lines, at.line, "opposite")),
        },
      ],
      [
        {
          label: "Insert new line before",
          run: () => {
            toCards();
            setAdding({ card: at.line, after: at.line - 1 });
          },
        },
        {
          label: "Insert new line after",
          run: () => {
            toCards();
            setAdding({ card: at.line, after: at.line });
          },
        },
        {
          label: "Duplicate line",
          run: () => restructure(duplicateLine(lines, at.line)),
        },
        {
          label: "Delete line",
          run: () => restructure(removeLine(lines, at.line)),
        },
      ],
    ];
  };
  const confirmSplit = (at: Cursor, choice: SplitChoice) => {
    const unit = lines[at.line]?.units[at.unit];
    setSplitting(null);
    if (!unit) return;
    if (choice.learned) {
      const next = { ...learned, [choice.learned.key]: choice.learned.offsets };
      setLearned(next);
      writeStorage(SPLITS_KEY, JSON.stringify(next));
    }
    restructure(
      choice.applyAll
        ? splitMatching(
            lines,
            unit.text,
            (text) =>
              cutAt(
                text,
                text === unit.text
                  ? choice.offsets
                  : choice.offsets.filter((at) => at < Array.from(text).length),
              ),
            choice.ignoreCase,
          )
        : splitUnit(lines, at, cutAt(unit.text, choice.offsets)),
    );
  };
  const startFromLyrics = () => {
    if (!state.lyrics || !here) return;
    const seeded = fromLyrics(state.lyrics);
    setLines(seeded);
    setText(toText(seeded));
    setCursor({ line: 0, unit: 0 });
  };

  const tap = useCallback(() => Math.round(read() + offset), [read, offset]);
  const seek = useCallback(
    (ms: number) =>
      onPlayer({ command: "seek", positionMs: Math.max(0, Math.round(ms)) }),
    [onPlayer],
  );
  const changeSpeed = useCallback(
    (next: number) => {
      void onSpeed(next).catch((error) => notify(String(error), true));
    },
    [onSpeed, notify],
  );
  const [speedDraft, setSpeedDraft] = useState<number | null>(null);
  const speedTimer = useRef(0);
  const slideSpeed = (value: number) => {
    setSpeedDraft(value);
    clearTimeout(speedTimer.current);
    speedTimer.current = window.setTimeout(() => {
      changeSpeed(value);
      speedTimer.current = window.setTimeout(() => setSpeedDraft(null), 1000);
    }, 120);
  };
  useEffect(() => () => clearTimeout(speedTimer.current), []);
  const shownSpeed = speedDraft ?? rate;

  const stateRef = useRef({ lines, cursor });
  stateRef.current = { lines, cursor };
  useEffect(() => {
    if (tab !== "sync") return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (document.querySelector(".ttml-menu, .ttml-dialog")) return;
      if (
        target?.closest("input, textarea, select, [contenteditable=true]") ||
        event.altKey ||
        event.metaKey
      )
        return;
      const { lines, cursor } = stateRef.current;
      const ctrl = event.ctrlKey;
      const key = event.key.toLowerCase();
      let handled = true;
      if (ctrl && key === "z") (event.shiftKey ? redo : undo)();
      else if (ctrl && key === "y") redo();
      else if (ctrl) handled = false;
      else if (event.key === "ArrowLeft" && event.shiftKey) seek(read() - 3000);
      else if (event.key === "ArrowRight" && event.shiftKey)
        seek(read() + 3000);
      else if (event.key === "ArrowLeft")
        setCursor(previousCursor(lines, cursor) ?? cursor);
      else if (event.key === "ArrowRight")
        setCursor(nextCursor(lines, cursor) ?? cursor);
      else if (event.key === "ArrowUp")
        setCursor(clampCursor(lines, { line: cursor.line - 1, unit: 0 }));
      else if (event.key === "ArrowDown")
        setCursor(clampCursor(lines, { line: cursor.line + 1, unit: 0 }));
      else if (!here || !lines.length) handled = false;
      else if (event.repeat && "fgh".includes(key)) handled = true;
      else if (key === "f") setLines(markStart(lines, cursor, tap()));
      else if (key === "g") {
        const result = markNext(lines, cursor, tap());
        setLines(result.lines);
        setCursor(result.cursor);
      } else if (key === "h") {
        const result = markEnd(lines, cursor, tap());
        setLines(result.lines);
        setCursor(result.cursor);
      } else if (key === "r") {
        const line = lines[cursor.line];
        const before = lines[cursor.line - 1];
        const from =
          (line && lineSpan(line)?.start) ??
          (before && lineSpan(before)?.end) ??
          read();
        seek(from - 2000);
      } else if (event.key === "Backspace" || event.key === "Delete")
        setLines(clearTiming(lines, cursor));
      else if (event.key === "[") changeSpeed(clampSpeed(rate - 0.05));
      else if (event.key === "]") changeSpeed(clampSpeed(rate + 0.05));
      else handled = false;
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [tab, here, tap, read, seek, undo, redo, setLines, changeSpeed, rate]);

  const list = useRef<HTMLDivElement>(null);
  const glide = useRef(0);
  const reduceMotion = !!state.settings.reduce_motion;
  const centre = useCallback(
    (index: number) => {
      const container = list.current;
      const line = container?.querySelector<HTMLElement>(
        `[data-line="${index}"]`,
      );
      if (!container || !line) return;
      cancelAnimationFrame(glide.current);
      const box = container.getBoundingClientRect();
      const row = line.getBoundingClientRect();
      const from = container.scrollTop;
      const to = Math.max(
        0,
        Math.min(
          container.scrollHeight - container.clientHeight,
          from + row.top - box.top - (box.height - row.height) / 2,
        ),
      );
      if (reduceMotion || Math.abs(to - from) < 1) {
        container.scrollTop = to;
        return;
      }
      const start = performance.now();
      const step = (time: number) => {
        const t = Math.min(1, (time - start) / GLIDE_MS);
        const eased = 1 - Math.pow(1 - t, 3);
        container.scrollTop = from + (to - from) * eased;
        if (t < 1) glide.current = requestAnimationFrame(step);
      };
      glide.current = requestAnimationFrame(step);
    },
    [reduceMotion],
  );
  useEffect(() => () => cancelAnimationFrame(glide.current), []);
  useEffect(() => {
    if (tab === "sync") centre(cursor.line);
  }, [cursor.line, tab, centre]);

  const playingLine = useMemo(() => {
    let found = -1;
    lines.forEach((line, index) => {
      const span = lineSpan(line);
      if (span && span.start <= position) found = index;
    });
    return found;
  }, [lines, position]);
  const scrolledAt = useRef(0);
  useEffect(() => {
    if (
      tab !== "sync" ||
      playingLine < 0 ||
      !state.playback.is_playing ||
      Date.now() - scrolledAt.current < 3000
    )
      return;
    centre(playingLine);
  }, [playingLine, tab, state.playback.is_playing, centre]);

  const preview = useMemo(() => toLyrics(lines), [lines]);
  const issues = useMemo(() => problems(lines), [lines]);
  const { done, total } = progress(lines);
  const ttml = () => (track ? toTtml(lines, meta(track)) : "");

  const download = () => {
    if (!track) return;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([ttml()], { type: "application/ttml+xml" }),
    );
    link.download = fileName(meta(track));
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  };
  const copy = () =>
    void navigator.clipboard.writeText(ttml()).then(
      () => notify("TTML copied."),
      () => notify("Couldn't copy the TTML.", true),
    );
  const apply = () => {
    if (!track || !here) return;
    void onApply(fileName(meta(track)), ttml());
  };

  if (!track)
    return (
      <section className="ttml-creator empty" aria-label="TTML Creator">
        <Wand2 size={32} />
        <h2>TTML Creator</h2>
        <p>Play a song, then come back here to time its lyrics.</p>
      </section>
    );

  return (
    <section className="ttml-creator" aria-label="TTML Creator">
      <header className="ttml-head">
        <div className="ttml-song">
          <small>TTML Creator</small>
          <strong title={track.name}>{track.name}</strong>
          <span>{track.artists.map((artist) => artist.name).join(", ")}</span>
        </div>
        <div className="ttml-tabs" role="tablist">
          {(
            [
              ["write", "Lyrics"],
              ["sync", "Sync"],
              ["preview", "Preview"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={tab === value}
              className={tab === value ? "active" : ""}
              disabled={value !== "write" && !lines.length}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="ttml-actions">
          <button onClick={copy} disabled={!done} title="Copy TTML">
            <Copy size={15} />
          </button>
          <button onClick={download} disabled={!done} title="Save TTML file">
            <Download size={15} />
          </button>
          <button
            className="primary"
            onClick={apply}
            disabled={!done || !here}
            title={
              here
                ? "Save these lyrics for this song in Lyssna"
                : "Play this song to use the lyrics for it"
            }
          >
            <Save size={15} />
            Use for this song
          </button>
        </div>
      </header>

      {!here && (
        <div className="ttml-banner" role="status">
          <span>
            This draft is for <strong>{track.name}</strong>
            {playing ? (
              <>
                , but <strong>{playing.name}</strong> is playing.
              </>
            ) : (
              "."
            )}{" "}
            Timing needs the draft's song playing.
          </span>
          <button onClick={() => onPlayer({ command: "play", uri: track.uri })}>
            Play {track.name}
          </button>
          {playing && (
            <button onClick={() => setTrack(playing)}>
              Work on {playing.name}
            </button>
          )}
        </div>
      )}

      {tab === "write" && !textMode && lines.length > 0 && (
        <div className="ttml-write">
          <div className="ttml-write-actions">
            <p className="ttml-hint">
              Double-click a word to edit it. Type <kbd>|</kbd> to split it into
              syllables. Click <kbd>Space</kbd> to join two words.
            </p>
            <div className="ttml-row">
              <button
                onClick={startFromLyrics}
                disabled={!here || !state.lyrics?.lines.length}
                title="Use the lyrics Lyssna found for this song as a start"
              >
                <Wand2 size={15} />
                Start from current lyrics
              </button>
              <button onClick={openText}>
                <Type size={15} />
                Edit as text
              </button>
              <button className="primary" onClick={() => setTab("sync")}>
                Continue to Sync
              </button>
            </div>
          </div>
          <div className="ttml-lines">
            {lines.map((line, lineIndex) => (
              <div
                key={lineIndex}
                className={`ttml-card${line.background ? " background" : ""}${line.opposite ? " opposite" : ""}`}
              >
                <span className="ttml-card-number">{lineIndex + 1}</span>
                <div className="ttml-card-body">
                  <div className="ttml-chips">
                    {line.units.map((unit, unitIndex) => {
                      const at = { line: lineIndex, unit: unitIndex };
                      const isEditing =
                        editing?.line === lineIndex &&
                        editing.unit === unitIndex;
                      return (
                        <Fragment key={unitIndex}>
                          {unitIndex > 0 && !unit.joined && (
                            <button
                              className="ttml-space"
                              title="Join these words"
                              onClick={() => setLines(toggleJoin(lines, at))}
                            >
                              Space
                            </button>
                          )}
                          {isEditing ? (
                            <input
                              className="ttml-chip-edit"
                              aria-label="Edit word"
                              autoFocus
                              defaultValue={unit.text}
                              size={Math.max(2, unit.text.length + 1)}
                              onBlur={(event) =>
                                commitWord(at, event.target.value)
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter")
                                  event.currentTarget.blur();
                                if (event.key === "Escape") setEditing(null);
                              }}
                            />
                          ) : (
                            <button
                              className={`ttml-chip${unit.joined ? " joined" : ""}`}
                              title={
                                unit.joined
                                  ? "Syllable. Click to split it into its own word; double-click to edit."
                                  : "Double-click to edit"
                              }
                              onClick={() =>
                                unit.joined && setLines(toggleJoin(lines, at))
                              }
                              onDoubleClick={() => setEditing(at)}
                              onContextMenu={(event) => openMenu(event, at)}
                            >
                              {unit.text}
                            </button>
                          )}
                        </Fragment>
                      );
                    })}
                  </div>
                  {(["translation", "romanization"] as const).map((key) => (
                    <label key={key} className="ttml-card-extra">
                      {key === "translation" ? "Translation:" : "Romanization:"}
                      <input
                        key={line[key] ?? ""}
                        defaultValue={line[key] ?? ""}
                        placeholder="None"
                        spellCheck={false}
                        onBlur={(event) =>
                          event.target.value !== (line[key] ?? "") &&
                          setLines(
                            setLineText(
                              lines,
                              lineIndex,
                              key,
                              event.target.value.trim(),
                            ),
                          )
                        }
                        onKeyDown={(event) =>
                          event.key === "Enter" && event.currentTarget.blur()
                        }
                      />
                    </label>
                  ))}
                  {adding?.card === lineIndex && (
                    <input
                      className="ttml-card-add"
                      aria-label="New line"
                      placeholder="New line, then Enter"
                      autoFocus
                      onBlur={() => setAdding(null)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setAdding(null);
                        if (event.key !== "Enter") return;
                        const value = event.currentTarget.value;
                        const after = adding.after;
                        setAdding(null);
                        if (value.trim())
                          setLines(insertLines(lines, after, value));
                      }}
                    />
                  )}
                </div>
                <div className="ttml-line-tools">
                  <button
                    className={line.background ? "active" : ""}
                    aria-pressed={line.background}
                    title="Background vocal"
                    onClick={() =>
                      setLines(toggleLine(lines, lineIndex, "background"))
                    }
                  >
                    BG
                  </button>
                  <button
                    className={line.opposite ? "active" : ""}
                    aria-pressed={line.opposite}
                    title="Second singer"
                    onClick={() =>
                      setLines(toggleLine(lines, lineIndex, "opposite"))
                    }
                  >
                    v2
                  </button>
                  <button
                    title="Delete line"
                    aria-label="Delete line"
                    onClick={() => {
                      const next = removeLine(lines, lineIndex);
                      setLines(next);
                      setCursor((at) => clampCursor(next, at));
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                  <button
                    title="Add line below"
                    aria-label="Add line below"
                    onClick={() =>
                      setAdding({ card: lineIndex, after: lineIndex })
                    }
                  >
                    <Plus size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "write" && (textMode || !lines.length) && (
        <div className="ttml-write">
          <p className="ttml-hint">
            One lyric line per line. Split a word into syllables with{" "}
            <kbd>|</kbd>, like <code>beau|ti|ful</code>. Wrap a background vocal
            in parentheses. Start a line with <code>v2:</code> for the second
            singer.
          </p>
          <textarea
            aria-label="Lyrics text"
            value={text}
            spellCheck={false}
            placeholder={
              "First line of the song\n(background vocal)\nv2: a line the other singer takes"
            }
            onChange={(event) => {
              editedFor.current = track?.uri;
              setText(event.target.value);
            }}
          />
          <div className="ttml-write-actions">
            <button
              onClick={startFromLyrics}
              disabled={!here || !state.lyrics?.lines.length}
              title="Use the lyrics Lyssna found for this song as a start"
            >
              <Wand2 size={15} />
              Start from current lyrics
            </button>
            <div className="ttml-row">
              {lines.length > 0 && (
                <button onClick={() => applyText(false)}>Done</button>
              )}
              <button
                className="primary"
                onClick={() => applyText(true)}
                disabled={!text.trim()}
              >
                Continue to Sync
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === "sync" && (
        <>
          <div className="ttml-transport">
            <button
              className="ttml-play"
              onClick={onToggle}
              aria-label={state.playback.is_playing ? "Pause" : "Play"}
            >
              {state.playback.is_playing ? (
                <Pause size={16} fill="currentColor" />
              ) : (
                <Play size={16} fill="currentColor" />
              )}
            </button>
            <span className="ttml-time">{formatTime(position)}</span>
            <label
              className="ttml-speed"
              title={
                native
                  ? "Playback speed. Pitch stays the same."
                  : "Speed works when playing on this computer."
              }
            >
              <Gauge size={15} />
              <input
                type="range"
                aria-label="Playback speed"
                min={MIN_SPEED}
                max={MAX_SPEED}
                step={0.05}
                value={shownSpeed}
                disabled={!native}
                style={{
                  ["--fill" as string]: `${((shownSpeed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED)) * 100}%`,
                }}
                onChange={(event) =>
                  slideSpeed(clampSpeed(Number(event.target.value)))
                }
              />
              <output
                className="ttml-speed-value"
                title="Double-click for normal speed"
                onDoubleClick={() => native && slideSpeed(1)}
              >
                {shownSpeed.toFixed(2)}×
              </output>
            </label>
            <label
              className="ttml-offset"
              title="Shift every tap by this much. Negative taps earlier."
            >
              Offset
              <input
                type="number"
                step={10}
                value={offset}
                aria-label="Tap offset in milliseconds"
                onChange={(event) => {
                  const value = Math.max(
                    -2000,
                    Math.min(2000, Number(event.target.value) || 0),
                  );
                  setOffset(value);
                  writeStorage(OFFSET_KEY, String(value));
                }}
              />
              ms
            </label>
            <span className="ttml-progress">
              {done}/{total} timed
            </span>
            <button onClick={undo} title="Undo (Ctrl+Z)" aria-label="Undo">
              <Undo2 size={15} />
            </button>
            <button onClick={redo} title="Redo (Ctrl+Y)" aria-label="Redo">
              <Redo2 size={15} />
            </button>
            <button
              onClick={() => setLines(clearAll(lines))}
              disabled={!done}
              title="Clear every timing"
              aria-label="Clear every timing"
            >
              <RotateCcw size={15} />
            </button>
          </div>
          <p className="ttml-keys">
            <kbd>F</kbd> start word · <kbd>G</kbd> end and start next ·{" "}
            <kbd>H</kbd> end word · <kbd>←</kbd>
            <kbd>→</kbd> move · <kbd>Shift</kbd>+<kbd>←</kbd>
            <kbd>→</kbd> seek 3s · <kbd>R</kbd> replay line · <kbd>Space</kbd>{" "}
            play · <kbd>[</kbd>
            <kbd>]</kbd> speed · <kbd>Del</kbd> clear word
          </p>
          <div
            className="ttml-lines"
            ref={list}
            onWheel={() => {
              scrolledAt.current = Date.now();
              cancelAnimationFrame(glide.current);
            }}
            onTouchMove={() => {
              scrolledAt.current = Date.now();
              cancelAnimationFrame(glide.current);
            }}
          >
            {lines.map((line, lineIndex) => (
              <div
                key={lineIndex}
                data-line={lineIndex}
                className={`ttml-card ttml-line${line.background ? " background" : ""}${line.opposite ? " opposite" : ""}${cursor.line === lineIndex ? " current" : ""}${playingLine === lineIndex ? " playing" : ""}`}
              >
                <span className="ttml-card-number">{lineIndex + 1}</span>
                <div className="ttml-cells">
                  {line.units.map((unit, unitIndex) => {
                    const selected =
                      cursor.line === lineIndex && cursor.unit === unitIndex;
                    const live =
                      unit.start !== undefined &&
                      position >= unit.start &&
                      position < (unit.end ?? unit.start);
                    return (
                      <button
                        key={unitIndex}
                        className={`ttml-unit${unit.joined ? " joined" : ""}${timed(unit) ? " timed" : unit.start !== undefined ? " started" : ""}${selected ? " selected" : ""}${live ? " live" : ""}`}
                        onClick={() =>
                          setCursor({ line: lineIndex, unit: unitIndex })
                        }
                        onDoubleClick={() =>
                          unit.start !== undefined && seek(unit.start - 1000)
                        }
                        onContextMenu={(event) =>
                          openMenu(event, { line: lineIndex, unit: unitIndex })
                        }
                      >
                        <TimePill ms={unit.start} />
                        <span className="ttml-word">{unit.text}</span>
                        <TimePill ms={unit.end} end />
                      </button>
                    );
                  })}
                </div>
                <div className="ttml-line-side">
                  <TimePill ms={lineSpan(line)?.start} />
                  <TimePill
                    ms={
                      line.units.some((unit) => unit.end !== undefined)
                        ? lineSpan(line)?.end
                        : undefined
                    }
                    end
                  />
                </div>
                <div className="ttml-line-tools">
                  <button
                    className={line.background ? "active" : ""}
                    aria-pressed={line.background}
                    title="Background vocal"
                    onClick={() =>
                      setLines(toggleLine(lines, lineIndex, "background"))
                    }
                  >
                    BG
                  </button>
                  <button
                    className={line.opposite ? "active" : ""}
                    aria-pressed={line.opposite}
                    title="Second singer"
                    onClick={() =>
                      setLines(toggleLine(lines, lineIndex, "opposite"))
                    }
                  >
                    v2
                  </button>
                </div>
              </div>
            ))}
          </div>
          {issues.length > 0 && (
            <p className="ttml-issues">{issues.join(" ")}</p>
          )}
        </>
      )}

      {tab === "preview" && (
        <div className="ttml-preview">
          {preview.lines.length ? (
            <LyricsDisplay
              lyrics={preview}
              positionMs={position}
              settings={state.settings}
              onSeek={seek}
            />
          ) : (
            <p className="ttml-hint">Time some words to see them here.</p>
          )}
        </div>
      )}
      {menu && (
        <WordMenu
          x={menu.x}
          y={menu.y}
          groups={menuGroups(menu.at)}
          onClose={() => setMenu(null)}
        />
      )}
      {splitting && lines[splitting.line]?.units[splitting.unit] && (
        <SplitDialog
          word={lines[splitting.line].units[splitting.unit].text}
          learned={learned}
          onClose={() => setSplitting(null)}
          onConfirm={(choice) => confirmSplit(splitting, choice)}
        />
      )}
    </section>
  );
}
