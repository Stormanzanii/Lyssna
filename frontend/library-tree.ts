import type { FolderRef, LibraryFolder, Playlist } from "./types";

/** A sidebar row: a playlist, or a Spotify folder with its own rows. */
export type LibraryEntry =
  | { kind: "playlist"; playlist: Playlist }
  | {
      kind: "folder";
      folder: FolderRef;
      entries: LibraryEntry[];
      /** Playlists anywhere inside, including subfolders. */
      count: number;
    };

/**
 * Groups the sidebar into Spotify folders. `items` is the sidebar order
 * (pins, recents, then library order); a folder takes the place of its
 * first playlist in that order, so it rises with its most recent playlist.
 * Pinned playlists stay at the top level. `library` is Spotify's own order,
 * used inside folders.
 */
export function libraryTree(
  items: Playlist[],
  library: Playlist[],
  pinned: string[],
  folders: LibraryFolder[] = [],
): LibraryEntry[] {
  const placed = new Set<string>();
  const entries: LibraryEntry[] = [];
  for (const playlist of items) {
    const top = playlist.folders?.[0];
    if (!top || pinned.includes(playlist.id)) {
      entries.push({ kind: "playlist", playlist });
      continue;
    }
    if (placed.has(top.id)) continue;
    placed.add(top.id);
    entries.push(
      folderEntry(
        top,
        library.filter((item) => item.folders?.[0]?.id === top.id),
        0,
        folders,
      ),
    );
  }
  // Folders with no playlists anywhere inside sit under the pins, where
  // Spotify puts a new folder.
  const empty = folders
    .filter((folder) => !folder.parents.length && !placed.has(folder.id))
    .map((folder) => folderEntry(folder, [], 0, folders));
  const pins = entries.findIndex(
    (entry) =>
      entry.kind !== "playlist" || !pinned.includes(entry.playlist.id),
  );
  entries.splice(pins < 0 ? entries.length : pins, 0, ...empty);
  return entries;
}

function folderEntry(
  folder: FolderRef,
  members: Playlist[],
  depth: number,
  folders: LibraryFolder[],
): LibraryEntry {
  const entries: LibraryEntry[] = [];
  const placed = new Set<string>();
  for (const playlist of members) {
    const child = playlist.folders?.[depth + 1];
    if (!child) {
      entries.push({ kind: "playlist", playlist });
      continue;
    }
    if (placed.has(child.id)) continue;
    placed.add(child.id);
    entries.push(
      folderEntry(
        child,
        members.filter((item) => item.folders?.[depth + 1]?.id === child.id),
        depth + 1,
        folders,
      ),
    );
  }
  for (const child of folders)
    if (
      child.parents.length === depth + 1 &&
      child.parents[depth] === folder.id &&
      !placed.has(child.id)
    )
      entries.push(folderEntry(child, [], depth + 1, folders));
  return { kind: "folder", folder, entries, count: members.length };
}
