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
  ExternalLink,
  LibraryBig,
  LogOut,
  Search,
  Settings2,
  Palette,
  X,
  AlignLeft,
} from "lucide-react";
import type { AppState } from "./state";
import type { Settings, SpotifyPlus } from "./types";
import { SettingRow, SettingsQuery, Toggle } from "./setting-row";
import { IS_MAC } from "./platform";
import { CREDITS, Credits } from "./credits";
import { FontSettings } from "./custom-fonts";
import { LyricsProvider } from "./lyrics-provider";
import { AnimatorPresetRow } from "./animator-settings";

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
    help: "Community-contributed lyrics from Spicy Lyrics. Receives the track ID and your IP address.",
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
  ["General", Settings2],
  ["Appearance", Palette],
  ["Library", LibraryBig],
  ["Lyrics", AlignLeft],
  ["Effects", FlaskConical],
  ["Layout", AppWindow],
  ["Sources", FileText],
] as const;
/** About opens from the footer card rather than the tab bar. */
export type SettingsTab = (typeof TABS)[number][0] | "About";
type Tab = SettingsTab;

/** Settings reopen on the tab and scroll position they were left at. */
const PLACE_KEY = "spotiflex.settings-place";
function readPlace(): { tab: Tab; scroll: number } {
  try {
    const place = JSON.parse(localStorage.getItem(PLACE_KEY) ?? "null");
    if (
      place &&
      [...TABS.map(([label]) => label), "About"].includes(place.tab) &&
      Number.isFinite(place.scroll)
    )
      return { tab: place.tab, scroll: Math.max(0, place.scroll) };
  } catch {
    // Storage may be unavailable; start at the top of General.
  }
  return { tab: "General", scroll: 0 };
}
function writePlace(tab: Tab, scroll: number) {
  try {
    localStorage.setItem(PLACE_KEY, JSON.stringify({ tab, scroll }));
  } catch {
    // Remembering the place is a convenience only.
  }
}
/** The tab Settings was last left on. */
export const lastSettingsTab = () => readPlace().tab;

type Flag = {
  [K in keyof Settings]-?: Settings[K] extends boolean | undefined ? K : never;
}[keyof Settings];

/** Every SpotiFlex setting in one window, laid out like Spicy Lyrics'
 *  settings panel: category tabs, search across all of them, then rows
 *  grouped into cards. */
export function SettingsWindow({
  state,
  initialTab = "General",
  onSettings,
  onLoadTtml,
  onDatabase,
  onOpen,
  onClose,
  onCall,
  onNotice,
  onManageAnimator,
}: {
  initialTab?: Tab;
  /** Opens Custom animator tuning beside full screen lyrics. */
  onManageAnimator: () => void;
  state: AppState;
  onSettings: (settings: Partial<Settings>) => void;
  onCall: <T = void>(
    command: string,
    args?: Record<string, unknown>,
  ) => Promise<T | undefined>;
  onNotice: (message: string, error?: boolean) => void;
  onLoadTtml: () => void;
  onDatabase: () => void;
  onOpen: (url: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  // Back on the tab it was left at, Settings scrolls to where it was.
  useLayoutEffect(() => {
    const place = readPlace();
    if (place.tab !== initialTab) {
      writePlace(initialTab, 0);
      return;
    }
    // Rows fill in over the first frames (audio outputs, fonts); keep
    // restoring until the page is tall enough or a moment has passed.
    const node = scroll.current;
    const opened = performance.now();
    let frame = 0;
    const restore = () => {
      node?.scrollTo({ top: place.scroll });
      if (
        node &&
        node.scrollHeight - node.clientHeight < place.scroll &&
        performance.now() - opened < 600
      )
        frame = requestAnimationFrame(restore);
    };
    restore();
    return () => cancelAnimationFrame(frame);
    // Only when the window opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [query, setQuery] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  // The highlight slides under the selected tab; hidden while searching.
  const [marker, setMarker] = useState<{ left: number; width: number }>();
  const searching = !!query.trim();
  // Closing records the place too: a scroll right before closing may not
  // have reported yet.
  const place = useRef({ tab, searching });
  place.current = { tab, searching };
  useLayoutEffect(() => {
    const node = scroll.current;
    return () => {
      if (node && !place.current.searching)
        writePlace(place.current.tab, node.scrollTop);
    };
  }, []);
  const settings = state.settings;
  const [audioOutputs, setAudioOutputs] = useState<string[] | null>(null);
  const [audioRefresh, setAudioRefresh] = useState(0);
  const [testingOutput, setTestingOutput] = useState(false);
  const [cacheBytes, setCacheBytes] = useState<number | null>(null);
  // Read from Windows each time Settings opens: Task Manager can change it.
  const [launch, setLaunch] = useState<"off" | "open" | "minimized" | null>(
    null,
  );
  useEffect(() => {
    let active = true;
    void onCall<"off" | "open" | "minimized">("autostart").then((value) => {
      if (active && value) setLaunch(value);
    });
    return () => {
      active = false;
    };
  }, [onCall]);
  const [clearingCache, setClearingCache] = useState(false);
  useEffect(() => {
    let active = true;
    void onCall<number>("audio_cache_size").then((bytes) => {
      if (active && typeof bytes === "number") setCacheBytes(bytes);
    });
    return () => {
      active = false;
    };
  }, [onCall]);
  useEffect(() => {
    if (!state.profile?.id) return;
    let active = true;
    void onCall<string[]>("audio_outputs").then((outputs) => {
      if (active && Array.isArray(outputs)) setAudioOutputs(outputs);
    });
    return () => {
      active = false;
    };
  }, [onCall, state.profile?.id, audioRefresh]);
  const plus = settings.spotify_plus ?? {};
  const setPlus = (change: Partial<SpotifyPlus>) =>
    onSettings({ spotify_plus: { ...plus, ...change } });
  const chosenFolders = new Set(plus.playlist_folders ?? []);
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
    writePlace(next, 0);
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
  const lyricSize = settings.lyric_size || 36;
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
      "General",
      "Account",
      [
        state.login_issue && !searching ? (
          <div key="login" className="settings-alert" role="alert">
            <p>{state.login_issue.message}</p>
            <button
              className="pill"
              disabled={state.login_pending}
              onClick={() => void onCall("sign_in", { clientId: "" })}
            >
              Sign in again
            </button>
          </div>
        ) : null,
        <SettingRow
          key="account"
          label={state.profile?.display_name || state.profile?.id || "Spotify"}
          help="Spotify connected"
          keywords="account sign out log out profile"
        >
          <button
            className="pill outline"
            onClick={() => void onCall("sign_out")}
          >
            <LogOut size={14} />
            Sign out
          </button>
        </SettingRow>,
        !state.can_follow ? (
          <SettingRow
            key="follow"
            label="Artist following"
            help="Allow SpotiFlex to follow your favourite artists."
            keywords="permissions scopes"
          >
            <button
              className="pill outline"
              onClick={() => void onCall("sign_in", { clientId: "" })}
            >
              Update permissions
              <ExternalLink size={13} />
            </button>
          </SettingRow>
        ) : null,
      ],
    ],
    [
      "General",
      "Playback",
      [
        <SettingRow
          key="output"
          label="Audio output"
          help="Speakers or headphones for this computer."
          keywords="device speaker headphones sound"
        >
          <select
            className="settings-select"
            aria-label="Audio output"
            value={settings.audio_output || ""}
            onChange={(event) =>
              onSettings({ audio_output: event.target.value || null })
            }
          >
            <option value="">System default</option>
            {settings.audio_output &&
              !audioOutputs?.includes(settings.audio_output) && (
                <option value={settings.audio_output}>
                  {settings.audio_output}
                  {audioOutputs ? " (unavailable)" : ""}
                </option>
              )}
            {audioOutputs?.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </SettingRow>,
        flag(
          "crossfade",
          "Crossfade songs",
          "Fade each song into the next when one runs into the other, as Spotify does. Songs you pick start straight away.",
          "crossfade fade transition gapless overlap blend",
        ),
        settings.crossfade ? (
          <SettingRow
            key="crossfade-seconds"
            label={`Crossfade length: ${settings.crossfade_seconds || 5} s`}
            help="How long the end of one song overlaps the start of the next."
            keywords="crossfade seconds length duration"
          >
            <span className="settings-range">
              <input
                type="range"
                aria-label="Crossfade seconds"
                min="1"
                max="12"
                value={settings.crossfade_seconds || 5}
                style={
                  {
                    "--fill": `${(((settings.crossfade_seconds || 5) - 1) / 11) * 100}%`,
                  } as CSSProperties
                }
                onChange={(event) =>
                  onSettings({ crossfade_seconds: Number(event.target.value) })
                }
              />
            </span>
          </SettingRow>
        ) : null,
        <SettingRow
          key="refresh"
          label="New headphones or speakers"
          help="Find outputs you connected while SpotiFlex was open."
          keywords="audio output device refresh"
        >
          <button
            className="pill outline"
            onClick={() => setAudioRefresh((value) => value + 1)}
          >
            Refresh outputs
          </button>
        </SettingRow>,
        <SettingRow
          key="test"
          label="Check output"
          help="Play two quiet tones on the selected output."
          keywords="audio output test sound"
        >
          <button
            className="pill outline"
            disabled={testingOutput}
            onClick={async () => {
              setTestingOutput(true);
              try {
                if (await onCall<boolean>("test_audio_output"))
                  onNotice("Test sound sent to the selected output");
              } finally {
                setTestingOutput(false);
              }
            }}
          >
            {testingOutput ? "Playing test sound…" : "Test output"}
          </button>
        </SettingRow>,
        <SettingRow
          key="native"
          label="Native audio"
          help={
            <span className={state.native_ready ? "native-ready" : ""}>
              {state.native_status}
            </span>
          }
          keywords="native audio reconnect playback engine"
        >
          <button
            className="pill outline"
            onClick={() => void onCall("retry_audio")}
          >
            Reconnect native audio
          </button>
        </SettingRow>,
      ],
    ],
    [
      "General",
      "Startup and window behaviour",
      [
        <SettingRow
          key="autostart"
          label="Open SpotiFlex automatically after you log into the computer"
          keywords="startup autostart login sign in boot launch minimized"
        >
          <select
            className="settings-select"
            aria-label="Open SpotiFlex automatically"
            value={launch ?? "off"}
            disabled={launch === null}
            onChange={(event) => {
              const next = event.target.value as "off" | "open" | "minimized";
              setLaunch(next);
              void onCall("set_autostart", { launch: next });
            }}
          >
            <option value="off">No</option>
            <option value="open">Yes</option>
            <option value="minimized">Minimized</option>
          </select>
        </SettingRow>,
        flag(
          "keep_playing_on_close",
          "Close button should minimize the SpotiFlex window",
          "",
          "close minimize minimise tray background notification area system tray quit keep playing",
        ),
      ],
    ],
    [
      "General",
      "Storage",
      [
        <SettingRow
          key="cache"
          label={`Cache: ${cacheBytes === null ? "…" : `${Math.round(cacheBytes / 1_048_576).toLocaleString()} MB`}`}
          help="Songs you have played, kept so they start faster and use less data."
          keywords="cache storage disk offline data clear"
        >
          <button
            className="pill outline"
            disabled={clearingCache || !cacheBytes}
            onClick={() => {
              setClearingCache(true);
              void onCall<number>("clear_audio_cache")
                .then((freed) => {
                  setCacheBytes(0);
                  onNotice(
                    `Cleared ${Math.round((freed ?? 0) / 1_048_576).toLocaleString()} MB of cached songs.`,
                  );
                })
                .finally(() => setClearingCache(false));
            }}
          >
            Clear cache
          </button>
        </SettingRow>,
        <SettingRow
          key="lyrics-cache"
          label="Lyrics cache"
          help="Saved lyrics are reused for three days. Clear them to fetch newly uploaded lyrics for every song. Imported lyrics are kept."
          keywords="lyrics cache clear refresh upload spicy stale"
        >
          <button
            className="pill outline"
            onClick={() =>
              void onCall("clear_lyrics_cache").then(() =>
                onNotice("Cleared saved lyrics."),
              )
            }
          >
            Clear lyrics
          </button>
        </SettingRow>,
      ],
    ],
    [
      "General",
      "Updates",
      [
        <SettingRow
          key="version"
          label={`Version ${__APP_VERSION__}`}
          help={
            state.update_version
              ? `${state.update_status} · v${state.update_version}`
              : state.update_status
          }
          keywords="updates version check install"
        >
          <button
            className="pill outline"
            disabled={
              IS_MAC || state.update_status.startsWith("Downloading update")
            }
            onClick={() =>
              void onCall("app_update", {
                action:
                  state.update_status === "Ready to install"
                    ? "install"
                    : state.update_status === "Update available"
                      ? "download"
                      : "check",
              })
            }
          >
            {state.update_status === "Ready to install"
              ? "Install update and restart"
              : state.update_status === "Update available"
                ? "Download update"
                : "Check for updates"}
          </button>
        </SettingRow>,
        !IS_MAC ? (
          <SettingRow
            key="auto-update"
            label="Download updates automatically"
            help="New versions are verified before they install."
            keywords="updates auto"
          >
            <Toggle
              label="Download updates automatically"
              checked={settings.auto_download_updates}
              onChange={(auto_download_updates) =>
                onSettings({ auto_download_updates })
              }
            />
          </SettingRow>
        ) : null,
      ],
    ],
    [
      "Appearance",
      "Theme",
      [
        flag(
          "liquid_glass",
          "Liquid Glass",
          "Frosted, translucent panels that pick up colour from the artwork you're playing.",
          "theme glass blur translucent apple transparency",
        ),
        flag(
          "reduce_motion",
          "Reduce motion",
          "Turn off animated backgrounds and word animations.",
          "animation accessibility",
        ),
      ],
    ],
    [
      "Appearance",
      "Font",
      [
        <FontSettings
          key="ui-font"
          field="ui_font"
          settings={settings}
          onSettings={onSettings}
          onNotice={onNotice}
        />,
      ],
    ],
    [
      "Library",
      "Your Library",
      [
        flag(
          "compact_library",
          "Compact library",
          "Show Your Library as a narrow column of covers.",
          "compact library sidebar",
        ),
        <SettingRow
          key="folders"
          stacked
          label="Add to playlist folders"
          help={
            state.library_folders?.length
              ? "Offer only playlists directly inside the folders you choose. Choose none to offer every playlist you can edit."
              : "Your library has no folders."
          }
          keywords="add playlist folders menu"
        >
          <div className="settings-folder-picks">
            {(state.library_folders ?? []).map((folder) => (
              <label key={folder.id}>
                <input
                  type="checkbox"
                  checked={chosenFolders.has(folder.id)}
                  onChange={(event) => {
                    const next = new Set(chosenFolders);
                    if (event.target.checked) next.add(folder.id);
                    else next.delete(folder.id);
                    setPlus({ playlist_folders: [...next] });
                  }}
                />
                <span>
                  {[
                    ...folder.parents.map(
                      (parent) =>
                        state.library_folders?.find(
                          (item) => item.id === parent,
                        )?.name ?? "",
                    ),
                    folder.name,
                  ]
                    .filter(Boolean)
                    .join(" / ")}
                </span>
              </label>
            ))}
          </div>
        </SettingRow>,
      ],
    ],
    [
      "Lyrics",
      "Look",
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
        <SettingRow
          key="pinned-footer"
          label="Pinned Lyrics Footer"
          help="Keep source and community credits visible. Full also pins writers."
          keywords="pinned footer written by writers credits source community"
        >
          <select
            className="settings-select"
            aria-label="Pinned Lyrics Footer"
            value={settings.lyrics_pinned_footer ?? "off"}
            onChange={(event) =>
              onSettings({
                lyrics_pinned_footer: event.target
                  .value as Settings["lyrics_pinned_footer"],
              })
            }
          >
            <option value="off">Off</option>
            <option value="no_writers">No Writers</option>
            <option value="full">Full</option>
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
      "Display",
      [
        flag(
          "lyrics_discord_usernames",
          "Discord usernames in credits",
          "Credit community lyrics makers by their Discord username, looked up on spicylyrics.org, instead of their display name.",
          "discord username display name community credits maker uploader",
        ),
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
          "lyrics_translations",
          "Show translations",
          "Show translations that come with the lyrics under each line.",
          "translation translate language",
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
      "Lyric effects",
      [
        flag(
          "space_gravity",
          "Space Gravity",
          "Words float in zero gravity, drift as they're sung and react when you move the window.",
          "gravity float",
        ),
        <AnimatorPresetRow
          key="animator"
          animator={settings.lyrics_animator}
          onChange={(lyrics_animator) => onSettings({ lyrics_animator })}
          onManage={onManageAnimator}
        />,
        flag(
          "canvas_lyrics",
          "Canvas in lyrics",
          "Play the track's Canvas video behind the lyrics page.",
          "video background",
        ),
      ],
    ],
    [
      "Layout",
      "Lyrics layout",
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
      "Lyric sources",
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
      ],
    ],
    [
      "Sources",
      "Your lyrics",
      [
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
        aria-labelledby="settings-window-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lyrics-settings-head">
          <h2 id="settings-window-title">
            <Settings2 size={20} />
            SpotiFlex settings
          </h2>
          <label className="lyrics-settings-search">
            <Search size={15} />
            <input
              aria-label="Search settings"
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
            aria-label="Close settings"
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
        <div
          className="lyrics-settings-scroll"
          ref={scroll}
          onScroll={(event) => {
            if (!searching) writePlace(tab, event.currentTarget.scrollTop);
          }}
        >
          <SettingsQuery.Provider value={query}>
            {about ? (
              <section className="lyrics-settings-about" aria-label="About">
                <button
                  className="text-link lyrics-settings-back"
                  onClick={() => select("General")}
                >
                  <ChevronLeft size={16} />
                  Settings
                </button>
                <Credits onOpen={onOpen} />
              </section>
            ) : (
              <div role="tabpanel">
                {visible.map(([key, title, rows]) => (
                  <section
                    key={`${key}-${title}`}
                    className="lyrics-settings-section"
                  >
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
              onClick={() => select(about ? "General" : "About")}
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
