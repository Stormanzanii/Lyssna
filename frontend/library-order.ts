import type { Playlist, PlayerRequest, Settings } from "./types";
import type { AppState } from "./state";
export const DJ_ID = "37i9dQZF1EYkqdzj48dyYq";
export const DJ_PLAYLIST: Playlist = {
  id: DJ_ID,
  name: "DJ",
  images: [],
  owner: { id: "spotify" },
  collaborative: false,
};
export interface LibraryOrder {
  pinned: string[];
  recent: string[];
  items: Playlist[];
}
export const emptyOrder = (): LibraryOrder => ({
  pinned: [],
  recent: [],
  items: [],
});
export function accountOrder(state: AppState): LibraryOrder {
  return (
    state.settings.library_order?.[state.profile?.id ?? ""] ?? emptyOrder()
  );
}
export function libraryItems(state: AppState): Playlist[] {
  const order = accountOrder(state),
    items = new Map(
      [...order.items, DJ_PLAYLIST, ...state.playlists].map((item) => [
        item.id,
        item,
      ]),
    );
  const ids = [
      ...order.pinned,
      ...order.recent,
      DJ_ID,
      ...state.playlists.map((item) => item.id),
    ],
    seen = new Set<string>();
  return ids.flatMap((id) => {
    const item = items.get(id);
    if (!item || seen.has(id)) return [];
    seen.add(id);
    return [item];
  });
}
function remember(order: LibraryOrder, item: Playlist): Playlist[] {
  const items = [item, ...order.items.filter((old) => old.id !== item.id)];
  return [
    ...items.filter((entry) => order.pinned.includes(entry.id)),
    ...items.filter((entry) => !order.pinned.includes(entry.id)).slice(0, 40),
  ];
}
export function recordManualPlay(
  order: LibraryOrder,
  item: Playlist,
): LibraryOrder {
  return {
    ...order,
    recent: [item.id, ...order.recent.filter((id) => id !== item.id)].slice(
      0,
      40,
    ),
    items: remember(order, item),
  };
}
/** Drop a removed playlist from pins, recents and remembered items. */
export function forgetPlaylist(order: LibraryOrder, id: string): LibraryOrder {
  return {
    pinned: order.pinned.filter((item) => item !== id),
    recent: order.recent.filter((item) => item !== id),
    items: order.items.filter((item) => item.id !== id),
  };
}
export function togglePlaylistPin(
  order: LibraryOrder,
  item: Playlist,
): LibraryOrder {
  const pinned = order.pinned.includes(item.id)
    ? order.pinned.filter((id) => id !== item.id)
    : [...order.pinned, item.id];
  if (pinned.length > 3)
    throw new Error("Four pins maximum, including Liked Songs.");
  const next = { ...order, pinned };
  return { ...next, items: remember(next, item) };
}
export function playlistForManualPlay(
  state: AppState,
  request: PlayerRequest,
): Playlist | undefined {
  if (
    !["play_context", "play_home", "play_uris", "dj"].includes(request.command)
  )
    return;
  const id =
    request.command === "dj"
      ? DJ_ID
      : request.context?.match(/^spotify:playlist:([A-Za-z0-9]{22})$/)?.[1];
  if (!id) return;
  const existing = libraryItems(state).find((item) => item.id === id);
  if (existing) return existing;
  const home =
    state.home?.account === state.profile?.id
      ? state.home?.sections
          .flatMap((section) => section.items)
          .find((item) => item.route === `playlist:${id}`)
      : undefined;
  const info =
    state.browse_info?.key === `playlist:${id}` ? state.browse_info : undefined;
  if (!home && !info?.title) return;
  return {
    id,
    name: home?.name || info?.title || "Playlist",
    images: home?.images || info?.images || [],
    owner: { id: info?.playlist?.owner || "spotify" },
    collaborative: false,
  };
}
export function saveAccountOrder(
  state: AppState,
  order: LibraryOrder,
): Partial<Settings> {
  return {
    library_order: {
      ...state.settings.library_order,
      [state.profile!.id]: order,
    },
  };
}
