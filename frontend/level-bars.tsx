import { useEffect, useRef } from "react";
import { rpc } from "./bridge";

type Listener = (levels: number[]) => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setTimeout> | undefined;

// One poll serves every visible set of bars.
async function poll() {
  try {
    const bytes = await rpc<number[]>("audio_levels");
    if (Array.isArray(bytes)) {
      const levels = bytes.map((byte) => byte / 255);
      listeners.forEach((listener) => listener(levels));
    }
  } catch {
    // Not running natively; the bars keep their last height.
  }
  if (listeners.size) timer = setTimeout(poll, 33);
  else timer = undefined;
}

function listen(listener: Listener) {
  listeners.add(listener);
  if (!timer) timer = setTimeout(poll, 0);
  return () => {
    listeners.delete(listener);
  };
}

/** Three bars that follow the bass, mids and treble of what this computer
 * is playing, or bounce on their own when `live` is off. */
export function LevelBars({
  className,
  live,
}: {
  className: string;
  live: boolean;
}) {
  const element = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!live) return;
    const shown = [0, 0, 0];
    const peaks = [0.5, 0.5, 0.5];
    return listen((levels) => {
      const bars = element.current?.children;
      if (!bars) return;
      levels.forEach((level, index) => {
        // Loud, compressed songs sit near the top all the time; scale each
        // bar to its band's recent peak and stretch the upper range so beats
        // still show.
        peaks[index] = Math.max(level, peaks[index] * 0.995, 0.5);
        const target = Math.min(
          1,
          Math.max(0, (level / peaks[index] - 0.35) / 0.65),
        );
        // Rise at once, fall gently, so beats read without flicker.
        const eased =
          target > shown[index]
            ? target
            : shown[index] + (target - shown[index]) * 0.35;
        shown[index] = eased;
        (bars[index] as HTMLElement | undefined)?.style.setProperty(
          "--level",
          eased.toFixed(3),
        );
      });
    });
  }, [live]);
  return (
    <span
      ref={element}
      className={`${className}${live ? " live" : ""}`}
      aria-hidden="true"
    >
      <i />
      <i />
      <i />
    </span>
  );
}
