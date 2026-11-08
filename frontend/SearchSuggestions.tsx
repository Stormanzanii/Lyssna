import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  CircleCheck,
  CirclePlus,
  Search,
} from "lucide-react";
import { rpc } from "./bridge";
import { Cover, ExplicitBadge } from "./components";
import { searchEntries, type SearchEntry } from "./search-results";
import type { Album, Artist, Playlist, Profile, Track } from "./types";

export type SearchSuggestionResults = {
  terms: string[];
  results: {
    tracks: Track[];
    artists: Artist[];
    albums: Album[];
    playlists: Playlist[];
    users?: Profile[];
    top_results: string[];
  };
};

export type SuggestionKeys = {
  handle: (event: KeyboardEvent<HTMLInputElement>) => boolean;
};

type Row = { term: string } | { entry: SearchEntry };

const TERMS = 4;
const ITEMS = 12;
const cache = new Map<string, Row[]>();

export function suggestionRows(found: SearchSuggestionResults): Row[] {
  const { results } = found;
  const entries = searchEntries({
    tracks: results.tracks,
    search_artists: results.artists,
    search_albums: results.albums,
    search_playlists: results.playlists,
    search_users: results.users,
    search_top_results: results.top_results,
  });
  const rank = (entry: SearchEntry) => {
    const index = results.top_results.indexOf(entry.uri);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [
    ...found.terms.slice(0, TERMS).map((term) => ({ term })),
    ...entries
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, ITEMS)
      .map((entry) => ({ entry })),
  ];
}

function detail(entry: SearchEntry) {
  if (entry.kind === "Artist" || entry.kind === "Profile") return entry.kind;
  const type = entry.album?.album_type;
  const kind =
    entry.kind === "Album" && type && type !== "album"
      ? type === "ep"
        ? "EP"
        : type[0].toUpperCase() + type.slice(1)
      : entry.kind;
  const subtitle = entry.subtitle.replace(/^By /, "");
  return subtitle ? `${kind} • ${subtitle}` : kind;
}

export function SearchSuggestions({
  query,
  keys,
  searchFor,
  open,
  save,
  saved,
}: {
  query: string;
  keys: Ref<SuggestionKeys>;
  searchFor: (term: string) => void;
  open: (entry: SearchEntry) => void;
  save: (track: Track) => void;
  saved: Record<string, boolean>;
}) {
  const term = query.trim();
  const [rows, setRows] = useState<Row[]>(() => cache.get(term) ?? []);
  const [active, setActive] = useState(-1);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Fetch the full results once typing pauses, so Enter shows them at once.
    const timer = setTimeout(
      () => void rpc("search_warm", { query: term }).catch(() => {}),
      450,
    );
    return () => clearTimeout(timer);
  }, [term]);
  useEffect(() => {
    setActive(-1);
    const known = cache.get(term);
    if (known) {
      setRows(known);
      return;
    }
    let live = true;
    // Short enough to feel instant, long enough to skip most keystrokes.
    const timer = setTimeout(() => {
      rpc<SearchSuggestionResults>("search_suggestions", { query: term })
        .then((found) => {
          const next = suggestionRows(found);
          if (cache.size >= 60) cache.clear();
          cache.set(term, next);
          if (live) setRows(next);
        })
        .catch(() => {});
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [term]);
  const choose = (row: Row) =>
    "term" in row ? searchFor(row.term) : open(row.entry);
  useImperativeHandle(
    keys,
    () => ({
      handle: (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!rows.length) return true;
          const step = event.key === "ArrowDown" ? 1 : -1;
          setActive((index) => {
            const next = index + step;
            return next < -1
              ? rows.length - 1
              : next >= rows.length
                ? -1
                : next;
          });
          return true;
        }
        if (event.key === "Enter" && active >= 0 && rows[active]) {
          event.preventDefault();
          choose(rows[active]);
          return true;
        }
        return false;
      },
    }),
    [rows, active],
  );
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-row="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);
  if (!rows.length)
    return (
      <div
        className="recent-searches search-suggestions popover"
        aria-label="Loading suggestions"
        aria-busy="true"
        onMouseDown={(event) => event.preventDefault()}
      >
        {Array.from({ length: 7 }, (_, index) => (
          <div className="search-suggestion-skeleton" key={index}>
            <i />
            <i style={{ width: `${70 - ((index * 17) % 35)}%` }} />
            <i />
          </div>
        ))}
      </div>
    );
  return (
    <div
      ref={list}
      className="recent-searches search-suggestions popover"
      role="listbox"
      aria-label="Search suggestions"
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="search-suggestions-keys" aria-hidden="true">
        <kbd>
          <ArrowUp size={14} />
        </kbd>
        <kbd>
          <ArrowDown size={14} />
        </kbd>
        <span>Navigate</span>
        <kbd className="wide">Enter</kbd>
        <span>Search</span>
      </div>
      {rows.map((row, index) => {
        const selected = index === active;
        if ("term" in row)
          return (
            <div
              className={`recent-search ${selected ? "active" : ""}`}
              key={`term:${row.term}`}
              data-row={index}
            >
              <button
                role="option"
                aria-selected={selected}
                onClick={() => choose(row)}
                onMouseMove={() => setActive(index)}
              >
                <span className="search-suggestion-icon">
                  <Search size={24} />
                </span>
                <strong>{row.term}</strong>
              </button>
            </div>
          );
        const { entry } = row;
        const liked = !!saved[entry.uri];
        return (
          <div
            className={`recent-search ${selected ? "active" : ""}`}
            key={entry.uri}
            data-row={index}
          >
            <button
              role="option"
              aria-selected={selected}
              onClick={() => choose(row)}
              onMouseMove={() => setActive(index)}
            >
              <Cover
                images={entry.images}
                className={
                  entry.kind === "Artist" || entry.kind === "Profile"
                    ? "round"
                    : ""
                }
              />
              <span>
                <strong>{entry.name}</strong>
                <small>
                  {entry.track && <ExplicitBadge track={entry.track} />}
                  {detail(entry)}
                </small>
              </span>
            </button>
            {entry.track && (
              <button
                className={`icon-button search-suggestion-save ${liked ? "saved" : ""}`}
                aria-label={
                  liked
                    ? `Remove ${entry.name} from Liked Songs`
                    : `Save ${entry.name} to Liked Songs`
                }
                onClick={() => save(entry.track!)}
              >
                {liked ? (
                  <CircleCheck size={18} fill="currentColor" />
                ) : (
                  <CirclePlus size={18} />
                )}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
