import type { Track, TrackFacts } from "./types";
export interface SongFilters {
  query: string;
  genre: string;
  age: string;
  sort: string;
  /** Orders the Random sort; a new one reshuffles. */
  seed?: number;
}
/** A row's place in the Random sort: the same for one seed, so the list
 * holds still while more of the playlist loads. */
function shuffleKey(seed: number, uri: string, index: number) {
  let hash = 2166136261 ^ seed;
  for (const char of `${uri}:${index}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  }
  return hash >>> 0;
}
/** Keep displayed order and duplicate occurrences when starting a queue. */
export function collectionQueue(
  tracks: Track[],
  selected: Track,
  index?: number,
) {
  if (selected.is_local || selected.unavailable) return;
  let clicked =
    index !== undefined && tracks[index]?.uri === selected.uri
      ? index
      : tracks.indexOf(selected);
  if (clicked < 0)
    clicked = tracks.findIndex((track) => track.uri === selected.uri);
  if (clicked < 0) return;
  const playable = tracks
    .map((track, position) => ({ track, position }))
    .filter(({ track }) => !track.is_local && !track.unavailable);
  return {
    uris: playable.map(({ track }) => track.uri),
    offset: playable.findIndex(({ position }) => position === clicked),
  };
}
/**
 * Spotify's "Date added" text: relative under four weeks ("3 days ago"),
 * otherwise the date ("Mar 13, 2024"). Empty when unknown.
 */
export function addedLabel(added: string | undefined, now = Date.now()) {
  const time = Date.parse(added || "");
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  const units: [number, string][] = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4, "week"],
  ];
  let value = seconds;
  for (const [size, unit] of units) {
    if (value < size) return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
    value = Math.floor(value / size);
  }
  return new Date(time).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
/** Text sorts compare like Spotify: case-insensitive, numbers in order. */
const TEXT_SORTS: Record<string, [(track: Track) => string, 1 | -1]> = {
  title_asc: [(track) => track.name, 1],
  title_desc: [(track) => track.name, -1],
  album_asc: [(track) => track.album.name, 1],
  album_desc: [(track) => track.album.name, -1],
};
const collator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

/** Clicking a column header cycles like Spotify: ascending, descending,
 * then back to the playlist's own order. Date added ascends oldest first. */
export function nextHeaderSort(
  column: "title" | "album" | "added",
  current: string,
) {
  const [ascending, descending] =
    column === "added"
      ? ["added_oldest", "recent"]
      : [`${column}_asc`, `${column}_desc`];
  return current === ascending
    ? descending
    : current === descending
      ? "order"
      : ascending;
}
export function genresFor(track: Track, facts: Record<string, TrackFacts>) {
  return facts[track.uri]?.genres?.length
    ? facts[track.uri].genres
    : track.artists.flatMap((artist) => artist.genres ?? []);
}
export function collectionTracks(
  tracks: Track[],
  facts: Record<string, TrackFacts>,
  filters: SongFilters,
  now = Date.now(),
) {
  const query = filters.query.trim().toLocaleLowerCase();
  const release = (track: Track) =>
    Date.parse(
      // The song's own album date is there from the start, so release
      // order holds while facts are still loading.
      track.album.release_date || facts[track.uri]?.release_date || "",
    );
  return tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => {
      if (
        query &&
        !`${track.name} ${track.album.name} ${track.artists.map((artist) => artist.name).join(" ")}`
          .toLocaleLowerCase()
          .includes(query)
      )
        return false;
      const genres = genresFor(track, facts);
      if (
        filters.genre &&
        (filters.genre === "unknown"
          ? genres.length > 0
          : !genres.includes(filters.genre))
      )
        return false;
      if (filters.age) {
        const years = (now - release(track)) / (365.25 * 86400000);
        if (!Number.isFinite(years)) return false;
        if (filters.age === "year" && years > 1) return false;
        if (filters.age === "five" && (years <= 1 || years > 5)) return false;
        if (filters.age === "ten" && (years <= 5 || years > 10)) return false;
        if (filters.age === "older" && years <= 10) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const text = TEXT_SORTS[filters.sort];
      if (text) {
        const [field, direction] = text;
        return (
          direction * collator.compare(field(a.track), field(b.track)) ||
          a.index - b.index
        );
      }
      const value = (track: Track) =>
        filters.sort === "popular"
          ? facts[track.uri]?.plays
          : filters.sort === "recent" || filters.sort === "added_oldest"
            ? Date.parse(track.added_at || "")
            : release(track);
      if (filters.sort === "order") return a.index - b.index;
      if (filters.sort === "random") {
        const seed = filters.seed ?? 0;
        return (
          shuffleKey(seed, a.track.uri, a.index) -
            shuffleKey(seed, b.track.uri, b.index) || a.index - b.index
        );
      }
      const left = value(a.track),
        right = value(b.track),
        hasLeft = left != null && Number.isFinite(left),
        hasRight = right != null && Number.isFinite(right);
      if (!hasLeft || !hasRight)
        return Number(hasRight) - Number(hasLeft) || a.index - b.index;
      return (
        (filters.sort === "oldest" || filters.sort === "added_oldest"
          ? left! - right!
          : right! - left!) || a.index - b.index
      );
    })
    .map(({ track }) => track);
}
