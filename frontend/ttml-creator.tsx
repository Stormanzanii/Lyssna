import {
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronDown,
  Copy,
  Download,
  History,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Settings,
  Tags,
  Trash2,
  Type,
  Upload,
  Languages,
  Undo2,
  Wand2,
  X,
} from "lucide-react";
import { Cover, LyricsDisplay, usePlaybackClock } from "./components";
import type { AppState } from "./state";
import type { Lyrics, PlayerRequest, Track } from "./types";
import {
  type CreatorLine,
  type Cursor,
  type MetaEntry,
  type SongMeta,
  AUTHOR_KEYS,
  defaultMetadata,
  withSongwriters,
  breakLine,
  clampCursor,
  clearAll,
  clearTiming,
  duplicateLine,
  editUnit,
  appendWords,
  fileName,
  formatTime,
  fromLyrics,
  insertBlankLine,
  keepTimings,
  lineSpan,
  singingAt,
  markEnd,
  markNext,
  markStart,
  moveLine,
  moveSpace,
  moveWord,
  moveWords,
  deletePicked,
  applyRomanized,
  nextCursor,
  romanizeRequest,
  setUnitRoman,
  hasWordRoman,
  parseText,
  previousCursor,
  problems,
  progress,
  removeLine,
  setLineText,
  splitMatching,
  replaceMatching,
  splitUnit,
  timed,
  toLyrics,
  toText,
  toTtml,
  toggleJoin,
  toggleLine,
  wordBounds,
  setLineFlag,
  shiftLines,
  clearLines,
  removeLines,
} from "./ttml-creator-model";
import { romanizeAway } from "./romanization";
import { MetadataDialog } from "./ttml-metadata";
import { TtmlBar } from "./ttml-bar";
import { TtmlSpectrogram } from "./ttml-spectrogram";
import { createPortal } from "react-dom";
import { rpc } from "./bridge";
import {
  type ExportFormat,
  type WordFormat,
  EXPORT_FORMATS,
  WORD_FORMATS,
  exportLyrics,
  formatOf,
  parseWordFormat,
} from "./ttml-formats";

const FORMAT_NAMES: Record<ExportFormat | "ttml", string> = {
  ttml: "TTML",
  lrc: "LRC (lines only)",
  qrc: "QRC",
  yrc: "YRC",
  lys: "Lyricify Syllable",
  eslrc: "ESLyric",
};
import {
  type KeyAction,
  type KeyMap,
  KeysDialog,
  actionFor,
  loadKeys,
  saveKeys,
} from "./ttml-keys";
import {
  type DraftVersion,
  type SavedSong,
  addVersion,
  deleteSaves,
  listDrafts,
  listVersions,
  loadDraft,
  newVersionDue,
  savedLabel,
  writeDraft,
} from "./ttml-saves";
import { type LearnedSplits, cutAt, suggestSplit } from "./ttml-syllables";
import {
  type MenuAction,
  type SplitChoice,
  SplitDialog,
  ReplaceDialog,
  type ReplaceChoice,
  WordMenu,
} from "./ttml-word-menu";
import "./ttml-creator.css";

type Tab = "write" | "sync" | "preview";

const MIN_SPEED = 0.25;
const MAX_SPEED = 1.5;
const clampSpeed = (value: number) =>
  Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(value * 20) / 20));
const SPLITS_KEY = "lyssna.ttml-splits";
const WORD_ROMAN_KEY = "lyssna.ttml-word-roman";
const SPECTROGRAM_KEY = "lyssna.ttml-spectrogram";
const SYNC_ROMAN_KEY = "lyssna.ttml-sync-roman";
const GLIDE_MS = 550;
const OFFSET_KEY = "lyssna.ttml-offset";
const HISTORY_LIMIT = 200;

type Drag =
  | { kind: "line"; line: number }
  | { kind: "word" | "space"; at: Cursor; group?: Cursor[] };

const firstHalf = (event: ReactDragEvent, vertical: boolean) => {
  const box = event.currentTarget.getBoundingClientRect();
  return vertical
    ? event.clientY < box.top + box.height / 2
    : event.clientX < box.left + box.width / 2;
};

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
    // Private storage is a convenience; settings still apply this session.
  }
}

const AUTHOR_KEY = "lyssna.ttml-author";
const loadAuthor = (): MetaEntry[] => {
  try {
    const author = JSON.parse(readStorage(AUTHOR_KEY) ?? "[]");
    return Array.isArray(author) ? author : [];
  } catch {
    return [];
  }
};
const contentOf = (
  lines: CreatorLine[],
  text: string,
  metadata: MetaEntry[] | undefined,
) => JSON.stringify({ lines, text, metadata });

const meta = (track: Track): SongMeta => ({
  name: track.name,
  artists: track.artists.map((artist) => artist.name),
  album: track.album?.name,
  spotifyId: track.id,
  durationMs: track.duration_ms,
  songwriters: track.songwriters,
});

function TimePill({ ms, end }: { ms?: number; end?: boolean }) {
  const pill = useRef<HTMLSpanElement>(null);
  const shown = useRef(ms);
  useEffect(() => {
    if (shown.current === ms) return;
    shown.current = ms;
    if (ms === undefined || document.querySelector(".reduce-motion")) return;
    pill.current?.animate([{ background: "#1ed76073", color: "#fff" }, {}], {
      duration: 500,
      easing: "ease-out",
    });
  }, [ms]);
  return (
    <span
      ref={pill}
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
  onParse,
  notify,
  renderPreview,
  barSlot,
  onShowPlayer,
  onClose,
}: {
  state: AppState;
  onPlayer: (request: PlayerRequest) => void;
  onToggle: () => void;
  onSpeed: (rate: number) => Promise<void>;
  onApply: (filename: string, ttml: string) => Promise<boolean>;
  onParse: (
    filename: string,
    contents: string,
    durationMs: number,
  ) => Promise<Lyrics>;
  notify: (message: string, error?: boolean) => void;
  renderPreview?: (lyrics: Lyrics) => ReactNode;
  /** Where the creator's own bar replaces the player bar. */
  barSlot?: HTMLElement | null;
  onShowPlayer?: () => void;
  onClose?: () => void;
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

  const [savedAt, setSavedAt] = useState<number | undefined>();
  // The content last written for `uri`, so loading or seeding a song is not
  // mistaken for an edit and only real changes get a new save time.
  const [metadata, setMetadata] = useState<MetaEntry[] | undefined>();
  const saved = useRef({ uri: "", content: "", loading: false });
  const current = useRef({ uri: "", lines, text, metadata });
  const versions = useRef<{ at?: number; changed: boolean }>({
    changed: false,
  });
  const snapshot = useCallback((leaving: boolean) => {
    const { uri, lines, text, metadata } = current.current;
    const now = Date.now();
    if (
      !uri ||
      !versions.current.changed ||
      !newVersionDue(versions.current.at, now, leaving)
    )
      return;
    versions.current = { at: now, changed: false };
    void addVersion({ uri, savedAt: now, lines, text, metadata }).catch(
      () => {},
    );
  }, []);

  useEffect(() => {
    if (!track) return;
    const draft = loadDraft(track.uri);
    setLinesRaw(draft?.lines ?? []);
    setText(draft?.text ?? "");
    setMetadata(draft?.metadata);
    setSavedAt(draft?.savedAt);
    saved.current = {
      uri: track.uri,
      content: contentOf(
        draft?.lines ?? [],
        draft?.text ?? "",
        draft?.metadata,
      ),
      loading: true,
    };
    versions.current = { changed: false };
    setCursor({ line: 0, unit: 0 });
    history.current = { past: [], future: [] };
    setTab(draft?.lines.length ? "sync" : "write");
    return () => snapshot(true);
  }, [track, snapshot]);

  useEffect(() => {
    const leave = () => snapshot(true);
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
  }, [snapshot]);

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
    saved.current.content = contentOf(seeded, toText(seeded), metadata);
  }, [
    track,
    here,
    state.lyrics,
    state.lyrics_uri,
    lines.length,
    text,
    metadata,
  ]);

  useEffect(() => {
    if (!track) return;
    current.current = { uri: track.uri, lines, text, metadata };
    // The load above ran in this same commit; these are the previous song's.
    if (saved.current.loading) {
      saved.current.loading = false;
      return;
    }
    const content = contentOf(lines, text, metadata);
    if (saved.current.uri !== track.uri || saved.current.content === content)
      return;
    saved.current.content = content;
    versions.current.changed = true;
    if (!lines.length && !text.trim()) {
      writeDraft(track.uri, null);
      setSavedAt(undefined);
      return;
    }
    const now = Date.now();
    writeDraft(track.uri, {
      lines,
      text,
      metadata,
      savedAt: now,
      song: track,
    });
    setSavedAt(now);
    snapshot(false);
  }, [track, lines, text, metadata, snapshot]);

  useEffect(() => () => void onSpeed(1), [onSpeed]);

  const repeatRef = useRef(state.playback.repeat_state);
  repeatRef.current = state.playback.repeat_state;
  const playerRef = useRef(onPlayer);
  playerRef.current = onPlayer;
  useEffect(() => {
    if (!here) return;
    void rpc("hold_crossfade", { held: true }).catch(() => undefined);
    const release = () =>
      void rpc("hold_crossfade", { held: false }).catch(() => undefined);
    const before = repeatRef.current ?? "off";
    if (before === "track") return release;
    playerRef.current({ command: "repeat", repeat: "track" });
    return () => {
      release();
      playerRef.current({ command: "repeat", repeat: before });
    };
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
  const [chosen, setChosen] = useState<Cursor | null>(null);
  const chosenRef = useRef(chosen);
  chosenRef.current = chosen;
  // Word starts picked with Ctrl or Shift, dragged as one bunch.
  const [group, setGroup] = useState<Cursor[]>([]);
  const groupRef = useRef(group);
  groupRef.current = group;
  // Picked Space blocks, each named by the word after it.
  const [spaces, setSpaces] = useState<Cursor[]>([]);
  const spacesRef = useRef(spaces);
  spacesRef.current = spaces;
  useEffect(() => {
    setGroup([]);
    setSpaces([]);
  }, [lines, tab]);
  const isSpace = (at: Cursor) =>
    spaces.some((each) => each.line === at.line && each.unit === at.unit);
  const pickSpace = (event: ReactMouseEvent, at: Cursor) => {
    if (event.shiftKey || event.ctrlKey || event.metaKey)
      return setSpaces(
        isSpace(at)
          ? spaces.filter(
              (each) => each.line !== at.line || each.unit !== at.unit,
            )
          : [...spaces, at],
      );
    setSpaces([at]);
    setGroup([]);
    setChosen(null);
  };
  const wordStart = (at: Cursor) => ({
    line: at.line,
    unit: wordBounds(lines[at.line]?.units ?? [], at.unit).start,
  });
  const inGroup = (at: Cursor) => {
    const start = wordStart(at);
    return group.some(
      (each) => each.line === start.line && each.unit === start.unit,
    );
  };
  const pickWord = (at: Cursor, range: boolean) => {
    const start = wordStart(at);
    const base = group.length || !chosen ? group : [wordStart(chosen)];
    if (range && chosen) {
      const from = wordStart(chosen);
      const [first, last] =
        from.line < start.line ||
        (from.line === start.line && from.unit <= start.unit)
          ? [from, start]
          : [start, from];
      const picked: Cursor[] = [];
      for (let line = first.line; line <= last.line; line++)
        lines[line]?.units.forEach((unit, index) => {
          if (unit.joined && index) return;
          if (line === first.line && index < first.unit) return;
          if (line === last.line && index > last.unit) return;
          picked.push({ line, unit: index });
        });
      setGroup(picked);
      setSpaces(picked.slice(1).filter((at) => at.unit > 0));
      return;
    }
    const has = base.some(
      (each) => each.line === start.line && each.unit === start.unit,
    );
    setGroup(
      has
        ? base.filter(
            (each) => each.line !== start.line || each.unit !== start.unit,
          )
        : [...base, start],
    );
    setChosen(at);
  };
  const moveDragged = (
    dragged: { at: Cursor; group?: Cursor[] },
    to: Cursor,
  ) =>
    dragged.group
      ? moveWords(lines, dragged.group, to)
      : moveWord(lines, dragged.at, to);
  // A new blank line's Type word here box takes focus once it renders.
  const [focusLine, setFocusLine] = useState<number | null>(null);
  const addBlankLine = (after: number) => {
    setLines(insertBlankLine(lines, after));
    setCursor({ line: after + 1, unit: 0 });
    setFocusLine(after + 1);
  };
  useEffect(() => {
    if (focusLine === null) return;
    list.current
      ?.querySelector<HTMLInputElement>(
        `[data-line="${focusLine}"] .ttml-chip-add`,
      )
      ?.focus();
    setFocusLine(null);
  }, [focusLine, lines]);
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

  useEffect(() => {
    if (tab !== "write") return setChosen(null);
    const onKey = (event: KeyboardEvent) => {
      const at = chosenRef.current;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, select, [contenteditable=true]") ||
        document.querySelector(".ttml-menu, .ttml-dialog")
      )
        return;
      const key = event.key.toLowerCase();
      if (event.ctrlKey && key === "z") (event.shiftKey ? redo : undo)();
      else if (event.ctrlKey && key === "y") redo();
      if (event.ctrlKey && (key === "z" || key === "y")) {
        event.preventDefault();
        return;
      }
      const lineSet = pickedRef.current;
      if (
        lineSet.size &&
        !at &&
        !spacesRef.current.length &&
        !groupRef.current.length &&
        !event.ctrlKey &&
        (event.key === "Delete" || event.key === "Backspace")
      ) {
        event.preventDefault();
        const next = removeLines(stateRef.current.lines, lineSet);
        setLines(next);
        setCursor((cursor) => clampCursor(next, cursor));
        setPicked(new Set());
        return;
      }
      const gaps = spacesRef.current;
      const picked = groupRef.current;
      if (
        (gaps.length || picked.length) &&
        !event.ctrlKey &&
        (event.key === "Delete" || event.key === "Backspace")
      ) {
        event.preventDefault();
        const next = deletePicked(stateRef.current.lines, picked, gaps);
        setLines(next);
        setCursor((cursor) => clampCursor(next, cursor));
        setChosen(null);
        setSpaces([]);
        setGroup([]);
        return;
      }
      if (!at || event.ctrlKey || event.altKey || event.metaKey) return;
      const { lines } = stateRef.current;
      if (event.key === "Delete" || event.key === "Backspace") {
        const next = editUnit(lines, at, "");
        setLines(next);
        setCursor((cursor) => clampCursor(next, cursor));
        // The next word or syllable takes its place, for deleting in a row.
        const line = next[at.line];
        setChosen(
          line && line.units.length && next.length === lines.length
            ? { line: at.line, unit: Math.min(at.unit, line.units.length - 1) }
            : null,
        );
      } else if (event.key === "Escape") {
        setChosen(null);
        setGroup([]);
        setSpaces([]);
      } else if (event.key === "Enter") setEditing(at);
      else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const move = event.key === "ArrowLeft" ? previousCursor : nextCursor;
        setChosen(move(lines, at) ?? at);
      } else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, setLines, undo, redo]);

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
  const [replacing, setReplacing] = useState<Cursor | null>(null);
  const openMenu = (event: ReactMouseEvent, at: Cursor) => {
    event.preventDefault();
    setCursor(at);
    setMenu({ x: event.clientX, y: event.clientY, at });
  };
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const pickedFrom = useRef(0);
  useEffect(() => setPicked(new Set()), [lines.length, track]);
  const pick = (index: number, range: boolean) => {
    const anchor = picked.size ? pickedFrom.current : cursor.line;
    const [from, to] = [anchor, index].sort((a, b) => a - b);
    pickedFrom.current = index;
    setPicked((old) => {
      const next = new Set(old);
      if (range) for (let at = from; at <= to; at++) next.add(at);
      else if (!next.delete(index)) next.add(index);
      return next;
    });
  };
  // Like AMLL: Ctrl-click adds or removes a line, Shift-click adds a range,
  // and a plain click on a line's empty space drops the selection.
  const pickProps = (index: number) => ({
    onMouseDown: (event: ReactMouseEvent) => {
      if (event.shiftKey || event.ctrlKey || event.metaKey)
        event.preventDefault();
    },
    onClickCapture: (event: ReactMouseEvent) => {
      if (
        (event.shiftKey || event.ctrlKey || event.metaKey) &&
        !(event.target as Element).closest(".ttml-chip, .ttml-space")
      ) {
        event.preventDefault();
        event.stopPropagation();
        pick(index, event.shiftKey);
      } else if (
        picked.size &&
        !(event.target as Element).closest("button, input, textarea")
      )
        setPicked(new Set());
    },
  });
  const [shiftBy, setShiftBy] = useState(0);
  const allPicked = (key: "background" | "opposite") =>
    [...picked].every((index) => lines[index]?.[key]);
  const pickBar = picked.size > 0 && (
    <div className="ttml-pick-bar" role="toolbar" aria-label="Selected lines">
      <strong>
        {picked.size} line{picked.size === 1 ? "" : "s"} selected
      </strong>
      <button
        className={allPicked("background") ? "active" : ""}
        aria-pressed={allPicked("background")}
        onClick={() =>
          setLines(
            setLineFlag(lines, picked, "background", !allPicked("background")),
          )
        }
      >
        Background
      </button>
      <button
        className={allPicked("opposite") ? "active" : ""}
        aria-pressed={allPicked("opposite")}
        onClick={() =>
          setLines(
            setLineFlag(lines, picked, "opposite", !allPicked("opposite")),
          )
        }
      >
        Second singer
      </button>
      <label className="ttml-offset">
        Shift
        <input
          type="number"
          step={10}
          value={shiftBy}
          aria-label="Shift selected lines by milliseconds"
          onChange={(event) => setShiftBy(Number(event.target.value) || 0)}
        />
        ms
      </label>
      <button
        disabled={!shiftBy}
        onClick={() => setLines(shiftLines(lines, picked, shiftBy))}
      >
        Shift timing
      </button>
      <button onClick={() => setLines(clearLines(lines, picked))}>
        Clear timing
      </button>
      <button
        className="danger"
        onClick={() => restructure(removeLines(lines, picked))}
      >
        <Trash2 size={14} />
        Delete
      </button>
      <span className="ttml-pick-end">
        <button
          onClick={() => setPicked(new Set(lines.map((_, index) => index)))}
        >
          Select all
        </button>
        <button onClick={() => setPicked(new Set())}>Deselect</button>
      </span>
    </div>
  );
  const restructure = (next: CreatorLine[]) => {
    if (next === lines) return;
    setLines(next);
    setCursor((cursor) => clampCursor(next, cursor));
  };
  const [wordRoman, setWordRoman] = useState(
    () => readStorage(WORD_ROMAN_KEY) === "1",
  );
  const showWordRoman = (on: boolean) => {
    setWordRoman(on);
    writeStorage(WORD_ROMAN_KEY, on ? "1" : null);
  };
  const [romanNote, setRomanNote] = useState("");
  const [syncRoman, setSyncRoman] = useState(
    () => readStorage(SYNC_ROMAN_KEY) === "1",
  );
  const romanJob = useRef(0);
  const autoRomanize = async () => {
    const job = ++romanJob.current;
    setRomanNote("Romanizing…");
    const request = romanizeRequest(lines);
    const result = await romanizeAway(request).catch(() => null);
    if (job !== romanJob.current) return;
    if (!result) {
      setRomanNote("Romanization failed.");
      return;
    }
    // The worker hands back a copy, so compare readings rather than objects.
    const found = result.lines.some((line, lineIndex) =>
      line.words.some(
        (word, index) =>
          word.text.trim() !==
          request.lines[lineIndex]?.words[index]?.text.trim(),
      ),
    );
    setRomanNote(
      found
        ? ""
        : "Nothing to romanize: these lyrics are already in Latin letters.",
    );
    if (!found) return;
    setLines((current) => applyRomanized(current, request, result));
    showWordRoman(true);
  };
  const [drag, setDrag] = useState<Drag | null>(null);
  const [drop, setDrop] = useState("");
  const dragScroll = useRef({ speed: 0, frame: 0 });
  useEffect(() => {
    const scroll = dragScroll.current;
    return () => cancelAnimationFrame(scroll.frame);
  }, []);
  const endDrag = () => {
    setDrag(null);
    setDrop("");
    dragScroll.current.speed = 0;
  };
  const scrollWhileDragging = (event: ReactDragEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const edge = Math.min(90, box.height / 4);
    const reach = (distance: number) =>
      Math.min(1, 1 - distance / edge) ** 2 * 22;
    const scroll = dragScroll.current;
    scroll.speed =
      event.clientY - box.top < edge
        ? -reach(event.clientY - box.top)
        : box.bottom - event.clientY < edge
          ? reach(box.bottom - event.clientY)
          : 0;
    if (!scroll.speed || scroll.frame) return;
    const element = event.currentTarget;
    const step = () => {
      if (!scroll.speed) {
        scroll.frame = 0;
        return;
      }
      element.scrollTop += scroll.speed;
      scroll.frame = requestAnimationFrame(step);
    };
    scroll.frame = requestAnimationFrame(step);
  };
  const startDrag = (event: ReactDragEvent, next: Drag) => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", "");
    if (next.kind === "word") {
      // Shows every word being moved, not just the block under the pointer.
      const text = [...(next.group ?? [next.at])]
        .sort((a, b) => a.line - b.line || a.unit - b.unit)
        .map((at) => {
          const units = lines[at.line]?.units ?? [];
          const { start, end } = wordBounds(units, at.unit);
          return units
            .slice(start, end)
            .map((unit) => unit.text)
            .join("");
        })
        .join(" ");
      const ghost = document.createElement("div");
      ghost.className = "ttml-drag-ghost";
      ghost.textContent = text;
      document.body.append(ghost);
      event.dataTransfer.setDragImage(ghost, 12, 16);
      setTimeout(() => ghost.remove());
    }
    setDrag(next);
  };
  // The picked words, or the selected word when none are picked.
  const pickedWords = () =>
    group.length ? group : chosen ? [wordStart(chosen)] : [];
  const dragWords = (event: ReactDragEvent, at: Cursor) => {
    const words = pickedWords();
    const carry = words.some(
      (each) => each.line === at.line && each.unit === wordStart(at).unit,
    );
    startDrag(
      event,
      carry && words.length > 1
        ? { kind: "word", at, group: words }
        : { kind: "word", at },
    );
  };
  const over = (event: ReactDragEvent, key: string) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDrop(key);
  };
  const land = (event: ReactDragEvent, next: CreatorLine[]) => {
    event.preventDefault();
    event.stopPropagation();
    endDrag();
    restructure(next);
  };
  const dropClass = (key: string) =>
    drop.startsWith(`${key}:`) ? ` drop-${drop.slice(key.length + 1)}` : "";
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
          run: () => setReplacing(at),
        },
        ...(unit.joined
          ? [
              {
                label: "Space before this syllable",
                run: () => setLines(toggleJoin(lines, at)),
              },
            ]
          : []),
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
            addBlankLine(at.line - 1);
          },
        },
        {
          label: "Insert new line after",
          run: () => {
            toCards();
            addBlankLine(at.line);
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
  const confirmReplace = (at: Cursor, choice: ReplaceChoice) => {
    const unit = lines[at.line]?.units[at.unit];
    setReplacing(null);
    if (!unit) return;
    if (!choice.replaceAll) return commitWord(at, choice.value);
    restructure(
      replaceMatching(lines, unit.text, choice.value, choice.matchCase),
    );
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
  // Right-clicking a word on the spectrogram plays only that word, as in
  // AMLL's tool. Seeking and pausing the player is late by its buffering,
  // so Lyssna's own output plays the word's decoded samples, cut at its
  // exact edges, at the player's volume.
  const clipAsked = useRef(0);
  const [clipping, setClipping] = useState<{
    start: number;
    end: number;
    began: number;
  } | null>(null);
  const [clipNow, setClipNow] = useState(0);
  useEffect(() => {
    if (!clipping) return;
    let frame = 0;
    const tick = (time: number) => {
      setClipNow(time);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    // The song waits where the word ends, as the playhead does.
    const done = window.setTimeout(() => {
      seek(clipping.end);
      setClipping(null);
    }, clipping.end - clipping.start);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(done);
    };
  }, [clipping, seek]);
  const shownPosition = clipping
    ? Math.min(
        clipping.end,
        clipping.start + Math.max(0, clipNow - clipping.began),
      )
    : position;
  const playUnit = useCallback(
    (at: Cursor) => {
      const unit = lines[at.line]?.units[at.unit];
      const range =
        unit?.start !== undefined && unit.end !== undefined
          ? { start: unit.start, end: unit.end }
          : lines[at.line] && lineSpan(lines[at.line]);
      if (!track || !range || range.end <= range.start) return;
      setCursor(at);
      setClipping(null);
      if (state.playback.is_playing) onPlayer({ command: "pause" });
      seek(range.start);
      const asked = ++clipAsked.current;
      rpc("play_clip", {
        uri: track.uri,
        fromMs: range.start,
        toMs: range.end,
      })
        .then(() => {
          if (asked !== clipAsked.current) return;
          const began = performance.now();
          setClipNow(began);
          setClipping({ ...range, began });
        })
        .catch((error) => notify(`Couldn't play the word: ${error}`, true));
    },
    [lines, seek, track, state.playback.is_playing, onPlayer, notify],
  );
  useEffect(() => {
    if (!state.playback.is_playing) return;
    clipAsked.current++;
    setClipping(null);
    void rpc("stop_clip").catch(() => undefined);
  }, [state.playback.is_playing]);
  useEffect(() => () => void rpc("stop_clip").catch(() => undefined), []);
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
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  const volumeTimer = useRef(0);
  const changeVolume = (percent: number) => {
    setVolumeDraft(percent);
    clearTimeout(volumeTimer.current);
    volumeTimer.current = window.setTimeout(() => {
      onPlayer({ command: "volume", volume: Math.round(percent) });
      volumeTimer.current = window.setTimeout(() => setVolumeDraft(null), 1500);
    }, 80);
  };
  useEffect(() => () => clearTimeout(volumeTimer.current), []);
  const barVolume =
    volumeDraft ??
    state.playback.device.volume_percent ??
    state.settings.volume_percent ??
    70;

  const [keys, setKeys] = useState<KeyMap>(loadKeys);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const [editingKeys, setEditingKeys] = useState(false);
  const changeKeys = useCallback((next: KeyMap) => {
    setKeys(next);
    saveKeys(next);
  }, []);
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
      else {
        const arrows: Record<string, KeyAction> = {
          ArrowLeft: "previous",
          ArrowRight: "following",
          ArrowUp: "lineUp",
          ArrowDown: "lineDown",
          Backspace: "clear",
        };
        const action = arrows[event.key] ?? actionFor(keysRef.current, key);
        const timing = ["start", "next", "end"].includes(action ?? "");
        if (action === "previous")
          setCursor(previousCursor(lines, cursor) ?? cursor);
        else if (action === "following")
          setCursor(nextCursor(lines, cursor) ?? cursor);
        else if (action === "lineUp")
          setCursor(clampCursor(lines, { line: cursor.line - 1, unit: 0 }));
        else if (action === "lineDown")
          setCursor(clampCursor(lines, { line: cursor.line + 1, unit: 0 }));
        else if (action === "normalSpeed") changeSpeed(1);
        else if (action === "slower") changeSpeed(clampSpeed(rate - 0.05));
        else if (action === "faster") changeSpeed(clampSpeed(rate + 0.05));
        else if (!action || !here || !lines.length) handled = false;
        else if (action === "jumpBack" || action === "jumpForward") {
          const to =
            (action === "jumpBack"
              ? previousCursor(lines, cursor)
              : nextCursor(lines, cursor)) ?? cursor;
          setCursor(to);
          const start = lines[to.line]?.units[to.unit]?.start;
          if (start !== undefined) seek(start);
        } else if (event.repeat && timing) handled = true;
        else if (action === "start") setLines(markStart(lines, cursor, tap()));
        else if (action === "next") {
          const result = markNext(lines, cursor, tap());
          setLines(result.lines);
          setCursor(result.cursor);
        } else if (action === "end") {
          const result = markEnd(lines, cursor, tap());
          setLines(result.lines);
          setCursor(result.cursor);
        } else if (action === "replay") {
          const line = lines[cursor.line];
          const before = lines[cursor.line - 1];
          const from =
            (line && lineSpan(line)?.start) ??
            (before && lineSpan(before)?.end) ??
            read();
          seek(from - 2000);
        } else if (action === "clear") setLines(clearTiming(lines, cursor));
        else handled = false;
      }
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
    (index: number, instant = false) => {
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
      if (instant || reduceMotion || Math.abs(to - from) < 1) {
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
  // A line picked with the mouse is already in view; scrolling it to the
  // middle would move the word away from the pointer.
  const clickedLine = useRef(false);
  useEffect(() => {
    if (clickedLine.current) {
      clickedLine.current = false;
      return;
    }
    if (tab === "sync") centre(cursor.line);
  }, [cursor.line, tab, centre]);
  const centreOnLyrics = useRef<number | null>(null);
  useEffect(() => {
    if (tab !== "write" || centreOnLyrics.current === null) return;
    centre(centreOnLyrics.current, true);
    centreOnLyrics.current = null;
  }, [tab, centre]);

  const shownWord = useRef<(Cursor & { start: number }) | null>(null);
  const liveWord = useMemo(() => {
    let next: (Cursor & { start: number }) | null = null;
    lines.forEach((line, lineIndex) =>
      line.units.forEach((unit, unitIndex) => {
        if (
          unit.start !== undefined &&
          unit.end !== undefined &&
          position >= unit.start &&
          position < unit.end
        )
          next = { line: lineIndex, unit: unitIndex, start: unit.start };
      }),
    );
    const shown = shownWord.current;
    const found = next as (Cursor & { start: number }) | null;
    // The clock can step back a few ms; only a real seek lights an earlier word.
    if (
      shown &&
      found &&
      found.start < shown.start &&
      shown.start - position < 250
    )
      return shown;
    shownWord.current = found;
    return found;
  }, [lines, position]);
  // Overlapping lines, like a second singer or background vocals, sing
  // together, so every word under the playhead lights up.
  const liveWords = useMemo(
    () => singingAt(lines, position),
    [lines, position],
  );
  const [peaks, setPeaks] = useState<{
    uri: string;
    values: Uint8Array;
  } | null>(null);
  const trackUri = track?.uri;
  const [spectrogram, setSpectrogram] = useState(
    () => readStorage(SPECTROGRAM_KEY) === "1",
  );
  const showSpectrogram = (on: boolean) => {
    setSpectrogram(on);
    writeStorage(SPECTROGRAM_KEY, on ? "1" : null);
  };
  useEffect(() => {
    if (!barSlot || !trackUri || peaks?.uri === trackUri) return;
    let current = true;
    rpc<number[]>("track_waveform", { uri: trackUri, buckets: 2400 })
      .then(
        (values) =>
          current &&
          Array.isArray(values) &&
          setPeaks({ uri: trackUri, values: Uint8Array.from(values) }),
      )
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [barSlot, trackUri, peaks?.uri]);
  const barSpans = useMemo(
    () =>
      lines.flatMap((line, index) => {
        if (index !== cursor.line && !picked.has(index)) return [];
        const span = lineSpan(line);
        return span ? [{ ...span, current: true }] : [];
      }),
    [lines, cursor.line, picked],
  );
  const playingLine = useMemo(() => {
    let found = -1;
    lines.forEach((line, index) => {
      const span = lineSpan(line);
      if (span && span.start <= position) found = index;
    });
    return found;
  }, [lines, position]);
  const scrolledAt = useRef(0);
  // A double-click replays from just before a word, which can start in the
  // line above; the view stays put until playback reaches the word's line.
  const holdLine = useRef<number | null>(null);
  useEffect(() => {
    if (
      tab !== "sync" ||
      playingLine < 0 ||
      !state.playback.is_playing ||
      Date.now() - scrolledAt.current < 3000
    )
      return;
    if (holdLine.current !== null) {
      if (playingLine < holdLine.current) return;
      holdLine.current = null;
    }
    centre(playingLine);
  }, [playingLine, tab, state.playback.is_playing, centre]);

  const preview = useMemo(() => toLyrics(lines), [lines]);
  const issues = useMemo(() => problems(lines), [lines]);
  const { done, total } = progress(lines);
  const entries = useMemo(
    () =>
      track
        ? metadata
          ? withSongwriters(metadata, meta(track))
          : defaultMetadata(meta(track), loadAuthor())
        : (metadata ?? []),
    [metadata, track],
  );
  const ttml = () => (track ? toTtml(lines, meta(track), entries) : "");
  const [editingMeta, setEditingMeta] = useState(false);
  const changeMetadata = (next: MetaEntry[]) => {
    setMetadata(next);
    const author = next.filter(
      (entry) =>
        AUTHOR_KEYS.includes(entry.key) &&
        entry.values.some((value) => value.trim()),
    );
    // Clearing one song's fields keeps the author for the next song.
    if (author.length) writeStorage(AUTHOR_KEY, JSON.stringify(author));
  };

  const [exporting, setExporting] = useState(false);
  const download = (format: ExportFormat | "ttml" = "ttml") => {
    if (!track) return;
    setExporting(false);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([format === "ttml" ? ttml() : exportLyrics(format, lines)], {
        type: format === "ttml" ? "application/ttml+xml" : "text/plain",
      }),
    );
    link.download = fileName(meta(track)).replace(/\.ttml$/, `.${format}`);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  };
  const importFile = async (file: File) => {
    if (file.size > 2_000_000) return notify("Lyric file exceeds 2 MB", true);
    const format = formatOf(file.name);
    const source = await file.text();
    try {
      const parsed = (WORD_FORMATS as readonly string[]).includes(format)
        ? parseWordFormat(format as WordFormat, source)
        : fromLyrics(await onParse(file.name, source, track?.duration_ms ?? 0));
      if (!parsed.length)
        return notify(`No lyrics found in ${file.name}.`, true);
      setLines(parsed);
      setText(toText(parsed));
      setCursor({ line: 0, unit: 0 });
      notify(
        `Imported ${parsed.length} line${parsed.length === 1 ? "" : "s"} from ${file.name}. Ctrl+Z undoes it.`,
      );
    } catch (error) {
      notify(`Couldn't read ${file.name}: ${String(error)}`, true);
    }
  };
  const importInput = (
    <input
      type="file"
      hidden
      accept=".ttml,.xml,.lrc,.qrc,.yrc,.lys,.eslrc"
      aria-label="Lyric file to import"
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void importFile(file);
      }}
    />
  );
  const copy = () =>
    void navigator.clipboard.writeText(ttml()).then(
      () => notify("TTML copied."),
      () => notify("Couldn't copy the TTML.", true),
    );
  const apply = () => {
    if (!track || !here) return;
    void onApply(fileName(meta(track)), ttml());
  };

  const [saves, setSaves] = useState<{
    songs: SavedSong[];
    versions: DraftVersion[];
  } | null>(null);
  const [olderSaves, setOlderSaves] = useState(false);
  const openSaves = () => {
    setOlderSaves(false);
    setSaves({ songs: listDrafts(), versions: [] });
    if (track)
      void listVersions(track.uri).then(
        (versions) => setSaves((open) => open && { ...open, versions }),
        () => {},
      );
  };
  const restore = (version: DraftVersion) => {
    setLines(version.lines);
    setText(version.text);
    if (version.metadata) setMetadata(version.metadata);
    setCursor({ line: 0, unit: 0 });
    setSaves(null);
    notify(`Restored the save from ${savedLabel(version.savedAt)}.`);
  };
  const forget = (song: SavedSong) => {
    void deleteSaves(song.uri).finally(() =>
      setSaves(
        (open) =>
          open && {
            songs: open.songs.filter((saved) => saved.uri !== song.uri),
            versions: song.uri === track?.uri ? [] : open.versions,
          },
      ),
    );
    if (song.uri === track?.uri) setSavedAt(undefined);
  };
  const savesDialog = saves && (
    <div className="ttml-dialog-backdrop" onClick={() => setSaves(null)}>
      <div
        className="ttml-dialog ttml-saves"
        role="dialog"
        aria-label="TTML saves"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h3>Saves</h3>
          <button onClick={() => setSaves(null)} aria-label="Close saves">
            <X size={16} />
          </button>
        </header>
        <p className="ttml-hint">
          Drafts save on every change. A dated version is kept every 10 minutes
          and whenever you leave a song, up to 10 per song.
        </p>
        {track && (
          <section>
            <h4>Versions of {track.name}</h4>
            {saves.versions.length ? (
              <ul>
                {saves.versions
                  .slice(0, olderSaves ? undefined : 2)
                  .map((version) => (
                    <li key={version.id ?? version.savedAt}>
                      <span>
                        <strong>{savedLabel(version.savedAt)}</strong>
                        <small>
                          {version.lines.length} line
                          {version.lines.length === 1 ? "" : "s"}
                        </small>
                      </span>
                      <button onClick={() => restore(version)}>Restore</button>
                    </li>
                  ))}
                {saves.versions.length > 2 && (
                  <li className="ttml-saves-more">
                    <button
                      aria-expanded={olderSaves}
                      onClick={() => setOlderSaves(!olderSaves)}
                    >
                      {olderSaves
                        ? "Hide older versions"
                        : `${saves.versions.length - 2} older version${saves.versions.length === 3 ? "" : "s"}`}
                      <ChevronDown
                        size={15}
                        className={olderSaves ? "open" : ""}
                      />
                    </button>
                  </li>
                )}
              </ul>
            ) : (
              <p className="ttml-hint">No earlier versions yet.</p>
            )}
          </section>
        )}
        <section>
          <h4>Saved songs</h4>
          {saves.songs.length ? (
            <ul>
              {saves.songs.map((saved) => (
                <li
                  key={saved.uri}
                  className={saved.uri === track?.uri ? "current" : ""}
                >
                  <span>
                    <strong>{saved.song?.name ?? saved.uri}</strong>
                    <small>
                      {saved.song &&
                        `${saved.song.artists.map((artist) => artist.name).join(", ")} · `}
                      {saved.savedAt
                        ? `Saved ${savedLabel(saved.savedAt)}`
                        : "Saved before save times were kept"}
                    </small>
                  </span>
                  {saved.uri !== track?.uri && (
                    <button
                      disabled={!saved.song}
                      title={
                        saved.song
                          ? undefined
                          : "Play this song to open its draft"
                      }
                      onClick={() => {
                        if (saved.song) setTrack(saved.song);
                        setSaves(null);
                      }}
                    >
                      Open
                    </button>
                  )}
                  <button
                    className="danger"
                    onClick={() => forget(saved)}
                    aria-label={`Delete saves for ${saved.song?.name ?? saved.uri}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="ttml-hint">Nothing saved yet.</p>
          )}
        </section>
      </div>
    </div>
  );

  if (!track)
    return (
      <section className="ttml-creator empty" aria-label="TTML Creator">
        <Wand2 size={32} />
        <h2>TTML Creator</h2>
        <p>Play a song, then come back here to time its lyrics.</p>
        <button onClick={openSaves}>
          <History size={15} />
          Saves
        </button>
        {savesDialog}
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
              onClick={() => {
                if (tab === "sync" && value === "write") {
                  const at =
                    state.playback.is_playing && liveWord ? liveWord : cursor;
                  setCursor(clampCursor(lines, at));
                  centreOnLyrics.current = at.line;
                }
                setTab(value);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="ttml-actions">
          <span className="ttml-saved">
            {savedAt ? `Saved ${savedLabel(savedAt)}` : "Not saved yet"}
          </span>
          <button onClick={openSaves} title="Saves and earlier versions">
            <History size={15} />
          </button>
          {tab !== "preview" && (
            <button
              onClick={() => setEditingKeys(true)}
              title={tab === "sync" ? "Sync settings" : "Lyrics settings"}
            >
              <Settings size={15} />
            </button>
          )}
          <button onClick={() => setEditingMeta(true)} title="Metadata">
            <Tags size={15} />
          </button>
          <button onClick={copy} disabled={!done} title="Copy TTML">
            <Copy size={15} />
          </button>
          <span className="ttml-export">
            <button
              onClick={() => setExporting(!exporting)}
              disabled={!done}
              title="Save lyrics file"
              aria-expanded={exporting}
            >
              <Download size={15} />
            </button>
            {exporting && (
              <div className="ttml-meta-menu" role="menu">
                {(["ttml", ...EXPORT_FORMATS] as const).map((format) => (
                  <button
                    key={format}
                    role="menuitem"
                    onClick={() => download(format)}
                  >
                    {FORMAT_NAMES[format]}
                    <code>.{format}</code>
                  </button>
                ))}
              </div>
            )}
          </span>
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
              <label
                className="ttml-import"
                title="TTML, LRC, QRC, YRC, Lyricify Syllable or ESLyric"
              >
                <Upload size={15} />
                Import file
                {importInput}
              </label>
              <button
                className={wordRoman ? "active" : ""}
                aria-pressed={wordRoman}
                onClick={() => showWordRoman(!wordRoman)}
                title="Show a reading under each word"
              >
                Word romanization
              </button>
              <button
                onClick={() => void autoRomanize()}
                disabled={romanNote === "Romanizing…"}
                title="Fill empty word readings for lyrics in any non-Latin script"
              >
                <Languages size={15} />
                Auto romanize
              </button>
            </div>
            <button className="primary" onClick={() => setTab("sync")}>
              Continue to Sync
            </button>
          </div>
          {romanNote && (
            <p className="ttml-hint" role="status">
              {romanNote}
            </p>
          )}
          {pickBar}
          <div
            className="ttml-lines"
            ref={list}
            onClick={(event) => {
              if ((event.target as Element).closest(".ttml-chip, .ttml-space"))
                return;
              setChosen(null);
              setGroup([]);
              setSpaces([]);
            }}
            onDragEnd={endDrag}
            onDragOverCapture={(event) => drag && scrollWhileDragging(event)}
          >
            {lines.map((line, lineIndex) => (
              <div
                key={lineIndex}
                data-line={lineIndex}
                {...pickProps(lineIndex)}
                className={`ttml-card${line.background ? " background" : ""}${line.opposite ? " opposite" : ""}${cursor.line === lineIndex ? " current" : ""}${line.units.length ? "" : " empty"}${picked.has(lineIndex) ? " picked" : ""}${drag?.kind === "line" && drag.line === lineIndex ? " dragging" : ""}${dropClass(`line:${lineIndex}`)}`}
                onClick={(event) => {
                  setCursor((at) =>
                    at.line === lineIndex ? at : { line: lineIndex, unit: 0 },
                  );
                  // A plain click on the card itself selects the whole line.
                  if (
                    !event.shiftKey &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    !(event.target as Element).closest(
                      ".ttml-chip, .ttml-space, button, input, label",
                    )
                  ) {
                    pickedFrom.current = lineIndex;
                    setPicked(new Set([lineIndex]));
                  }
                }}
                onPointerDown={(event) => {
                  event.currentTarget.draggable = !(
                    event.target as Element
                  ).closest("button, input");
                }}
                onDragStart={(event) =>
                  event.target === event.currentTarget &&
                  startDrag(event, { kind: "line", line: lineIndex })
                }
                onDragOver={(event) => {
                  if (drag?.kind === "line")
                    over(
                      event,
                      `line:${lineIndex}:${firstHalf(event, true) ? "before" : "after"}`,
                    );
                  else if (drag?.kind === "word")
                    over(event, `line:${lineIndex}:end`);
                }}
                onDrop={(event) => {
                  if (drag?.kind === "line")
                    land(
                      event,
                      moveLine(
                        lines,
                        drag.line,
                        firstHalf(event, true) ? lineIndex : lineIndex + 1,
                      ),
                    );
                  else if (drag?.kind === "word")
                    land(
                      event,
                      moveDragged(drag, {
                        line: lineIndex,
                        unit: line.units.length,
                      }),
                    );
                }}
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
                              className={`ttml-space${isSpace(at) ? " chosen" : ""}${dropClass(`gap:${lineIndex}:${unitIndex}`)}`}
                              draggable
                              onClick={(event) => pickSpace(event, at)}
                              onDragStart={(event) => {
                                // A picked space drags the picked words with it.
                                const words = pickedWords();
                                if (isSpace(at) && words.length)
                                  startDrag(event, {
                                    kind: "word",
                                    at: words[0],
                                    ...(words.length > 1 && { group: words }),
                                  });
                                else startDrag(event, { kind: "space", at });
                              }}
                              onDragOver={(event) =>
                                drag?.kind === "word" &&
                                over(
                                  event,
                                  `gap:${lineIndex}:${unitIndex}:word`,
                                )
                              }
                              onDrop={(event) =>
                                drag?.kind === "word" &&
                                land(event, moveDragged(drag, at))
                              }
                            >
                              Space
                            </button>
                          )}
                          <span
                            className={
                              wordRoman ? "ttml-chip-stack" : "ttml-chip-plain"
                            }
                          >
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
                                className={`ttml-chip${unit.joined ? " joined" : ""}${(chosen?.line === lineIndex && chosen.unit === unitIndex) || inGroup(at) ? " chosen" : ""}${drag?.kind === "word" && ((drag.at.line === lineIndex && drag.at.unit === unitIndex) || (drag.group && inGroup(at))) ? " dragging" : ""}${dropClass(`unit:${lineIndex}:${unitIndex}`)}`}
                                title={
                                  unit.joined
                                    ? "Syllable. Double-click to edit; right-click to make it its own word."
                                    : "Double-click to edit; drag to move"
                                }
                                draggable
                                onDragStart={(event) => dragWords(event, at)}
                                onDragOver={(event) => {
                                  if (drag?.kind === "word")
                                    over(
                                      event,
                                      `unit:${lineIndex}:${unitIndex}:${firstHalf(event, false) ? "before" : "after"}`,
                                    );
                                  else if (
                                    drag?.kind === "space" &&
                                    unit.joined &&
                                    drag.at.line === lineIndex
                                  )
                                    over(
                                      event,
                                      `unit:${lineIndex}:${unitIndex}:space`,
                                    );
                                }}
                                onDrop={(event) => {
                                  if (drag?.kind === "word") {
                                    const word = wordBounds(
                                      line.units,
                                      unitIndex,
                                    );
                                    land(
                                      event,
                                      moveDragged(drag, {
                                        line: lineIndex,
                                        unit: firstHalf(event, false)
                                          ? word.start
                                          : word.end,
                                      }),
                                    );
                                  } else if (
                                    drag?.kind === "space" &&
                                    unit.joined
                                  )
                                    land(event, moveSpace(lines, drag.at, at));
                                }}
                                onClick={(event) => {
                                  if (
                                    event.shiftKey ||
                                    event.ctrlKey ||
                                    event.metaKey
                                  )
                                    return pickWord(at, event.shiftKey);
                                  setGroup([]);
                                  setSpaces([]);
                                  setPicked(new Set());
                                  setChosen(at);
                                }}
                                onDoubleClick={() => setEditing(at)}
                                onContextMenu={(event) => openMenu(event, at)}
                              >
                                {unit.text}
                              </button>
                            )}
                            {wordRoman && (
                              <input
                                className="ttml-roman"
                                key={unit.roman ?? ""}
                                aria-label={`Romanization of ${unit.text}`}
                                defaultValue={unit.roman ?? ""}
                                placeholder="–"
                                spellCheck={false}
                                onBlur={(event) =>
                                  setLines(
                                    setUnitRoman(lines, at, event.target.value),
                                  )
                                }
                                onKeyDown={(event) =>
                                  event.key === "Enter" &&
                                  event.currentTarget.blur()
                                }
                              />
                            )}
                          </span>
                        </Fragment>
                      );
                    })}
                    {line.spaceAfter && (
                      <button
                        className={`ttml-space${isSpace({ line: lineIndex, unit: line.units.length }) ? " chosen" : ""}`}
                        onClick={(event) =>
                          pickSpace(event, {
                            line: lineIndex,
                            unit: line.units.length,
                          })
                        }
                      >
                        Space
                      </button>
                    )}
                    <input
                      className="ttml-chip-add"
                      aria-label={`Add words to line ${lineIndex + 1}`}
                      placeholder="Type word here"
                      spellCheck={false}
                      onFocus={() =>
                        setCursor((at) =>
                          at.line === lineIndex
                            ? at
                            : { line: lineIndex, unit: 0 },
                        )
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Escape") event.currentTarget.blur();
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        event.stopPropagation();
                        const next = appendWords(
                          lines,
                          lineIndex,
                          event.currentTarget.value,
                        );
                        event.currentTarget.value = "";
                        if (next !== lines) setLines(next);
                      }}
                    />
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
                    onClick={() => addBlankLine(lineIndex)}
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
            <label
              className="ttml-import"
              title="TTML, LRC, QRC, YRC, Lyricify Syllable or ESLyric"
            >
              <Upload size={15} />
              Import file
              {importInput}
            </label>
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
            <button
              className={`ttml-roman-toggle${syncRoman ? " active" : ""}`}
              aria-pressed={syncRoman}
              disabled={!lines.some(hasWordRoman)}
              onClick={() => {
                setSyncRoman(!syncRoman);
                writeStorage(SYNC_ROMAN_KEY, syncRoman ? null : "1");
              }}
              title={
                lines.some(hasWordRoman)
                  ? "Show each word's romanization instead of its text"
                  : "Add word romanization on the Lyrics tab first"
              }
            >
              <Languages size={15} />
              Romanization
            </button>
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
          {pickBar}
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
                {...pickProps(lineIndex)}
                className={`ttml-card ttml-line${line.background ? " background" : ""}${line.opposite ? " opposite" : ""}${cursor.line === lineIndex ? " current" : ""}${playingLine === lineIndex || liveWords.singing.has(lineIndex) ? " playing" : ""}${picked.has(lineIndex) ? " picked" : ""}`}
                onClick={(event) => {
                  if (
                    cursor.line !== lineIndex &&
                    !(event.target as Element).closest("button, input")
                  ) {
                    clickedLine.current = true;
                    setCursor(clampCursor(lines, { line: lineIndex, unit: 0 }));
                  }
                }}
              >
                <span className="ttml-card-number">{lineIndex + 1}</span>
                <div className="ttml-cells">
                  {line.units.map((unit, unitIndex) => {
                    const selected =
                      cursor.line === lineIndex && cursor.unit === unitIndex;
                    const live =
                      (liveWord?.line === lineIndex &&
                        liveWord.unit === unitIndex) ||
                      // The lit word's own line keeps its steadied pick.
                      (liveWord?.line !== lineIndex &&
                        liveWords.live.has(`${lineIndex}:${unitIndex}`));
                    return (
                      <button
                        key={unitIndex}
                        className={`ttml-unit${unit.joined ? " joined" : ""}${timed(unit) ? " timed" : unit.start !== undefined ? " started" : ""}${selected ? " selected" : ""}${live ? " live" : ""}`}
                        onClick={() => {
                          if (lineIndex !== cursor.line)
                            clickedLine.current = true;
                          setCursor({ line: lineIndex, unit: unitIndex });
                        }}
                        onDoubleClick={() => {
                          if (unit.start === undefined) return;
                          holdLine.current = lineIndex;
                          seek(unit.start - 1000);
                        }}
                        onContextMenu={(event) =>
                          openMenu(event, { line: lineIndex, unit: unitIndex })
                        }
                      >
                        <TimePill ms={unit.start} />
                        <span
                          className="ttml-word"
                          title={
                            syncRoman && unit.roman ? unit.text : undefined
                          }
                        >
                          {syncRoman && unit.roman ? unit.roman : unit.text}
                        </span>
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
            renderPreview ? (
              renderPreview(preview)
            ) : (
              <LyricsDisplay
                lyrics={preview}
                positionMs={position}
                settings={state.settings}
                onSeek={seek}
              />
            )
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
      {replacing && lines[replacing.line]?.units[replacing.unit] && (
        <ReplaceDialog
          word={lines[replacing.line].units[replacing.unit].text}
          onClose={() => setReplacing(null)}
          onConfirm={(choice) => confirmReplace(replacing, choice)}
        />
      )}
      {savesDialog}
      {editingKeys && (
        <KeysDialog
          mode={tab === "sync" ? "sync" : "lyrics"}
          keys={keys}
          onChange={changeKeys}
          onClose={() => setEditingKeys(false)}
        />
      )}
      {editingMeta && (
        <MetadataDialog
          entries={entries}
          onChange={changeMetadata}
          onReset={() => setMetadata(undefined)}
          onClose={() => setEditingMeta(false)}
        />
      )}
      {barSlot &&
        createPortal(
          <TtmlBar
            position={shownPosition}
            duration={track.duration_ms}
            playing={state.playback.is_playing}
            peaks={peaks?.uri === track.uri ? peaks.values : null}
            spectrum={
              <TtmlSpectrogram
                uri={track.uri}
                duration={track.duration_ms}
                position={shownPosition}
                playing={state.playback.is_playing || !!clipping}
                lines={lines}
                cursor={cursor}
                picked={picked}
                onSeek={seek}
                onLines={setLines}
                onCursor={setCursor}
                onPlayUnit={playUnit}
              />
            }
            spectrogram={spectrogram}
            onSpectrogram={showSpectrogram}
            spans={barSpans}
            onToggle={onToggle}
            onSeek={seek}
            onShowPlayer={() => onShowPlayer?.()}
            onClose={onClose}
            speed={shownSpeed}
            minSpeed={MIN_SPEED}
            maxSpeed={MAX_SPEED}
            speedEnabled={native}
            onSpeed={(value) => slideSpeed(clampSpeed(value))}
            volume={barVolume}
            onVolume={changeVolume}
            song={
              <>
                <Cover images={track.album.images} />
                <span>
                  <strong title={track.name}>{track.name}</strong>
                  <small>
                    {formatTime(track.duration_ms).replace(/\.\d+$/, "")}
                  </small>
                </span>
              </>
            }
          />,
          barSlot,
        )}
    </section>
  );
}
