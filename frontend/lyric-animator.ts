import type { Lyrics } from "./types";
import {
  MOTION,
  SyllableSprings,
  letterGoals,
  vocalEnd,
  wordGoal,
  type SyllableGoal,
} from "./lyric-motion";

interface Piece {
  element: HTMLElement;
  springs: SyllableSprings;
  /** Last value written per style property, to skip redundant writes. */
  written: Map<string, string>;
}
interface Syllable extends Piece {
  start: number;
  end: number;
  letters: Piece[];
}
const STYLES = [
  "scale",
  "translate",
  "--gradient-position",
  "--glow-blur",
  "--glow-opacity",
];
const piece = (element: HTMLElement, letter: boolean): Piece => ({
  element,
  springs: new SyllableSprings(letter),
  written: new Map(),
});
function write(target: Piece, property: string, value: string) {
  if (target.written.get(property) === value) return;
  target.written.set(property, value);
  target.element.style.setProperty(property, value);
}
function clear(target: Piece) {
  for (const property of STYLES) target.element.style.removeProperty(property);
  target.written.clear();
}

/** Drives syllable springs on rendered lyric lines. Lines being sung, and
 * lines whose springs are still settling, are stepped every frame and written
 * straight to the DOM. Other lines rest on static styles. */
export class LyricAnimator {
  private live = new Map<number, Syllable[]>();
  private ends: number[];
  private time = 0;
  private last = performance.now();
  private frame = 0;
  constructor(
    private lyrics: Lyrics,
    private line: (index: number) => HTMLElement | null,
    private reduceMotion: boolean,
  ) {
    this.ends = lyrics.lines.map(vocalEnd);
  }
  /** Sets song time and steps. Keeps stepping on its own while springs
   * settle, such as after a pause or a seek. */
  update(time: number) {
    this.time = time;
    this.run();
  }
  dispose() {
    cancelAnimationFrame(this.frame);
    for (const [index, syllables] of this.live) this.release(index, syllables);
  }
  private run = () => {
    cancelAnimationFrame(this.frame);
    const now = performance.now(),
      seconds = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.frame = this.step(seconds) ? requestAnimationFrame(this.run) : 0;
  };
  private release(index: number, syllables: Syllable[]) {
    for (const syllable of syllables) {
      clear(syllable);
      syllable.letters.forEach(clear);
    }
    this.live.delete(index);
  }
  private build(index: number): Syllable[] | undefined {
    const element = this.line(index),
      words = this.lyrics.lines[index].words;
    const nodes = element?.querySelectorAll<HTMLElement>(".lyric-syllable");
    if (!nodes || nodes.length !== words.length) return undefined;
    return Array.from(nodes, (node, part) => {
      const emphasis = node.classList.contains("emphasis");
      return {
        ...piece(node, false),
        start: words[part].start_ms,
        end: words[part].end_ms - (emphasis ? MOTION.emphasisTailMs : 0),
        letters: emphasis
          ? Array.from(
              node.querySelectorAll<HTMLElement>(".lyric-letter"),
              (letter) => piece(letter, true),
            )
          : [],
      };
    });
  }
  private apply(
    target: Piece,
    goal: SyllableGoal,
    seconds: number,
    glow: [blur: number, opacity: number] | undefined,
  ) {
    if (glow || !this.reduceMotion)
      write(target, "--gradient-position", `${goal.gradient}%`);
    if (this.reduceMotion) return;
    const motion = target.springs.step(goal, seconds);
    write(target, "scale", motion.scale.toFixed(4));
    write(target, "translate", `0 ${motion.lift.toFixed(4)}em`);
    if (glow) {
      write(
        target,
        "--glow-blur",
        `${(4 + glow[0] * motion.glow).toFixed(2)}px`,
      );
      write(
        target,
        "--glow-opacity",
        `${Math.min(100, Math.max(0, motion.glow * glow[1])).toFixed(1)}%`,
      );
    }
  }
  private step(seconds: number): boolean {
    const time = this.time;
    let moving = false;
    this.lyrics.lines.forEach((line, index) => {
      if (!line.words.length) return;
      const active = line.start_ms <= time && time < this.ends[index];
      let syllables = this.live.get(index);
      if (!active && !syllables) return;
      // After a seek back, lines not reached yet snap to their resting
      // styles instead of settling.
      if (syllables && time < line.start_ms) {
        this.release(index, syllables);
        return;
      }
      syllables ??= this.build(index);
      if (!syllables) return;
      this.live.set(index, syllables);
      let awake = false;
      for (const syllable of syllables) {
        const goal = wordGoal(syllable.start, syllable.end, time);
        // Held words move as a block while their letters carry the fill and
        // glow.
        this.apply(
          syllable,
          goal,
          seconds,
          syllable.letters.length ? undefined : [2, 35],
        );
        letterGoals(
          syllable.start,
          syllable.end,
          time,
          syllable.letters.length,
        ).forEach((goal, letter) =>
          this.apply(syllable.letters[letter], goal, seconds, [12, 185]),
        );
        awake ||=
          !this.reduceMotion &&
          (!syllable.springs.asleep ||
            syllable.letters.some((letter) => !letter.springs.asleep));
      }
      moving ||= awake;
      if (!awake && !active) this.release(index, syllables);
    });
    return moving;
  }
}
