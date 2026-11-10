import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRightToLine, Eye, EyeOff, Settings2 } from "lucide-react";
import { rpc } from "./bridge";
import {
  type CreatorLine,
  type Cursor,
  formatTime,
  lineSpan,
  moveEdge,
  panUnit,
} from "./ttml-creator-model";

const TILE_MS = 5000;
const DETAIL = [512, 1024, 2048, 4096, 8192];
const ROWS = 256;
const TOP_HZ = 20000;
// The backend sends levels as 16-bit fractions of this.
const LEVEL_SPAN = 4;
const RULER = 30;
const SNAP_PX = 7;
const MIN_ZOOM = 50;
const MAX_ZOOM = 10000;
const KEPT_TILES = 80;
const NOTES = "C C# D D# E F F# G G# A A# B".split(" ");

export type Palette = "icy" | "green" | "gray";
export const PALETTES: { id: Palette; name: string }[] = [
  { id: "icy", name: "Icy Blue" },
  { id: "green", name: "Green" },
  { id: "gray", name: "Grayscale" },
];

function hsl(hue: number, saturation: number, light: number) {
  const chroma = (1 - Math.abs(2 * light - 1)) * saturation;
  const sector = (((hue % 360) + 360) % 360) / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const [r, g, b] = [
    [chroma, second, 0],
    [second, chroma, 0],
    [0, chroma, second],
    [0, second, chroma],
    [second, 0, chroma],
    [chroma, 0, second],
  ][Math.min(5, Math.floor(sector))];
  const base = light - chroma / 2;
  return [r, g, b].map((part) => Math.round((part + base) * 255));
}

// Aegisub's colour schemes, which AMLL's TTML tool also offers.
function colour(palette: Palette, level: number) {
  if (palette === "gray") return [level * 255, level * 255, level * 255];
  if (palette === "green") return hsl(120, 1, Math.min(1, (200 * level) / 255));
  const hue = ((((-128 * level + 191) % 256) + 256) % 256) * (360 / 255);
  return hsl(hue, Math.min(255, 128 * level + 127) / 255, level);
}

export function paletteTable(palette: Palette) {
  const table = new Uint8ClampedArray(256 * 4);
  for (let index = 0; index < 256; index++)
    table.set([...colour(palette, index / 255), 255], index * 4);
  return table;
}

export const colourIndex = (encoded: number, gain: number) =>
  Math.min(255, Math.floor((encoded / 65535) * LEVEL_SPAN * gain * 255 + 0.5));

export function noteName(hz: number) {
  if (hz < 8) return "";
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  return `${NOTES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

export type VocalKind = "main" | "overlap" | "background";

/**
 * Header rows for each line's words: lead vocals share the top row, a lead
 * line whose words are sung over another's drops to the next free row, and
 * background vocals sit in rows under the lead lines they overlap. Overlap
 * counts timed words only; a line's span can reach past its last word.
 */
export function vocalLanes(
  lines: CreatorLine[],
): { lane: number; kind: VocalKind }[] {
  const words = lines.map((line) => {
    const timed = line.units.flatMap((unit) =>
      unit.start !== undefined &&
      unit.end !== undefined &&
      unit.end > unit.start
        ? [{ start: unit.start, end: unit.end }]
        : [],
    );
    const span = timed.length ? null : lineSpan(line);
    return span && span.end > span.start ? [span] : timed;
  });
  const clash = (a: number, b: number) =>
    words[a].some((one) =>
      words[b].some((two) => one.start < two.end && two.start < one.end),
    );
  const lanes = lines.map(() => ({ lane: 0, kind: "main" as VocalKind }));
  const order = (background: boolean) =>
    lines
      .map((line, index) => index)
      .filter(
        (index) =>
          lines[index].background === background && words[index].length,
      )
      .sort((a, b) => words[a][0].start - words[b][0].start);
  const place = (rows: number[][], index: number, from: number) => {
    let lane = from;
    while (rows[lane]?.some((other) => clash(index, other))) lane++;
    (rows[lane] ??= []).push(index);
    return lane;
  };
  const leads = order(false);
  const leadRows: number[][] = [];
  for (const index of leads) {
    const lane = place(leadRows, index, 0);
    lanes[index] = { lane, kind: lane ? "overlap" : "main" };
  }
  const backingRows: number[][] = [];
  for (const index of order(true)) {
    const under = leads
      .filter((other) => clash(index, other))
      .reduce((deepest, other) => Math.max(deepest, lanes[other].lane), 0);
    lanes[index] = {
      lane: place(backingRows, index, under + 1),
      kind: "background",
    };
  }
  return lanes;
}

export function rulerStep(zoom: number) {
  return (
    [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000].find(
      (ms) => (ms / 1000) * zoom >= 90,
    ) ?? 60000
  );
}

const tiles = new Map<string, Uint16Array>();
const asked = new Set<string>();
function keep(key: string, data: Uint16Array) {
  tiles.delete(key);
  tiles.set(key, data);
  while (tiles.size > KEPT_TILES) tiles.delete(tiles.keys().next().value!);
}

function stored<T>(
  key: string,
  fallback: T,
  valid: (value: unknown) => boolean,
) {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return valid(value) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Settings still apply for this session.
  }
}
function useStored<T>(
  key: string,
  fallback: T,
  valid: (value: unknown) => boolean,
) {
  const [value, setValue] = useState<T>(() => stored(key, fallback, valid));
  const set = (next: T) => {
    setValue(next);
    store(key, next);
  };
  return [value, set] as const;
}
const isNumber = (value: unknown) => typeof value === "number";
const isBoolean = (value: unknown) => typeof value === "boolean";

function Tile({
  data,
  columns,
  left,
  width,
  table,
  gain,
}: {
  data: Uint16Array;
  columns: number;
  left: number;
  width: number;
  table: Uint8ClampedArray;
  gain: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    const image = context.createImageData(columns, ROWS);
    for (let index = 0; index < columns * ROWS; index++) {
      const at = colourIndex(data[index], gain) * 4;
      image.data.set(table.subarray(at, at + 4), index * 4);
    }
    context.putImageData(image, 0, 0);
  }, [data, columns, table, gain]);
  return (
    <canvas
      ref={canvas}
      className="ttml-spectrum-tile"
      width={columns}
      height={ROWS}
      style={{ left, width }}
    />
  );
}

interface Drag {
  at: Cursor;
  edge: "start" | "end" | "word";
  from: number;
  x: number;
}

export function TtmlSpectrogram({
  uri,
  duration,
  position,
  playing,
  lines,
  cursor,
  picked,
  onSeek,
  onLines,
  onCursor,
  onPlayUnit,
}: {
  uri: string;
  duration: number;
  position: number;
  playing: boolean;
  lines: CreatorLine[];
  cursor: Cursor;
  picked: ReadonlySet<number>;
  onSeek: (ms: number) => void;
  onLines: (lines: CreatorLine[]) => void;
  onCursor: (at: Cursor) => void;
  onPlayUnit: (at: Cursor) => void;
}) {
  const [height, setHeight] = useStored(
    "lyssna.ttml-spectrum-height",
    240,
    isNumber,
  );
  const [gain, setGain] = useStored("lyssna.ttml-spectrum-gain", 3, isNumber);
  const [palette, setPalette] = useStored<Palette>(
    "lyssna.ttml-spectrum-palette",
    "icy",
    (value) => PALETTES.some((each) => each.id === value),
  );
  const [follow, setFollow] = useStored(
    "lyssna.ttml-spectrum-follow",
    true,
    isBoolean,
  );
  const [everyLine, setEveryLine] = useStored(
    "lyssna.ttml-spectrum-every-line",
    true,
    isBoolean,
  );
  const [zoom, setZoom] = useState(() =>
    stored("lyssna.ttml-spectrum-zoom", 200, isNumber),
  );
  const [scroll, setScroll] = useState(0);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [settings, setSettings] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [preview, setPreview] = useState<CreatorLine[] | null>(null);
  const [, setLoaded] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLCanvasElement>(null);
  const target = useRef({ zoom, scroll });
  const live = useRef({ zoom, scroll, width, duration });
  live.current = { zoom, scroll, width, duration };
  const frame = useRef<number | null>(null);

  const span = (atZoom: number) => (live.current.duration / 1000) * atZoom;
  const clampScroll = (value: number, atZoom: number) =>
    Math.max(0, Math.min(value, span(atZoom) - live.current.width));
  const glide = () => {
    if (frame.current !== null) return;
    const step = () => {
      const { zoom: nowZoom, scroll: nowScroll } = live.current;
      const goal = target.current;
      const nextZoom = nowZoom + (goal.zoom - nowZoom) * 0.35;
      const nextScroll = nowScroll + (goal.scroll - nowScroll) * 0.35;
      const done =
        Math.abs(nextZoom - goal.zoom) < 1 &&
        Math.abs(nextScroll - goal.scroll) < 1;
      setZoom(done ? goal.zoom : nextZoom);
      setScroll(done ? goal.scroll : nextScroll);
      live.current = {
        ...live.current,
        zoom: done ? goal.zoom : nextZoom,
        scroll: done ? goal.scroll : nextScroll,
      };
      if (done) {
        frame.current = null;
        store("lyssna.ttml-spectrum-zoom", goal.zoom);
      } else frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  };
  const jump = (value: number) => {
    target.current = {
      ...target.current,
      scroll: clampScroll(value, target.current.zoom),
    };
    glide();
  };
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(element);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const x = event.clientX - box.left;
      const goal = target.current;
      if (event.ctrlKey) {
        const at = (goal.scroll + x) / goal.zoom;
        const zoomTo = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, goal.zoom * (event.deltaY < 0 ? 1.15 : 0.85)),
        );
        target.current = {
          zoom: zoomTo,
          scroll: clampScroll(at * zoomTo - x, zoomTo),
        };
      } else {
        target.current = {
          ...goal,
          scroll: clampScroll(
            goal.scroll + event.deltaY + event.deltaX,
            goal.zoom,
          ),
        };
      }
      glide();
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      observer.disconnect();
      element.removeEventListener("wheel", wheel);
    };
  }, []);

  useEffect(() => {
    target.current = { zoom: target.current.zoom, scroll: 0 };
    setScroll(0);
    setFailed(null);
  }, [uri]);

  const shown = position;
  const last = useRef(position);
  useEffect(() => {
    const jumped = Math.abs(shown - last.current) > 1000;
    last.current = shown;
    if (!width || drag) return;
    const x = (shown / 1000) * target.current.zoom;
    const view = target.current.scroll;
    const outside = x < view || x > view + width - 24;
    if (outside && ((follow && playing) || jumped)) jump(x - width * 0.1);
  }, [shown, width, follow, playing]);

  const tilePx = (TILE_MS / 1000) * zoom;
  const detail = DETAIL.find((columns) => columns >= tilePx) ?? DETAIL.at(-1)!;
  const tileCount = Math.ceil(duration / TILE_MS);
  const firstTile = Math.max(0, Math.floor(scroll / tilePx) - 1);
  const lastTile = Math.min(
    tileCount - 1,
    Math.ceil((scroll + width) / tilePx) + 1,
  );
  const visible: { index: number; data: Uint16Array; columns: number }[] = [];
  for (let index = firstTile; width && index <= lastTile; index++) {
    const key = `${uri}|${index}|${detail}`;
    let data = tiles.get(key);
    let columns = detail;
    if (!data)
      for (const other of DETAIL) {
        const fallback = tiles.get(`${uri}|${index}|${other}`);
        if (fallback) {
          data = fallback;
          columns = other;
          break;
        }
      }
    if (data) visible.push({ index, data, columns });
  }
  useEffect(() => {
    if (!width || failed === uri) return;
    for (let index = firstTile; index <= lastTile; index++) {
      const key = `${uri}|${index}|${detail}`;
      if (tiles.has(key) || asked.has(key)) continue;
      asked.add(key);
      rpc<ArrayBuffer | number[]>("track_spectrogram", {
        uri,
        fromMs: index * TILE_MS,
        toMs: (index + 1) * TILE_MS,
        columns: detail,
        rows: ROWS,
      })
        .then((result) => {
          const data = Array.isArray(result)
            ? Uint16Array.from(result)
            : new Uint16Array(result);
          if (data.length === detail * ROWS) {
            keep(key, data);
            setLoaded((count) => count + 1);
          }
        })
        .catch(() => setFailed(uri))
        .finally(() => asked.delete(key));
    }
  }, [uri, firstTile, lastTile, detail, width, failed]);

  const table = useMemo(() => paletteTable(palette), [palette]);

  useLayoutEffect(() => {
    const element = ruler.current;
    const context = element?.getContext("2d");
    if (!element || !context || !width) return;
    const scale = devicePixelRatio;
    element.width = Math.round(width * scale);
    element.height = Math.round(RULER * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, RULER);
    const step = rulerStep(zoom);
    const minor = step / 5;
    const from = Math.floor(((scroll / zoom) * 1000) / minor) * minor;
    const to = ((scroll + width) / zoom) * 1000;
    context.font = "10px system-ui, sans-serif";
    context.textBaseline = "top";
    for (let ms = from; ms <= Math.min(to, duration); ms += minor) {
      const x = Math.round((ms / 1000) * zoom - scroll) + 0.5;
      const major = Math.abs(ms / step - Math.round(ms / step)) < 1e-6;
      context.fillStyle = major ? "#ffffff8c" : "#ffffff40";
      context.fillRect(x, major ? RULER - 12 : RULER - 5, 1, major ? 12 : 5);
      if (major) {
        context.fillStyle = "#ffffffb3";
        context.fillText(formatTime(Math.round(ms)), x + 3, 8);
      }
    }
  }, [zoom, scroll, width, duration]);

  const timeAt = (clientX: number) => {
    const box = area.current!.getBoundingClientRect();
    const x = Math.max(0, Math.min(box.width, clientX - box.left));
    return Math.max(0, Math.min(duration, ((scroll + x) / zoom) * 1000));
  };
  const scrub = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const up = (done: PointerEvent) => {
      window.removeEventListener("pointerup", up);
      onSeek(timeAt(done.clientX));
    };
    window.addEventListener("pointerup", up);
  };

  const grab = (event: React.PointerEvent, at: Cursor, edge: Drag["edge"]) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const from =
      lines[at.line]?.units[at.unit]?.[edge === "end" ? "end" : "start"];
    if (from === undefined) return;
    setDrag({ at, edge, from, x: event.clientX });
  };
  // Playback moves the playhead every frame; reading it through refs keeps
  // the drag listeners, and the edit in progress, alive while it plays.
  const dragging = useRef({ lines, zoom, position, onLines });
  dragging.current = { lines, zoom, position, onLines };
  useEffect(() => {
    if (!drag) return;
    let latest: CreatorLine[] | null = null;
    let moved = false;
    const move = (event: PointerEvent) => {
      const { lines, zoom, position } = dragging.current;
      const shift = event.clientX - drag.x;
      if (!moved && Math.abs(shift) < 3) return;
      moved = true;
      let time = drag.from + (shift / zoom) * 1000;
      if (
        !event.shiftKey &&
        Math.abs(((time - position) / 1000) * zoom) < SNAP_PX
      )
        time = position;
      latest =
        drag.edge === "word"
          ? panUnit(lines, drag.at, time)
          : moveEdge(lines, drag.at, drag.edge, time);
      setPreview(latest);
    };
    const up = () => {
      const { lines, onLines } = dragging.current;
      if (latest && latest !== lines) onLines(latest);
      setDrag(null);
      setPreview(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag]);

  const shownLines = preview ?? lines;
  const ms = (time: number) => (time / 1000) * zoom;
  const fromMs = (scroll / zoom) * 1000;
  const toMs = ((scroll + width) / zoom) * 1000;
  const lanes = useMemo(() => vocalLanes(shownLines), [shownLines]);
  const bands = shownLines.flatMap((line, lineIndex) => {
    const chosen = lineIndex === cursor.line || picked.has(lineIndex);
    const span = everyLine || chosen ? lineSpan(line) : null;
    return span && span.end >= fromMs && span.start <= toMs
      ? [{ key: lineIndex, ...span, chosen, background: line.background }]
      : [];
  });
  const segments = shownLines.flatMap((line, lineIndex) => {
    const chosen = lineIndex === cursor.line || picked.has(lineIndex);
    if (!everyLine && !chosen) return [];
    const timed = line.units.some(
      (unit) => unit.start !== undefined && unit.end !== undefined,
    );
    const span = timed ? null : lineSpan(line);
    // Line-synced lyrics only time the line, so it shows as one block.
    if (span)
      return span.end > span.start && span.end >= fromMs && span.start <= toMs
        ? [
            {
              key: `${lineIndex}:line`,
              ...lanes[lineIndex],
              at: { line: lineIndex, unit: 0 },
              text: line.units
                .map((unit, index) =>
                  index && !unit.joined ? ` ${unit.text}` : unit.text,
                )
                .join(""),
              start: span.start,
              end: span.end,
              roman: line.romanization,
              chosen,
              current: false,
              whole: true,
            },
          ]
        : [];
    return line.units.flatMap((unit, unitIndex) =>
      unit.start === undefined ||
      unit.end === undefined ||
      unit.end < fromMs ||
      unit.start > toMs
        ? []
        : [
            {
              key: `${lineIndex}:${unitIndex}`,
              ...lanes[lineIndex],
              at: { line: lineIndex, unit: unitIndex },
              text: unit.text,
              start: unit.start,
              end: unit.end,
              roman: unit.roman,
              chosen,
              current: lineIndex === cursor.line && unitIndex === cursor.unit,
              whole: false,
            },
          ],
    );
  });

  const resize = (event: React.PointerEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    let next = startHeight;
    const move = (moved: PointerEvent) => {
      next = Math.round(
        Math.max(120, Math.min(560, startHeight + startY - moved.clientY)),
      );
      setHeight(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      setHeight(next);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const hoverMs = hover ? ((scroll + hover.x) / zoom) * 1000 : 0;
  const plotHeight = height - RULER;
  const hoverHz =
    hover && hover.y > RULER
      ? (1 - (hover.y - RULER) / plotHeight) * TOP_HZ
      : null;
  const gainFill = ((gain - 0.5) / 7.5) * 100;

  return (
    <section
      className="ttml-spectrum"
      aria-label="Spectrogram"
      style={{ height }}
    >
      <div
        className="ttml-spectrum-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the spectrogram"
        onPointerDown={resize}
      />
      <div className="ttml-spectrum-side">
        <div className="ttml-spectrum-scale" style={{ top: RULER }}>
          {[20000, 15000, 10000, 5000].map((hz) => (
            <span key={hz} style={{ bottom: `${(hz / TOP_HZ) * 100}%` }}>
              {hz / 1000}k
            </span>
          ))}
        </div>
        <label className="ttml-spectrum-gain" title={`Gain ${gain}×`}>
          <input
            type="range"
            aria-label="Spectrogram gain"
            min={0.5}
            max={8}
            step={0.5}
            value={gain}
            style={{ ["--fill" as string]: `${gainFill}%` }}
            onChange={(event) => setGain(Number(event.target.value))}
          />
          <output>{gain}×</output>
        </label>
      </div>
      <div
        ref={area}
        className="ttml-spectrum-main"
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setHover({ x: event.clientX - box.left, y: event.clientY - box.top });
        }}
        onPointerLeave={() => setHover(null)}
        onContextMenu={(event) => event.preventDefault()}
      >
        <canvas
          ref={ruler}
          className="ttml-spectrum-ruler"
          role="slider"
          aria-label="Spectrogram position"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={Math.round(position)}
          onPointerDown={scrub}
        />
        <div className="ttml-spectrum-plot" onPointerDown={scrub}>
          <div
            className="ttml-spectrum-content"
            style={{
              width: Math.ceil(span(zoom)),
              transform: `translate3d(${-scroll}px, 0, 0)`,
            }}
          >
            {visible.map((tile) => (
              <Tile
                key={tile.index}
                data={tile.data}
                columns={tile.columns}
                left={tile.index * tilePx}
                width={tilePx}
                table={table}
                gain={gain}
              />
            ))}
            {bands.map((band) => (
              <div
                key={band.key}
                className={`ttml-spectrum-line${band.chosen ? " chosen" : ""}${band.background ? " background" : ""}`}
                style={{
                  left: ms(band.start),
                  width: Math.max(1, ms(band.end) - ms(band.start)),
                }}
              />
            ))}
            {segments.map((segment) => (
              <div
                key={segment.key}
                className={`ttml-spectrum-word ${segment.kind}${segment.whole ? " whole" : ""}${segment.chosen ? " chosen" : ""}${segment.current ? " current" : ""}`}
                style={
                  {
                    left: ms(segment.start),
                    width: Math.max(1, ms(segment.end) - ms(segment.start)),
                    "--lane": segment.lane,
                  } as React.CSSProperties
                }
                title={`${segment.text} ${formatTime(segment.start)} – ${formatTime(segment.end)}`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  onCursor(segment.at);
                  if (!segment.whole) grab(event, segment.at, "word");
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onPlayUnit(segment.at);
                }}
              >
                <div className="ttml-spectrum-head">
                  {segment.roman && <small>{segment.roman}</small>}
                  <span>{segment.text}</span>
                </div>
                {!segment.whole && (
                  <>
                    <i
                      className="ttml-spectrum-edge start"
                      aria-label={`Move the start of ${segment.text}`}
                      onPointerDown={(event) =>
                        grab(event, segment.at, "start")
                      }
                    />
                    <i
                      className="ttml-spectrum-edge end"
                      aria-label={`Move the end of ${segment.text}`}
                      onPointerDown={(event) => grab(event, segment.at, "end")}
                    />
                  </>
                )}
              </div>
            ))}
            <div
              className="ttml-spectrum-playhead"
              style={{ left: ms(position) }}
            />
            {hover && !drag && (
              <div
                className="ttml-spectrum-hover"
                style={{ left: scroll + hover.x }}
              />
            )}
          </div>
          {!visible.length && (
            <p className="ttml-spectrum-empty">
              {failed === uri
                ? "No spectrogram for this song."
                : "Drawing the spectrogram…"}
            </p>
          )}
        </div>
        {hover && !drag && (
          <div className="ttml-spectrum-tip" style={{ left: hover.x }}>
            {formatTime(Math.round(hoverMs))}
            {hoverHz !== null &&
              ` (${(hoverHz / 1000).toFixed(2)} kHz / ${noteName(hoverHz)})`}
          </div>
        )}
      </div>
      <div className="ttml-spectrum-tools">
        <button
          className={`ttml-spectrum-tool${everyLine ? " on" : ""}`}
          aria-pressed={everyLine}
          aria-label="Show every line"
          title={everyLine ? "Showing every line" : "Showing the chosen lines"}
          onClick={() => setEveryLine(!everyLine)}
        >
          {everyLine ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
        <button
          className={`ttml-spectrum-tool${follow ? " on" : ""}`}
          aria-pressed={follow}
          aria-label="Follow playback"
          title="Keep the playhead in view while playing"
          onClick={() => setFollow(!follow)}
        >
          <ArrowRightToLine size={15} />
        </button>
        <div className="ttml-spectrum-settings">
          <button
            className={`ttml-spectrum-tool${settings ? " on" : ""}`}
            aria-expanded={settings}
            aria-label="Spectrogram colours"
            title="Spectrogram colours"
            onClick={() => setSettings(!settings)}
          >
            <Settings2 size={15} />
          </button>
          {settings && (
            <div
              className="ttml-spectrum-menu"
              role="menu"
              aria-label="Colours"
            >
              {PALETTES.map((each) => (
                <button
                  key={each.id}
                  role="menuitemradio"
                  aria-checked={palette === each.id}
                  onClick={() => {
                    setPalette(each.id);
                    setSettings(false);
                  }}
                >
                  <i
                    style={{
                      background: `linear-gradient(90deg, ${[
                        0, 0.25, 0.5, 0.75, 1,
                      ]
                        .map(
                          (level) => `rgb(${colour(each.id, level).join(",")})`,
                        )
                        .join(",")})`,
                    }}
                  />
                  {each.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
