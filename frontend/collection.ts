import type { Track, TrackFacts } from "./types";
export interface SongFilters {
  query: string;
  genre: string;
  age: string;
  sort: string;
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
          : filters.sort === "recent"
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
        (filters.sort === "oldest" ? left! - right! : right! - left!) ||
        a.index - b.index
      );
    })
    .map(({ track }) => track);
}
