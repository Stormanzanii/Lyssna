import { useMemo, useState } from "react";
import { ChevronDown, Heart } from "lucide-react";
import type { Playlist, Track } from "./types";
import { contextRoute, groupRecents, type RecentGroup } from "./recents";
import { Cover, ExplicitBadge, artistNames } from "./components";
import { formatTime } from "./state";

function describe(group: RecentGroup, playlists: Playlist[]) {
  const first = group.tracks[0];
  const count = `${group.tracks.length} song${group.tracks.length === 1 ? "" : "s"} played`;
  const route = contextRoute(group.context);
  if (route === "liked")
    return { title: "Liked Songs", detail: `${count} · Playlist`, liked: true };
  if (route?.startsWith("album:"))
    return {
      title: first.album.name,
      detail: `Album · ${artistNames(first)} · ${count}`,
      images: first.album.images,
    };
  if (route?.startsWith("playlist:")) {
    const playlist = playlists.find((item) => `playlist:${item.id}` === route);
    return {
      title: playlist?.name || "Playlist",
      detail: `${count} · Playlist${playlist?.owner.display_name ? ` · ${playlist.owner.display_name}` : ""}`,
      images: playlist?.images.length ? playlist.images : first.album.images,
    };
  }
  if (route?.startsWith("artist:")) {
    const artist = first.artists.find((item) => `artist:${item.id}` === route);
    return {
      title: artist?.name || "Artist",
      detail: `${count} · Artist`,
      images: first.album.images,
      round: true,
    };
  }
  return { title: count, detail: "", images: first.album.images };
}

/** Listening history grouped by day and by what it played from. */
export function RecentsPage({
  tracks,
  playlists,
  loading,
  onOpen,
  onPlay,
}: {
  tracks: Track[];
  playlists: Playlist[];
  loading: boolean;
  onOpen: (route: string) => void;
  onPlay: (track: Track, index: number) => void;
}) {
  const days = useMemo(() => groupRecents(tracks), [tracks]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  return (
    <div className="recents-page">
      <h1>Recents</h1>
      <div className="recents-filters">
        <span className="pill active">Music</span>
      </div>
      {!days.length && (
        <p className="recents-empty">
          {loading ? "Loading your history…" : "Nothing played recently."}
        </p>
      )}
      {days.map((day) => (
        <section key={day.label} className="recents-day">
          <h2>{day.label}</h2>
          {day.groups.map((group) => {
            const info = describe(group, playlists);
            const route = contextRoute(group.context);
            const key = `${group.tracks[0].added_at}:${group.context}`;
            const open = expanded.has(key);
            return (
              <div key={key} className={`recents-group ${open ? "open" : ""}`}>
                <div className="recents-row">
                  <button
                    className="recents-main"
                    disabled={!route}
                    data-context-route={route}
                    data-context-name={info.title}
                    onClick={() => route && onOpen(route)}
                  >
                    {info.liked ? (
                      <span className="liked-cover recents-art">
                        <Heart size={22} fill="currentColor" />
                      </span>
                    ) : (
                      <Cover
                        images={info.images}
                        className={`recents-art ${info.round ? "round" : ""}`}
                      />
                    )}
                    <span className="recents-copy">
                      <strong>{info.title}</strong>
                      {info.detail && <small>{info.detail}</small>}
                    </span>
                  </button>
                  <button
                    className="icon-button recents-toggle"
                    title={open ? "Hide songs" : "Show songs"}
                    aria-expanded={open}
                    onClick={() =>
                      setExpanded((previous) => {
                        const next = new Set(previous);
                        if (!next.delete(key)) next.add(key);
                        return next;
                      })
                    }
                  >
                    <ChevronDown size={20} />
                  </button>
                </div>
                {open && (
                  <ol className="recents-tracks">
                    {group.tracks.map((track) => {
                      const index = tracks.indexOf(track);
                      return (
                        <li
                          key={`${track.added_at}:${track.uri}`}
                          onDoubleClick={() => onPlay(track, index)}
                        >
                          <Cover images={track.album.images} />
                          <span className="recents-copy">
                            <button
                              className="text-link"
                              onClick={() => onPlay(track, index)}
                            >
                              {track.name}
                            </button>
                            <small>
                              <ExplicitBadge track={track} />
                              {artistNames(track)}
                            </small>
                          </span>
                          <time dateTime={track.added_at}>
                            {new Date(track.added_at || "").toLocaleTimeString(
                              undefined,
                              { hour: "numeric", minute: "2-digit" },
                            )}
                          </time>
                          <span className="recents-duration">
                            {formatTime(track.duration_ms)}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
