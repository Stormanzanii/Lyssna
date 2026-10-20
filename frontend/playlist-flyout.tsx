import { useState } from "react";
import { Plus, Search, Users } from "lucide-react";
import type { Playlist } from "./types";

const WIDTH = 300;

/** Spotify-style "Add to playlist" flyout: filter, New playlist, then names. */
export function PlaylistFlyout({
  playlists,
  x,
  y,
  onPick,
  onCreate,
}: {
  playlists: Playlist[];
  x: number;
  y: number;
  onPick: (playlist: Playlist) => void;
  onCreate: () => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? playlists.filter((playlist) =>
        playlist.name.toLowerCase().includes(needle),
      )
    : playlists;
  return (
    <div
      className="playlist-flyout popover"
      role="menu"
      aria-label="Add to playlist"
      style={{
        left: Math.max(8, Math.min(x, window.innerWidth - WIDTH - 8)),
        top: Math.max(8, Math.min(y, window.innerHeight - 460)),
        width: WIDTH,
      }}
    >
      <label className="playlist-flyout-search">
        <Search size={18} />
        <input
          autoFocus
          placeholder="Find a playlist"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <button
        role="menuitem"
        className="playlist-flyout-new"
        onClick={onCreate}
      >
        <Plus size={20} />
        New playlist
      </button>
      <div className="playlist-flyout-list">
        {shown.map((playlist) => (
          <button
            role="menuitem"
            key={playlist.id}
            title={playlist.name}
            onClick={() => onPick(playlist)}
          >
            <span>{playlist.name}</span>
            {playlist.collaborative && (
              <Users size={17} aria-label="Collaborative playlist" />
            )}
          </button>
        ))}
        {!shown.length && <p>No playlists found</p>}
      </div>
    </div>
  );
}
