import { useEffect, useState } from "react";
import { Check, CirclePlus, Play } from "lucide-react";
import type { Artist, Artwork } from "./types";
import { Cover } from "./components";
import { rpc } from "./bridge";

/** One release from Spotify's What's New feed. */
export interface Release {
  id: string;
  uri: string;
  name: string;
  album_type: string;
  artists: Artist[];
  images: Artwork[];
  released: string;
  new: boolean;
}

const DAY = 86_400_000;
/** "Today", "4 days ago", "1 week ago" and so on, as Spotify words it. */
export function releasedAgo(iso: string, now = Date.now()) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const days = Math.max(0, Math.floor((now - time) / DAY));
  const unit = (count: number, word: string) =>
    `${count} ${word}${count === 1 ? "" : "s"} ago`;
  if (days === 0) return "Today";
  if (days < 7) return unit(days, "day");
  if (days < 30) return unit(Math.floor(days / 7), "week");
  if (days < 365) return unit(Math.floor(days / 30), "month");
  return unit(Math.floor(days / 365), "year");
}

const typeName = (type: string) =>
  ({ SINGLE: "Single", ALBUM: "Album", EP: "EP", COMPILATION: "Compilation" })[
    type
  ] ?? "Release";

/** The bell's page: new releases from artists you follow, newest unseen
 * first, as Spotify's What's New. */
export function WhatsNewPage({
  saved,
  onOpen,
  onPlay,
  onSave,
}: {
  saved: Record<string, boolean>;
  onOpen: (route: string) => void;
  onPlay: (uri: string) => void;
  onSave: (uri: string, saved: boolean) => void;
}) {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    rpc<Release[]>("whats_new")
      .then((items) => {
        if (!active) return;
        setReleases(items ?? []);
        const uris = (items ?? []).map((item) => item.uri);
        if (uris.length) void rpc("saved_status", { uris }).catch(() => {});
      })
      .catch((reason) => active && setError(String(reason)));
    return () => {
      active = false;
    };
  }, []);
  // Spotify marks items seen once any client shows them, so recent releases
  // also count as new: a week, as in Spotify's own New section.
  const isFresh = (item: Release) =>
    item.new || Date.now() - Date.parse(item.released) < 7 * DAY;
  const fresh = releases?.filter(isFresh) ?? [];
  const earlier = releases?.filter((item) => !isFresh(item)) ?? [];
  const row = (release: Release) => {
    const id = release.uri.split(":")[2];
    const isSaved = !!saved[release.uri];
    return (
      <li key={release.id || release.uri} className="whats-new-row">
        <Cover
          images={release.images}
          className="whats-new-cover"
          onClick={() => id && onOpen(`album:${id}`)}
        />
        <div className="whats-new-text">
          <button
            className="whats-new-title"
            onClick={() => id && onOpen(`album:${id}`)}
          >
            {release.name}
          </button>
          <span className="whats-new-artists">
            {release.artists.map((artist, index) => (
              <span key={artist.uri || index}>
                {index > 0 && ", "}
                <button
                  onClick={() => artist.id && onOpen(`artist:${artist.id}`)}
                >
                  {artist.name}
                </button>
              </span>
            ))}
          </span>
          <span className="whats-new-meta">
            <span className="whats-new-type">
              {typeName(release.album_type)}
            </span>
            {releasedAgo(release.released) && (
              <>
                <span className="whats-new-dot">·</span>
                {releasedAgo(release.released)}
              </>
            )}
          </span>
        </div>
        <div className="whats-new-actions">
          <button
            className={`icon-button whats-new-save ${isSaved ? "saved" : ""}`}
            title={
              isSaved ? "Remove from Your Library" : "Save to Your Library"
            }
            aria-pressed={isSaved}
            onClick={() => onSave(release.uri, !isSaved)}
          >
            {isSaved ? (
              <Check size={18} />
            ) : (
              <CirclePlus size={30} strokeWidth={1.4} />
            )}
          </button>
          <button
            className="whats-new-play"
            title={`Play ${release.name}`}
            onClick={() => onPlay(release.uri)}
          >
            <Play size={20} fill="currentColor" />
          </button>
        </div>
      </li>
    );
  };
  return (
    <div className="whats-new-page">
      <h1>What&rsquo;s New</h1>
      <p className="whats-new-intro">
        The latest releases from artists you follow.
      </p>
      <div className="whats-new-filters">
        <span className="pill active">Music</span>
      </div>
      {error ? (
        <p className="whats-new-empty">{error}</p>
      ) : releases === null ? (
        <p className="whats-new-empty">Loading…</p>
      ) : !releases.length ? (
        <p className="whats-new-empty">
          Nothing new yet. Follow artists to see their releases here.
        </p>
      ) : (
        <>
          {fresh.length > 0 && (
            <section>
              <h2>New</h2>
              <ul>{fresh.map(row)}</ul>
            </section>
          )}
          {earlier.length > 0 && (
            <section>
              <h2>Earlier</h2>
              <ul>{earlier.map(row)}</ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
