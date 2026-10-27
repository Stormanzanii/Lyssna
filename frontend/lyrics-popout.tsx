import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import "./styles.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Heart, X } from "lucide-react";
import { rpc, subscribe } from "./bridge";
import {
  NextIcon,
  PauseIcon,
  PlayIcon,
  PreviousIcon,
  RepeatIcon,
  ShuffleIcon,
} from "./player-icons";
import { Ambience } from "./ambience";
import { LyricsDisplay, usePosition } from "./components";
import { displayLyrics } from "./word-sync";
import { useRomanization } from "./romanization";
import { filterWords } from "./word-filter";
import { setFrameCap } from "./frame-cap";
import { emptyState, formatTime, reducer } from "./state";
import type { PlayerRequest, Snapshot } from "./types";

/** The window label the desktop side gives the lyrics popout. */
export const POPOUT_VIEW = "lyrics-popout";

/** Spicy Lyrics' popup lyrics: the song's lyrics alone in a frameless
 *  window, over its ambience, with the title in a corner and a seek bar
 *  below; the close button and playback controls show while the pointer
 *  moves. It follows the same desktop events as the main window. */
export function LyricsPopout() {
  const [state, dispatch] = useReducer(reducer, emptyState);
  // Controls wake on pointer movement and fade a moment after it stops.
  const [awake, setAwake] = useState(false);
  const sleep = useRef<ReturnType<typeof setTimeout>>(undefined),
    // Held awake while the pointer rests on the controls.
    holding = useRef(false);
  const wake = () => {
    setAwake(true);
    clearTimeout(sleep.current);
    sleep.current = setTimeout(() => {
      if (!holding.current) setAwake(false);
    }, 2000);
  };
  useEffect(() => () => clearTimeout(sleep.current), []);
  useEffect(() => {
    let disposed = false,
      unlisten: (() => void) | undefined;
    const pending: Parameters<typeof dispatch>[0][] = [];
    let bootstrapped = false;
    void (async () => {
      unlisten = await subscribe((event) => {
        if (disposed) return;
        if (bootstrapped) dispatch(event);
        else pending.push(event);
      });
      const snapshot = await rpc<Snapshot>("bootstrap");
      if (disposed) return;
      dispatch({ type: "bootstrap", snapshot });
      bootstrapped = true;
      pending.splice(0).forEach(dispatch);
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    setFrameCap(
      state.settings.animation_fps_cap_enabled
        ? (state.settings.animation_fps_cap ?? 60)
        : 0,
    );
  }, [
    state.settings.animation_fps_cap_enabled,
    state.settings.animation_fps_cap,
  ]);
  const track = state.playback.item;
  useEffect(() => {
    document.title = track ? `${track.name} · Lyrics` : "SpotiFlex Lyrics";
  }, [track?.name]);
  // Re-render when romanized lyrics finish converting.
  useRomanization();
  const lyrics =
    state.lyrics &&
    filterWords(
      displayLyrics(
        state.lyrics,
        !!state.settings.experimental_word_sync,
        state.settings.romanized,
        track?.duration_ms,
      ),
      state.settings.lyrics_word_filter,
    );
  // Controls go where the main window sends them: this computer, or the
  // device Spotify reports active.
  const active = state.devices.find((device) => device.is_active);
  const target =
    !active || active.name === state.local_device_name || !active.id
      ? "native"
      : active.id;
  const play = (request: PlayerRequest) =>
    void rpc("player", { request, target }).catch(() => {});
  const year = track?.album.release_date?.slice(0, 4);
  const saved = !!(track && state.saved[track.uri]);
  const repeat = state.playback.repeat_state || "off";
  const toggleSaved = () => {
    if (!track) return;
    dispatch({ type: "saved", uri: track.uri, saved: !saved });
    void rpc("save_item", { uri: track.uri, saved: !saved }).catch(() =>
      dispatch({ type: "saved", uri: track.uri, saved }),
    );
  };
  return (
    <div
      className="lyrics-popout"
      data-awake={awake || undefined}
      data-tauri-drag-region
      onPointerMove={wake}
      onPointerDown={wake}
      onPointerLeave={() => {
        clearTimeout(sleep.current);
        setAwake(false);
      }}
      style={
        {
          "--lyric-size": `${Math.round(state.settings.lyric_size * 1.6)}px`,
        } as CSSProperties
      }
    >
      <Ambience
        track={track}
        animate={state.playback.is_playing}
        reduceMotion={state.settings.reduce_motion}
      />
      <button
        className="icon-button lyrics-popout-close"
        aria-label="Close lyrics popout"
        title="Close"
        onClick={() => void getCurrentWindow().close()}
      >
        <X size={18} />
      </button>
      <header className="lyrics-popout-title" data-tauri-drag-region>
        <strong>{track?.name ?? "Nothing playing"}</strong>
        {track && (
          <span>
            {year && `${year} · `}
            {track.artists.map((artist) => artist.name).join(", ")}
          </span>
        )}
      </header>
      <main className="lyrics-popout-lyrics" data-tauri-drag-region>
        {lyrics && !lyrics.instrumental ? (
          <PopoutLyrics
            state={state}
            lyrics={lyrics}
            onSeek={(ms) => play({ command: "seek", positionMs: ms })}
          />
        ) : (
          <p className="lyrics-popout-message">
            {lyrics?.instrumental
              ? "Instrumental"
              : state.lyric_error
                ? "Lyrics unavailable"
                : track
                  ? "Finding lyrics…"
                  : ""}
          </p>
        )}
      </main>
      <PopoutSeek
        state={state}
        onSeek={(ms) => play({ command: "seek", positionMs: ms })}
      />
      <div
        className="lyrics-popout-controls"
        onPointerEnter={() => (holding.current = true)}
        onPointerLeave={() => (holding.current = false)}
      >
        <button
          className={`icon-button lyrics-popout-like ${saved ? "is-saved" : ""}`}
          title={saved ? "Remove from Liked Songs" : "Save to Liked Songs"}
          disabled={!track}
          onClick={toggleSaved}
        >
          <Heart size={24} fill={saved ? "currentColor" : "none"} />
        </button>
        <div className="lyrics-popout-transport">
          <button
            className={`icon-button ${state.playback.shuffle_state ? "active" : ""}`}
            title="Shuffle"
            onClick={() =>
              play({
                command: "shuffle",
                enabled: !state.playback.shuffle_state,
              })
            }
          >
            <ShuffleIcon size={20} />
          </button>
          <button
            className="icon-button"
            title="Previous song"
            onClick={() => play({ command: "previous" })}
          >
            <PreviousIcon size={22} />
          </button>
          <button
            className="icon-button lyrics-popout-play"
            aria-label={state.playback.is_playing ? "Pause" : "Play"}
            onClick={() =>
              play({ command: state.playback.is_playing ? "pause" : "play" })
            }
          >
            {state.playback.is_playing ? (
              <PauseIcon size={26} />
            ) : (
              <PlayIcon size={26} />
            )}
          </button>
          <button
            className="icon-button"
            title="Next song"
            onClick={() => play({ command: "next" })}
          >
            <NextIcon size={22} />
          </button>
          <button
            className={`icon-button ${repeat !== "off" ? "active" : ""}`}
            title="Repeat"
            onClick={() =>
              play({
                command: "repeat",
                repeat:
                  repeat === "off"
                    ? "context"
                    : repeat === "context"
                      ? "track"
                      : "off",
              })
            }
          >
            <RepeatIcon size={20} one={repeat === "track"} />
          </button>
        </div>
      </div>
    </div>
  );
}

type PopoutState = Parameters<typeof usePosition>[0] & {
  settings: typeof emptyState.settings;
  playback: typeof emptyState.playback;
};

/** The lyrics, following song time every frame on their own. */
function PopoutLyrics({
  state,
  lyrics,
  onSeek,
}: {
  state: PopoutState;
  lyrics: NonNullable<typeof emptyState.lyrics>;
  onSeek: (ms: number) => void;
}) {
  const current = usePosition(state) + state.settings.lyric_offset_ms;
  return (
    <LyricsDisplay
      lyrics={lyrics}
      writers={state.playback.item?.songwriters}
      positionMs={current}
      settings={state.settings}
      onSeek={onSeek}
    />
  );
}

/** Song time and a seek bar; a drag previews, release seeks. */
function PopoutSeek({
  state,
  onSeek,
}: {
  state: PopoutState;
  onSeek: (ms: number) => void;
}) {
  const current = usePosition(state);
  const [seeking, setSeeking] = useState<number | null>(null);
  const duration = state.playback.item?.duration_ms || 0;
  const shown = seeking ?? current;
  const uri = useRef(state.playback.item?.uri);
  if (uri.current !== state.playback.item?.uri) {
    uri.current = state.playback.item?.uri;
    if (seeking !== null) setSeeking(null);
  }
  const commit = () => {
    if (seeking === null) return;
    onSeek(seeking);
    setSeeking(null);
  };
  return (
    <footer className="lyrics-popout-seek">
      <input
        aria-label="Seek position"
        type="range"
        min="0"
        max={duration || 1}
        value={Math.min(shown, duration || 1)}
        disabled={!duration}
        style={
          {
            "--range": `${(shown / Math.max(1, duration)) * 100}%`,
          } as CSSProperties
        }
        onChange={(event) => setSeeking(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span>
        <time>{formatTime(shown)}</time>
        <time>{formatTime(duration)}</time>
      </span>
    </footer>
  );
}
