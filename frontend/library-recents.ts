import type { LibraryEntry } from "./library-tree";
import type { LibrarySort, Playlist } from "./types";

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

/** What Your Library's sorts compare for one row. */
export interface LibraryFacts {
  /** Last played or added. */
  recent: number;
  /** When it joined Your Library. */
  added: number;
  name: string;
  creator: string;
}

const byName = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

/**
 * Your Library in one of Spotify's orders. Pinned rows stay on top in their
 * own order; "custom" keeps Spotify's own order, folders included, and ties
 * keep their order too.
 */
export function sortLibrary<T>(
  rows: T[],
  sort: LibrarySort,
  facts: (row: T) => LibraryFacts,
  pinned: (row: T) => boolean = () => false,
): T[] {
  const compare = (a: LibraryFacts, b: LibraryFacts) => {
    switch (sort) {
      case "recently_added":
        return b.added - a.added;
      case "alphabetical":
        return byName.compare(a.name, b.name);
      case "creator":
        return (
          byName.compare(a.creator, b.creator) || byName.compare(a.name, b.name)
        );
      case "custom":
        return 0;
      default:
        return b.recent - a.recent;
    }
  };
  const indexed = rows.map((row, index) => ({ row, index, facts: facts(row) }));
  return [
    ...indexed.filter(({ row }) => pinned(row)),
    ...indexed
      .filter(({ row }) => !pinned(row))
      .sort((a, b) => compare(a.facts, b.facts) || a.index - b.index),
  ].map(({ row }) => row);
}

/** When a row joined Your Library; a folder by its newest playlist. */
export function entryAdded(entry: LibraryEntry): number {
  return entry.kind === "playlist"
    ? (entry.playlist.added_at ?? 0)
    : Math.max(0, ...entry.entries.map(entryAdded));
}
