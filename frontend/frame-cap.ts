/** Limit Animation Frame Rate from Spicy Lyrics' Appearance settings: the
 *  app's animation loops skip frames to stay under one rate. 0 is no cap. */
let cap = 0;

export const frameCap = () => cap;

export function setFrameCap(fps: number) {
  cap = Number.isFinite(fps) && fps > 0 ? Math.min(240, Math.max(15, fps)) : 0;
}

/** Whether a loop that last ran at `last` may run again at `now`. A
 *  millisecond of slack keeps a 60 fps cap from dropping to 30 on a 60 Hz
 *  display, whose frames arrive a hair early. */
export function frameDue(last: number, now: number) {
  return !cap || now - last >= 1000 / cap - 1;
}

/** A loop's own rate, held under the cap. */
export const cappedFps = (fps: number) => (cap ? Math.min(cap, fps) : fps);
