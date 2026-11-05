import type { Line, Lyrics, Word } from "./types";

export interface CreatorUnit {
  text: string;
  joined: boolean;
  start?: number;
  end?: number;
}
export interface CreatorLine {
  units: CreatorUnit[];
  background: boolean;
  opposite: boolean;
  translation?: string;
  romanization?: string;
}
export interface Cursor {
  line: number;
  unit: number;
}
export interface SongMeta {
  name: string;
  artists: string[];
  album?: string;
  spotifyId?: string;
  durationMs?: number;
}

const OPPOSITE_PREFIX = "v2:";

/**
 * Plain text to lines. One lyric line per text line; `|` splits a word into
 * syllables; a line wrapped in parentheses is a background vocal; a `v2:`
 * prefix gives the line to the second singer.
 */
export function parseText(text: string): CreatorLine[] {
  const lines: CreatorLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let body = raw.trim();
    let opposite = false;
    if (body.toLowerCase().startsWith(OPPOSITE_PREFIX)) {
      opposite = true;
      body = body.slice(OPPOSITE_PREFIX.length).trim();
    }
    let background = false;
    if (body.length > 2 && body.startsWith("(") && body.endsWith(")")) {
      background = true;
      body = body.slice(1, -1).trim();
    }
    const units: CreatorUnit[] = [];
    for (const word of body.split(/\s+/)) {
      word
        .split("|")
        .filter(Boolean)
        .forEach((text, index) =>
          units.push({ text, joined: index > 0 && units.length > 0 }),
        );
    }
    if (units.length) lines.push({ units, background, opposite });
  }
  return lines;
}

export function toText(lines: CreatorLine[]): string {
  return lines
    .map((line) => {
      const body = line.units
        .map((unit, index) =>
          index === 0 ? unit.text : `${unit.joined ? "|" : " "}${unit.text}`,
        )
        .join("");
      const wrapped = line.background ? `(${body})` : body;
      return line.opposite ? `${OPPOSITE_PREFIX} ${wrapped}` : wrapped;
    })
    .join("\n");
}

const shape = (line: CreatorLine) =>
  line.units.map((unit) => `${unit.joined ? "|" : " "}${unit.text}`).join("");

export function keepTimings(
  previous: CreatorLine[],
  next: CreatorLine[],
): CreatorLine[] {
  const pool = new Map<string, CreatorLine[]>();
  for (const line of previous) {
    const key = shape(line);
    pool.set(key, [...(pool.get(key) ?? []), line]);
  }
  return next.map((line) => {
    const match = pool.get(shape(line))?.shift();
    return match
      ? {
          ...line,
          translation: match.translation,
          romanization: match.romanization,
          units: line.units.map((unit, index) => ({
            ...unit,
            start: match.units[index].start,
            end: match.units[index].end,
          })),
        }
      : line;
  });
}

export function fromLyrics(lyrics: Lyrics): CreatorLine[] {
  return lyrics.lines
    .map((line): CreatorLine => {
      const authored =
        lyrics.synced &&
        !lyrics.estimated_words &&
        line.words.length > 0 &&
        line.words.every((word) => !word.estimated);
      const units: CreatorUnit[] = authored
        ? line.words
            .filter((word) => word.text.trim())
            .map((word, index) => ({
              text: word.text.trim(),
              joined: index > 0 && !/^\s/.test(word.text),
              start: word.start_ms,
              end: word.end_ms,
            }))
        : (parseText(line.text.replace(/\|/g, ""))[0]?.units ?? []);
      if (
        !authored &&
        lyrics.synced &&
        !lyrics.estimated_lines &&
        units.length &&
        line.end_ms > line.start_ms
      ) {
        units[0] = { ...units[0], start: line.start_ms };
        const last = units.length - 1;
        units[last] = { ...units[last], end: line.end_ms };
      }
      return {
        units,
        background: line.background,
        opposite: line.opposite,
        ...(line.translation && { translation: line.translation }),
        ...(line.romanization && { romanization: line.romanization }),
      };
    })
    .filter((line) => line.units.length > 0);
}

export const timed = (unit: CreatorUnit) =>
  unit.start !== undefined && unit.end !== undefined;

export function progress(lines: CreatorLine[]) {
  let done = 0,
    total = 0;
  for (const line of lines)
    for (const unit of line.units) {
      total++;
      if (timed(unit)) done++;
    }
  return { done, total };
}

export function nextCursor(lines: CreatorLine[], at: Cursor): Cursor | null {
  if (at.unit + 1 < (lines[at.line]?.units.length ?? 0))
    return { line: at.line, unit: at.unit + 1 };
  for (let line = at.line + 1; line < lines.length; line++)
    if (lines[line].units.length) return { line, unit: 0 };
  return null;
}

export function previousCursor(
  lines: CreatorLine[],
  at: Cursor,
): Cursor | null {
  if (at.unit > 0) return { line: at.line, unit: at.unit - 1 };
  for (let line = at.line - 1; line >= 0; line--)
    if (lines[line].units.length)
      return { line, unit: lines[line].units.length - 1 };
  return null;
}

export function clampCursor(lines: CreatorLine[], at: Cursor): Cursor {
  if (!lines.length) return { line: 0, unit: 0 };
  const line = Math.min(Math.max(0, at.line), lines.length - 1);
  const unit = Math.min(
    Math.max(0, at.unit),
    Math.max(0, lines[line].units.length - 1),
  );
  return { line, unit };
}

function patch(
  lines: CreatorLine[],
  at: Cursor,
  change: Partial<CreatorUnit>,
): CreatorLine[] {
  return lines.map((line, index) =>
    index === at.line
      ? {
          ...line,
          units: line.units.map((unit, position) =>
            position === at.unit ? { ...unit, ...change } : unit,
          ),
        }
      : line,
  );
}

export function markStart(lines: CreatorLine[], at: Cursor, time: number) {
  const unit = lines[at.line]?.units[at.unit];
  if (!unit) return lines;
  return patch(lines, at, {
    start: time,
    end: unit.end !== undefined && unit.end > time ? unit.end : undefined,
  });
}

export function markEnd(
  lines: CreatorLine[],
  at: Cursor,
  time: number,
): { lines: CreatorLine[]; cursor: Cursor } {
  const unit = lines[at.line]?.units[at.unit];
  if (!unit) return { lines, cursor: at };
  const start = Math.min(unit.start ?? time, time);
  return {
    lines: patch(lines, at, { start, end: time }),
    cursor: nextCursor(lines, at) ?? at,
  };
}

export function markNext(
  lines: CreatorLine[],
  at: Cursor,
  time: number,
): { lines: CreatorLine[]; cursor: Cursor } {
  const ended = markEnd(lines, at, time);
  const next = nextCursor(lines, at);
  if (!next) return ended;
  return { lines: markStart(ended.lines, next, time), cursor: next };
}

export function clearTiming(lines: CreatorLine[], at: Cursor) {
  return patch(lines, at, { start: undefined, end: undefined });
}

export function clearAll(lines: CreatorLine[]): CreatorLine[] {
  return lines.map((line) => ({
    ...line,
    units: line.units.map(({ text, joined }) => ({ text, joined })),
  }));
}

export function toggleLine(
  lines: CreatorLine[],
  index: number,
  key: "background" | "opposite",
): CreatorLine[] {
  return lines.map((line, position) =>
    position === index ? { ...line, [key]: !line[key] } : line,
  );
}

export function editUnit(
  lines: CreatorLine[],
  at: Cursor,
  text: string,
): CreatorLine[] {
  const line = lines[at.line];
  const unit = line?.units[at.unit];
  if (!unit) return lines;
  const parts = parseText(text.replace(/[()]/g, ""))[0]?.units ?? [];
  if (parts.length === 1 && parts[0].text === unit.text) return lines;
  const replaced = parts.map((part, index) => ({
    text: part.text,
    joined: index === 0 ? unit.joined : part.joined,
    ...(parts.length === 1 && { start: unit.start, end: unit.end }),
  }));
  const units = [
    ...line.units.slice(0, at.unit),
    ...replaced,
    ...line.units.slice(at.unit + 1),
  ];
  if (units.length) units[0] = { ...units[0], joined: false };
  return units.length
    ? lines.map((each, index) =>
        index === at.line ? { ...each, units } : each,
      )
    : lines.filter((_, index) => index !== at.line);
}

function divided(unit: CreatorUnit, parts: string[]): CreatorUnit[] {
  const { start, end } = unit;
  const total = parts.length;
  let before = 0;
  return parts.map((text, index) => {
    const piece: CreatorUnit = { text, joined: index ? true : unit.joined };
    if (start !== undefined && end !== undefined) {
      piece.start = Math.round(start + ((end - start) * before) / total);
      before += 1;
      piece.end = Math.round(start + ((end - start) * before) / total);
    } else {
      if (index === 0 && start !== undefined) piece.start = start;
      if (index === parts.length - 1 && end !== undefined) piece.end = end;
    }
    return piece;
  });
}

export function splitUnit(
  lines: CreatorLine[],
  at: Cursor,
  parts: string[],
): CreatorLine[] {
  const unit = lines[at.line]?.units[at.unit];
  const kept = parts.filter(Boolean);
  if (!unit || kept.length < 2) return lines;
  return lines.map((line, index) =>
    index === at.line
      ? {
          ...line,
          units: [
            ...line.units.slice(0, at.unit),
            ...divided(unit, kept),
            ...line.units.slice(at.unit + 1),
          ],
        }
      : line,
  );
}

export function splitMatching(
  lines: CreatorLine[],
  text: string,
  cut: (text: string) => string[],
  ignoreCase: boolean,
): CreatorLine[] {
  const same = (other: string) =>
    ignoreCase ? other.toLowerCase() === text.toLowerCase() : other === text;
  return lines.map((line) => ({
    ...line,
    units: line.units.flatMap((unit) =>
      same(unit.text) ? divided(unit, cut(unit.text).filter(Boolean)) : [unit],
    ),
  }));
}

export function breakLine(
  lines: CreatorLine[],
  at: Cursor,
  onlyThisWord: boolean,
): CreatorLine[] {
  const line = lines[at.line];
  if (!line?.units[at.unit]) return lines;
  const moved = onlyThisWord
    ? [line.units[at.unit]]
    : line.units.slice(at.unit);
  const stay = onlyThisWord
    ? line.units.filter((_, index) => index !== at.unit)
    : line.units.slice(0, at.unit);
  if (!stay.length) return lines;
  const fresh = (units: CreatorUnit[]) =>
    units.map((unit, index) => (index ? unit : { ...unit, joined: false }));
  return [
    ...lines.slice(0, at.line),
    { ...line, units: fresh(stay) },
    {
      units: fresh(moved),
      background: line.background,
      opposite: line.opposite,
    },
    ...lines.slice(at.line + 1),
  ];
}

export const duplicateLine = (lines: CreatorLine[], index: number) =>
  lines[index]
    ? [...lines.slice(0, index + 1), lines[index], ...lines.slice(index + 1)]
    : lines;

export function toggleJoin(lines: CreatorLine[], at: Cursor): CreatorLine[] {
  if (at.unit === 0) return lines;
  return lines.map((line, index) =>
    index === at.line
      ? {
          ...line,
          units: line.units.map((unit, position) =>
            position === at.unit ? { ...unit, joined: !unit.joined } : unit,
          ),
        }
      : line,
  );
}

export function insertLines(
  lines: CreatorLine[],
  after: number,
  text: string,
): CreatorLine[] {
  const added = parseText(text);
  return [...lines.slice(0, after + 1), ...added, ...lines.slice(after + 1)];
}

export const removeLine = (lines: CreatorLine[], index: number) =>
  lines.filter((_, position) => position !== index);

/** `before` counts positions in the list before the move. */
export function moveLine(lines: CreatorLine[], from: number, before: number) {
  if (!lines[from] || before === from || before === from + 1) return lines;
  const rest = lines.filter((_, index) => index !== from);
  const at = before > from ? before - 1 : before;
  return [...rest.slice(0, at), lines[from], ...rest.slice(at)];
}

export function wordBounds(units: CreatorUnit[], index: number) {
  let start = index;
  while (start > 0 && units[start].joined) start--;
  let end = index + 1;
  while (end < units.length && units[end].joined) end++;
  return { start, end };
}

/** `to.unit` is a word boundary in the target line, counted before the move. */
export function moveWord(
  lines: CreatorLine[],
  from: Cursor,
  to: Cursor,
): CreatorLine[] {
  const source = lines[from.line];
  const target = lines[to.line];
  if (!source?.units[from.unit] || !target) return lines;
  const { start, end } = wordBounds(source.units, from.unit);
  const same = from.line === to.line;
  if (same && to.unit >= start && to.unit <= end) return lines;
  const word = source.units
    .slice(start, end)
    .map((unit, index) => (index ? unit : { ...unit, joined: false }));
  const kept = source.units.filter((_, index) => index < start || index >= end);
  if (kept[0]) kept[0] = { ...kept[0], joined: false };
  const into = same ? kept : target.units;
  const at = same && to.unit > start ? to.unit - word.length : to.unit;
  const placed = [...into.slice(0, at), ...word, ...into.slice(at)];
  return lines
    .map((line, index) =>
      index === to.line
        ? { ...line, units: placed }
        : index === from.line
          ? { ...line, units: kept }
          : line,
    )
    .filter((line) => line.units.length);
}

/** Moves the gap before `from.unit` to before `to.unit`, a syllable joint. */
export function moveSpace(
  lines: CreatorLine[],
  from: Cursor,
  to: Cursor,
): CreatorLine[] {
  const units = lines[from.line]?.units;
  if (
    !units ||
    from.line !== to.line ||
    from.unit === 0 ||
    units[from.unit]?.joined !== false ||
    !units[to.unit]?.joined
  )
    return lines;
  return lines.map((line, index) =>
    index === from.line
      ? {
          ...line,
          units: units.map((unit, position) =>
            position === from.unit
              ? { ...unit, joined: true }
              : position === to.unit
                ? { ...unit, joined: false }
                : unit,
          ),
        }
      : line,
  );
}

export function setLineText(
  lines: CreatorLine[],
  index: number,
  key: "translation" | "romanization",
  value: string,
): CreatorLine[] {
  return lines.map((line, position) =>
    position === index ? { ...line, [key]: value || undefined } : line,
  );
}

export function lineSpan(line: CreatorLine) {
  const starts = line.units.flatMap((unit) =>
    unit.start === undefined ? [] : [unit.start],
  );
  const ends = line.units.flatMap((unit) =>
    unit.end === undefined ? [] : [unit.end],
  );
  if (!starts.length) return null;
  return {
    start: Math.min(...starts),
    end: Math.max(...(ends.length ? ends : starts)),
  };
}

export function problems(lines: CreatorLine[]): string[] {
  const found: string[] = [];
  if (!lines.length) return ["Add some lyrics first."];
  const { done, total } = progress(lines);
  if (done < total)
    found.push(
      `${total - done} of ${total} ${total === 1 ? "word has" : "words have"} no timing yet.`,
    );
  let backwards = 0;
  for (const line of lines)
    for (const unit of line.units)
      if (timed(unit) && unit.end! < unit.start!) backwards++;
  if (backwards)
    found.push(
      `${backwards} ${backwards === 1 ? "word ends" : "words end"} before ${backwards === 1 ? "it starts" : "they start"}.`,
    );
  return found;
}

export function toLyrics(lines: CreatorLine[]): Lyrics {
  const shown: Line[] = [];
  for (const line of lines) {
    const words: Word[] = [];
    line.units.forEach((unit, index) => {
      if (unit.start === undefined) return;
      words.push({
        start_ms: unit.start,
        end_ms: Math.max(unit.start, unit.end ?? unit.start),
        text: index > 0 && !unit.joined ? ` ${unit.text}` : unit.text,
      });
    });
    const span = lineSpan(line);
    if (!span || !words.length) continue;
    shown.push({
      start_ms: span.start,
      end_ms: span.end,
      text: words.map((word) => word.text).join(""),
      translation: line.translation ?? "",
      romanization: line.romanization ?? "",
      words,
      background: line.background,
      opposite: line.opposite,
    });
  }
  return {
    lines: shown,
    source: "TTML Creator",
    instrumental: false,
    synced: true,
  };
}

export function formatTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

const escape = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function spans(line: CreatorLine): string {
  return line.units
    .filter(timed)
    .map((unit, index) => {
      const span = `<span begin="${formatTime(unit.start!)}" end="${formatTime(Math.max(unit.start!, unit.end!))}">${escape(unit.text)}</span>`;
      return index > 0 && !unit.joined ? ` ${span}` : span;
    })
    .join("");
}

function extras(line: CreatorLine): string {
  return [
    line.translation &&
      `<span ttm:role="x-translation">${escape(line.translation)}</span>`,
    line.romanization &&
      `<span ttm:role="x-roman">${escape(line.romanization)}</span>`,
  ]
    .filter(Boolean)
    .join("");
}

/**
 * Word-timed TTML in the Apple Music style AMLL and Spicy Lyrics read.
 * Background lines nest inside the lead line sung before them.
 */
export function toTtml(lines: CreatorLine[], meta: SongMeta): string {
  type Paragraph = { lead?: CreatorLine; backgrounds: CreatorLine[] };
  const paragraphs: Paragraph[] = [];
  for (const line of lines) {
    if (!lineSpan(line)) continue;
    const last = paragraphs.at(-1);
    if (line.background && last) last.backgrounds.push(line);
    else if (line.background) paragraphs.push({ backgrounds: [line] });
    else paragraphs.push({ lead: line, backgrounds: [] });
  }
  const opposite = lines.some((line) => line.opposite);
  let end = 0;
  const body = paragraphs
    .map((paragraph, index) => {
      const all = [paragraph.lead, ...paragraph.backgrounds].filter(
        (line): line is CreatorLine => !!line,
      );
      const spansOf = all.map((line) => lineSpan(line)!);
      const begin = Math.min(...spansOf.map((span) => span.start));
      const finish = Math.max(...spansOf.map((span) => span.end));
      end = Math.max(end, finish);
      const agent = (paragraph.lead ?? paragraph.backgrounds[0]).opposite
        ? "v2"
        : "v1";
      const lead = paragraph.lead
        ? spans(paragraph.lead) + extras(paragraph.lead)
        : "";
      const backgrounds = paragraph.backgrounds
        .map((line) => {
          const span = lineSpan(line)!;
          return `<span ttm:role="x-bg" begin="${formatTime(span.start)}" end="${formatTime(span.end)}">${spans(line)}</span>`;
        })
        .join("");
      return `<p begin="${formatTime(begin)}" end="${formatTime(finish)}" ttm:agent="${agent}" itunes:key="L${index + 1}">${lead}${backgrounds}</p>`;
    })
    .join("");
  const metadata = [
    `<ttm:agent type="person" xml:id="v1"/>`,
    opposite ? `<ttm:agent type="other" xml:id="v2"/>` : "",
    meta.name
      ? `<amll:meta key="musicName" value="${escape(meta.name)}"/>`
      : "",
    ...meta.artists.map(
      (artist) => `<amll:meta key="artists" value="${escape(artist)}"/>`,
    ),
    meta.album ? `<amll:meta key="album" value="${escape(meta.album)}"/>` : "",
    meta.spotifyId
      ? `<amll:meta key="spotifyId" value="${escape(meta.spotifyId)}"/>`
      : "",
  ].join("");
  const duration = Math.max(end, meta.durationMs ?? 0);
  return `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:amll="http://www.example.com/ns/amll" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="Word"><head><metadata>${metadata}</metadata></head><body dur="${formatTime(duration)}"><div begin="${formatTime(paragraphs.length ? Math.min(...paragraphs.map((p) => lineSpan(p.lead ?? p.backgrounds[0])!.start)) : 0)}" end="${formatTime(end)}">${body}</div></body></tt>`;
}

export function fileName(meta: SongMeta): string {
  const base = [meta.artists.join(", "), meta.name]
    .filter(Boolean)
    .join(" - ")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 120);
  return `${base || "lyrics"}.ttml`;
}
