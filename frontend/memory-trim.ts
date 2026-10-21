/**
 * WebView2 keeps GPU textures and decoded artwork cached while memory is
 * plentiful, roughly doubling its footprint after browsing. Once the user
 * rests for a minute after doing something, ask it to drop them once.
 */
export function idleTrim(idleMs = 60_000) {
  let last = 0;
  let pending = false;
  return {
    activity(now: number) {
      last = now;
      pending = true;
    },
    /** True once per burst of activity, after `idleMs` without input. */
    due(now: number) {
      if (!pending || now - last < idleMs) return false;
      pending = false;
      return true;
    },
  };
}

export function startIdleTrim(trim: () => void, idleMs = 60_000) {
  const state = idleTrim(idleMs);
  const touch = () => state.activity(Date.now());
  const events = ["pointerdown", "keydown", "wheel"] as const;
  for (const name of events)
    window.addEventListener(name, touch, { passive: true });
  const timer = window.setInterval(() => {
    if (state.due(Date.now())) trim();
  }, 15_000);
  return () => {
    window.clearInterval(timer);
    for (const name of events) window.removeEventListener(name, touch);
  };
}
