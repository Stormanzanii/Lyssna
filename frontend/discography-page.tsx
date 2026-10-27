import { useEffect, useRef, useState } from "react";
import { ChevronDown, Play } from "lucide-react";
import { rpc } from "./bridge";
import { Cover } from "./components";
import { albumMatches, albumTypeLabel } from "./album-type";
import { formatTime } from "./state";
import type { Album, Track } from "./types";

type Songs = { tracks: Track[]; streams: Record<string, number> };
/** Songs already loaded, by release, so returning to a discography is
 *  instant. Bounded: the oldest entries go first. */
const loaded = new Map<string, Songs>();
function remember(id: string, songs: Songs) {
  loaded.set(id, songs);
  if (loaded.size > 300) loaded.delete(loaded.keys().next().value!);
}

const FILTERS = [
  ["all", "All"],
  ["album", "Albums"],
  ["single", "Singles and EPs"],
  ["compilation", "Compilations"],
] as const;

/** Spotify's Discography page, from an artist's Show all: every release,
 *  newest first, each with its songs and their plays. */
export function DiscographyPage({
  artistId,
  artistName,
  ready,
  onOpenAlbum,
  onPlay,
}: {
  artistId: string;
  artistName: string;
  ready: boolean;
  onOpenAlbum: (album: Album) => void;
  /** Plays a release, from a chosen song when one is given. */
  onPlay: (release: string, track?: string) => void;
}) {
  const [releases, setReleases] = useState<Album[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    if (!ready) return;
    let current = true;
    setReleases(null);
    setError("");
    rpc<Album[]>("artist_discography", { id: artistId })
      .then((list) => current && setReleases(list))
      .catch((reason) => current && setError(String(reason)));
    return () => {
      current = false;
    };
  }, [artistId, ready]);
  const shown = (releases ?? []).filter((release) =>
    albumMatches(release.album_type, filter),
  );
  return (
    <div className="discography-page">
      <header className="discography-header">
        <h1>{artistName}</h1>
        <div className="discography-filter">
          <button
            className="text-link"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            {FILTERS.find(([value]) => value === filter)?.[1]}
            <ChevronDown size={16} />
          </button>
          {menu && (
            <div className="discography-filter-menu" role="menu">
              {FILTERS.map(([value, label]) => (
                <button
                  key={value}
                  role="menuitemradio"
                  aria-checked={filter === value}
                  onClick={() => {
                    setFilter(value);
                    setMenu(false);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>
      {error ? (
        <p className="discography-message">{error}</p>
      ) : !releases ? (
        <p className="discography-message">Loading releases…</p>
      ) : (
        shown.map((release, index) => (
          <DiscographyRelease
            key={release.uri ?? release.id}
            release={release}
            // The first releases load at once; the rest as they come near.
            eager={index < 6}
            onOpen={() => onOpenAlbum(release)}
            onPlay={(track) =>
              onPlay(release.uri ?? `spotify:album:${release.id}`, track)
            }
          />
        ))
      )}
    </div>
  );
}

/** One release: its cover and details, then its songs once it scrolls near
 *  view, so a long discography loads only what is looked at. */
function DiscographyRelease({
  release,
  eager,
  onOpen,
  onPlay,
}: {
  release: Album;
  eager: boolean;
  onOpen: () => void;
  onPlay: (track?: string) => void;
}) {
  const section = useRef<HTMLElement>(null);
  const id = release.id || release.uri?.split(":")[2];
  const [songs, setSongs] = useState<Songs | null>(
    () => (id && loaded.get(id)) || null,
  );
  const [near, setNear] = useState(eager);
  useEffect(() => {
    const element = section.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "2000px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!near || !id || songs) return;
    let current = true;
    rpc<[Track[], Record<string, number>]>("release_tracks", { id })
      .then(([tracks, streams]) => {
        remember(id, { tracks, streams });
        if (current) setSongs({ tracks, streams });
      })
      .catch(() => current && setSongs({ tracks: [], streams: {} }));
    return () => {
      current = false;
    };
  }, [near, id]);
  const count = release.total_tracks || songs?.tracks.length || 0;
  return (
    <section className="discography-release" ref={section}>
      <div className="discography-release-head">
        <button className="discography-release-cover" onClick={onOpen}>
          <Cover images={release.images} />
        </button>
        <div>
          <button className="discography-release-title" onClick={onOpen}>
            {release.name}
          </button>
          <p>
            {[
              albumTypeLabel(release.album_type),
              release.release_date?.slice(0, 4),
              count ? `${count} song${count === 1 ? "" : "s"}` : "",
            ]
              .filter(Boolean)
              .join(" • ")}
          </p>
          <button
            className="discography-release-play"
            aria-label={`Play ${release.name}`}
            onClick={() => onPlay()}
          >
            <Play size={18} fill="currentColor" />
          </button>
        </div>
      </div>
      <div className="discography-tracks" role="table">
        <div className="discography-track discography-track-head" role="row">
          <span>#</span>
          <span>Title</span>
          <span>Plays</span>
          <span>Time</span>
        </div>
        {songs?.tracks.map((track, index) => (
          <button
            key={track.uri}
            className="discography-track"
            role="row"
            onDoubleClick={() => onPlay(track.uri)}
          >
            <span>{index + 1}</span>
            <span className="discography-track-title">
              <strong>{track.name}</strong>
              <small>
                {track.artists.map((artist) => artist.name).join(", ")}
              </small>
            </span>
            <span>{songs.streams[track.uri]?.toLocaleString() ?? ""}</span>
            <span>{formatTime(track.duration_ms)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
