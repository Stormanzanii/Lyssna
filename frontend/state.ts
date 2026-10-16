import type { AppEvent, Device, Snapshot, Track, Word } from "./types";
export type ToggleIntent = { wanted: boolean; at: number };
export function nextToggle(
  current: boolean,
  previous: ToggleIntent | undefined,
  now: number,
): ToggleIntent {
  return {
    wanted: !(previous && now - previous.at < 2000 ? previous.wanted : current),
    at: now,
  };
}
export interface AppState extends Snapshot {
  booted: boolean;
  devices: Device[];
  saved: Record<string, boolean>;
  toast?: { message: string; error: boolean; serial: number };
  pending?: { uri: string; at: number };
  pageError: string;
  clock_revision: number;
}
export const emptyState: AppState = {
  booted: false,
  profile: undefined,
  playlists: [],
  playback: {
    is_playing: false,
    shuffle_state: false,
    repeat_state: "off",
    device: { name: "", is_active: false },
  },
  settings: {
    client_id: "",
    last_view: "home",
    show_lyrics: true,
    compact_library: false,
    lyric_size: 32,
    lyric_offset_ms: 0,
    romanized: false,
    reduce_motion: false,
    auto_download_updates: true,
    folders: [],
  },
  native_ready: false,
  local_device_name: "SpotiFlex",
  native_status: "Connecting…",
  provider_configured: false,
  login_pending: false,
  can_follow: false,
  lyrics: undefined,
  lyric_error: "",
  details: { artists: [], queue: [] },
  route: "home",
  generation: 0,
  tracks: [],
  loading: false,
  more: false,
  update_status: "Checking for updates…",
  notice: "",
  observed_at: Date.now(),
  devices: [],
  saved: {},
  pageError: "",
  clock_revision: 0,
};
export type Action =
  | AppEvent
  | { type: "bootstrap"; snapshot: Snapshot }
  | { type: "navigate"; key: string; generation: number }
  | { type: "play_requested"; track: Track }
  | { type: "settings"; settings: AppState["settings"] }
  | { type: "login_pending" }
  | { type: "page_loading"; generation: number }
  | { type: "toast_clear" };
export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "canvas":
      return state.playback.item?.uri === action.uri
        ? { ...state, canvas_url: action.url }
        : state;
    case "bootstrap":
      return { ...state, ...action.snapshot, booted: true };
    case "session":
      return {
        ...state,
        profile: action.profile,
        can_follow: action.can_follow,
        login_pending: false,
      };
    case "signed_out":
      return {
        ...emptyState,
        booted: true,
        settings: state.settings,
        native_status: "Waiting for sign-in",
      };
    case "login_pending":
      return { ...state, login_pending: true };
    case "login_finished":
      return { ...state, login_pending: false };
    case "native":
      return {
        ...state,
        native_ready: action.ready,
        native_status: action.status,
      };
    case "library":
      return { ...state, playlists: action.playlists };
    case "page_loading":
      return action.generation === state.generation
        ? { ...state, loading: true }
        : state;
    case "navigate":
      return {
        ...state,
        route: action.key,
        generation: action.generation,
        tracks: [],
        browse_info: undefined,
        loading: true,
        more: false,
        pageError: "",
      };
    case "tracks":
      if (action.generation !== state.generation || action.key !== state.route)
        return state;
      return {
        ...state,
        tracks:
          action.offset === 0
            ? action.tracks
            : action.offset === state.tracks.length
              ? [...state.tracks, ...action.tracks]
              : state.tracks,
        loading: false,
        more: action.more,
        pageError: "",
      };
    case "tracks_failed":
      return action.generation === state.generation
        ? { ...state, loading: false, pageError: action.message }
        : state;
    case "browse_info":
      return action.generation === state.generation
        ? { ...state, browse_info: action.info }
        : state;
    case "play_requested":
      return {
        ...state,
        canvas_url: undefined,
        pending: { uri: action.track.uri, at: Date.now() },
        playback: {
          ...state.playback,
          item: action.track,
          progress_ms: 0,
          is_playing: false,
        },
        observed_at: Date.now(),
        lyrics: undefined,
        lyric_error: "",
        details: { artists: [], queue: [] },
      };
    case "playback": {
      if (
        state.pending &&
        !action.loading &&
        action.playback.item?.uri !== state.pending.uri &&
        Date.now() - state.pending.at < 8000
      )
        return state;
      const changed = state.playback.item?.uri !== action.playback.item?.uri;
      return {
        ...state,
        playback: action.playback,
        observed_at: action.observed_at,
        pending:
          action.loading && action.playback.item
            ? { uri: action.playback.item.uri, at: Date.now() }
            : action.playback.is_playing
              ? undefined
              : state.pending,
        lyrics: changed ? undefined : state.lyrics,
        canvas_url: changed ? undefined : state.canvas_url,
        lyric_error: changed ? "" : state.lyric_error,
        details: changed ? { artists: [], queue: [] } : state.details,
      };
    }
    case "native_position":
      if (action.uri !== state.playback.item?.uri) return state;
      return {
        ...state,
        playback: {
          ...state.playback,
          progress_ms: action.position_ms,
          is_playing: action.playing ?? state.playback.is_playing,
        },
        observed_at: action.observed_at,
        pending:
          action.playing === true ||
          (action.playing !== false && state.playback.is_playing)
            ? undefined
            : state.pending,
        clock_revision: state.clock_revision + (action.seeked ? 1 : 0),
      };
    case "playing_details":
      return action.uri === state.playback.item?.uri
        ? { ...state, details: action.details }
        : state;
    case "lyrics":
      return action.uri === state.playback.item?.uri
        ? { ...state, lyrics: action.lyrics, lyric_error: "" }
        : state;
    case "lyric_error":
      return action.uri === state.playback.item?.uri
        ? { ...state, lyric_error: action.message }
        : state;
    case "devices":
      return { ...state, devices: action.devices };
    case "saved":
      return {
        ...state,
        saved: { ...state.saved, [action.uri]: action.saved },
      };
    case "settings":
      return { ...state, settings: action.settings };
    case "provider_configured":
      return {
        ...state,
        provider_configured: true,
        provider_kind: action.kind,
        lyric_error: "",
        toast: {
          message: "Lyrics source saved",
          error: false,
          serial: Date.now(),
        },
      };
    case "notice":
      return {
        ...state,
        toast: {
          message: action.message,
          error: action.error,
          serial: Date.now(),
        },
      };
    case "toast_clear":
      return { ...state, toast: undefined };
    case "update":
      return {
        ...state,
        update_status: action.status,
        update_version: action.version,
      };
  }
}
export function position(
  playback: AppState["playback"],
  observedAt: number,
  now = Date.now(),
): number {
  return Math.max(
    0,
    Math.min(
      playback.item?.duration_ms ?? 0,
      (playback.progress_ms ?? 0) +
        (playback.is_playing ? Math.max(0, now - observedAt) : 0),
    ),
  );
}
export function activeLines(
  lines: { start_ms: number; end_ms: number; words?: Word[] }[],
  time: number,
): number[] {
  return lines.flatMap((line, index) =>
    line.start_ms <= time &&
    time <
      (line.words?.length
        ? Math.max(...line.words.map((word) => word.end_ms))
        : line.end_ms)
      ? [index]
      : [],
  );
}
export function progress(start: number, end: number, time: number): number {
  return Math.max(0, Math.min(1, (time - start) / Math.max(1, end - start)));
}
export function formatTime(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
