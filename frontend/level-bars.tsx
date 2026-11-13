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
    const targets = [0, 0, 0];
    const shown = [0, 0, 0];
    const peaks = [0.5, 0.5, 0.5];
    const stop = listen((levels) =>
      levels.forEach((level, index) => {
        // Loud, compressed songs sit near the top all the time; scale each
        // bar to its band's recent peak and stretch the upper range so beats
        // still show.
        peaks[index] = Math.max(level, peaks[index] * 0.995, 0.5);
        targets[index] = Math.min(
          1,
          Math.max(0, (level / peaks[index] - 0.35) / 0.65),
        );
      }),
    );
    let frame = requestAnimationFrame(function draw() {
      const box = element.current;
      if (box) {
        // Whole-pixel heights; centred bars grow two pixels at a time so
        // both ends stay on the pixel grid. Scaling or half pixels blur the
        // bars and make them look like they change width.
        const tallest = box.clientHeight;
        const step = getComputedStyle(box).alignItems === "center" ? 2 : 1;
        Array.from(box.children).forEach((bar, index) => {
          const gap = targets[index] - shown[index];
          shown[index] += gap * (gap > 0 ? 0.55 : 0.2);
          const height =
            3 + step * Math.round((shown[index] * (tallest - 3)) / step);
          (bar as HTMLElement).style.height = `${height}px`;
          bar.setAttribute("data-level", shown[index].toFixed(3));
        });
      }
      frame = requestAnimationFrame(draw);
    });
    return () => {
      stop();
      cancelAnimationFrame(frame);
    };
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
