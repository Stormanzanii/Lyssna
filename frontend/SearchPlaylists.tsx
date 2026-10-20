import { Shelf } from "./HomePage";
import type { AppState } from "./state";
import type { HomeItem } from "./types";

export function SearchPlaylists({
  state,
  navigate,
  play,
}: {
  state: AppState;
  navigate: (route: string) => void;
  play: (item: HomeItem) => void;
}) {
  return (
    <div className="search-playlists">
      <Shelf
        section={{
          uri: state.route,
          title: "Playlists",
          subtitle: "",
          items: state.search_playlists.map((playlist) => ({
            uri: `spotify:playlist:${playlist.id}`,
            route: `playlist:${playlist.id}`,
            name: playlist.name,
            subtitle: `By ${playlist.owner.display_name || playlist.owner.id || "Spotify user"}`,
            images: playlist.images,
            kind: "playlist",
            playable: true,
            format: "",
          })),
        }}
        navigate={navigate}
        play={play}
        ready={state.native_ready}
      />
      {state.search_playlists_loading && (
        <p role="status">Searching playlists…</p>
      )}
      {!state.search_playlists_loading && state.search_playlists_error && (
        <p role="status">{state.search_playlists_error}</p>
      )}
      {!state.search_playlists_loading &&
        !state.search_playlists_error &&
        !state.search_playlists.length && (
          <p>No playlists found. Try another name or mood.</p>
        )}
    </div>
  );
}
