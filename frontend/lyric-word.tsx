import { memo } from "react";
import { isEmphasis, type AnimatedWord } from "./lyric-motion";

/** Shared static text; LyricAnimator drives its syllables and held letters. */
export const LyricWord = memo(function LyricWord({
  words,
  offset = 0,
  total = words.length,
}: {
  words: AnimatedWord[];
  /** Where these syllables sit in a word split over several boxes. */
  offset?: number;
  total?: number;
}) {
  const whitespace = words[0]?.text.match(/^\s+/u)?.[0] ?? "";
  return (
    <span className="lyric-word-group">
      {whitespace}
      <span className="lyric-word">
        {words.map((word, part) => {
          const text =
            part === 0 ? word.text.slice(whitespace.length) : word.text;
          const emphasis = isEmphasis(word, text);
          // Split syllables scale away from their joints so no seam opens.
          const at = offset + part;
          const joined =
            total === 1
              ? ""
              : at === 0
                ? "joined-start"
                : at === total - 1
                  ? "joined-end"
                  : "joined-middle";
          return (
            <span
              key={part}
              className={`lyric-syllable ${emphasis ? "emphasis" : ""} ${joined}`}
              data-start={word.start_ms}
              data-end={word.end_ms}
              data-letter-offset={word.letterOffset}
              data-letter-count={word.letterCount}
            >
              {emphasis ? (
                Array.from(text).map((letter, index) => (
                  <span key={index} className="lyric-letter">
                    <span className="lyric-paint">{letter}</span>
                  </span>
                ))
              ) : (
                <span className="lyric-paint">{text}</span>
              )}
            </span>
          );
        })}
      </span>
    </span>
  );
});
