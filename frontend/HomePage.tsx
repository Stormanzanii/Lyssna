import { memo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
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
import { DJ_COVER } from "./brand";
import "./HomePage.css";

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
  const row = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <section className="home-shelf" aria-label={section.title}>
      <div className="home-shelf-heading">
        <div>
          {section.subtitle && <p>{section.subtitle}</p>}
          <h2>{section.title}</h2>
        </div>
        <div className="home-shelf-controls">
          <button className="text-link" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Collapse" : "Expand"}
          </button>
          <button
            className="icon-button"
            aria-label={`Scroll ${section.title} left`}
            onClick={() =>
              row.current?.scrollBy({
                left: -row.current.clientWidth * 0.85,
                behavior: "smooth",
              })
            }
          >
            <ChevronLeft size={18} />
          </button>
          <button
            className="icon-button"
            aria-label={`Scroll ${section.title} right`}
            onClick={() =>
              row.current?.scrollBy({
                left: row.current.clientWidth * 0.85,
                behavior: "smooth",
              })
            }
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
      <div
        ref={row}
        className={`home-shelf-items ${expanded ? "expanded" : ""}`}
      >
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
            <button
              className="home-card-title"
              onClick={() =>
                item.kind === "track" ? play(item) : navigate(item.route)
              }
            >
              {item.name}
            </button>
            <p>{item.subtitle || item.kind}</p>
          </article>
        ))}
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
}) {
  return (
    <div className="personal-home">
      <div className="home-toolbar">
        <span className="pill active">Music</span>
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
          <div>
            <strong>DJ</strong>
            <span>Music picked for you</span>
          </div>
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
      {data?.sections.map((section, index) => (
        <Shelf
          key={`${section.uri}-${index}`}
          section={section}
          navigate={navigate}
          play={play}
          ready={ready}
        />
      ))}
    </div>
  );
});
