import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  AppWindow,
  FileText,
  FlaskConical,
  Info,
  Search,
  SlidersHorizontal,
  Palette,
  WandSparkles,
  X,
  AlignLeft,
} from "lucide-react";
import type { AppState } from "./state";
import type { Settings } from "./types";
import { SettingRow, SettingsQuery } from "./setting-row";
import { Toggle } from "./settings-page";
import { CREDITS, Credits } from "./credits";

const TABS = [
  ["Appearance", Palette],
  ["Lyrics", AlignLeft],
  ["Effects", FlaskConical],
  ["Interface", AppWindow],
  ["Sources", FileText],
  ["Advanced", SlidersHorizontal],
  ["About", Info],
] as const;
type Tab = (typeof TABS)[number][0];

type Flag = {
  [K in keyof Settings]-?: Settings[K] extends boolean | undefined ? K : never;
}[keyof Settings];

/** Lyrics settings in a compact window, laid out like Spicy Lyrics' own
 *  settings panel: category tabs, search, then rows. Only settings
 *  SpotiFlex really has appear here; everything else stays in Settings. */
export function LyricsSettings({
  state,
  onSettings,
  onLoadTtml,
  onDatabase,
  onAllSettings,
  onOpen,
  onClose,
}: {
  state: AppState;
  onSettings: (settings: Partial<Settings>) => void;
  onLoadTtml: () => void;
  onDatabase: () => void;
  onAllSettings: () => void;
  onOpen: (url: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("Appearance");
  const [query, setQuery] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  // The highlight slides under the selected tab; hidden while searching.
  const [marker, setMarker] = useState<{ left: number; width: number }>();
  const searching = !!query.trim();
  const settings = state.settings;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  useLayoutEffect(() => {
    const index = TABS.findIndex(([label]) => label === tab);
    const measure = () => {
      const button = tabs.current[index];
      if (button)
        setMarker({ left: button.offsetLeft, width: button.offsetWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    const list = tabs.current[index]?.parentElement;
    if (list) observer.observe(list);
    return () => observer.disconnect();
  }, [tab]);
  const select = (next: Tab) => {
    setTab(next);
    setQuery("");
    scroll.current?.scrollTo({ top: 0 });
  };
  const flag = (key: Flag, label: string, help: string, keywords = "") => (
    <SettingRow key={key} label={label} help={help} keywords={keywords}>
      <Toggle
        label={label}
        checked={!!settings[key]}
        onChange={(checked) => onSettings({ [key]: checked })}
      />
    </SettingRow>
  );
  const lyricSize = settings.lyric_size || 40;
  const provider = state.provider_builtin
    ? "The built-in lyrics provider is ready."
    : state.provider_configured
      ? "Your lyrics provider is configured."
      : "No lyrics provider is set up yet.";
  const sections: [Tab, string, React.ReactNode[]][] = [
    [
      "Appearance",
      "Appearance",
      [
        <SettingRow
          key="size"
          label="Lyric text size"
          help="Make room for every word."
          keywords="lyrics size font scale"
        >
          <span className="settings-range">
            <input
              type="range"
              aria-label="Lyric text size"
              min="18"
              max="60"
              value={lyricSize}
              style={
                {
                  "--fill": `${((lyricSize - 18) / 42) * 100}%`,
                } as CSSProperties
              }
              onChange={(event) =>
                onSettings({ lyric_size: Number(event.target.value) })
              }
            />
            <output>{Math.round(lyricSize)}</output>
          </span>
        </SettingRow>,
        flag(
          "liquid_glass",
          "Liquid Glass",
          "Frosted panels over the playing song's colours.",
          "glass background blur",
        ),
      ],
    ],
    [
      "Lyrics",
      "Lyrics Display",
      [
        <SettingRow
          key="offset"
          label="Timing offset"
          help="Shift lyrics earlier or later to match what you hear."
          keywords="lyrics sync delay offset milliseconds"
        >
          <span className="settings-number">
            <input
              className="number-field"
              type="number"
              aria-label="Timing offset"
              min="-10000"
              max="10000"
              step="50"
              value={settings.lyric_offset_ms}
              onChange={(event) =>
                onSettings({ lyric_offset_ms: Number(event.target.value) })
              }
            />
            ms
          </span>
        </SettingRow>,
        flag(
          "romanized",
          "Show romanized lyrics",
          "Display Latin-alphabet readings. Supplied readings are preferred; automatic transliteration is approximate.",
          "romanization transliteration",
        ),
        flag(
          "experimental_word_sync",
          "Experimental word sync",
          "Estimate word timing for line-synced or plain lyrics. Timing may be off.",
          "word timing estimate",
        ),
      ],
    ],
    [
      "Effects",
      "Effects",
      [
        flag(
          "space_gravity",
          "Space Gravity",
          "Words float in zero gravity, drift as they're sung and react when you move the window.",
          "gravity float",
        ),
        flag(
          "canvas_lyrics",
          "Canvas in lyrics",
          "Play the track's Canvas video behind the lyrics page.",
          "video background",
        ),
        flag(
          "reduce_motion",
          "Reduce motion",
          "Calm animations across the app, including the lyrics.",
          "animation motion",
        ),
      ],
    ],
    [
      "Interface",
      "Interface",
      [
        flag(
          "lyrics_compact",
          "Compact lyrics",
          "Use the narrow lyrics layout at any window size.",
          "narrow layout",
        ),
        flag(
          "lyrics_hide_artwork",
          "Hide artwork",
          "Show only the lyrics, without the album cover.",
          "cover",
        ),
        flag(
          "lyrics_artwork_right",
          "Artwork on the right",
          "Put the album cover on the right of the lyrics.",
          "cover side swap",
        ),
      ],
    ],
    [
      "Sources",
      "Sources",
      [
        <SettingRow
          key="provider"
          label="Lyrics provider"
          help={provider}
          keywords="spicy provider key"
        />,
        <SettingRow
          key="ttml"
          label="Load TTML"
          help="Use your own lyrics file for the playing song."
          keywords="import file"
        >
          <button className="pill outline" onClick={onLoadTtml}>
            Load
          </button>
        </SettingRow>,
        <SettingRow
          key="database"
          label="Browse TTML Database"
          help="Lyrics you loaded, with play, download and delete."
          keywords="saved lyrics database"
        >
          <button className="pill outline" onClick={onDatabase}>
            Browse
          </button>
        </SettingRow>,
      ],
    ],
    [
      "Advanced",
      "Advanced",
      [
        <SettingRow
          key="all"
          label="All SpotiFlex settings"
          help="Fonts, provider key, playback, storage and updates."
          keywords="settings fonts key"
        >
          <button className="pill outline" onClick={onAllSettings}>
            Open
          </button>
        </SettingRow>,
      ],
    ],
    [
      "About",
      "About",
      [
        <SettingRow
          key="credits"
          stacked
          label="Credits and licences"
          keywords={`about credits licence license ${CREDITS.map((credit) => `${credit.name} ${credit.by}`).join(" ")}`}
        >
          <Credits onOpen={onOpen} />
        </SettingRow>,
      ],
    ],
  ];
  const visible = sections.filter(([key]) => searching || key === tab);
  const status =
    state.update_status === "Up to date"
      ? ["latest", "Latest"]
      : state.update_status === "Update available" ||
          state.update_status === "Ready to install"
        ? ["outdated", "Update available"]
        : undefined;
  return (
    <div className="modal-backdrop lyrics-settings-backdrop" onClick={onClose}>
      <section
        className="lyrics-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lyrics-settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lyrics-settings-head">
          <h2 id="lyrics-settings-title">
            <WandSparkles size={18} />
            Lyrics settings
          </h2>
          <label className="lyrics-settings-search">
            <Search size={15} />
            <input
              aria-label="Search lyrics settings"
              placeholder="Search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                scroll.current?.scrollTo({ top: 0 });
              }}
            />
          </label>
          <button
            className="icon-button"
            aria-label="Close lyrics settings"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div
          className="lyrics-settings-tabs"
          role="tablist"
          aria-label="Settings categories"
        >
          <span
            className="lyrics-settings-marker"
            aria-hidden="true"
            style={
              marker && !searching
                ? {
                    opacity: 1,
                    transform: `translateX(${marker.left}px)`,
                    width: marker.width,
                  }
                : { opacity: 0 }
            }
          />
          {TABS.map(([label, Icon], index) => (
            <button
              key={label}
              ref={(element) => {
                tabs.current[index] = element;
              }}
              role="tab"
              aria-selected={tab === label && !searching}
              className={tab === label && !searching ? "active" : ""}
              onClick={() => select(label)}
              onKeyDown={(event) => {
                const step =
                  event.key === "ArrowRight"
                    ? 1
                    : event.key === "ArrowLeft"
                      ? -1
                      : 0;
                if (!step) return;
                event.preventDefault();
                const next = (index + step + TABS.length) % TABS.length;
                select(TABS[next][0]);
                tabs.current[next]?.focus();
              }}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </div>
        <div className="lyrics-settings-scroll" ref={scroll}>
          <SettingsQuery.Provider value={query}>
            <div role="tabpanel">
              {visible.map(([key, title, rows]) => (
                <section key={key} className="lyrics-settings-section">
                  <h3>{title}</h3>
                  <div className="lyrics-settings-group">{rows}</div>
                </section>
              ))}
              <p className="lyrics-settings-empty">No settings match.</p>
            </div>
          </SettingsQuery.Provider>
          <footer className="lyrics-settings-footer">
            <div>
              <span className="lyrics-settings-wordmark">SpotiFlex</span>
              <span className="lyrics-settings-version">
                v{__APP_VERSION__}
                {status && (
                  <span className={`lyrics-settings-status ${status[0]}`}>
                    {status[1]}
                  </span>
                )}
              </span>
            </div>
            <span className="lyrics-settings-build">
              {import.meta.env.DEV ? "Development build" : "Release build"}

            </span>
          </footer>
        </div>
      </section>
    </div>
  );
}
