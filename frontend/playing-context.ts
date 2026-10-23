import { DJ_ID } from "./library-order";

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
