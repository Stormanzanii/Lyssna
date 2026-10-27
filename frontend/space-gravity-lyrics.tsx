import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  lineBlur,
  tuneMotion,
  vocalGap,
  wordGroups,
  type AnimatedWord,
} from "./lyric-motion";
import type { AnimatorSettings } from "./animator-tuning";
import { LyricAnimator } from "./lyric-animator";
import { LyricWord } from "./lyric-word";
import { LyricCountdown } from "./lyric-countdown";
import {
  createBody,
  GRAVITY,
  gravityPieces,
  hash,
  lineLayout,
  random,
  measure,
  spawn,
  speedMultiplier,
  staticLayout,
  step,
  trackWindow,
  visibleWordCount,
  wordWindow,
  type Body,
  type Field,
  type Rect,
  type WindowMotion,
} from "./space-gravity";
import { windowPosition } from "./window-activity";
import type { Line, Lyrics } from "./types";
import { HighlighterWords } from "./highlighter";
import { frameDue } from "./frame-cap";

interface Entity {
  key: string;
  text: string;
  /** Source line index, and the syllables to animate like normal lyrics. */
  line: number;
  words: AnimatedWord[];
  /** The word as a line of its own, for the Highlighter's pen. */
  ink: Line;
  start: number;
  end: number;
  /** Lead line ordinal this word belongs to (backing vocals use their parent). */
  lead: number;
  /** Position within its line, for the spawn layout. */
  slot: number;
  slots: number;
  /** Index across all lead words, or -1 for backing vocals. */
  index: number;
  background: boolean;
  opposite: boolean;
  seed: number;
  speed: number;
}
interface LeadLine {
  start: number;
  end: number;
  first: number;
  count: number;
}

/** Groups shown words by their source line, keeping first-seen order. */
function groupByLine(entities: Entity[]) {
  const groups = new Map<number, Entity[]>();
  for (const entity of entities) {
    const group = groups.get(entity.line) ?? [];
    group.push(entity);
    groups.set(entity.line, group);
  }
  return [...groups.entries()];
}

/** Splits lyrics into floating word entities grouped by lead line. */
export function prepareGravity(lyrics: Lyrics) {
  const entities: Entity[] = [];
  const leads: LeadLine[] = [];
  let total = 0;
  for (const [lineIndex, line] of lyrics.lines.entries()) {
    if (!line.words.length) continue;
    if (!line.background || !leads.length)
      leads.push({
        start: line.start_ms,
        end: line.end_ms,
        first: total,
        count: 0,
      });
    const lead = leads.length - 1;
    const pieces = wordGroups(line.words).flatMap(gravityPieces);
    const speed = speedMultiplier(line.words.map((word) => word.start_ms));
    for (const [slot, piece] of pieces.entries()) {
      const { text } = piece;
      if (!text) continue;
      const background = line.background && lead >= 0;
      // A trailing space inside a rotated word's paint box draws a dotted
      // hairline past its last letter; floating words need no spacing.
      const words = piece.words.map((word, index, all) =>
        index === all.length - 1
          ? { ...word, text: word.text.trimEnd() }
          : word,
      );
      entities.push({
        key: `${lineIndex}:${slot}`,
        text,
        line: lineIndex,
        words,
        ink: {
          ...line,
          start_ms: piece.start,
          end_ms: piece.end,
          text: words.map((word) => word.text).join(""),
          words,
        },
        start: piece.start,
        end: piece.end,
        lead,
        slot,
        slots: pieces.length,
        index: background ? -1 : total,
        background,
        opposite: line.opposite,
        seed: hash(`${line.start_ms}:${line.end_ms}:${text}:${slot}`),
        speed,
      });
      if (!background) {
        total += 1;
        leads[lead].count += 1;
      }
    }
  }
  const finalEnd = entities
    .filter((entity) => !entity.background)
    .reduce((end, entity) => Math.max(end, entity.end), -Infinity);
  return { entities, leads, total, finalEnd };
}

type Role = "current" | "next" | "previous";
export function gravityRole(
  entity: Entity,
  lead: LeadLine,
  time: number,
  finalEnd: number,
): Role {
  if (time >= finalEnd) return "previous";
  if (entity.background)
    return time < entity.start
      ? "next"
      : time < entity.end
        ? "current"
        : "previous";
  if (time >= lead.start && time < lead.end) return "current";
  return time < lead.start ? "next" : "previous";
}

/** Lead line and word the window centres on: the one sung or coming next. */
export function gravityAnchor(
  prepared: ReturnType<typeof prepareGravity>,
  time: number,
) {
  const { leads, entities } = prepared;
  if (!leads.length) return { line: -1, word: Number.NaN };
  let line = leads.findIndex((lead) => time < lead.end);
  if (line < 0) line = leads.length - 1;
  const words = entities.filter(
    (entity) => entity.lead === line && !entity.background,
  );
  const word =
    words.find((entity) => time >= entity.start && time < entity.end) ??
    words.find((entity) => time < entity.start) ??
    words.at(-1);
  return { line, word: word?.index ?? Number.NaN };
}

/** Words to show: a window around the sung word plus its line and backing. */
export function visibleGravity(
  prepared: ReturnType<typeof prepareGravity>,
  time: number,
  count: number,
) {
  const anchor = gravityAnchor(prepared, time);
  const range = wordWindow(anchor.word, prepared.total, count);
  const lines = new Set<number>();
  if (anchor.line >= 0) lines.add(anchor.line);
  for (const entity of prepared.entities)
    if (
      range &&
      !entity.background &&
      entity.index >= range.first &&
      entity.index <= range.last
    )
      lines.add(entity.lead);
  return prepared.entities.filter(
    (entity) =>
      (entity.background && lines.has(entity.lead)) ||
      entity.lead === anchor.line ||
      (!!range && entity.index >= range.first && entity.index <= range.last),
  );
}

function relative(element: Element | null | undefined, stage: DOMRect) {
  const rect = element?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return undefined;
  return {
    left: rect.left - stage.left,
    top: rect.top - stage.top,
    right: rect.right - stage.left,
    bottom: rect.bottom - stage.top,
  };
}
const union = (rects: (Rect | undefined)[]) =>
  rects.reduce<Rect | undefined>(
    (all, rect) =>
      !rect
        ? all
        : !all
          ? rect
          : {
              left: Math.min(all.left, rect.left),
              top: Math.min(all.top, rect.top),
              right: Math.max(all.right, rect.right),
              bottom: Math.max(all.bottom, rect.bottom),
            },
    undefined,
  );
const contains = (outer: Rect | undefined, inner: Rect | undefined) =>
  !!outer &&
  !!inner &&
  outer.left <= inner.left &&
  outer.top <= inner.top &&
  outer.right >= inner.right &&
  outer.bottom >= inner.bottom;

/** Where words may float on this page, as the fork measures it: the whole
 * page above the credits. Over Canvas only the song details and controls
 * block words; otherwise words also drift around the artwork, above it and
 * below the title. Lines start laid out in the lyrics column. */
function measureField(stage: HTMLElement): Field {
  const box = stage.getBoundingClientRect();
  const page = stage.closest(".lyrics-page");
  const bounds = { width: stage.clientWidth, height: stage.clientHeight };
  const canvas =
    !!page?.matches(".canvas-lyrics:not(.narrow)") &&
    !page.matches(".no-artwork");
  const footer = relative(page?.querySelector(".gravity-credits"), box);
  const column = relative(page?.querySelector(".lyrics-body"), box);
  const area = { left: 0, top: 0, right: bounds.width, bottom: bounds.height };
  area.bottom = Math.min(area.bottom, footer?.top ?? area.bottom);
  const toolbar = relative(page?.querySelector(".lyrics-toolbar"), box);
  // Title and artists sit together; the full screen controls can be far
  // from them (over a canvas, title bottom left and controls top left), so
  // they block on their own rather than as one box across the page.
  const dock = union(
    [".lyrics-title", ".lyrics-artists"].map((selector) =>
      relative(page?.querySelector(selector), box),
    ),
  );
  const controls = relative(
    page?.querySelector(".lyrics-fullscreen-controls"),
    box,
  );
  const cover = canvas
    ? undefined
    : relative(
        page?.querySelector(".lyrics-media .cover") ??
          page?.querySelector(".lyrics-media"),
        box,
      );
  return {
    bounds,
    area,
    layout: column && {
      ...column,
      bottom: Math.min(column.bottom, area.bottom),
    },
    footer,
    cover,
    blockers: [
      dock,
      controls,
      contains(dock, toolbar) ||
      contains(controls, toolbar) ||
      contains(cover, toolbar)
        ? undefined
        : toolbar,
    ].filter((rect): rect is Rect => !!rect),
  };
}

type GravityBody = Body & { spawned: boolean; entryFrame?: number };

let kept: { signature: string; bodies: Map<string, GravityBody> } | undefined;

const SVG = "http://www.w3.org/2000/svg";
let linkCount = 0;

/** A drawn link's elements and state, kept per sheet so frames never
 *  search the DOM for them. */
interface Link {
  path: SVGPathElement;
  gradient: SVGLinearGradientElement;
  stops: SVGStopElement[];
  /** How far the pen has drawn, 0 to 1, and when it last moved. */
  drawn: number;
  at: number;
  /** Each half's eased strength. */
  strengths: [number, number];
  leaving: boolean;
  /** The two words it joins, and the seed that sets its swing. */
  from: string;
  to: string;
  seed: number;
}
const sheets = new WeakMap<SVGSVGElement, Map<string, Link>>();

/** How strongly a word shows, from its role, the way the stylesheet sets
 *  its opacity; read from classes, never computed style, so no frame
 *  forces a style recalculation. */
function strengthOf(entity: Entity, elements: Map<string, HTMLElement>) {
  const classes = elements.get(entity.key)?.classList;
  if (!classes || classes.contains("exiting")) return 0;
  return classes.contains("current")
    ? 1
    : classes.contains("next")
      ? 0.34
      : 0.22;
}

/** Where a turned, scaled word's left or right edge meets its middle,
 *  drawn in by `inset` pixels. */
function edge(body: Body, side: -1 | 1, inset = 0) {
  const angle = (body.angle * Math.PI) / 180,
    reach = side * Math.max(0, (body.width * body.scale) / 2 - inset);
  return {
    x: body.x + Math.cos(angle) * reach,
    y: body.y + Math.sin(angle) * reach,
  };
}

/** How long before its word starts a link lands, so the word's ink sets
 *  off from the line. */
const LANDS_EARLY_MS = 100;

/** The shortest pause between lines that shows the waiting dots. */
const BREAK_MS = 2500;

/** Eases in and out, so a link's pen starts and lands softly. */
const ease = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

/** Lays a link along the edges of its two words as they drift. */
function shapeLink(link: Link, a: Body, b: Body, width: number) {
  const { path, gradient } = link;
  // As broad as the Highlighter's band on the smaller of the two words.
  const stroke =
    Math.min(a.height * a.scale, b.height * b.scale) * 0.84 * width;
  // Each end tucks under its word's ink, so line and words read as one
  // unbroken stroke.
  const start = edge(a, 1, stroke / 2),
    end = edge(b, -1, stroke / 2);
  const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
  // Leave and arrive along each word's slant, with a seeded lift so
  // links swing their own way.
  const reach = Math.min(160, length * 0.45);
  const lift = ((link.seed % 200) / 100 - 1) * 0.5;
  const out = ((a.angle + lift * 30) * Math.PI) / 180,
    into = ((b.angle - lift * 30) * Math.PI) / 180;
  const c1 = {
      x: start.x + Math.cos(out) * reach,
      y: start.y + Math.sin(out) * reach,
    },
    c2 = {
      x: end.x - Math.cos(into) * reach,
      y: end.y - Math.sin(into) * reach,
    };
  const point = (p: { x: number; y: number }) =>
    `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  path.setAttribute(
    "d",
    `M${point(start)}C${point(c1)} ${point(c2)} ${point(end)}`,
  );
  path.style.strokeWidth = `${stroke.toFixed(1)}px`;
  gradient.setAttribute("x1", start.x.toFixed(1));
  gradient.setAttribute("y1", start.y.toFixed(1));
  gradient.setAttribute("x2", end.x.toFixed(1));
  gradient.setAttribute("y2", end.y.toFixed(1));
}

/** With the Highlighter on, a marker line runs from each sung word to the
 *  next one in the line being sung, drawn across the pause between them
 *  like brainstorm notes. It leaves each word along its own slant, so the
 *  curve flows between them, and follows both as they drift. The line
 *  before keeps its links, joined into the sung line; older ones fade
 *  away. */
function drawLinks(
  sheet: SVGSVGElement,
  entities: Entity[],
  bodies: Map<string, GravityBody>,
  elements: Map<string, HTMLElement>,
  time: number,
  width: number,
) {
  // Words fading out still carry their links, which fade with them.
  const lead = entities.filter(
    (entity) => entity.index >= 0 && elements.has(entity.key),
  );
  // A link sets off only once the word before is fully inked, and lands
  // just before its word is sung, so that word's ink starts from the line.
  // Words sung back to back leave no time: the link then shows whole the
  // moment the word before finishes.
  const setsOff = (from: Entity) => from.end;
  const lands = (from: Entity, to: Entity) =>
    Math.max(from.end, to.start - LANDS_EARLY_MS);
  // The latest line under way, counting the link drawing into it, and the
  // line before it keep their links.
  let current = -1;
  lead.forEach((entity, index) => {
    const before = lead[index - 1];
    if (
      entity.start <= time ||
      (before && before.index + 1 === entity.index && setsOff(before) <= time)
    )
      current = Math.max(current, entity.lead);
  });
  const now = performance.now();
  const wanted = new Set<string>();
  let drawn = sheets.get(sheet);
  if (!drawn) sheets.set(sheet, (drawn = new Map()));
  for (let index = 1; index < lead.length; index++) {
    const from = lead[index - 1],
      to = lead[index];
    const finish = lands(from, to),
      begin = setsOff(from);
    // Links within the sung line and the one before, and the link from
    // that earlier line into the sung one.
    const within =
      from.lead === to.lead && (to.lead === current || to.lead === current - 1);
    const across = from.lead === current - 1 && to.lead === current;
    if (!(within || across) || to.index !== from.index + 1 || time < begin)
      continue;
    const a = bodies.get(from.key),
      b = bodies.get(to.key);
    if (!a?.spawned || !b?.spawned) continue;
    const key = `${from.key}>${to.key}`;
    wanted.add(key);
    let link = drawn.get(key);
    if (!link) {
      const path = document.createElementNS(SVG, "path");
      path.dataset.link = key;
      path.setAttribute("pathLength", "1");
      // Each link's own gradient carries its two words' strengths.
      const id = `gravity-link-${(linkCount += 1)}`;
      const gradient = document.createElementNS(SVG, "linearGradient");
      gradient.id = id;
      gradient.setAttribute("gradientUnits", "userSpaceOnUse");
      // The two halves blend across the middle third.
      const stops = ["0", "0.33", "0.67", "1"].map((offset) => {
        const stop = document.createElementNS(SVG, "stop");
        stop.setAttribute("offset", offset);
        gradient.append(stop);
        return stop;
      });
      path.dataset.gradient = id;
      path.style.stroke = `url(#${id})`;
      sheet.append(gradient, path);
      link = {
        path,
        gradient,
        stops,
        drawn: 0,
        at: now,
        strengths: [strengthOf(from, elements), strengthOf(to, elements)],
        leaving: false,
        from: from.key,
        to: to.key,
        seed: from.seed,
      };
      drawn.set(key, link);
    }
    if (link.leaving) {
      link.leaving = false;
      link.path.classList.remove("leaving");
    }
    shapeLink(link, a, b, width);
    const elapsed = Math.min(100, now - link.at);
    link.at = now;
    // The link dims with its words: each half eases toward its own word's
    // strength, matching that word's ink, so a link from a dim word to the
    // sung one is half and half.
    // Across a break long enough for the waiting dots, both words are dim,
    // so the link drawing over it shows brighter, still split in two.
    const pause = across && time < finish && to.start - from.end >= BREAK_MS;
    const settle = 1 - Math.exp(-elapsed / 120);
    [from, to].forEach((entity, side) => {
      const strength = strengthOf(entity, elements);
      const goal = pause ? Math.min(1, strength * 2.5) : strength;
      const opacity = (link.strengths[side] +=
        (goal - link.strengths[side]) * settle).toFixed(2);
      for (const stop of link.stops.slice(side * 2, side * 2 + 2)) {
        if (stop.getAttribute("stop-opacity") !== opacity)
          stop.setAttribute("stop-opacity", opacity);
      }
    });
    // The pen follows song time softly, so coarse time updates don't step,
    // but it is always whole once it should have landed.
    const target =
      time >= finish
        ? 1
        : ease(Math.max(0, (time - begin) / Math.max(1, finish - begin)));
    link.drawn =
      target === 1
        ? 1
        : link.drawn + (target - link.drawn) * (1 - Math.exp(-elapsed / 35));
    link.path.style.strokeDashoffset = `${(1 - link.drawn).toFixed(3)}`;
  }
  for (const [key, link] of drawn) {
    if (wanted.has(key)) continue;
    // A fading link keeps following its words while they drift.
    const a = bodies.get(link.from),
      b = bodies.get(link.to);
    if (a?.spawned && b?.spawned) shapeLink(link, a, b, width);
    if (link.leaving) continue;
    link.leaving = true;
    link.path.classList.add("leaving");
    setTimeout(() => {
      if (!link.leaving) return;
      link.gradient.remove();
      link.path.remove();
      drawn.delete(key);
    }, 1300);
  }
}

/** One floating word. Memoised: while a song plays only the words whose
 *  role or ink changes re-render, not every word on every frame. */
const GravityWord = memo(function GravityWord({
  entity,
  role,
  exiting,
  highlighter,
  inkTime,
  wordRef,
  onSeek,
}: {
  entity: Entity;
  role: Role;
  exiting: boolean;
  highlighter: boolean;
  /** Song time for the Highlighter's pen: -Infinity before the word,
   *  Infinity after it, so only the sung word changes per frame. */
  inkTime: number;
  wordRef: (element: HTMLElement | null) => void;
  onSeek: (position: number) => void;
}) {
  return (
    <button
      ref={wordRef}
      className={`gravity-word ${role} ${entity.opposite ? "opposite" : ""} ${entity.background ? "background" : ""} ${exiting ? "exiting" : ""}`}
      onClick={() => onSeek(entity.start)}
      tabIndex={exiting ? -1 : 0}
    >
      {highlighter ? (
        <HighlighterWords line={entity.ink} time={inkTime} />
      ) : (
        <LyricWord words={entity.words} />
      )}
    </button>
  );
});

/** Space Gravity: sung words float in zero gravity around the artwork. */
export function SpaceGravityLyrics({
  lyrics,
  time,
  reduceMotion,
  tuning,
  onSeek,
  credits,
  highlighter,
  linkWidth = 1,
}: {
  lyrics: Lyrics;
  time: number;
  reduceMotion: boolean;
  /** The Highlighter's ink colour: each word gets its pen instead of the
   *  usual sweep. */
  highlighter?: string;
  /** Connecting lines' width as a share of the Highlighter's band; 0
   *  turns them off. */
  linkWidth?: number;
  tuning?: AnimatorSettings;
  onSeek: (position: number) => void;
  credits: ReactNode;
}) {
  // The same lyrics can arrive again (cached, then fetched) when a song
  // comes back; only new words start the field over.
  const signature = useMemo(() => JSON.stringify(lyrics.lines), [lyrics]);
  const prepared = useMemo(
    () => prepareGravity(lyrics),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature],
  );
  const gap = vocalGap(lyrics.lines, time);
  const waitKey = gap ? `wait:${gap.start}:${gap.end}` : "";
  const stage = useRef<HTMLDivElement>(null);
  // Lead words that fit the free play area; measured by the frame loop.
  const [count, setCount] = useState<number>(GRAVITY.minVisibleWords);
  const visible = visibleGravity(prepared, time, count);
  const visibleKeys = visible.map((entity) => entity.key).join("|");
  // Words that just left stay a moment to fade out.
  const [leaving, setLeaving] = useState<Entity[]>([]);
  const previous = useRef<Entity[]>([]);
  useEffect(() => {
    const now = new Set(visible.map((entity) => entity.key));
    const gone = previous.current.filter((entity) => !now.has(entity.key));
    previous.current = visible;
    if (!gone.length) return;
    setLeaving((current) => [
      ...current.filter((entity) => !now.has(entity.key)),
      ...gone,
    ]);
    const timer = setTimeout(
      () =>
        setLeaving((current) =>
          current.filter((entity) => !gone.includes(entity)),
        ),
      GRAVITY.presenceFadeMs + 40,
    );
    return () => clearTimeout(timer);
    // visibleKeys captures every change to the visible set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKeys]);
  const anchorLine = gravityAnchor(prepared, time).line;
  const shown = [
    ...visible,
    ...leaving.filter((entity) => !visible.includes(entity)),
  ];

  const elements = useRef(new Map<string, HTMLElement>());
  // Words keep their places when the view remounts for the same lyrics,
  // as when a song briefly loses and regains its lyrics.
  const [restored] = useState(() => {
    if (kept?.signature !== signature) return new Map<string, GravityBody>();
    for (const body of kept.bodies.values()) body.entryFrame = 0;
    return kept.bodies;
  });
  const bodies = useRef(restored);
  const fieldOf = useRef(signature);
  const live = useRef({
    visible,
    prepared,
    reduceMotion,
    waitKey,
    time,
    highlighter,
    linkWidth,
  });
  live.current = {
    visible,
    prepared,
    reduceMotion,
    waitKey,
    time,
    highlighter,
    linkWidth,
  };
  const links = useRef<SVGSVGElement>(null);
  // A stable seek handler, so floating words skip re-rendering.
  const seekTo = useRef(onSeek);
  seekTo.current = onSeek;
  const [seek] = useState(() => (position: number) => seekTo.current(position));
  useEffect(() => {
    // A new song starts every word fresh.
    if (fieldOf.current === signature) return;
    fieldOf.current = signature;
    bodies.current.clear();
    refs.current.clear();
  }, [signature]);
  useEffect(
    () => () => {
      kept = { signature: fieldOf.current, bodies: bodies.current };
    },
    [],
  );
  // One stable ref callback per word. An inline callback would be detached
  // and reattached on every render (every frame while playing), and its
  // cleanup would respawn the word each time.
  const refs = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const refFor = (key: string) => {
    let callback = refs.current.get(key);
    if (!callback) {
      callback = (element) => {
        if (element) elements.current.set(key, element);
        else elements.current.delete(key);
      };
      refs.current.set(key, callback);
    }
    return callback;
  };

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    let frame = 0,
      renderFrame = 0,
      last = performance.now(),
      fieldAt = 0,
      field: Field | undefined,
      staticKey = "";
    const motion: WindowMotion = { vx: 0, vy: 0 };
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (!frameDue(last, now)) return;
      renderFrame += 1;
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      if (element.clientWidth < 1 || element.clientHeight < 1) return;
      let measured = false;
      if (!field || now - fieldAt > 250) {
        fieldAt = now;
        measured = true;
        field = measureField(element);
        const next = visibleWordCount(field);
        setCount((current) => (current === next ? current : next));
      }
      const { visible, prepared, reduceMotion, waitKey } = live.current;
      const byKey = new Map(prepared.entities.map((item) => [item.key, item]));
      const shownKeys = new Set(visible.map((entity) => entity.key));
      if (waitKey) shownKeys.add(waitKey);
      for (const [key, node] of elements.current) {
        const entity = byKey.get(key);
        let body = bodies.current.get(key);
        if (!body) {
          body = {
            ...createBody(
              entity?.seed ?? hash(key),
              entity?.speed ?? 1,
              entity ? prepared.leads[entity.lead].start : 0,
              entity ? prepared.entities.indexOf(entity) : -1,
            ),
            spawned: false,
          };
          bodies.current.set(key, body);
        }
        if (node.offsetWidth)
          measure(body, node.offsetWidth, node.offsetHeight);
      }
      // Each new word starts near its place in its line, laid out across
      // the play area and centred in it, then drifts from there.
      // Beside artwork, words start in the lyrics column. Over a canvas
      // nothing needs dodging, so they start spread across the stage.
      const spread = !field.cover && !!element.closest(".canvas-lyrics");
      const area = spread ? field.area! : (field.layout ?? field.area!);
      const lines = new Map<string, string[]>();
      for (const key of shownKeys) {
        if (!elements.current.has(key)) continue;
        const line = key === waitKey ? key : String(byKey.get(key)?.line);
        lines.set(line, [...(lines.get(line) ?? []), key]);
      }
      const occupied: GravityBody[] = [];
      for (const [key, body] of bodies.current)
        if (body.spawned && elements.current.has(key)) occupied.push(body);
      for (const keys of lines.values()) {
        const members = keys.map((key) => bodies.current.get(key)!);
        if (members.every((body) => body.spawned)) continue;
        const width = area.right - area.left - GRAVITY.edgePadding * 2;
        const layout = lineLayout(
          members,
          width,
          !!byKey.get(keys[0])?.opposite,
          spread ? Math.max(...members.map((body) => body.height)) * 1.1 : 0,
        );
        // Spread lines each start at their own seeded spot across the
        // stage, so lines don't all pile up from the middle and get pushed
        // to one side.
        const placeX = spread ? random(hash(`${keys[0]}:x`)) * 2 - 1 : 0,
          placeY = spread ? random(hash(`${keys[0]}:y`)) * 2 - 1 : 0;
        const edges = layout.places.map((place, index) => [
          place.x - members[index].width / 2,
          place.x + members[index].width / 2,
        ]);
        const rowWidth =
          Math.max(...edges.map(([, right]) => right)) -
          Math.min(...edges.map(([left]) => left));
        const slackX = Math.max(0, width - rowWidth) / 2,
          slackY = Math.max(0, area.bottom - area.top - layout.height) / 2;
        const top =
          area.top +
          (area.bottom - area.top - layout.height) / 2 +
          placeY * slackY * 0.8;
        members.forEach((body, index) => {
          body.naturalX =
            area.left +
            GRAVITY.edgePadding +
            layout.places[index].x +
            placeX * slackX * 0.8;
          body.naturalY = top + layout.places[index].y;
        });
        for (const body of members) {
          if (body.spawned) continue;
          spawn(body, occupied, field, reduceMotion);
          body.spawned = true;
          body.entryFrame = renderFrame;
          occupied.push(body);
        }
      }
      const active: GravityBody[] = [],
        exiting: GravityBody[] = [];
      for (const [key, body] of bodies.current) {
        if (!body.spawned || !elements.current.has(key)) continue;
        (shownKeys.has(key) ? active : exiting).push(body);
      }
      if (reduceMotion) {
        const key = [...lines.values()].flat().join("|");
        if (key !== staticKey || measured) {
          staticKey = key;
          staticLayout(
            [...lines.values()].map((keys) =>
              keys.map((key) => bodies.current.get(key)!),
            ),
            field,
          );
        }
      } else {
        trackWindow(
          motion,
          windowPosition() ?? { x: window.screenX, y: window.screenY },
          dt,
        );
        step(active, dt, field, motion, exiting);
      }
      // Words that left the screen start fresh when they return.
      for (const key of bodies.current.keys())
        if (!elements.current.has(key)) bodies.current.delete(key);
      for (const [key, node] of elements.current) {
        const body = bodies.current.get(key);
        if (!body?.spawned) continue;
        node.style.transform = `translate3d(${body.x - body.width / 2}px, ${body.y - body.height / 2}px, 0) rotate(${body.angle}deg) scale(${body.scale})`;
      }
      if (links.current)
        drawLinks(
          links.current,
          live.current.highlighter && live.current.linkWidth > 0
            ? prepared.entities
            : [],
          bodies.current,
          elements.current,
          live.current.time,
          live.current.linkWidth,
        );
      for (const [key, node] of elements.current) {
        const body = bodies.current.get(key);
        if (!body?.spawned) continue;
        // Shown a frame after placing, so it fades in where it spawned.
        if (
          !node.hasAttribute("data-spawned") &&
          (reduceMotion || (body.entryFrame ?? 0) < renderFrame)
        )
          node.setAttribute("data-spawned", "");
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  // The normal lyrics animator drives the syllables, exactly as in the
  // regular lyrics view.
  const animator = useRef<LyricAnimator>(undefined);
  const tuningKey = JSON.stringify(tuning ?? {});
  useLayoutEffect(() => {
    tuneMotion(JSON.parse(tuningKey));
    const instance = new LyricAnimator(
      lyrics,
      (index) =>
        stage.current?.querySelector<HTMLElement>(
          `.gravity-line[data-line="${index}"]`,
        ) ?? null,
      reduceMotion,
    );
    animator.current = instance;
    return () => instance.dispose();
  }, [lyrics, reduceMotion, tuningKey]);
  const lastTime = useRef(time);
  useLayoutEffect(() => {
    // A seek jumps song time; snap instead of springing through it.
    if (Math.abs(time - lastTime.current) > 1500) animator.current?.reset();
    lastTime.current = time;
    animator.current?.update(time);
  }, [time, lyrics]);

  return (
    <div
      className={`gravity-lyrics ${highlighter ? "highlighter" : ""} ${highlighter && linkWidth > 0 ? "linked" : ""}`}
      style={
        highlighter
          ? ({ "--highlighter-ink": highlighter } as CSSProperties)
          : undefined
      }
    >
      <div
        className="gravity-stage"
        ref={stage}
        aria-label="Space Gravity lyrics"
      >
        {highlighter && (
          <svg className="gravity-links" ref={links} aria-hidden="true" />
        )}
        {groupByLine(shown).map(([index, entities]) => {
          const line = lyrics.lines[index];
          // Like the normal view, lines blur by their distance from the line
          // being sung.
          const distance = Math.abs(entities[0].lead - anchorLine);
          const state =
            time >= line.end_ms
              ? "past"
              : time >= line.start_ms
                ? "active"
                : "";
          return (
            // A box-less wrapper so the lyric animator finds this line's
            // syllables, and the normal lyric styles apply to them.
            <div
              key={index}
              className={`gravity-line lyric-line ${state} ${line.background ? "background-vocal" : ""}`}
              data-line={index}
              style={
                {
                  "--blur": `${reduceMotion ? 0 : lineBlur(distance)}px`,
                } as CSSProperties
              }
            >
              {entities.map((entity) => {
                const lead = prepared.leads[entity.lead];
                const role = gravityRole(entity, lead, time, prepared.finalEnd);
                const exiting = !visible.includes(entity);
                return (
                  <GravityWord
                    key={entity.key}
                    entity={entity}
                    role={role}
                    exiting={exiting}
                    highlighter={!!highlighter}
                    inkTime={
                      time < entity.start
                        ? -Infinity
                        : time < entity.end
                          ? time
                          : Infinity
                    }
                    wordRef={refFor(entity.key)}
                    onSeek={seek}
                  />
                );
              })}
            </div>
          );
        })}
        {gap && (
          <LyricCountdown
            key={waitKey}
            ref={refFor(waitKey)}
            className="gravity-wait"
            gap={gap}
            time={time}
            reduceMotion={reduceMotion}
          />
        )}
      </div>
      <div className="gravity-credits">{credits}</div>
    </div>
  );
}
