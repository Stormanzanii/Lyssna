import type { Playlist, Track } from "./types";

/** "Song - Artist, Artist", as Spotify+'s Copy Song & Artist Name. */
export const songAndArtist = (track: Track) =>
  `${track.name} - ${track.artists.map((artist) => artist.name).join(", ")}`;

/** Track IDs joined as "id1, id2, id3", as Spotify+'s Copy IDs. */
export const trackIds = (tracks: Track[]) =>
  tracks
    .map((track) => track.id || track.uri.split(":")[2])
    .filter(Boolean)
    .join(", ");

/** Spotify's embed player markup for a song, album, playlist or artist. */
export function embedCode(
  kind: "track" | "album" | "playlist" | "artist",
  id: string,
) {
  const height = kind === "track" ? 152 : 352;
  return `<iframe style="border-radius:12px" src="https://open.spotify.com/embed/${kind}/${encodeURIComponent(id)}?utm_source=generator" width="100%" height="${height}" frameBorder="0" allowfullscreen="" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>`;
}

/** Add to playlist offers only playlists directly inside the chosen
 *  folders; no folders chosen offers them all. */
export function inChosenFolders(playlists: Playlist[], folders: string[] = []) {
  if (!folders.length) return playlists;
  const chosen = new Set(folders);
  return playlists.filter((playlist) => {
    const inner = playlist.folders?.at(-1);
    return !!inner && chosen.has(inner.id);
  });
}
