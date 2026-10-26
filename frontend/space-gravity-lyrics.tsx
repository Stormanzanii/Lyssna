import {
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
import type { Lyrics } from "./types";
import { frameDue } from "./frame-cap";

interface Entity {
  key: string;
  text: string;
  /** Source line index, and the syllables to animate like normal lyrics. */
  line: number;
  words: AnimatedWord[];
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
      entities.push({
        key: `${lineIndex}:${slot}`,
        text,
        line: lineIndex,
        // A trailing space inside a rotated word's paint box draws a dotted
        // hairline past its last letter; floating words need no spacing.
        words: piece.words.map((word, index, all) =>
          index === all.length - 1
            ? { ...word, text: word.text.trimEnd() }
            : word,
        ),
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
  const dock = union(
    [".lyrics-title", ".lyrics-artists", ".lyrics-fullscreen-controls"].map(
      (selector) => relative(page?.querySelector(selector), box),
    ),
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
      contains(dock, toolbar) || contains(cover, toolbar) ? undefined : toolbar,
    ].filter((rect): rect is Rect => !!rect),
  };
}

type GravityBody = Body & { spawned: boolean; entryFrame?: number };

let kept: { signature: string; bodies: Map<string, GravityBody> } | undefined;

/** Space Gravity: sung words float in zero gravity around the artwork. */
export function SpaceGravityLyrics({
  lyrics,
  time,
  reduceMotion,
  tuning,
  onSeek,
  credits,
}: {
  lyrics: Lyrics;
  time: number;
  reduceMotion: boolean;
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
  const live = useRef({ visible, prepared, reduceMotion, waitKey });
  live.current = { visible, prepared, reduceMotion, waitKey };
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
      const area = field.layout ?? field.area!;
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
        );
        const top = area.top + (area.bottom - area.top - layout.height) / 2;
        members.forEach((body, index) => {
          body.naturalX =
            area.left + GRAVITY.edgePadding + layout.places[index].x;
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
    <div className="gravity-lyrics">
      <div
        className="gravity-stage"
        ref={stage}
        aria-label="Space Gravity lyrics"
      >
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
                  <button
                    key={entity.key}
                    ref={refFor(entity.key)}
                    className={`gravity-word ${role} ${entity.opposite ? "opposite" : ""} ${entity.background ? "background" : ""} ${exiting ? "exiting" : ""}`}
                    onClick={() => onSeek(entity.start)}
                    tabIndex={exiting ? -1 : 0}
                  >
                    <LyricWord words={entity.words} />
                  </button>
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
