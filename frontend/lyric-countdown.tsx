import { memo, useRef, type CSSProperties, type Ref } from "react";
import {
  CountdownSprings,
  countdownDots,
  countdownVisible,
  type VocalGap,
} from "./lyric-motion";

/** Shared waiting dots for the normal and floating lyrics views. */
export const LyricCountdown = memo(function LyricCountdown({
  gap,
  time,
  reduceMotion = false,
  visible = true,
  className = "",
  ref,
}: {
  gap: VocalGap;
  time: number;
  reduceMotion?: boolean;
  visible?: boolean;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}) {
  const shown = visible && countdownVisible(gap, time);
  // Song time updates every frame; springs ease each dot toward its target.
  const springs = useRef<CountdownSprings>(null);
  springs.current ??= new CountdownSprings();
  const dots = springs.current.frame(
    countdownDots(gap, time, reduceMotion),
    time,
    performance.now(),
    reduceMotion,
  );
  return (
    <div
      ref={ref}
      aria-hidden={!shown}
      className={`lyric-wait ${className} ${gap.opposite ? "opposite" : ""}`}
      role="status"
      aria-label="Instrumental break"
    >
      <span className="lyric-wait-dots">
        {dots.map((dot, index) => (
          <i
            key={index}
            style={
              {
                "--dot-opacity": dot.opacity,
                "--dot-lift": dot.lift,
                "--dot-scale": dot.scale,
                "--dot-glow": dot.glow,
              } as CSSProperties
            }
          />
        ))}
      </span>
    </div>
  );
});
