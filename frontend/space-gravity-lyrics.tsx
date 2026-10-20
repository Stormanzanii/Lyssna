import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { vocalGap, wordGroups, type AnimatedWord } from "./lyric-motion";
import { LyricAnimator } from "./lyric-animator";
import { LyricWord } from "./lyric-word";
import { LyricCountdown } from "./lyric-countdown";
import {
  constrain,
  createBody,
  GRAVITY,
  gravityPieces,
  hash,
  measure,
  random,
  speedMultiplier,
  step,
  trackWindow,
  visibleWordCount,
  wordWindow,
  type Body,
  type Rect,
  type WindowMotion,
} from "./space-gravity";
import { windowPosition } from "./window-activity";
import type { Lyrics } from "./types";

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
        words: piece.words,
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

/** Space Gravity: sung words float in zero gravity around the artwork. */
export function SpaceGravityLyrics({
  lyrics,
  time,
  reduceMotion,
  onSeek,
  credits,
}: {
  lyrics: Lyrics;
  time: number;
  reduceMotion: boolean;
  onSeek: (position: number) => void;
  credits: ReactNode;
}) {
  const prepared = useMemo(() => prepareGravity(lyrics), [lyrics]);
  const gap = vocalGap(lyrics.lines, time);
  const waitKey = gap ? `wait:${gap.start}:${gap.end}` : "";
  const stage = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  // Area the artwork, toolbar and credits take; measured by the frame loop.
  const [occupied, setOccupied] = useState(0);
  const count = visibleWordCount(bounds, occupied);
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
  const shown = [
    ...visible,
    ...leaving.filter((entity) => !visible.includes(entity)),
  ];

  const elements = useRef(new Map<string, HTMLElement>());
  const bodies = useRef(new Map<string, Body & { spawned: boolean }>());
  const live = useRef({ visible, prepared, reduceMotion, waitKey });
  live.current = { visible, prepared, reduceMotion, waitKey };
  useEffect(() => {
    // A new song starts every word fresh.
    bodies.current.clear();
    refs.current.clear();
  }, [prepared]);
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

  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setBounds({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    setBounds({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    let frame = 0,
      last = performance.now(),
      obstaclesAt = 0;
    let obstacles: Rect[] = [];
    const motion: WindowMotion = { vx: 0, vy: 0 };
    const page = element.closest(".lyrics-page");
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const area = { width: element.clientWidth, height: element.clientHeight };
      if (area.width < 1 || area.height < 1) return;
      const box = element.getBoundingClientRect();
      if (now - obstaclesAt > 250) {
        obstaclesAt = now;
        // The artwork block first: words shrink to fit beside it.
        obstacles = [
          relative(page?.querySelector(".lyrics-album"), box),
          relative(page?.querySelector(".lyrics-toolbar"), box),
          relative(page?.querySelector(".gravity-credits"), box),
        ].filter((rect): rect is Rect => !!rect);
        const covered = obstacles.reduce(
          (sum, rect) =>
            sum +
            Math.max(
              0,
              Math.min(area.width, rect.right) - Math.max(0, rect.left),
            ) *
              Math.max(
                0,
                Math.min(area.height, rect.bottom) - Math.max(0, rect.top),
              ),
          0,
        );
        setOccupied((current) =>
          Math.abs(current - covered) > GRAVITY.areaPerWord / 2
            ? covered
            : current,
        );
      }
      const { visible, prepared, reduceMotion, waitKey } = live.current;
      const art = obstacles[0];
      // Spawn words in the larger free strip beside the artwork.
      const freeLeft =
        art && art.left > area.width - art.right ? 0 : (art?.right ?? 0);
      const freeRight =
        art && art.left > area.width - art.right ? art.left : area.width;
      const centreX = (freeLeft + freeRight) / 2;
      // A wide header above (the stacked layout) moves the free area down;
      // the credits close it off at the bottom.
      const headerAbove =
        art &&
        art.right - art.left > area.width * 0.5 &&
        art.bottom < area.height * 0.6;
      const freeTop = headerAbove ? art.bottom : 0;
      const credits = obstacles.find((rect) => rect.top > area.height * 0.6);
      const centreY = (freeTop + (credits?.top ?? area.height)) / 2;
      const active: Body[] = [];
      for (const [key, element] of elements.current) {
        const waiting = key === waitKey;
        const entity =
          visible.find((item) => item.key === key) ??
          prepared.entities.find((item) => item.key === key);
        if (!entity && !waiting) continue;
        let body = bodies.current.get(key);
        if (!body) {
          body = {
            ...createBody(entity?.seed ?? hash(key), entity?.speed ?? 1),
            spawned: false,
          };
          bodies.current.set(key, body);
        }
        if (element.offsetWidth)
          measure(body, element.offsetWidth, element.offsetHeight);
        if (!body.spawned) {
          const spread = Math.min(freeRight - freeLeft, area.width) * 0.8;
          const column =
            entity && entity.slots > 1
              ? entity.slot / (entity.slots - 1) - 0.5
              : 0;
          body.x =
            centreX +
            column * spread +
            (random(body.seed + 7) * 2 - 1) * body.width * 1.35;
          // Every line spawns around the middle of the free area, as in
          // Spicy Lyrics; its words then drift apart.
          body.y =
            centreY + (random(body.seed + 8) * 2 - 1) * body.height * 1.35;
          body.spawned = true;
          constrain(body, area, obstacles);
        }
        if (waiting || (entity && visible.includes(entity))) active.push(body);
      }
      if (reduceMotion) {
        for (const body of active) {
          body.angle = 0;
          constrain(body, area, obstacles);
        }
      } else {
        trackWindow(
          motion,
          windowPosition() ?? { x: window.screenX, y: window.screenY },
          dt,
        );
        step(active, dt, area, obstacles, motion);
      }
      // Words that left the screen start fresh when they return.
      for (const key of bodies.current.keys())
        if (!elements.current.has(key)) bodies.current.delete(key);
      for (const [key, element] of elements.current) {
        const body = bodies.current.get(key);
        if (!body?.spawned) continue;
        element.style.transform = `translate3d(${body.x - body.width / 2}px, ${body.y - body.height / 2}px, 0) rotate(${body.angle}deg) scale(${body.scale})`;
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  // The normal lyrics animator drives the syllables, exactly as in the
  // regular lyrics view.
  const animator = useRef<LyricAnimator>(undefined);
  useLayoutEffect(() => {
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
  }, [lyrics, reduceMotion]);
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
            >
              {entities.map((entity) => {
                const lead = prepared.leads[entity.lead];
                const role = gravityRole(entity, lead, time, prepared.finalEnd);
                const exiting = !visible.includes(entity);
                // The word being sung right now is the brightest.
                const singing =
                  role === "current" &&
                  time >= entity.start &&
                  time < entity.end;
                return (
                  <button
                    key={entity.key}
                    ref={refFor(entity.key)}
                    className={`gravity-word ${role} ${entity.opposite ? "opposite" : ""} ${entity.background ? "background" : ""} ${exiting ? "exiting" : ""} ${singing ? "singing" : ""}`}
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
