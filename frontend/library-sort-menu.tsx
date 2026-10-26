import { useEffect, useRef, useState } from "react";
import { AlignJustify, Check, Grid3x3, LayoutGrid, List } from "lucide-react";
import type { LibrarySort, LibraryView } from "./types";

const SORTS: [LibrarySort, string][] = [
  ["recents", "Recents"],
  ["recently_added", "Recently added"],
  ["alphabetical", "Alphabetical"],
  ["creator", "Creator"],
  ["custom", "Custom order"],
];

const VIEWS: [LibraryView, string, typeof List][] = [
  ["compact", "Compact", AlignJustify],
  ["list", "List", List],
  ["grid", "Compact grid", Grid3x3],
  ["large_grid", "Default grid", LayoutGrid],
];

/** Your Library's "Recents ☰" button: Spotify's sorts and row views. */
export function LibrarySortMenu({
  sort,
  view,
  onSort,
  onView,
}: {
  sort: LibrarySort;
  view: LibraryView;
  onSort: (value: LibrarySort) => void;
  onView: (value: LibraryView) => void;
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
  const Current = VIEWS.find(([value]) => value === view)?.[2] ?? List;
  return (
    <div className="sort-menu-root library-sort" ref={root}>
      <button
        className="sort-menu-button"
        title="Sort and view"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {SORTS.find(([value]) => value === sort)?.[1] ?? "Recents"}
        <Current size={16} />
      </button>
      {open && (
        <div
          className="sort-menu library-sort-menu"
          role="dialog"
          aria-label="Sort and view"
        >
          <span className="sort-menu-heading">Sort by</span>
          {SORTS.map(([value, name]) => (
            <button
              key={value}
              className={value === sort ? "active" : ""}
              aria-pressed={value === sort}
              onClick={() => {
                onSort(value);
                setOpen(false);
              }}
            >
              {name}
              {value === sort && <Check size={16} />}
            </button>
          ))}
          <hr />
          <span className="sort-menu-heading">View as</span>
          <div className="library-view-picker">
            {VIEWS.map(([value, name, Icon]) => (
              <button
                key={value}
                title={name}
                aria-label={name}
                aria-pressed={value === view}
                className={value === view ? "active" : ""}
                onClick={() => {
                  onView(value);
                  setOpen(false);
                }}
              >
                <Icon size={16} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
