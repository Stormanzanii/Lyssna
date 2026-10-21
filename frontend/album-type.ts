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
