import {
  useMemo,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { vocalGap, wordGroups } from "./lyric-motion";
import type { Lyrics } from "./types";

export function prepareFloatingWords(lyrics: Lyrics) {
  return lyrics.lines.flatMap((line, lineIndex) =>
    wordGroups(line.words).map((group, index) => ({
      key: `${lineIndex}:${index}`,
      text: group
        .map((word) => word.text)
        .join("")
        .trim(),
      start: group[0].start_ms,
      end: group.at(-1)!.end_ms,
      opposite: line.opposite,
      background: line.background,
      seed: lineIndex * 37 + index * 13,
    })),
  );
}
export function visibleFloatingWords(
  groups: ReturnType<typeof prepareFloatingWords>,
  time: number,
) {
  return groups
    .filter(
      (word) =>
        word.text && word.start <= time + 900 && word.end >= time - 6500,
    )
    .slice(-36);
}
export function FloatingLyrics({
  lyrics,
  time,
  onSeek,
  credits,
}: {
  lyrics: Lyrics;
  time: number;
  onSeek: (position: number) => void;
  credits: ReactNode;
}) {
  const groups = useMemo(() => prepareFloatingWords(lyrics), [lyrics]);
  const words = visibleFloatingWords(groups, time),
    gap = vocalGap(lyrics.lines, time),
    stage = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = stage.current,
      cover = container
        ?.closest(".lyrics-page")
        ?.querySelector(".lyrics-album>.cover");
    if (!container || !cover) return;
    const align = () => {
      const box = cover.getBoundingClientRect();
      container.style.setProperty(
        "--floating-focus",
        `${box.top + box.height / 2 - container.getBoundingClientRect().top}px`,
      );
    };
    align();
    const observer = new ResizeObserver(align);
    observer.observe(container);
    observer.observe(cover);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="floating-lyrics">
      <div className="floating-stage" ref={stage} aria-label="Floating lyrics">
        {words.map((word) => {
          const age = (time - word.start) / 1000,
            active = time >= word.start && time < word.end,
            angle = ((word.seed % 12) * Math.PI) / 6 + age * 0.075,
            radius = active ? 10 : 19 + (word.seed % 16),
            x = Math.cos(angle) * radius,
            y = active ? 0 : Math.sin(angle) * radius,
            opacity = active ? 1 : Math.max(0, Math.min(0.62, (7 - age) / 7));
          const fill = Math.max(
            0,
            Math.min(
              100,
              ((time - word.start) / Math.max(1, word.end - word.start)) * 100,
            ),
          );
          return (
            <button
              key={word.key}
              className={`floating-word ${active ? "active" : ""} ${word.opposite ? "opposite" : ""}`}
              onClick={() => onSeek(word.start)}
              style={
                {
                  left: `${50 + x + (word.opposite ? 8 : -4)}%`,
                  top: `calc(var(--floating-focus,47%) + ${y}%)`,
                  opacity: opacity * (word.background ? 0.7 : 1),
                  transform: `translate(-50%,-50%) rotate(${active ? Math.sin(age * 2) * 4 : Math.sin(angle) * 62}deg) scale(${active ? 1.1 : 1})`,
                  "--word-progress": `${fill}%`,
                } as CSSProperties
              }
            >
              {word.text}
            </button>
          );
        })}
        {gap && (
          <div
            className={`lyric-wait floating-wait ${gap.opposite ? "opposite" : ""}`}
            aria-label="Instrumental break"
          >
            <i />
            <i />
            <i />
          </div>
        )}
        {!words.length && !gap && (
          <p className="floating-instrumental">
            {lyrics.instrumental ? "Instrumental" : "…"}
          </p>
        )}
      </div>
      <div className="floating-credits">{credits}</div>
    </div>
  );
}
