import { useMemo, useState, type KeyboardEvent } from "react";
import {
  CircleCheck,
  CirclePlus,
  LoaderCircle,
  Play,
  Search,
} from "lucide-react";
import { ArtistLinks, Cover, cancelPrefetch, prefetchPage } from "./components";
import { Shelf } from "./HomePage";
import type { AppState } from "./state";
import type { Album, Artist, HomeItem, Track } from "./types";
import {
  SEARCH_CATEGORIES,
  searchEntries,
  type SearchCategory,
  type SearchEntry,
} from "./search-results";
import "./SearchPage.css";

export function SearchPage({
  state,
  navigate,
  play,
  playTrack,
  openArtist,
  openAlbum,
  save,
  follow,
  retry,
  remember,
}: {
  state: AppState;
  navigate: (route: string) => void;
  play: (item: HomeItem) => void;
  playTrack: (track: Track, index?: number) => void;
  openArtist: (artist: Artist) => void;
  openAlbum: (album: Album) => void;
  save: (track: Track) => void;
  follow: (artist: Artist) => void;
  retry: () => void;
  /** Record an opened result for the search box's recent searches. */
  remember: (entry: SearchEntry) => void;
}) {
  const [category, setCategory] = useState<SearchCategory>("All");
  const entries = useMemo(
    () => searchEntries(state),
    [
      state.tracks,
      state.search_artists,
      state.search_albums,
      state.search_playlists,
      state.search_top_results,
    ],
  );
  const top = entries[0];
  const preview = entries.slice(1, 6);
  const previewUris = new Set([top?.uri, ...preview.map((entry) => entry.uri)]);
  const busy = state.loading || state.search_playlists_loading;
  const message = state.search_playlists_error || state.pageError;
  const asItem = (entry: SearchEntry): HomeItem => ({
    ...entry,
    kind: entry.kind.toLowerCase(),
    playable: true,
    format: "",
  });
  const start = (entry: SearchEntry) => {
    remember(entry);
    return entry.track
      ? playTrack(
          entry.track,
          state.tracks.findIndex((track) => track.uri === entry.uri),
        )
      : play(asItem(entry));
  };
  const open = (entry: SearchEntry) => {
    remember(entry);
    if (entry.track) start(entry);
    else if (entry.artist) openArtist(entry.artist);
    else if (entry.album) openAlbum(entry.album);
    else navigate(entry.route);
  };
  const tabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === "ArrowRight")
      next = (index + 1) % SEARCH_CATEGORIES.length;
    else if (event.key === "ArrowLeft")
      next = (index + SEARCH_CATEGORIES.length - 1) % SEARCH_CATEGORIES.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = SEARCH_CATEGORIES.length - 1;
    else return;
    event.preventDefault();
    setCategory(SEARCH_CATEGORIES[next]);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [next]?.focus();
  };
  const row = (entry: SearchEntry, featured = false) => {
    const saved = !!state.saved[entry.uri];
    return (
      <article
        key={entry.uri}
        className={`search-result-row ${featured ? "search-top-result" : ""} ${entry.kind === "Artist" ? "search-artist-row" : ""}`}
        data-context-route={entry.route}
        data-context-name={entry.name}
        aria-label={featured ? "Top result" : undefined}
        onMouseEnter={() =>
          !entry.track &&
          /^(artist|album|playlist):/.test(entry.route) &&
          prefetchPage(entry.route)
        }
        onMouseLeave={cancelPrefetch}
      >
        <button
          className="search-result-art"
          onClick={() => open(entry)}
          aria-label={`Select ${entry.name}`}
        >
          <Cover images={entry.images} />
          <Play size={23} fill="currentColor" className="search-art-play" />
        </button>
        <div className="search-result-copy">
          <button className="search-result-title" onClick={() => open(entry)}>
            {entry.name}
          </button>
          <div className="search-result-subtitle">
            {entry.track ? (
              <>
                {entry.track.explicit && (
                  <span className="explicit-badge" aria-label="Explicit">
                    E
                  </span>
                )}
                <span>Song · </span>
                <ArtistLinks
                  artists={entry.track.artists}
                  onArtist={openArtist}
                />
              </>
            ) : (
              entry.subtitle
            )}
          </div>
        </div>
        {!featured && <span className="search-result-kind">{entry.kind}</span>}
        <div className="search-result-actions">
          {entry.track && (
            <button
              className={`icon-button search-save ${saved ? "saved" : ""}`}
              onClick={() => save(entry.track!)}
              aria-label={
                saved
                  ? `Remove ${entry.name} from Liked Songs`
                  : `Save ${entry.name} to Liked Songs`
              }
            >
              {saved ? (
                <CircleCheck size={19} fill="currentColor" />
              ) : (
                <CirclePlus size={19} />
              )}
            </button>
          )}
          {entry.artist && !featured && (
            <button
              className="search-follow"
              onClick={() => follow(entry.artist!)}
            >
              {saved ? "Following" : "Follow"}
            </button>
          )}
          {featured && (
            <button
              className="primary-play search-result-play"
              onClick={() => start(entry)}
              aria-label={`Play ${entry.name}`}
              disabled={!state.native_ready}
            >
              <Play size={24} fill="currentColor" />
            </button>
          )}
        </div>
      </article>
    );
  };
  const shelf = (title: "Playlists" | "Artists" | "Albums") => {
    const items = entries.filter((entry) => entry.kind === title.slice(0, -1));
    if (!items.length) return null;
    return (
      <div className={title === "Playlists" ? "search-playlists" : undefined}>
        <Shelf
          key={`${state.route}:${title}:${category}`}
          section={{
            uri: `${state.route}:${title}`,
            title,
            subtitle: "",
            items: items.map(asItem),
          }}
          navigate={(route) => {
            const entry = entries.find((entry) => entry.route === route);
            if (entry) open(entry);
          }}
          play={play}
          ready={state.native_ready}
          defaultExpanded={category !== "All"}
        />
      </div>
    );
  };
  const filtered =
    category === "All"
      ? entries
      : entries.filter((entry) => entry.kind === category.slice(0, -1));
  return (
    <section
      className="search-page"
      aria-label={`Search results for ${state.route.slice(7)}`}
    >
      <h1 className="search-accessible-title">
        Search results for “{state.route.slice(7)}”
      </h1>
      <div
        className="search-category-bar"
        role="tablist"
        aria-label="Search categories"
      >
        {SEARCH_CATEGORIES.map((value, index) => (
          <button
            key={value}
            id={`search-tab-${value}`}
            role="tab"
            aria-selected={category === value}
            aria-controls="search-results-panel"
            tabIndex={category === value ? 0 : -1}
            className={`search-category ${category === value ? "selected" : ""}`}
            onClick={() => setCategory(value)}
            onKeyDown={(event) => tabKey(event, index)}
          >
            {value}
          </button>
        ))}
      </div>
      <div
        id="search-results-panel"
        role="tabpanel"
        aria-labelledby={`search-tab-${category}`}
      >
        {busy && !entries.length ? (
          <div
            className="search-loading"
            role="status"
            aria-label="Searching Spotify"
          >
            <LoaderCircle className="spin" size={22} /> Searching Spotify…
          </div>
        ) : null}
        {message && (
          <div className="search-result-message" role="status">
            <span>{message}</span>
            <button className="text-link" onClick={retry}>
              Try again
            </button>
          </div>
        )}
        {category === "All" ? (
          <>
            {top && row(top, true)}
            {!!preview.length && (
              <section className="search-top-rows" aria-label="Top results">
                {preview.map((entry) => row(entry))}
              </section>
            )}
            {shelf("Playlists")}
            {shelf("Artists")}
            {shelf("Albums")}
            {entries.some(
              (entry) => entry.track && !previewUris.has(entry.uri),
            ) && (
              <section className="search-song-results" aria-label="Songs">
                <h2>Songs</h2>
                {entries
                  .filter((entry) => entry.track && !previewUris.has(entry.uri))
                  .map((entry) => row(entry))}
              </section>
            )}
          </>
        ) : category === "Songs" ? (
          <section className="search-song-results" aria-label="Songs">
            <h2 className="search-accessible-title">Songs</h2>
            {filtered.map((entry) => row(entry))}
          </section>
        ) : (
          shelf(category)
        )}
        {!busy && !filtered.length && (
          <div className="search-empty">
            <Search size={30} />
            <h2>
              No {category === "All" ? "results" : category.toLowerCase()} found
            </h2>
            <p>Try another name, artist or mood.</p>
          </div>
        )}
      </div>
    </section>
  );
}
