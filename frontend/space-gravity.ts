/*
 * Space Gravity physics: words drift as bodies in zero gravity.
 *
 * Ported from the pixels-spicy-lyrics fork's Space Gravity mode
 * (src/utils/Lyrics/SpaceGravity.ts, 100.10.54, AGPL-3.0): seeded drift
 * speeds scaled by the line's words per minute, seeded bounces off the play
 * area and obstacles, soft separation between words, a gentle upward pull in
 * the lower half, rotation with damping, a kick opposite to the window's own
 * movement, spawning near each word's place in the line with a spiral search
 * that avoids words already on screen, and a static layout under reduced
 * motion. No DOM access lives here.
 */

import { isEmphasis, type AnimatedWord } from "./lyric-motion";
import type { Word } from "./types";

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface Bounds {
  width: number;
  height: number;
}
/** Where words may float: the stage, the play area inside it, the artwork
 * they shrink beside, other blockers, and the credits footer below. */
export interface Field {
  bounds: Bounds;
  area?: Rect;
  /** Where lines are laid out before their words float: the lyrics column,
   * even when words may roam the whole page over Canvas. */
  layout?: Rect;
  cover?: Rect;
  blockers?: Rect[];
  footer?: Rect;
}
export interface Body {
  seed: number;
  /** Line start and position across shown words, for seeded bounces. */
  lineStart: number;
  order: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  bounces: number;
  speed: number;
  width: number;
  height: number;
  baseRadius: number;
  radius: number;
  scale: number;
  naturalX: number;
  naturalY: number;
}
type Axis = "x" | "y";
type Exit = "left" | "right" | "top" | "bottom";

export const GRAVITY = {
  edgePadding: 18,
  obstacleClearance: 12,
  wordOverhang: 0.3,
  maxSpeed: 16,
  wpmThreshold: 60,
  wpmMax: 180,
  maxWpmMultiplier: 1.75,
  highSpeedDrag: 0.6,
  windowSmoothing: 0.18,
  windowImpulse: 1.1,
  restitution: 0.82,
  maxRestitution: 2.4,
  separationGap: 10,
  separationAcceleration: 5,
  upwardAcceleration: 0.4,
  spinDamping: 0.18,
  minVisibleWords: 12,
  maxVisibleWords: 120,
  areaPerWord: 33_334,
  /** Gap between stacked lines, as a share of the stage height. */
  lineGap: 0.01,
  presenceFadeMs: 180,
  spawnAttempts: 48,
  spawnClearance: 4,
  maxStep: 0.05,
};

/** FNV-1a string hash, for stable per-word randomness. */
export function hash(value: string) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

/** Deterministic random number in [0, 1) from a seed. */
export function random(seed: number) {
  let value = seed + 0x6d2b79f5;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

/** Faster lines drift faster: 1x up to 60 wpm, 1.75x from 180 wpm. */
export function speedMultiplier(wordStartsMs: number[]) {
  const starts = [...new Set(wordStartsMs)].sort((a, b) => a - b);
  if (starts.length < 2) return 1;
  const duration = starts.at(-1)! - starts[0];
  const wpm = duration > 0 ? ((starts.length - 1) * 60_000) / duration : 0;
  if (wpm <= GRAVITY.wpmThreshold) return 1;
  const progress = Math.min(
    1,
    (wpm - GRAVITY.wpmThreshold) / (GRAVITY.wpmMax - GRAVITY.wpmThreshold),
  );
  return 1 + progress * (GRAVITY.maxWpmMultiplier - 1);
}

export function createBody(
  seed: number,
  speed: number,
  lineStart = 0,
  order = 0,
): Body {
  const velocity = (4.4 + random(seed + 3) * 5.6) * speed;
  const direction = random(seed + 4) * Math.PI * 2;
  return {
    seed,
    lineStart,
    order,
    x: 0,
    y: 0,
    vx: Math.cos(direction) * velocity,
    vy: Math.sin(direction) * velocity,
    angle: 0,
    spin: (random(seed + 2) * 2 - 1) * 19,
    bounces: 0,
    speed,
    width: 48,
    height: 48,
    baseRadius: 24,
    radius: 24,
    scale: 1,
    naturalX: 0,
    naturalY: 0,
  };
}

/** Collision circle for a word box, with room for glyph overhang. */
export function measure(body: Body, width: number, height: number) {
  body.width = width;
  body.height = height;
  body.baseRadius = Math.max(
    14,
    Math.hypot(width, height) / 2 + height * GRAVITY.wordOverhang,
  );
  body.radius = body.baseRadius * body.scale;
}

function bounce(body: Body, axis: Axis, direction: 1 | -1, hit: Set<Axis>) {
  const velocity = axis === "x" ? body.vx : body.vy;
  const set = (value: number) => {
    if (axis === "x") body.vx = value;
    else body.vy = value;
  };
  if (!Number.isFinite(velocity)) return set(0);
  if (velocity * direction >= 0) return;
  // Hitting opposite walls in one solve would amplify forever; stop instead.
  if (hit.has(axis)) return set(0);
  hit.add(axis);
  // Most bounces keep their speed; rare ones launch hard.
  const strength =
    GRAVITY.restitution +
    random(hash(`${body.lineStart}:${body.order}:${body.bounces++}`)) ** 2 *
      (GRAVITY.maxRestitution - GRAVITY.restitution);
  set(
    direction *
      Math.min(
        GRAVITY.maxSpeed * GRAVITY.maxRestitution * body.speed,
        Math.abs(velocity) * strength,
      ),
  );
}

const playArea = (field: Field): Rect =>
  field.area ?? {
    left: 0,
    top: 0,
    right: field.bounds.width,
    bottom: field.bounds.height,
  };

function limits(body: Body, field: Field, padding: number): Rect {
  const area = playArea(field);
  const padX = Math.min(
    padding,
    Math.max(0, (area.right - area.left) / 2 - body.radius),
  );
  const padY = Math.min(
    padding,
    Math.max(0, (area.bottom - area.top) / 2 - body.radius),
  );
  return {
    left: area.left + padX + body.radius,
    right: area.right - padX - body.radius,
    top: area.top + padY + body.radius,
    bottom: area.bottom - padY - body.radius,
  };
}

function clampToArea(
  body: Body,
  field: Field,
  hit: Set<Axis>,
  padding = GRAVITY.edgePadding,
) {
  const limit = limits(body, field, padding);
  let changed = false;
  if (body.x < limit.left) {
    body.x = limit.left;
    bounce(body, "x", 1, hit);
    changed = true;
  } else if (body.x > limit.right) {
    body.x = limit.right;
    bounce(body, "x", -1, hit);
    changed = true;
  }
  if (body.y < limit.top) {
    body.y = limit.top;
    bounce(body, "y", 1, hit);
    changed = true;
  } else if (body.y > limit.bottom) {
    body.y = limit.bottom;
    bounce(body, "y", -1, hit);
    changed = true;
  }
  return changed;
}

export function intersects(body: Body, rect: Rect | undefined) {
  if (!rect) return false;
  const nearestX = Math.min(rect.right, Math.max(rect.left, body.x)),
    nearestY = Math.min(rect.bottom, Math.max(rect.top, body.y));
  return Math.hypot(body.x - nearestX, body.y - nearestY) < body.radius;
}

const ALL_EXITS: Exit[] = ["left", "right", "top", "bottom"];

/** Pushes a body out through the nearest allowed side of an obstacle. */
function pushOut(
  body: Body,
  rect: Rect | undefined,
  field: Field,
  exits: Exit[],
  hit: Set<Axis>,
  padding = GRAVITY.edgePadding,
) {
  if (!rect || !intersects(body, rect)) return false;
  const limit = limits(body, field, padding);
  const candidates = [
    { side: "left" as const, x: rect.left - body.radius, y: body.y },
    { side: "right" as const, x: rect.right + body.radius, y: body.y },
    { side: "top" as const, x: body.x, y: rect.top - body.radius },
    { side: "bottom" as const, x: body.x, y: rect.bottom + body.radius },
  ].filter(
    (exit) =>
      exits.includes(exit.side) &&
      exit.x >= limit.left &&
      exit.x <= limit.right &&
      exit.y >= limit.top &&
      exit.y <= limit.bottom,
  );
  if (!candidates.length) return false;
  const exit = candidates.reduce((best, next) =>
    Math.hypot(next.x - body.x, next.y - body.y) <
    Math.hypot(best.x - body.x, best.y - body.y)
      ? next
      : best,
  );
  body.x = exit.x;
  body.y = exit.y;
  if (exit.side === "left") bounce(body, "x", -1, hit);
  else if (exit.side === "right") bounce(body, "x", 1, hit);
  else if (exit.side === "top") bounce(body, "y", -1, hit);
  else bounce(body, "y", 1, hit);
  return true;
}

function setScale(body: Body, scale: number) {
  body.scale = scale;
  body.radius = body.baseRadius * scale;
}

/** Shrinks words to fit the largest free strip beside the artwork. */
function fitAroundCover(body: Body, field: Field) {
  const area = playArea(field),
    width = area.right - area.left,
    height = area.bottom - area.top,
    cover = field.cover;
  if (
    !cover ||
    cover.right <= area.left ||
    cover.left >= area.right ||
    cover.bottom <= area.top ||
    cover.top >= area.bottom
  ) {
    setScale(
      body,
      Math.min(
        1,
        width / (2 * body.baseRadius),
        height / (2 * body.baseRadius),
      ),
    );
    return;
  }
  const spans = [
    Math.max(0, Math.min(area.right, cover.left) - area.left),
    Math.max(0, area.right - Math.max(area.left, cover.right)),
    Math.max(0, Math.min(area.bottom, cover.top) - area.top),
    Math.max(0, area.bottom - Math.max(area.top, cover.bottom)),
  ];
  const room = Math.max(
    Math.min(spans[0] / 2, height / 2),
    Math.min(spans[1] / 2, height / 2),
    Math.min(spans[2] / 2, width / 2),
    Math.min(spans[3] / 2, width / 2),
  );
  setScale(body, Math.min(1, room / body.baseRadius));
}

const expand = (rect: Rect | undefined, amount: number) =>
  rect && {
    left: rect.left - amount,
    top: rect.top - amount,
    right: rect.right + amount,
    bottom: rect.bottom + amount,
  };

/** Keeps a body inside the play area, beside the artwork and blockers and
 * above the footer. Tight layouts drop the margins before giving up. */
export function constrain(body: Body, field: Field) {
  fitAroundCover(body, field);
  const blockers = field.blockers ?? [];
  const padded = [field.cover, ...blockers].map((rect) =>
    expand(rect, GRAVITY.obstacleClearance),
  );
  const hit = new Set<Axis>();
  const solve = (rects: (Rect | undefined)[], padding: number) => {
    let changed = clampToArea(body, field, hit, padding);
    for (const rect of rects)
      changed = pushOut(body, rect, field, ALL_EXITS, hit, padding) || changed;
    return (
      pushOut(body, field.footer, field, ["left", "right", "top"], hit) ||
      changed
    );
  };
  for (let pass = 0; pass < 4; pass += 1)
    if (!solve(padded, GRAVITY.edgePadding)) return;
  const hard = [field.cover, ...blockers];
  if (!hard.some((rect) => intersects(body, rect))) {
    clampToArea(body, field, hit);
    return;
  }
  for (let pass = 0; pass < 4; pass += 1) if (!solve(hard, 0)) break;
  clampToArea(body, field, hit, 0);
}

/** Restores a body whose motion became NaN or infinite. */
function recover(body: Body) {
  const position = Number.isFinite(body.x) && Number.isFinite(body.y),
    velocity = Number.isFinite(body.vx) && Number.isFinite(body.vy),
    rotation = Number.isFinite(body.angle) && Number.isFinite(body.spin);
  if (position && velocity && rotation) return;
  const seed = hash(`${body.lineStart}:${body.order}:${body.bounces}:recovery`);
  const speed = (4.4 + random(seed) * 5.6) * body.speed,
    direction = random(seed + 1) * Math.PI * 2;
  if (!position) {
    body.x = Number.isFinite(body.naturalX) ? body.naturalX : 0;
    body.y = Number.isFinite(body.naturalY) ? body.naturalY : 0;
  }
  if (!velocity) {
    body.vx = Math.cos(direction) * speed;
    body.vy = Math.sin(direction) * speed;
  }
  if (!rotation) {
    body.angle = 0;
    body.spin = (random(seed + 2) * 2 - 1) * 19;
  }
}

/** Smoothed window velocity in CSS pixels per second. */
export interface WindowMotion {
  x?: number;
  y?: number;
  vx: number;
  vy: number;
}
export function trackWindow(
  motion: WindowMotion,
  position: { x: number; y: number } | undefined,
  dt: number,
) {
  if (!position) return;
  if (motion.x !== undefined && motion.y !== undefined) {
    const time = Math.max(dt, 0.001);
    const sampledX = (position.x - motion.x) / time,
      sampledY = (position.y - motion.y) / time;
    motion.vx += (sampledX - motion.vx) * GRAVITY.windowSmoothing;
    motion.vy += (sampledY - motion.vy) * GRAVITY.windowSmoothing;
  }
  motion.x = position.x;
  motion.y = position.y;
}

/** Advances shown words by dt seconds in small substeps. Words fading out
 * still feel window throws but otherwise stay where they are. */
export function step(
  bodies: Body[],
  dt: number,
  field: Field,
  window: WindowMotion = { vx: 0, vy: 0 },
  exiting: Body[] = [],
) {
  for (const body of bodies) recover(body);
  let remaining = Math.min(0.1, Math.max(0, dt));
  while (remaining > 0) {
    const delta = Math.min(GRAVITY.maxStep, remaining);
    remaining -= delta;
    if (window.vx || window.vy)
      for (const body of [...bodies, ...exiting]) {
        // Moving the window throws the words the other way.
        body.vx -= window.vx * GRAVITY.windowImpulse * delta;
        body.vy -= window.vy * GRAVITY.windowImpulse * delta;
      }
    for (let index = 0; index < bodies.length; index += 1)
      for (let other = 0; other < index; other += 1) {
        const a = bodies[index],
          b = bodies[other];
        let dx = a.x - b.x,
          dy = a.y - b.y,
          distance = Math.hypot(dx, dy);
        if (distance < 0.001) {
          const angle =
            random(
              hash(
                `${a.lineStart}:${a.order}:${b.lineStart}:${b.order}:avoidance`,
              ),
            ) *
            Math.PI *
            2;
          dx = Math.cos(angle) * 0.001;
          dy = Math.sin(angle) * 0.001;
          distance = 0.001;
        }
        const reach = a.radius + b.radius + GRAVITY.separationGap;
        if (distance >= reach) continue;
        const nudge =
          ((reach - distance) / reach) * GRAVITY.separationAcceleration * delta;
        a.vx += (dx / distance) * nudge;
        a.vy += (dy / distance) * nudge;
        b.vx -= (dx / distance) * nudge;
        b.vy -= (dy / distance) * nudge;
      }
    for (const body of bodies) {
      const speed = Math.hypot(body.vx, body.vy),
        limit = GRAVITY.maxSpeed * body.speed;
      if (speed > limit) {
        const next =
          limit + (speed - limit) * Math.exp(-GRAVITY.highSpeedDrag * delta);
        body.vx = (body.vx / speed) * next;
        body.vy = (body.vy / speed) * next;
      }
      body.vy -=
        GRAVITY.upwardAcceleration *
        Math.max(0, (body.y / field.bounds.height - 0.45) / 0.55) *
        delta;
      body.x += body.vx * delta;
      body.y += body.vy * delta;
      body.spin *= Math.exp(-GRAVITY.spinDamping * delta);
      body.angle =
        ((((body.angle + body.spin * delta + 180) % 360) + 360) % 360) - 180;
      constrain(body, field);
    }
  }
}

/** How deep two rotated word boxes overlap, by separating axes. */
export function spawnOverlap(body: Body, other: Body) {
  const a = (body.angle * Math.PI) / 180,
    b = (other.angle * Math.PI) / 180;
  const aCos = Math.cos(a),
    aSin = Math.sin(a),
    bCos = Math.cos(b),
    bSin = Math.sin(b);
  const clearance = GRAVITY.spawnClearance / 2;
  const aw = (body.width * body.scale) / 2 + clearance,
    ah = (body.height * body.scale) / 2 + clearance,
    bw = (other.width * other.scale) / 2 + clearance,
    bh = (other.height * other.scale) / 2 + clearance;
  const dx = body.x - other.x,
    dy = body.y - other.y;
  let least = Infinity;
  for (const [x, y] of [
    [aCos, aSin],
    [-aSin, aCos],
    [bCos, bSin],
    [-bSin, bCos],
  ]) {
    const reachA =
      aw * Math.abs(aCos * x + aSin * y) + ah * Math.abs(-aSin * x + aCos * y);
    const reachB =
      bw * Math.abs(bCos * x + bSin * y) + bh * Math.abs(-bSin * x + bCos * y);
    const overlap = reachA + reachB - Math.abs(dx * x + dy * y);
    if (overlap <= 0) return 0;
    least = Math.min(least, overlap);
  }
  return least;
}

/** Places a new word near its spot in the line, searching a golden-angle
 * spiral outward for room among words already on screen. */
export function spawn(
  body: Body,
  occupied: Body[],
  field: Field,
  reduced = false,
  rand = Math.random,
) {
  const startX = body.naturalX + (rand() * 2 - 1) * body.width * 1.35,
    startY = body.naturalY + (rand() * 2 - 1) * body.height * 1.35;
  const phase = rand() * Math.PI * 2,
    area = playArea(field),
    reach = Math.hypot(area.right - area.left, area.bottom - area.top);
  let best = { ...body, x: startX, y: startY, angle: 0 },
    bestOverlap = Infinity;
  const attempts = reduced ? 1 : GRAVITY.spawnAttempts;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const distance = (reach * attempt) / (GRAVITY.spawnAttempts - 1),
      angle = phase + attempt * Math.PI * (3 - Math.sqrt(5));
    const candidate = {
      ...body,
      x: startX + Math.cos(angle) * distance,
      y: startY + Math.sin(angle) * distance,
      angle: 0,
    };
    constrain(candidate, field);
    const overlap = occupied.reduce(
      (sum, other) => sum + spawnOverlap(candidate, other) ** 2,
      0,
    );
    if (overlap < bestOverlap) {
      best = candidate;
      bestOverlap = overlap;
    }
    if (overlap === 0) break;
  }
  Object.assign(body, best);
}

/** Reduced motion: shown lines sit centred and still, one row each. */
export function staticLayout(lines: Body[][], field: Field) {
  const { width, height } = field.bounds;
  const heights = lines.map((line) =>
    Math.max(...line.map((body) => body.height)),
  );
  const total =
    heights.reduce((sum, value) => sum + value, 0) +
    Math.max(0, lines.length - 1) * 12;
  let y = Math.max(GRAVITY.edgePadding, (height - total) / 2);
  lines.forEach((line, index) => {
    const lineWidth =
      line.reduce((sum, body) => sum + body.width, 0) +
      Math.max(0, line.length - 1) * 6;
    let x = Math.max(GRAVITY.edgePadding, (width - lineWidth) / 2);
    for (const body of line) {
      body.x = x + body.width / 2;
      body.y = y + heights[index] / 2;
      body.angle = 0;
      constrain(body, field);
      x += body.width + 6;
    }
    y += heights[index] + 12;
  });
}

const overlapArea = (rect: Rect | undefined, area: Rect) =>
  rect
    ? Math.max(
        0,
        Math.min(area.right, rect.right) - Math.max(area.left, rect.left),
      ) *
      Math.max(
        0,
        Math.min(area.bottom, rect.bottom) - Math.max(area.top, rect.top),
      )
    : 0;

/** How many lead words fit the play area left free by artwork and credits. */
export function visibleWordCount(field: Field) {
  const area = playArea(field);
  const free = Math.max(
    0,
    (area.right - area.left) * (area.bottom - area.top) -
      overlapArea(field.cover, area) -
      overlapArea(field.footer, area),
  );
  return Math.min(
    GRAVITY.maxVisibleWords,
    Math.max(GRAVITY.minVisibleWords, Math.ceil(free / GRAVITY.areaPerWord)),
  );
}

/** The run of `count` words centred on `anchor` within `total`. */
export function wordWindow(anchor: number, total: number, count: number) {
  if (!total || !Number.isFinite(anchor)) return undefined;
  const size = Math.min(count, total);
  const first = Math.max(
    0,
    Math.min(anchor - Math.floor((size - 1) / 2), total - size),
  );
  return { first, last: first + size - 1 };
}

/** Each word's place when its line is laid out in the play area, as the fork
 * measures lines before floating them: rows wrap at the area's width and
 * duet lines sit at the right. Returns centres relative to the line top. */
export function lineLayout(
  sizes: { width: number; height: number }[],
  width: number,
  opposite = false,
) {
  const rows: { items: number[]; width: number; height: number }[] = [];
  sizes.forEach((size, index) => {
    const row = rows.at(-1);
    if (row && row.width + size.width <= width) {
      row.items.push(index);
      row.width += size.width;
      row.height = Math.max(row.height, size.height);
    } else
      rows.push({ items: [index], width: size.width, height: size.height });
  });
  const places: { x: number; y: number }[] = [];
  let top = 0;
  for (const row of rows) {
    let x = opposite ? Math.max(0, width - row.width) : 0;
    for (const index of row.items) {
      places[index] = {
        x: x + sizes[index].width / 2,
        y: top + sizes[index].height / 2,
      };
      x += sizes[index].width;
    }
    top += row.height;
  }
  return { places, height: top };
}

const DASH_END = /[-‐‑‒–—―]$/u;
const DASH_START = /^[-‐‑‒–—―]/u;

/**
 * One floating piece per hyphen-joined part, like Spicy Lyrics: "eye-eye-eyes"
 * floats as three words. Pieces sung as one timed word share its time by
 * letter count.
 */
export function gravityPieces(group: Word[]) {
  const pieces: {
    text: string;
    start: number;
    end: number;
    words: AnimatedWord[];
  }[] = [];
  let current: Word[] = [];
  const flush = () => {
    if (!current.length) return;
    const text = current
      .map((word) => word.text)
      .join("")
      .trim();
    const start = current[0].start_ms,
      end = current.at(-1)!.end_ms;
    const parts = text.match(/[^-‐‑‒–—―]+[-‐‑‒–—―]*/gu) ?? [text];
    if (current.length > 1 || parts.length < 2) {
      const words = current.map((word, index) =>
        index ? word : { ...word, text: word.text.trimStart() },
      );
      if (text) pieces.push({ text, start, end, words });
    } else {
      const held = isEmphasis(current[0], current[0].text.trimStart());
      const weights = parts.map((part) => Math.max(1, Array.from(part).length));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      let used = 0;
      parts.forEach((part, index) => {
        const from = start + ((end - start) * used) / total;
        const letterOffset = used;
        used += weights[index];
        const to =
          index === parts.length - 1
            ? end
            : Math.round(start + ((end - start) * used) / total);
        pieces.push({
          text: part,
          start: Math.round(from),
          end: to,
          words: [
            {
              ...current[0],
              text: part,
              start_ms: held ? start : Math.round(from),
              end_ms: held ? end : to,
              letterOffset: held ? letterOffset : undefined,
              letterCount: held ? total : undefined,
            },
          ],
        });
      });
    }
    current = [];
  };
  group.forEach((word, index) => {
    current.push(word);
    const next = group[index + 1];
    if (
      DASH_END.test(word.text.trim()) ||
      (next && DASH_START.test(next.text.trim()))
    )
      flush();
  });
  flush();
  return pieces;
}
