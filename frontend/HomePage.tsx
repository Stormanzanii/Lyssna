import { memo, useState, type ReactNode } from "react";
import {
  CircleCheck,
  CirclePlus,
  Heart,
  LoaderCircle,
  Play,
  RefreshCw,
} from "lucide-react";
import type {
  HomeItem,
  HomePage as HomeData,
  HomeSection,
  Playlist,
} from "./types";
import { Cover } from "./components";
import { SpotifyText } from "./SpotifyText";
import { DJ_COVER } from "./brand";
import "./HomePage.css";

/** Splits "Made For Name" into a small label and a large name, as Spotify does. */
const LABELS =
  /^(Made For|New release from|Go deeper on|More like|More of what you like from|Because you listened to)\s+(.+)$/;
export function shelfHeading(section: HomeSection) {
  const match = LABELS.exec(section.title);
  return match
    ? { label: match[1], title: match[2] }
    : { label: section.subtitle, title: section.title };
}
/** Spotify-made playlists carry their name in the artwork; show only the description. */
export const titleInArt = (item: HomeItem) =>
  item.kind === "playlist" && !!item.format;

export function Shelf({
  section,
  navigate,
  play,
  ready,
  defaultExpanded = false,
}: {
  section: HomeSection;
  navigate: (route: string) => void;
  play: (item: HomeItem) => void;
  ready: boolean;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const heading = shelfHeading(section);
  return (
    <section className="home-shelf" aria-label={section.title}>
      <div className="home-shelf-heading">
        <div>
          {heading.label && (
            <p>
              <SpotifyText text={heading.label} navigate={navigate} />
            </p>
          )}
          <h2>{heading.title}</h2>
        </div>
        <button
          className="home-show-all"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show all"}
        </button>
      </div>
      <div className={`home-shelf-items ${expanded ? "expanded" : ""}`}>
        {section.items.map((item) => (
          <article
            className={`home-card ${item.kind === "artist" ? "artist-card" : ""}`}
            key={item.uri}
            data-context-route={item.route}
            data-context-name={item.name}
          >
            <div className="home-card-art">
              <button
                className="home-card-open"
                onClick={() =>
                  item.kind === "track" ? play(item) : navigate(item.route)
                }
                aria-label={`Open ${item.name}`}
              >
                <Cover images={item.images} />
              </button>
              <button
                className="home-card-play"
                disabled={!ready || !item.playable}
                onClick={() => play(item)}
                aria-label={`Play ${item.name}`}
              >
                <Play size={23} fill="currentColor" />
              </button>
            </div>
            {!titleInArt(item) && (
              <button
                className="home-card-title"
                onClick={() =>
                  item.kind === "track" ? play(item) : navigate(item.route)
                }
              >
                {item.name}
              </button>
            )}
            <p>
              <SpotifyText
                text={item.subtitle || item.kind}
                navigate={navigate}
              />
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
/** A one-item section, such as a new release, shown large like Spotify. */
function FeaturedShelf({
  section,
  navigate,
  play,
  ready,
  saved,
  onSave,
}: {
  section: HomeSection;
  navigate: (route: string) => void;
  play: (item: HomeItem) => void;
  ready: boolean;
  saved: Record<string, boolean>;
  onSave: (item: HomeItem) => void;
}) {
  const item = section.items[0];
  const heading = shelfHeading(section);
  const kind = item.kind.charAt(0).toUpperCase() + item.kind.slice(1);
  return (
    <section
      className="home-shelf home-featured"
      aria-label={section.title}
      data-context-route={item.route}
      data-context-name={item.name}
    >
      <div className="home-featured-heading">
        <Cover images={item.images} />
        <div>
          {heading.label && <p>{heading.label}</p>}
          <h2>{heading.title}</h2>
        </div>
      </div>
      <div className="home-featured-body">
        <button
          className="home-featured-art"
          onClick={() => navigate(item.route)}
          aria-label={`Open ${item.name}`}
        >
          <Cover images={item.images} />
        </button>
        <div className="home-featured-info">
          <p>
            {kind}
            {item.subtitle && !titleInArt(item) ? ` • ${item.subtitle}` : ""}
          </p>
          <button
            className="home-featured-title"
            onClick={() => navigate(item.route)}
          >
            {item.name}
          </button>
          <div className="home-featured-actions">
            <button
              className="home-featured-play"
              disabled={!ready || !item.playable}
              onClick={() => play(item)}
              aria-label={`Play ${item.name}`}
            >
              <Play size={20} fill="currentColor" />
            </button>
            {item.kind === "album" && (
              <button
                className={`icon-button ${saved[item.uri] ? "is-saved" : ""}`}
                aria-label={
                  saved[item.uri]
                    ? "Remove from Your Library"
                    : "Save to Your Library"
                }
                onClick={() => onSave(item)}
              >
                {saved[item.uri] ? (
                  <CircleCheck size={26} fill="currentColor" stroke="#000" />
                ) : (
                  <CirclePlus size={26} />
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
function SkeletonShelf() {
  return (
    <section className="home-shelf home-skeleton" aria-hidden="true">
      <div className="home-shelf-heading">
        <span className="skeleton-bar heading" />
      </div>
      <div className="home-shelf-items">
        {Array.from({ length: 7 }, (_, index) => (
          <div className="home-card" key={index}>
            <span className="skeleton-bar art" />
            <span className="skeleton-bar title" />
            <span className="skeleton-bar subtitle" />
          </div>
        ))}
      </div>
    </section>
  );
}
export const HomePage = memo(function HomePage({
  data,
  playlists,
  loading,
  error,
  ready,
  navigate,
  play,
  dj,
  refresh,
  saved,
  onSave,
}: {
  data?: HomeData;
  playlists: Playlist[];
  loading: boolean;
  error: string;
  ready: boolean;
  navigate: (route: string) => void;
  play: (item: HomeItem) => void;
  dj: () => void;
  refresh: () => void;
  saved: Record<string, boolean>;
  onSave: (item: HomeItem) => void;
}) {
  const [filter, setFilter] = useState<"all" | "music">("all");
  const sections = data?.sections ?? [];
  const rows: ReactNode[] = [];
  const shelf = (section: HomeSection, key: number) => (
    <Shelf
      key={`${section.uri}-${key}`}
      section={section}
      navigate={navigate}
      play={play}
      ready={ready}
    />
  );
  for (let index = 0; index < sections.length; index++) {
    const section = sections[index];
    if (section.items.length !== 1) {
      rows.push(shelf(section, index));
      continue;
    }
    const featured = (
      <FeaturedShelf
        key={`${section.uri}-${index}`}
        section={section}
        navigate={navigate}
        play={play}
        ready={ready}
        saved={saved}
        onSave={onSave}
      />
    );
    // Spotify sets a featured item beside the next shelf.
    const next = sections[index + 1];
    if (next && next.items.length > 1) {
      rows.push(
        <div className="home-pair" key={`pair-${index}`}>
          {featured}
          {shelf(next, index + 1)}
        </div>,
      );
      index++;
    } else rows.push(featured);
  }
  return (
    <div className="personal-home">
      <div className="home-toolbar">
        <div className="home-filters" role="tablist" aria-label="Home filters">
          {(["all", "music"] as const).map((value) => (
            <button
              key={value}
              role="tab"
              aria-selected={filter === value}
              className={`pill ${filter === value ? "active" : ""}`}
              onClick={() => setFilter(value)}
            >
              {value === "all" ? "All" : "Music"}
            </button>
          ))}
        </div>
        <button
          className="icon-button"
          title="Refresh personalized Home"
          onClick={refresh}
          disabled={!ready || loading}
        >
          {loading ? (
            <LoaderCircle className="spin" size={20} />
          ) : (
            <RefreshCw size={20} />
          )}
        </button>
      </div>
      <div className="home-quick-links">
        <button className="quick-tile" onClick={() => navigate("liked")}>
          <div className="liked-cover">
            <Heart fill="currentColor" />
          </div>
          <strong>Liked Songs</strong>
        </button>
        <button
          className="quick-tile dj-quick-tile"
          aria-label="Start DJ"
          onClick={dj}
          disabled={!ready}
        >
          <img className="dj-cover" src={DJ_COVER} alt="" draggable={false} />
          <strong>DJ</strong>
          <Play className="quick-tile-play" size={18} fill="currentColor" />
        </button>
        {playlists.slice(0, 6).map((playlist) => (
          <button
            className="quick-tile"
            key={playlist.id}
            onClick={() => navigate(`playlist:${playlist.id}`)}
          >
            <Cover images={playlist.images} />
            <strong>{playlist.name}</strong>
          </button>
        ))}
      </div>
      {error && (
        <div className="home-status" role="status">
          {error}{" "}
          <button className="text-link" onClick={refresh} disabled={!ready}>
            Retry
          </button>
        </div>
      )}
      {!data && !error && (
        <>
          <p className="home-status-hint" role="status">
            {ready ? "Loading your recommendations…" : "Connecting to Spotify…"}
          </p>
          <SkeletonShelf />
          <SkeletonShelf />
        </>
      )}
      {rows}
    </div>
  );
});
