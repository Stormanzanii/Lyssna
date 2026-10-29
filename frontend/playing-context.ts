import { DJ_ID } from "./library-order";
import type { Playlist, Track } from "./types";

/**
 * The library route of what is playing: `playlist:<id>` for a playlist or
 * the DJ, `liked` for Liked Songs. Undefined for albums, artists and
 * unknown contexts, which have no library row.
 */
export function playingRoute(
  context: string | null | undefined,
  dj = false,
): string | undefined {
  if (dj) return `playlist:${DJ_ID}`;
  if (!context) return;
  if (/^spotify:user:[^:]+:collection$/.test(context)) return "liked";
  const playlist = context.match(
    /^spotify:(?:user:[^:]+:)?playlist:([A-Za-z0-9]+)$/,
  );
  return playlist ? `playlist:${playlist[1]}` : undefined;
}

/** What Spotify's queue calls the playing context: "Next from: <name>".
 * Albums and artists are named from the playing song; undefined when the
 * context is unknown. */
export function contextName(
  context: string | null | undefined,
  {
    dj = false,
    playlists = [],
    track,
  }: {
    dj?: boolean;
    playlists?: Playlist[];
    track?: Track | null;
  } = {},
): string | undefined {
  if (dj) return "DJ";
  const route = playingRoute(context);
  if (route === "liked") return "Liked Songs";
  if (route?.startsWith("playlist:"))
    return playlists.find((item) => `playlist:${item.id}` === route)?.name;
  const [, kind, id] = context?.match(/^spotify:(album|artist):(\w+)$/) ?? [];
  if (kind === "album" && track?.album.id === id) return track.album.name;
  if (kind === "artist")
    return track?.artists.find((artist) => artist.id === id)?.name;
}
