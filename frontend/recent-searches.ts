import type { SearchEntry } from "./search-results";

/** A search result the user opened, shown again under an empty search box. */
export type RecentSearch = Pick<
  SearchEntry,
  "uri" | "route" | "name" | "subtitle" | "kind" | "images" | "track"
>;

const LIMIT = 20;
const key = (account: string) => `lyssna.recent-searches.${account}`;

/** Newest first, without duplicates, capped at 20. */
export function rememberSearch(
  list: RecentSearch[],
  entry: SearchEntry,
): RecentSearch[] {
  const { uri, route, name, subtitle, kind, images, track } = entry;
  return [
    { uri, route, name, subtitle, kind, images: images.slice(0, 1), track },
    ...list.filter((item) => item.uri !== uri),
  ].slice(0, LIMIT);
}

export function loadRecentSearches(account: string): RecentSearch[] {
  if (!account) return [];
  try {
    const value = JSON.parse(localStorage.getItem(key(account)) || "[]");
    return Array.isArray(value)
      ? value
          .filter(
            (item) =>
              typeof item?.uri === "string" &&
              typeof item?.route === "string" &&
              typeof item?.name === "string",
          )
          .slice(0, LIMIT)
      : [];
  } catch {
    return [];
  }
}

export function saveRecentSearches(account: string, list: RecentSearch[]) {
  if (!account) return;
  try {
    localStorage.setItem(key(account), JSON.stringify(list));
  } catch {
    // Storage can be unavailable; recents then last for this session only.
  }
}
