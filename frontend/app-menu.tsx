import { useEffect, useRef, useState } from "react";
import { ChevronRight, MoreHorizontal } from "lucide-react";

export interface AppMenuItem {
  label: string;
  /** Shortcut hint shown on the right, such as "Ctrl+N". */
  shortcut?: string;
  disabled?: boolean;
  /** Draws a divider above this item. */
  divider?: boolean;
  onSelect: () => void;
}
export interface AppMenuGroup {
  label: string;
  items: AppMenuItem[];
}

/**
 * Spotify's desktop "⋯" menu: File, Edit, View, Playback and Help, each
 * opening a submenu on hover, click or the arrow keys.
 */
export function AppMenu({ groups }: { groups: AppMenuGroup[] }) {
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState<number>();
  const root = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    setGroup(undefined);
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className="app-menu-root" ref={root}>
      <button
        className={`icon-button app-menu-button ${open ? "active" : ""}`}
        title="Menu"
        aria-label="Menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <MoreHorizontal size={22} />
      </button>
      {open && (
        <div className="app-menu" role="menu" aria-label="Menu">
          {groups.map((entry, index) => (
            <div
              key={entry.label}
              className="app-menu-group"
              onPointerEnter={() => setGroup(index)}
            >
              <button
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={group === index}
                className={group === index ? "active" : ""}
                onClick={() => setGroup(index)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight") {
                    event.preventDefault();
                    setGroup(index);
                    requestAnimationFrame(() =>
                      root.current
                        ?.querySelector<HTMLButtonElement>(
                          ".app-submenu button:not(:disabled)",
                        )
                        ?.focus(),
                    );
                  }
                }}
              >
                <span>{entry.label}</span>
                <ChevronRight size={16} />
              </button>
              {group === index && (
                <div
                  className="app-submenu"
                  role="menu"
                  aria-label={entry.label}
                >
                  {entry.items.map((item) => (
                    <button
                      key={item.label}
                      role="menuitem"
                      disabled={item.disabled}
                      className={item.divider ? "divided" : ""}
                      // Keep focus where it was, so Edit actions reach the
                      // field being edited.
                      onPointerDown={(event) => event.preventDefault()}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowLeft") {
                          event.preventDefault();
                          setGroup(undefined);
                        }
                      }}
                      onClick={() => {
                        close();
                        item.onSelect();
                      }}
                    >
                      <span>{item.label}</span>
                      {item.shortcut && <kbd>{item.shortcut}</kbd>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
