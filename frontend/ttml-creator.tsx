import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  Download,
  Gauge,
  Pause,
  Play,
  Redo2,
  RotateCcw,
  Save,
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
  clampCursor,
  clearAll,
  clearTiming,
  fileName,
  formatTime,
  fromLyrics,
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
  timed,
  toLyrics,
  toText,
  toTtml,
  toggleLine,
} from "./ttml-creator-model";
import "./ttml-creator.css";

type Tab = "write" | "sync" | "preview";
interface Draft {
  lines: CreatorLine[];
  text: string;
}

const SPEEDS = [0.25, 0.5, 0.75, 0.9, 1, 1.25, 1.5];
const DRAFT_PREFIX = "lyssna.ttml-draft.";
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

  useEffect(() => {
    if (!track) return;
    writeStorage(
      DRAFT_PREFIX + track.uri,
      lines.length || text.trim() ? JSON.stringify({ lines, text }) : null,
    );
  }, [track, lines, text]);

  useEffect(() => () => void onSpeed(1), [onSpeed]);

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

  const applyText = () => {
    const parsed = keepTimings(lines, parseText(text));
    setLines(parsed);
    setCursor((at) => clampCursor(parsed, at));
    if (parsed.length) setTab("sync");
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

  const stateRef = useRef({ lines, cursor });
  stateRef.current = { lines, cursor };
  useEffect(() => {
    if (tab !== "sync") return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
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
      else if (event.key === "[")
        changeSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(rate) - 1)] ?? 1);
      else if (event.key === "]")
        changeSpeed(
          SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(rate) + 1)] ?? 1,
        );
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
  useEffect(() => {
    list.current
      ?.querySelector(`[data-line="${cursor.line}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [cursor.line, tab]);

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

      {tab === "write" && (
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
            onChange={(event) => setText(event.target.value)}
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
            <button
              className="primary"
              onClick={applyText}
              disabled={!text.trim()}
            >
              Continue to Sync
            </button>
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
              <select
                aria-label="Playback speed"
                value={rate}
                disabled={!native}
                onChange={(event) => changeSpeed(Number(event.target.value))}
              >
                {SPEEDS.map((speed) => (
                  <option key={speed} value={speed}>
                    {speed}×
                  </option>
                ))}
              </select>
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
          <div className="ttml-lines" ref={list}>
            {lines.map((line, lineIndex) => (
              <div
                key={lineIndex}
                data-line={lineIndex}
                className={`ttml-line${line.background ? " background" : ""}${line.opposite ? " opposite" : ""}${cursor.line === lineIndex ? " current" : ""}`}
              >
                <span className="ttml-line-time">
                  {lineSpan(line) ? formatTime(lineSpan(line)!.start) : "—"}
                </span>
                <div className="ttml-units">
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
                        title={
                          unit.start === undefined
                            ? "Not timed"
                            : `${formatTime(unit.start)} → ${unit.end === undefined ? "…" : formatTime(unit.end)}`
                        }
                        onClick={() =>
                          setCursor({ line: lineIndex, unit: unitIndex })
                        }
                        onDoubleClick={() =>
                          unit.start !== undefined && seek(unit.start - 1000)
                        }
                      >
                        {unit.text}
                      </button>
                    );
                  })}
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
    </section>
  );
}
