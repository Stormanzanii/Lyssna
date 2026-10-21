import type { Track, TrackFacts } from "./types";
export interface SongFilters {
  query: string;
  genre: string;
  age: string;
  sort: string;
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
      facts[track.uri]?.release_date || track.album.release_date || "",
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
      const value = (track: Track) =>
        filters.sort === "popular"
          ? facts[track.uri]?.plays
          : filters.sort === "recent" || filters.sort === "added_oldest"
            ? Date.parse(track.added_at || "")
            : release(track);
      if (filters.sort === "order") return a.index - b.index;
      const left = value(a.track),
        right = value(b.track),
        hasLeft = left != null && Number.isFinite(left),
        hasRight = right != null && Number.isFinite(right);
      if (!hasLeft || !hasRight)
        return Number(hasRight) - Number(hasLeft) || a.index - b.index;
      return (
        (filters.sort === "oldest" || filters.sort === "added_oldest"
          ? left! - right!
          : right! - left!) ||
        a.index - b.index
      );
    })
    .map(({ track }) => track);
}
