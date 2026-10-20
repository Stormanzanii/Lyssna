/** Whether the desktop window is minimized or focused, as reported by Rust. */
export interface WindowActivity {
  minimized: boolean;
  focused: boolean;
}

let current: WindowActivity = { minimized: false, focused: true };
const listeners = new Set<() => void>();

export const windowActivity = () => current;

export function setWindowActivity(next: WindowActivity) {
  if (next.minimized === current.minimized && next.focused === current.focused)
    return;
  current = { minimized: next.minimized, focused: next.focused };
  listeners.forEach((listener) => listener());
}

export function onWindowActivity(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Ambience frame rate: full while focused, reduced in the background. */
export const ambienceFps = (activity: WindowActivity) =>
  activity.minimized ? 0 : activity.focused ? 30 : 12;

/** Latest window position in CSS pixels, as reported by Rust when moved. */
let position: { x: number; y: number } | undefined;
export const windowPosition = () => position;
export function setWindowPosition(x: number, y: number) {
  if (Number.isFinite(x) && Number.isFinite(y)) position = { x, y };
}
