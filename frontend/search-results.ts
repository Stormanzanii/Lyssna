import type { Album, Artist, Artwork, Playlist, Track } from "./types";

export type SearchCategory =
  "All" | "Songs" | "Artists" | "Playlists" | "Albums";
export const SEARCH_CATEGORIES: SearchCategory[] = [
  "All",
  "Songs",
  "Artists",
  "Playlists",
  "Albums",
];
export type SearchEntry = {
  uri: string;
  route: string;
  name: string;
  subtitle: string;
  kind: "Song" | "Artist" | "Playlist" | "Album";
  images: Artwork[];
  track?: Track;
  artist?: Artist;
  album?: Album;
};

export function searchEntries(data: {
  tracks: Track[];
  search_artists: Artist[];
  search_albums: Album[];
  search_playlists: Playlist[];
  search_top_results: string[];
}) {
  const entries: SearchEntry[] = [
    ...data.tracks.map((track): SearchEntry => ({
      uri: track.uri,
      route: track.uri.replace(/^spotify:/, ""),
      name: track.name,
      subtitle: track.artists.map((artist) => artist.name).join(", "),
      kind: "Song",
      images: track.album.images,
      track,
    })),
    ...data.search_artists.map((artist): SearchEntry => ({
      uri: artist.uri || `spotify:artist:${artist.id}`,
      route: `artist:${artist.id || artist.uri?.split(":")[2]}`,
      name: artist.name,
      subtitle: "Artist",
      kind: "Artist",
      images: artist.images ?? [],
      artist,
    })),
    ...data.search_playlists.map((playlist): SearchEntry => ({
      uri: `spotify:playlist:${playlist.id}`,
      route: `playlist:${playlist.id}`,
      name: playlist.name,
      subtitle: `By ${playlist.owner.display_name || playlist.owner.id || "Spotify user"}`,
      kind: "Playlist",
      images: playlist.images,
    })),
    ...data.search_albums.map((album): SearchEntry => ({
      uri: album.uri || `spotify:album:${album.id}`,
      route: `album:${album.id || album.uri?.split(":")[2]}`,
      name: album.name,
      subtitle: (album.artists ?? []).map((artist) => artist.name).join(", "),
      kind: "Album",
      images: album.images,
      album,
    })),
  ];
  const byUri = new Map(entries.map((entry) => [entry.uri, entry]));
  const seen = new Set<string>();
  return [
    ...data.search_top_results,
    ...entries.map((entry) => entry.uri),
  ].flatMap((uri) => {
    const entry = byUri.get(uri);
    if (!entry || seen.has(uri)) return [];
    seen.add(uri);
    return [entry];
  });
}
