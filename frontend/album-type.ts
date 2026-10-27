import type { Album, Discography } from "./types";

/** Spotify sends release types in either case ("SINGLE", "single"). */
export const albumKind = (type?: string) => (type || "album").toLowerCase();

/** The release type as Spotify shows it: "Album", "Single", "EP", "Compilation". */
export function albumTypeLabel(type?: string) {
  const kind = albumKind(type);
  return kind === "ep" ? "EP" : kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** Discography filter match; "Singles and EPs" includes EPs. */
export const albumMatches = (type: string | undefined, filter: string) =>
  filter === "all" ||
  albumKind(type) === filter ||
  (filter === "single" && albumKind(type) === "ep");

/** The releases a Discography chip shows. Spotify's own page lists come
 *  first: Popular releases opens with the latest release. Without them
 *  (an older saved page), the Web API's releases are filtered by type. */
export function discographyReleases(
  albums: Album[],
  discography: Discography | undefined,
  filter: string,
): Album[] {
  const listed =
    filter === "all"
      ? [
          ...(discography?.latest ? [discography.latest] : []),
          ...(discography?.popular ?? []),
        ]
      : filter === "album"
        ? discography?.albums
        : filter === "single"
          ? discography?.singles
          : discography?.compilations;
  if (!listed?.length)
    return albums.filter((album) => albumMatches(album.album_type, filter));
  return listed.filter(
    (album, index) =>
      listed.findIndex((other) => other.uri === album.uri) === index,
  );
}
