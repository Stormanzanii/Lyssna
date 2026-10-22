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
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Search,
  SlidersHorizontal,
  Palette,
  Mic2,
  X,
  AlignLeft,
} from "lucide-react";
import type { AppState } from "./state";
import type { Settings } from "./types";
import { SettingRow, SettingsQuery } from "./setting-row";
import { Toggle } from "./settings-page";
import { CREDITS, Credits } from "./credits";
import { FontSettings } from "./custom-fonts";
import { LyricsProvider } from "./lyrics-provider";

/** Default source order; LRCLIB and Netease start off. */
const DEFAULT_SOURCES = [
  "spicy",
  "apple",
  "musixmatch",
  "spotify",
  "lrclib",
  "netease",
];
const DEFAULT_SOURCES_OFF = ["lrclib", "netease"];
/** Lyric sources SpotiFlex can use, as listed in Sources. */
const SOURCES: Record<string, { name: string; help: string }> = {
  spicy: {
    name: "Spicy Lyrics",
    help: "Community-contributed lyrics from Spicy Lyrics.",
  },
  musixmatch: {
    name: "Musixmatch",
    help: "Synced or word-timed lyrics through Musixmatch's desktop-app service (unofficial). Receives the title, artists, album, length and track ID.",
  },
  apple: {
    name: "Apple Music",
    help: "Apple Music lyrics through the Spicy Lyrics provider.",
  },
  spotify: {
    name: "Spotify",
    help: "Spotify's own lyrics, through your signed-in session.",
  },
  lrclib: {
    name: "LRCLIB",
    help: "Free open lyrics database. Receives the title, artist, album and length.",
  },
  netease: {
    name: "Netease",
    help: "Netease community lyrics through a third-party proxy. Receives the title and artist.",
  },
};

const TABS = [
  ["Appearance", Palette],
  ["Lyrics", AlignLeft],
  ["Effects", FlaskConical],
  ["Interface", AppWindow],
  ["Sources", FileText],
  ["Advanced", SlidersHorizontal],
] as const;
/** About opens from the footer card rather than the tab bar. */
type Tab = (typeof TABS)[number][0] | "About";

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
  onCall,
  onNotice,
}: {
  state: AppState;
  onSettings: (settings: Partial<Settings>) => void;
  onCall: <T = void>(
    command: string,
    args?: Record<string, unknown>,
  ) => Promise<T | undefined>;
  onNotice: (message: string, error?: boolean) => void;
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
  const order = settings.lyrics_source_order?.length
    ? settings.lyrics_source_order
    : DEFAULT_SOURCES;
  const disabled = new Set(
    settings.lyrics_sources_disabled ?? DEFAULT_SOURCES_OFF,
  );
  const move = (id: string, step: -1 | 1) => {
    const next = [...order];
    const index = next.indexOf(id);
    const to = index + step;
    if (index < 0 || to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    onSettings({ lyrics_source_order: next });
  };
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
        <FontSettings
          key="font"
          field="lyric_font"
          settings={settings}
          onSettings={onSettings}
          onNotice={onNotice}
        />,
        <SettingRow
          key="background"
          label="Background"
          help="Moving artwork, still artwork, or one colour from the cover behind the lyrics."
          keywords="background ambience dynamic static colour color"
        >
          <select
            className="settings-select"
            aria-label="Lyrics background"
            value={settings.lyrics_background ?? "animated"}
            onChange={(event) =>
              onSettings({
                lyrics_background: event.target
                  .value as Settings["lyrics_background"],
              })
            }
          >
            <option value="animated">Animated artwork</option>
            <option value="static">Still artwork</option>
            <option value="color">Cover colour</option>
          </select>
        </SettingRow>,
        flag(
          "lyrics_hide_year",
          "Hide release year",
          "Leave the year out of the song details beside the lyrics.",
          "year date metadata",
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
        flag(
          "lyrics_simple",
          "Simple lyrics mode",
          "Fill lines without the per-word lift, scale and glow.",
          "simple minimal animation",
        ),
        flag(
          "lyrics_early_scroll",
          "Early scroll",
          "Start moving to the next line a moment before it is sung.",
          "scroll ahead",
        ),
        flag(
          "lyrics_right_align",
          "Right align lyrics",
          "Line lyrics up on the right instead of the left.",
          "alignment",
        ),
        flag(
          "lyrics_flip_duet",
          "Flip duet sides",
          "Swap which side each duet voice sits on.",
          "duet opposite alignment",
        ),
        flag(
          "lyrics_wide_duet",
          "Wide duet line padding",
          "Separate duet voices into wider columns.",
          "duet padding",
        ),
        flag(
          "lyrics_line_hover",
          "Line hover background",
          "Highlight a line when you point at it.",
          "hover highlight",
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
        flag(
          "lyrics_hide_npv",
          "Hide lyrics in Now playing",
          "Never show the lyrics card in the Now playing panel.",
          "now playing card sidebar",
        ),
        flag(
          "lyrics_hide_npv_empty",
          "Hide the Now playing card without lyrics",
          "Remove the lyrics card when the current song has no lyrics.",
          "now playing card empty",
        ),
      ],
    ],
    [
      "Sources",
      "Sources",
      [
        <SettingRow
          key="sources"
          stacked
          label="Lyric sources"
          help="Tried top to bottom until one has lyrics for the song."
          keywords="sources priority order lrclib spicy provider"
        >
          <ol className="lyric-sources">
            {order.map((id, index) => {
              const source = SOURCES[id];
              if (!source) return null;
              const on = !disabled.has(id);
              return (
                <li key={id} className={on ? "" : "off"}>
                  <span className="lyric-source-name">
                    <strong>{source.name}</strong>
                    <small>{source.help}</small>
                  </span>
                  <button
                    className="icon-button"
                    title={`Move ${source.name} up`}
                    disabled={index === 0}
                    onClick={() => move(id, -1)}
                  >
                    <ChevronUp size={16} />
                  </button>
                  <button
                    className="icon-button"
                    title={`Move ${source.name} down`}
                    disabled={index === order.length - 1}
                    onClick={() => move(id, 1)}
                  >
                    <ChevronDown size={16} />
                  </button>
                  <Toggle
                    label={source.name}
                    checked={on}
                    onChange={(checked) => {
                      const next = new Set(disabled);
                      if (checked) next.delete(id);
                      else next.add(id);
                      onSettings({ lyrics_sources_disabled: [...next] });
                    }}
                  />
                </li>
              );
            })}
          </ol>
          <button
            className="text-link lyric-sources-reset"
            onClick={() =>
              onSettings({
                lyrics_source_order: DEFAULT_SOURCES,
                lyrics_sources_disabled: DEFAULT_SOURCES_OFF,
              })
            }
          >
            Reset sources
          </button>
        </SettingRow>,
        <LyricsProvider
          key="provider"
          state={state}
          onCall={onCall}
          onNotice={onNotice}
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
  const about = tab === "About" && !searching;
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
            <Mic2 size={20} />
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
              marker && !searching && tab !== "About"
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
            {about ? (
              <section className="lyrics-settings-about" aria-label="About">
                <button
                  className="text-link lyrics-settings-back"
                  onClick={() => select("Appearance")}
                >
                  <ChevronLeft size={16} />
                  Settings
                </button>
                <Credits onOpen={onOpen} />
              </section>
            ) : (
              <div role="tabpanel">
                {visible.map(([key, title, rows]) => (
                  <section key={key} className="lyrics-settings-section">
                    <h3>{title}</h3>
                    <div className="lyrics-settings-group">{rows}</div>
                  </section>
                ))}
                <p className="lyrics-settings-empty">No settings match.</p>
              </div>
            )}
          </SettingsQuery.Provider>
          <footer className="lyrics-settings-footer">
            <button
              className="lyrics-settings-about-link"
              aria-pressed={about}
              onClick={() => select(about ? "Appearance" : "About")}
            >
              <span className="lyrics-settings-wordmark">SpotiFlex</span>
              <span className="lyrics-settings-version">
                v{__APP_VERSION__}
                {status && (
                  <span className={`lyrics-settings-status ${status[0]}`}>
                    {status[1]}
                  </span>
                )}
              </span>
              <span className="lyrics-settings-about-hint">
                {about ? "Back to settings" : "About and credits"}
                <ChevronRight size={14} />
              </span>
            </button>
            <span className="lyrics-settings-build">
              {import.meta.env.DEV ? "Development build" : "Release build"}
            </span>
          </footer>
        </div>
      </section>
    </div>
  );
}
