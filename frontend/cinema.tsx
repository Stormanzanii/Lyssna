import { useEffect } from "react";
import "./styles.css";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Settings as SettingsIcon, X } from "lucide-react";
import { rpc } from "./bridge";
import { LyricsPage } from "./components";
import { sendPlayer, useDesktopState } from "./desktop-state";
import {
  CompactIcon,
  FullScreenIcon,
  HideArtworkIcon,
  RetryIcon,
  SwapSidesIcon,
  TranslateIcon,
  UploadIcon,
  WordSyncIcon,
} from "./toolbar-icons";
import type { AppState } from "./state";
import type { Album, Artist, Track } from "./types";

/** The view name the desktop gives the Cinema window. */
export const CINEMA_VIEW = "cinema";

/** What the Cinema window asks the main window to do: things that live
 *  there, such as opening a page, importing lyrics or showing settings. */
export type CinemaRequest =
  { kind: "route"; route: string } | { kind: "import" } | { kind: "settings" };

const askMain = (request: CinemaRequest) =>
  void emitTo("main", "cinema-request", request).catch(() => {});

/** The layout toggles the lyrics toolbar shares with the main window. */
const TOGGLES = [
  ["romanized", "Romanization", TranslateIcon],
  ["experimental_word_sync", "Experimental word sync", WordSyncIcon],
  ["lyrics_compact", "Compact lyrics", CompactIcon],
  ["lyrics_hide_artwork", "Hide artwork", HideArtworkIcon],
  ["lyrics_artwork_right", "Artwork on the right", SwapSidesIcon],
] as const;

/** Cinema Lyrics, as the pixels-spicy-lyrics fork's: the full screen lyrics
 *  page in a window of its own that can be moved, resized or made full
 *  screen, following the same playback as the main window. Native here, so
 *  it needs no developer tools. */
export function CinemaLyrics() {
  const [state, dispatch] = useDesktopState();
  const track = state.playback.item;
  useEffect(() => {
    document.title = track
      ? `${track.name} · SpotiFlex Cinema`
      : "SpotiFlex Cinema";
  }, [track?.name]);
  const fullscreen = async () => {
    const window = getCurrentWindow();
    await window.setFullscreen(!(await window.isFullscreen()));
  };
  // F11 toggles full screen and Escape leaves it, as in the main window.
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "F11") {
        event.preventDefault();
        void fullscreen();
      } else if (event.key === "Escape")
        void getCurrentWindow()
          .isFullscreen()
          .then((on) => {
            if (on) void getCurrentWindow().setFullscreen(false);
          });
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);
  const updateSettings = (change: Partial<AppState["settings"]>) => {
    const settings = { ...state.settings, ...change };
    dispatch({ type: "settings", settings });
    void rpc("save_settings", { settings }).catch(() => {});
  };
  const save = (song: Track) => {
    const saved = !state.saved[song.uri];
    dispatch({ type: "saved", uri: song.uri, saved });
    void rpc("save_item", { uri: song.uri, saved }).catch(() =>
      dispatch({ type: "saved", uri: song.uri, saved: !saved }),
    );
  };
  const open = (route: string) => askMain({ kind: "route", route });
  return (
    <div
      className={`application immersive cinema ${state.settings.reduce_motion ? "reduce-motion" : ""} ${state.settings.liquid_glass ? "liquid-glass glass-refraction" : ""}`}
    >
      <div className="workspace">
        <main className="center-panel showing-lyrics">
          <LyricsPage
            state={state}
            immersive
            onPlayer={(request) => sendPlayer(state, request)}
            onAlbum={(album: Album) => {
              const id = album.id || album.uri?.split(":")[2];
              if (id) open(`album:${id}`);
            }}
            onArtist={(artist: Artist) => {
              const id = artist.id || artist.uri?.split(":")[2];
              if (id) open(`artist:${id}`);
            }}
            onImport={() => askMain({ kind: "import" })}
            onRetry={() => void rpc("retry_lyrics").catch(() => {})}
            onSave={save}
          >
            <div className="lyrics-toolbar" role="toolbar" aria-label="Lyrics">
              {TOGGLES.map(([key, label, Icon]) => {
                const on = !!state.settings[key];
                return (
                  <button
                    key={key}
                    className={`icon-button ${on ? "active" : ""}`}
                    data-icon={key}
                    title={label}
                    aria-pressed={on}
                    onClick={() => updateSettings({ [key]: !on })}
                  >
                    <Icon />
                  </button>
                );
              })}
              <span className="toolbar-divider" aria-hidden="true" />
              <button
                className="icon-button"
                title="Load TTML"
                data-icon="upload"
                onClick={() => askMain({ kind: "import" })}
              >
                <UploadIcon />
              </button>
              {state.settings.lyrics_cache_button !== false && (
                <button
                  className="icon-button"
                  title="Refresh lyrics"
                  data-icon="retry"
                  onClick={() => {
                    // The same action the main toolbar's button is set to.
                    const action = state.settings.lyrics_cache_action ?? "song";
                    void (
                      action === "all"
                        ? rpc("clear_lyrics_cache")
                        : rpc("refresh_lyrics", {
                            keepSaved: action === "reload",
                          })
                    ).catch(() => {});
                  }}
                >
                  <RetryIcon />
                </button>
              )}
              <button
                className="icon-button"
                title="Full screen"
                data-icon="fullscreen"
                onClick={() => void fullscreen()}
              >
                <FullScreenIcon />
              </button>
              <button
                className="icon-button"
                title="SpotiFlex settings"
                data-icon="settings"
                onClick={() => askMain({ kind: "settings" })}
              >
                <SettingsIcon size={18} />
              </button>
              <button
                className="icon-button"
                title="Close Cinema"
                aria-label="Close Cinema"
                onClick={() => void getCurrentWindow().close()}
              >
                <X size={18} />
              </button>
            </div>
          </LyricsPage>
        </main>
      </div>
    </div>
  );
}
