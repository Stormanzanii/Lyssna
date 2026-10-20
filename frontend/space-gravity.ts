/*
 * Space Gravity physics: words drift as bodies in zero gravity.
 *
 * Reimplements the behaviour of Spicy Lyrics' Space Gravity mode
 * (iPixelGalaxy/spicy-lyrics, src/utils/Lyrics/SpaceGravity.ts, AGPL-3.0):
 * seeded drift speeds scaled by the line's words per minute, randomised
 * bounces off the stage edges and obstacles, soft separation between words,
 * a gentle upward pull in the lower half, rotation with damping, and a kick
 * opposite to the window's own movement. No DOM access lives here.
 */

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
export interface Body {
  seed: number;
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
}
type Axis = "x" | "y";

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
  presenceFadeMs: 180,
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

export function createBody(seed: number, speed: number): Body {
  const velocity = (4.4 + random(seed + 3) * 5.6) * speed;
  const direction = random(seed + 4) * Math.PI * 2;
  return {
    seed,
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
    random(body.seed * 31 + body.bounces++) ** 2 *
      (GRAVITY.maxRestitution - GRAVITY.restitution);
  set(
    direction *
      Math.min(
        GRAVITY.maxSpeed * GRAVITY.maxRestitution * body.speed,
        Math.abs(velocity) * strength,
      ),
  );
}

function clampToStage(
  body: Body,
  bounds: Bounds,
  hit: Set<Axis>,
  padding = GRAVITY.edgePadding,
) {
  const minX = padding + body.radius,
    maxX = Math.max(minX, bounds.width - padding - body.radius),
    minY = padding + body.radius,
    maxY = Math.max(minY, bounds.height - padding - body.radius);
  let changed = false;
  if (body.x < minX) {
    body.x = minX;
    bounce(body, "x", 1, hit);
    changed = true;
  } else if (body.x > maxX) {
    body.x = maxX;
    bounce(body, "x", -1, hit);
    changed = true;
  }
  if (body.y < minY) {
    body.y = minY;
    bounce(body, "y", 1, hit);
    changed = true;
  } else if (body.y > maxY) {
    body.y = maxY;
    bounce(body, "y", -1, hit);
    changed = true;
  }
  return changed;
}

export function intersects(body: Body, rect: Rect) {
  const nearestX = Math.min(rect.right, Math.max(rect.left, body.x)),
    nearestY = Math.min(rect.bottom, Math.max(rect.top, body.y));
  return Math.hypot(body.x - nearestX, body.y - nearestY) < body.radius;
}

/** Pushes a body out through the nearest side of an obstacle that fits. */
function pushOut(body: Body, rect: Rect, bounds: Bounds, hit: Set<Axis>) {
  if (!intersects(body, rect)) return false;
  const pad = GRAVITY.edgePadding,
    minX = pad + body.radius,
    maxX = Math.max(minX, bounds.width - pad - body.radius),
    minY = pad + body.radius,
    maxY = Math.max(minY, bounds.height - pad - body.radius);
  const exits = [
    { side: "left", x: rect.left - body.radius, y: body.y },
    { side: "right", x: rect.right + body.radius, y: body.y },
    { side: "top", x: body.x, y: rect.top - body.radius },
    { side: "bottom", x: body.x, y: rect.bottom + body.radius },
  ].filter(
    (exit) =>
      exit.x >= minX && exit.x <= maxX && exit.y >= minY && exit.y <= maxY,
  );
  if (!exits.length) return false;
  const exit = exits.reduce((best, next) =>
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

/** Shrinks words that could not otherwise fit beside a large obstacle. */
function fitAround(body: Body, bounds: Bounds, obstacles: Rect[]) {
  const main = obstacles[0];
  if (
    !main ||
    main.right <= 0 ||
    main.left >= bounds.width ||
    main.bottom <= 0 ||
    main.top >= bounds.height
  ) {
    body.scale = 1;
  } else {
    const room = Math.max(
      Math.min(Math.max(0, main.left) / 2, bounds.height / 2),
      Math.min(Math.max(0, bounds.width - main.right) / 2, bounds.height / 2),
      Math.min(Math.max(0, main.top) / 2, bounds.width / 2),
      Math.min(Math.max(0, bounds.height - main.bottom) / 2, bounds.width / 2),
    );
    body.scale = Math.min(1, room / body.baseRadius);
  }
  body.radius = body.baseRadius * body.scale;
}

const expand = (rect: Rect, amount: number): Rect => ({
  left: rect.left - amount,
  top: rect.top - amount,
  right: rect.right + amount,
  bottom: rect.bottom + amount,
});

/** Keeps a body inside the stage and outside every obstacle. */
export function constrain(body: Body, bounds: Bounds, obstacles: Rect[]) {
  fitAround(body, bounds, obstacles);
  const padded = obstacles.map((rect) =>
    expand(rect, GRAVITY.obstacleClearance),
  );
  const hit = new Set<Axis>();
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = clampToStage(body, bounds, hit);
    for (const rect of padded)
      changed = pushOut(body, rect, bounds, hit) || changed;
    if (!changed) return;
  }
  clampToStage(body, bounds, hit, 0);
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
  if (motion.x !== undefined && motion.y !== undefined && dt > 0) {
    const sampledX = (position.x - motion.x) / dt,
      sampledY = (position.y - motion.y) / dt;
    motion.vx += (sampledX - motion.vx) * GRAVITY.windowSmoothing;
    motion.vy += (sampledY - motion.vy) * GRAVITY.windowSmoothing;
  }
  motion.x = position.x;
  motion.y = position.y;
}

/** Advances the simulation by dt seconds in small, stable substeps. */
export function step(
  bodies: Body[],
  dt: number,
  bounds: Bounds,
  obstacles: Rect[],
  window: WindowMotion = { vx: 0, vy: 0 },
) {
  let remaining = Math.min(0.1, Math.max(0, dt));
  while (remaining > 0) {
    const delta = Math.min(GRAVITY.maxStep, remaining);
    remaining -= delta;
    for (const body of bodies) {
      // Moving the window throws the words the other way.
      body.vx -= window.vx * GRAVITY.windowImpulse * delta;
      body.vy -= window.vy * GRAVITY.windowImpulse * delta;
    }
    for (let index = 0; index < bodies.length; index += 1)
      for (let other = 0; other < index; other += 1) {
        const a = bodies[index],
          b = bodies[other];
        const dx = a.x - b.x,
          dy = a.y - b.y;
        const distance = Math.hypot(dx, dy) || 0.001;
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
        Math.max(0, (body.y / bounds.height - 0.45) / 0.55) *
        delta;
      body.x += body.vx * delta;
      body.y += body.vy * delta;
      body.spin *= Math.exp(-GRAVITY.spinDamping * delta);
      body.angle =
        ((((body.angle + body.spin * delta + 180) % 360) + 360) % 360) - 180;
      if (
        !Number.isFinite(body.x) ||
        !Number.isFinite(body.y) ||
        !Number.isFinite(body.vx) ||
        !Number.isFinite(body.vy)
      ) {
        body.x = bounds.width / 2;
        body.y = bounds.height / 2;
        body.vx = body.vy = 0;
      }
      constrain(body, bounds, obstacles);
    }
  }
}

/** How many sung words fit the free stage area. */
export function visibleWordCount(bounds: Bounds, occupiedArea = 0) {
  const area = Math.max(0, bounds.width * bounds.height - occupiedArea);
  return Math.min(
    GRAVITY.maxVisibleWords,
    Math.max(GRAVITY.minVisibleWords, Math.ceil(area / GRAVITY.areaPerWord)),
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
