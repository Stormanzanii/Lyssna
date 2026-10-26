import type { LibraryEntry } from "./library-tree";
import type { Playlist } from "./types";

/** Last played or added, in Unix milliseconds, keyed by Spotify URI. */
export type Recency = Record<string, number>;

export function playlistRecency(playlist: Playlist, recency: Recency) {
  return Math.max(
    recency[`spotify:playlist:${playlist.id}`] ?? 0,
    playlist.added_at ?? 0,
  );
}

/** A folder is as recent as the most recent playlist anywhere inside. */
export function entryRecency(entry: LibraryEntry, recency: Recency): number {
  return entry.kind === "playlist"
    ? playlistRecency(entry.playlist, recency)
    : Math.max(
        0,
        ...entry.entries.map((inner) => entryRecency(inner, recency)),
      );
}

/**
 * Spotify's Recents order: most recently played or added first. Pinned rows
 * stay on top in their own order; rows with equal times keep their order.
 */
export function byRecents<T>(
  rows: T[],
  time: (row: T) => number,
  pinned: (row: T) => boolean = () => false,
): T[] {
  const indexed = rows.map((row, index) => ({ row, index, time: time(row) }));
  return [
    ...indexed.filter(({ row }) => pinned(row)),
    ...indexed
      .filter(({ row }) => !pinned(row))
      .sort((a, b) => b.time - a.time || a.index - b.index),
  ].map(({ row }) => row);
}
