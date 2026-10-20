import { useEffect, useRef, useState } from "react";
import { List } from "lucide-react";

const SORTS = [
  ["order", "Playlist order"],
  ["recent", "Recently added"],
  ["newest", "Newest releases"],
  ["oldest", "Oldest releases"],
  ["popular", "Most played"],
] as const;

/**
 * Spotify-style "Recently added ☰" button: one popover holding the playlist
 * sort plus the genre and release-age filters, so the action bar stays on
 * one line.
 */
export function SongSortMenu({
  sort,
  genre,
  age,
  genres,
  onSort,
  onGenre,
  onAge,
}: {
  sort: string;
  genre: string;
  age: string;
  genres: string[];
  onSort: (value: string) => void;
  onGenre: (value: string) => void;
  onAge: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const label = SORTS.find(([value]) => value === sort)?.[1] ?? "Custom order";
  const filtered = !!(genre || age);
  return (
    <div className="sort-menu-root" ref={root}>
      <button
        className={`sort-menu-button ${filtered ? "filtered" : ""}`}
        title="Sort and filter"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
        <List size={20} />
      </button>
      {open && (
        <div className="sort-menu" role="dialog" aria-label="Sort and filter">
          <span className="sort-menu-heading">Sort by</span>
          {SORTS.map(([value, name]) => (
            <button
              key={value}
              className={value === sort ? "active" : ""}
              aria-pressed={value === sort}
              onClick={() => onSort(value)}
            >
              {name}
            </button>
          ))}
          <hr />
          <label>
            <span className="sort-menu-heading">Genre</span>
            <select
              aria-label="Genre"
              value={genre}
              onChange={(event) => onGenre(event.target.value)}
            >
              <option value="">All genres</option>
              {genres.map((name) => (
                <option key={name}>{name}</option>
              ))}
              <option value="unknown">Unknown genre</option>
            </select>
          </label>
          <label>
            <span className="sort-menu-heading">Release age</span>
            <select
              aria-label="Release age"
              value={age}
              onChange={(event) => onAge(event.target.value)}
            >
              <option value="">Any release age</option>
              <option value="year">Past year</option>
              <option value="five">1–5 years old</option>
              <option value="ten">5–10 years old</option>
              <option value="older">10+ years old</option>
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
