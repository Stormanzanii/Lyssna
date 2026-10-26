import type { AnimatorSettings } from "./animator-tuning";
export interface Artwork {
  url: string;
  width?: number;
}
export interface Artist {
  monthly_listeners?: number;
  id?: string;
  uri?: string;
  name: string;
  images?: Artwork[];
  genres?: string[];
  followers?: { total: number };
  verified?: boolean;
  biography?: string;
}
export interface Album {
  copyrights?: { text: string; type: string }[];
  id?: string;
  uri?: string;
  name: string;
  images: Artwork[];
  artists?: Artist[];
  release_date?: string;
  album_type?: string;
  total_tracks?: number;
}
export interface Track {
  added_at?: string;
  explicit?: boolean;
  songwriters?: string[];
  id?: string;
  uri: string;
  name: string;
  artists: Artist[];
  album: Album;
  duration_ms: number;
  is_local: boolean;
  played_context?: string;
  /** Spotify cannot play it for this account; shown dimmed, never started. */
  unavailable?: boolean;
}
export interface Device {
  id?: string;
  name: string;
  is_active: boolean;
  volume_percent?: number;
  is_offline?: boolean;
}
export interface TrackFacts {
  plays?: number;
  genres: string[];
  release_date: string;
}
export interface Playback {
  item?: Track;
  is_playing: boolean;
  progress_ms?: number;
  shuffle_state: boolean;
  repeat_state: string;
  device: Device;
  /** URI of the playlist, album, artist or Liked Songs playing. */
  context?: string | null;
}
export interface Profile {
  images?: Artwork[];
  id: string;
  display_name?: string;
}
/** A Spotify library folder. */
export interface FolderRef {
  id: string;
  name: string;
}
/** A Spotify folder in the library, with its parent folder IDs. */
export interface LibraryFolder extends FolderRef {
  parents: string[];
}
export interface Playlist {
  id: string;
  name: string;
  images: Artwork[];
  owner: { id: string; display_name?: string };
  collaborative: boolean;
  /** Spotify folders containing the playlist, outermost first. */
  folders?: FolderRef[];
  /** When it joined Your Library, in Unix milliseconds. */
  added_at?: number;
}
export interface SearchResults {
  tracks: Track[];
  artists: Artist[];
  albums: Album[];
  playlists: Playlist[];
  /** Spotify user profiles; native search only. */
  users?: Profile[];
  top_results: string[];
}
export interface Folder {
  name: string;
  playlist_ids: string[];
  show_in_picker: boolean;
}
export interface Settings {
  library_order?: Record<string, import("./library-order").LibraryOrder>;
  client_id: string;
  last_view: string;
  show_lyrics: boolean;
  compact_library: boolean;
  lyric_size: number;
  lyric_offset_ms: number;
  romanized: boolean;
  reduce_motion: boolean;
  cover_animation?: boolean;
  liquid_glass?: boolean;
  canvas_lyrics?: boolean;
  npv_ambience?: boolean;
  space_gravity?: boolean;
  lyrics_translations?: boolean;
  lyrics_animator?: AnimatorSettings;
  experimental_word_sync?: boolean;
  lyrics_hide_artwork?: boolean;
  lyrics_artwork_right?: boolean;
  lyrics_compact?: boolean;
  lyrics_toolbar_bottom?: boolean;
  lyrics_right_align?: boolean;
  lyrics_flip_duet?: boolean;
  lyrics_wide_duet?: boolean;
  lyrics_credits_follow?: boolean;
  lyrics_simple?: boolean;
  lyrics_minimal?: boolean;
  lyrics_line_hover?: boolean;
  lyrics_skeleton?: boolean;
  lyrics_cache_button?: boolean;
  lyrics_cache_action?: "song" | "reload" | "all";
  lyrics_early_scroll?: boolean;
  lyrics_follow_button?: boolean;
  /** Early scroll lead in milliseconds, 0 to 800; 250 unless chosen. */
  lyrics_early_scroll_ms?: number;
  /** Release year beside the artists on the lyrics page. */
  lyrics_year_position?: "left" | "right" | "off";
  lyrics_hide_npv?: boolean;
  lyrics_hide_npv_empty?: boolean;
  now_playing_open?: boolean;
  song_sorts?: Record<string, string>;
  lyrics_background?: "animated" | "static" | "color";
  lyrics_pinned_footer?: "off" | "no_writers" | "full";
  /** Full screen parts kept visible while the rest hides on idle. */
  fullscreen_always_show?: "none" | "controls" | "time" | "both";
  fullscreen_volume?: "off" | "left" | "right" | "below";
  fullscreen_animate_close?: boolean;
  lyrics_escape_exits?: boolean;
  lyrics_source_order?: string[];
  lyrics_sources_disabled?: string[];
  lyrics_prefer_apple?: boolean;
  lyrics_musixmatch_lines_only?: boolean;
  settings_remember_place?: boolean;
  ui_font?: string;
  ui_zoom_percent?: number;
  lyric_font?: string;
  volume_percent?: number;
  auto_download_updates: boolean;
  keep_playing_on_close?: boolean;
  crossfade?: boolean;
  crossfade_seconds?: number;
  lyrics_discord_usernames?: boolean;
  lyrics_profiles_in_browser?: boolean;
  audio_output?: string | null;
  folders: Folder[];
  spotify_plus?: SpotifyPlus;
}
/** Interface options modelled on the Spotify+ extension. */
export interface SpotifyPlus {
  /** Folders whose playlists Add to playlist offers; empty offers all. */
  playlist_folders?: string[];
}
export interface Word {
  start_ms: number;
  end_ms: number;
  text: string;
  /** Timing estimated by experimental word sync, not authored. */
  estimated?: boolean;
}
export interface Line {
  start_ms: number;
  end_ms: number;
  text: string;
  translation: string;
  romanization: string;
  words: Word[];
  background: boolean;
  opposite: boolean;
}
export interface Lyrics {
  songwriters?: string[];
  attribution?: { uploader?: Contributor; maker?: Contributor };
  lines: Line[];
  source: string;
  instrumental: boolean;
  synced: boolean;
  /** Word timing was estimated (experimental word sync). */
  estimated_words?: boolean;
  /** Merged Apple Music words were split by experimental word sync. */
  split_words?: boolean;
  /** Line boundaries were estimated from static text and track duration. */
  estimated_lines?: boolean;
}
export interface Contributor {
  id: string;
  username: string;
  /** Discord username from the public profile, if it differs. */
  discord?: string;
  url?: string;
  avatar?: string;
  hasProfileBanner?: boolean;
}
export interface PlayingDetails {
  artists: Artist[];
  queue: Track[];
  /** Songs played before this one, newest last, to predict Previous. */
  played?: Track[];
}
export interface BrowseInfo {
  playlist?: {
    owner: string;
    owner_profile?: Profile | null;
    total_tracks?: number | null;
    format: string;
  };
  album_details?: {
    streams: Record<string, number>;
    duration_ms: number;
    complete_duration: boolean;
    copyrights: { text: string; type: string }[];
    more: Album[];
  };
  overview?: {
    header_image?: string;
    verified?: boolean;
    monthly_listeners?: number;
    followers?: number;
    biography: string;
    popular: { track: Track; streams?: number }[];
    source_url: string;
    fetched_at: number;
    avatar_image?: string;
    /** Spotify's worldwide listener rank, when ranked. */
    world_rank?: number;
    /** A large artist photo for the About card. */
    gallery_image?: string;
    /** Every gallery photo, for the About window. */
    gallery?: string[];
    /** Cities with the most listeners. */
    top_cities?: { city: string; country: string; listeners: number }[];
    /** The biography with Spotify's links kept. */
    biography_html?: string;
    /** Featuring, Discovered on, Artist Playlists, Fans also like, Appears On. */
    sections?: HomeSection[];
    /** The item the artist pinned ("Artist pick"). */
    pick?: HomeItem;
  };
  key: string;
  title: string;
  subtitle: string;
  images: Artwork[];
  artist?: Artist;
  album?: Album;
  albums: Album[];
}
export interface Snapshot {
  login_issue?: { message: string; retry_saved: boolean } | null;
  narrating: boolean;
  home?: HomePage;
  home_loading: boolean;
  home_error: string;
  canvas_url?: string;
  profile?: Profile;
  playlists: Playlist[];
  playback: Playback;
  settings: Settings;
  native_ready: boolean;
  local_device_name: string;
  native_status: string;
  provider_configured: boolean;
  provider_builtin?: boolean;
  provider_kind?: "spicy" | "legacy";
  login_pending: boolean;
  can_follow: boolean;
  lyrics?: Lyrics;
  lyric_error: string;
  details: PlayingDetails;
  route: string;
  generation: number;
  tracks: Track[];
  search_playlists: Playlist[];
  search_artists: Artist[];
  search_albums: Album[];
  search_top_results: string[];
  search_users?: Profile[];
  search_playlists_loading: boolean;
  search_playlists_error: string;
  browse_info?: BrowseInfo;
  loading: boolean;
  more: boolean;
  update_status: string;
  update_version?: string;
  update_notes?: string;
  notice: string;
  observed_at: number;
}
export type HomeItem = {
  uri: string;
  route: string;
  name: string;
  subtitle: string;
  images: Artwork[];
  kind: string;
  playable: boolean;
  format: string;
};
export type HomeSection = {
  uri: string;
  title: string;
  subtitle: string;
  items: HomeItem[];
  /** The section's own picture, such as the artist of a new release. */
  header_images?: Artwork[];
};
/** A Spotify user's profile page, as the desktop client shows it. */
export type UserProfilePage = {
  id: string;
  name: string;
  images: Artwork[];
  public_playlists: number;
  followers: number;
  following: number;
  is_current_user: boolean;
  /** Whether the viewer follows this profile; absent for their own. */
  is_following?: boolean | null;
  allow_follows: boolean;
  sections: HomeSection[];
};
export type HomePage = {
  account: string;
  greeting: string;
  sections: HomeSection[];
  cached?: boolean;
};
export type PlayerRequest = {
  command: string;
  uri?: string;
  uris?: string[];
  context?: string;
  offset?: number;
  positionMs?: number;
  volume?: number;
  enabled?: boolean;
  repeat?: string;
  track?: Track;
};
export type AppEvent =
  | { type: "window_activity"; minimized: boolean; focused: boolean }
  | { type: "window_moved"; x: number; y: number }
  | { type: "login_failed"; issue: { message: string; retry_saved: boolean } }
  | { type: "narration"; active: boolean }
  | { type: "dj_context"; active: boolean }
  /** A Spicy Lyrics creator profile sheet opened or closed. */
  | { type: "creator_profile"; open: boolean }
  | {
      /** A press on the taskbar buttons, media keys or the media flyout. */
      type: "media_control";
      action: "toggle" | "play" | "pause" | "next" | "previous" | "seek";
      position_ms?: number | null;
    }
  | { type: "home"; page: HomePage }
  | { type: "home_loading"; account: string }
  | { type: "home_error"; account: string; message: string }
  | { type: "track_facts"; facts: Record<string, TrackFacts> }
  | { type: "canvas"; uri: string; url?: string }
  | { type: "canvas_prefetch"; uri: string; url: string }
  | { type: "page_prefetch"; key: string; tracks: Track[]; more: boolean }
  | { type: "info_prefetch"; info: BrowseInfo }
  | { type: "session"; profile: Profile; can_follow: boolean }
  | { type: "profile"; profile: Profile }
  | { type: "signed_out" | "login_finished" }
  | { type: "provider_configured"; kind?: "spicy" | "legacy" }
  | { type: "native"; ready: boolean; status: string }
  | { type: "library"; playlists: Playlist[] }
  | { type: "library_folders"; folders: LibraryFolder[] }
  | {
      type: "search_results";
      account: string;
      key: string;
      generation: number;
      results: SearchResults;
      message: string;
    }
  | {
      type: "search_playlists";
      account: string;
      key: string;
      generation: number;
      playlists: Playlist[];
      message: string;
    }
  | {
      type: "playback";
      loading?: boolean;
      playback: Playback;
      observed_at: number;
      changed: boolean;
    }
  | {
      type: "native_position";
      seeked?: boolean;
      uri: string;
      position_ms: number;
      playing?: boolean;
      observed_at: number;
    }
  | {
      type: "tracks";
      key: string;
      generation: number;
      offset: number;
      tracks: Track[];
      more: boolean;
    }
  | { type: "tracks_failed"; generation: number; message: string }
  | { type: "browse_info"; generation: number; info: BrowseInfo }
  | { type: "playing_details"; uri: string; details: PlayingDetails }
  | { type: "lyrics"; uri: string; lyrics: Lyrics }
  | { type: "lyric_error"; uri: string; message: string }
  | { type: "devices"; devices: Device[] }
  | { type: "notice"; message: string; error: boolean }
  | { type: "saved"; uri: string; saved: boolean }
  | { type: "saved_many"; items: Record<string, boolean> }
  | { type: "update"; status: string; version?: string; notes?: string };
