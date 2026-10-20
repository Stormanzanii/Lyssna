import { memo } from "react";
import { isEmphasis, type AnimatedWord } from "./lyric-motion";

/** Shared static text; LyricAnimator drives its syllables and held letters. */
export const LyricWord = memo(function LyricWord({
  words,
}: {
  words: AnimatedWord[];
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
          const joined =
            words.length === 1
              ? ""
              : part === 0
                ? "joined-start"
                : part === words.length - 1
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
              {emphasis
                ? Array.from(text).map((letter, index) => (
                    <span key={index} className="lyric-letter">
                      {letter}
                    </span>
                  ))
                : text}
            </span>
          );
        })}
      </span>
    </span>
  );
});
