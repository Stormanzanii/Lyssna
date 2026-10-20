import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DJRequest } from "./DJRequest";
import { createDJReminder } from "./djHint";
import {
  ArrowLeft,
  ArrowRight,
  ArrowLeftRight,
  AudioLines,
  BadgeCheck,
  Check,
  Languages,
  PanelLeftClose,
  Rows3,
  Settings as SettingsIcon,
  ChevronDown,
  Clock3,
  FolderPlus,
  Heart,
  Home,
  Library,
  LoaderCircle,
  Maximize2,
  PanelRight,
  CirclePlus,
  CircleCheck,
  Mic2,
  Minus,
  MoreHorizontal,
  Music2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Repeat,
  Repeat1,
  Search,
  Shuffle,
  SkipBack,
  SkipForward,
  Speaker,
  Square,
  Volume2,
  VolumeX,
  X,
  ListMusic,
  Upload,
  Copy,
  ExternalLink,
  Pin,
  ChevronRight,
} from "lucide-react";
import { rpc, subscribe } from "./bridge";
import { HomePage } from "./HomePage";
import { SearchPage } from "./SearchPage";
import { SpotifyText } from "./SpotifyText";
import { Logo } from "./brand";
import {
  emptyState,
  reducer,
  formatTime,
  nextToggle,
  sessionScreen,
  type ToggleIntent,
} from "./state";
import type { AppState } from "./state";
import type {
  Album,
  Artist,
  PlayerRequest,
  Playlist,
  Settings,
  Snapshot,
  Track,
  HomeItem,
  AppEvent,
} from "./types";
import {
  Ambience,
  ArtistLinks,
  Cover,
  LyricsPage,
  Marquee,
  NowPlaying,
  QueuePanel,
  DJPresentation,
  DJArtwork,
  TrackTitle,
  artistNames,
  imageOf,
  preloadCanvas,
  prefetchCanvas,
  prefetchPage,
  cancelPrefetch,
  useLoadedImage,
  useStickyLoadedImage,
  preloadImage,
  ExplicitBadge,
  usePosition,
} from "./components";
import "./styles.css";
import "./pages.css";
import "./settings.css";
import "./glass.css";
import { VolumeControl } from "./volume-control";
import { DJButton } from "./dj-button";
import {
  DJ_ID,
  accountOrder,
  libraryItems,
  playlistForManualPlay,
  recordManualPlay,
  saveAccountOrder,
  togglePlaylistPin,
} from "./library-order";
import { fontFamily, loadSelectedFonts } from "./custom-fonts";
import { SettingsPage } from "./settings-page";
import { GlassBackdrop } from "./liquid-glass";
import { setWindowActivity, setWindowPosition } from "./window-activity";
import { useArtworkColor } from "./artwork-color";
import { SongSortMenu } from "./song-sort-menu";
import { ProfileMenu } from "./profile-menu";
import { ProfilePage } from "./profile-page";
import { RecentsPage } from "./recents-page";
import { collectionTracks, genresFor } from "./collection";
import { useAppZoom } from "./app-zoom";
import { PlaylistFlyout } from "./playlist-flyout";
import {
  loadRecentSearches,
  rememberSearch,
  saveRecentSearches,
  type RecentSearch,
} from "./recent-searches";
import type { SearchEntry } from "./search-results";
/** Lyrics use Inter unless the user picks a lyrics font. */
const DEFAULT_LYRIC_FONT = '"Inter Variable", "Segoe UI", sans-serif';
/** Inputs that take no typing, so Space still toggles playback. */
const NON_TEXT_INPUTS = new Set([
  "range",
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "color",
  "file",
]);

type Center = "browse" | "lyrics" | "settings" | "profile";
type EntityMenu = {
  kind: "playlist" | "album" | "artist" | "liked";
  id: string;
  name: string;
  x: number;
  y: number;
};
const windowHandle = () => getCurrentWindow();
/** Spotify-style total length: "1 hr 42 min" or "38 min 12 sec". */
const longDuration = (ms: number) => {
  const minutes = Math.floor(ms / 60_000);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min`
    : `${minutes} min ${Math.floor(ms / 1000) % 60} sec`;
};

function App() {
  const [djRequest, setDJRequest] = useState(false);
  const [entityMenu, setEntityMenu] = useState<EntityMenu | null>(null);
  const [state, dispatch] = useReducer(reducer, emptyState);
  useEffect(() => setDJRequest(false), [state.profile?.id, state.native_ready]);
  const [center, setCenter] = useState<Center>("browse");
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([]);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryFilter, setLibraryFilter] = useState("all");
  const [sidebar, setSidebar] = useState(true);
  // The right panel shows Now playing or the queue.
  const [panel, setPanel] = useState<"now" | "queue">("now");
  const toggleQueue = () => {
    if (sidebar && panel === "queue") setPanel("now");
    else {
      setPanel("queue");
      setSidebar(true);
    }
  };
  const [rightWidth, setRightWidth] = useState(360);
  const [target, setTarget] = useState("native");
  const [deviceMenu, setDeviceMenu] = useState(false);
  useEffect(() => {
    if (!deviceMenu) return;
    // Clicking anywhere outside the device popup closes it. The Devices
    // button toggles it itself, so it is left out here.
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest('.device-menu, [title="Devices"]'))
        setDeviceMenu(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [deviceMenu]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [picker, setPicker] = useState<{
    tracks: Track[];
    x: number;
    y: number;
  } | null>(null);
  const [folderDialog, setFolderDialog] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [songMenu, setSongMenu] = useState<{
    track: Track;
    fromList?: boolean;
    x: number;
    y: number;
  } | null>(null);
  const [immersive, setImmersive] = useState(false);
  const restoreMaximized = useRef(false),
    fullscreenBusy = useRef(false);
  const [albumFilter, setAlbumFilter] = useState("all");
  const [allAlbums, setAllAlbums] = useState(false);
  const [popularMore, setPopularMore] = useState(false);
  const [songSearch, setSongSearch] = useState(false);
  const [songQuery, setSongQuery] = useState(""),
    [songGenre, setSongGenre] = useState(""),
    [songAge, setSongAge] = useState(""),
    [songSort, setSongSort] = useState("order");
  useEffect(() => {
    setSongSearch(false);
    setSongQuery("");
    setSongGenre("");
    setSongAge("");
    setSongSort("order");
  }, [state.route]);
  const generation = useRef(0),
    bootRoute = useRef("home"),
    loadedAccount = useRef(""),
    history = useRef<string[]>([]),
    future = useRef<string[]>([]),
    routeRef = useRef("home"),
    stateRef = useRef(state),
    fileInput = useRef<HTMLInputElement>(null),
    searchInput = useRef<HTMLInputElement>(null),
    mainScroll = useRef<HTMLDivElement>(null),
    pageSentinel = useRef<HTMLDivElement>(null),
    pendingPage = useRef<string>("");
  stateRef.current = state;
  useEffect(() => {
    void loadSelectedFonts([
      state.settings.ui_font,
      state.settings.lyric_font,
    ]).catch(() => {});
  }, [state.settings.ui_font, state.settings.lyric_font]);
  routeRef.current = state.route;
  const notify = useCallback(
    (message: string, error = false) =>
      dispatch({ type: "notice", message, error }),
    [],
  );
  const djReminder = useMemo(
    () =>
      createDJReminder({
        getItem: (key) => window.localStorage.getItem(key),
        setItem: (key, value) => window.localStorage.setItem(key, value),
      }),
    [],
  );
  useEffect(() => {
    if (state.narrating && state.profile && djReminder(state.profile.id))
      notify("Hold the DJ button to ask for music.");
  }, [state.narrating, state.profile, djReminder, notify]);
  const call = useCallback(
    async <T,>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T | undefined> => {
      try {
        return await rpc<T>(command, args);
      } catch (error) {
        notify(String(error), true);
        return undefined;
      }
    },
    [notify],
  );
  const navigate = useCallback(
    (key: string, push = true) => {
      if (!stateRef.current.profile) return;
      if (push && routeRef.current !== key) {
        if (!(
          routeRef.current.startsWith("search:") && key.startsWith("search:")
        ))
          history.current.push(routeRef.current);
        future.current = [];
      }
      setCenter("browse");
      setAlbumFilter("all");
      setAllAlbums(false);
      setPopularMore(false);
      setSelected(new Set());
      setSongMenu(null);
      const next = ++generation.current;
      const hint = stateRef.current.home?.sections
        .flatMap((section) => section.items)
        .find((item) => item.route === key);
      if (hint && (key.startsWith("artist:") || key.startsWith("album:")))
        dispatch({
          type: "info_prefetch",
          info: {
            key,
            title: hint.name,
            subtitle: hint.subtitle,
            images: hint.images,
            albums: [],
          },
        });
      dispatch({ type: "navigate", key, generation: next });
      mainScroll.current?.scrollTo({ top: 0 });
      void call("browse", { key, generation: next, offset: 0 });
    },
    [call],
  );
  useEffect(() => {
    let disposed = false,
      unlisten: (() => void) | undefined;
    void (async () => {
      let bootstrapped = false;
      const pending: AppEvent[] = [];
      const receive = (event: AppEvent) => {
        if (event.type === "window_activity") {
          setWindowActivity(event);
          return;
        }
        if (event.type === "window_moved") {
          setWindowPosition(event.x, event.y);
          return;
        }
        if (event.type === "canvas_prefetch") preloadCanvas(event.url);
        if (event.type === "session")
          void preloadImage(imageOf(event.profile.images));
        if (event.type === "browse_info" || event.type === "info_prefetch") {
          void preloadImage(imageOf(event.info.images));
          void preloadImage(event.info.overview?.header_image);
        }
        dispatch(event);
      };
      try {
        unlisten = await subscribe((event) => {
          if (disposed) return;
          if (!bootstrapped) {
            pending.push(event);
            return;
          }
          receive(event);
        });
        const snapshot = await rpc<Snapshot>("bootstrap");
        void preloadImage(imageOf(snapshot.profile?.images));
        void preloadImage(snapshot.browse_info?.overview?.header_image);
        if (!disposed) {
          generation.current = snapshot.generation;
          bootRoute.current = snapshot.route || "home";
          setQuery(
            snapshot.route.startsWith("search:") ? snapshot.route.slice(7) : "",
          );
          dispatch({ type: "bootstrap", snapshot });
          bootstrapped = true;
          pending.splice(0).forEach(receive);
        }
      } catch (error) {
        if (!disposed)
          notify(`Cannot connect to desktop services: ${String(error)}`, true);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [notify]);
  useEffect(() => {
    if (state.profile && loadedAccount.current !== state.profile.id) {
      loadedAccount.current = state.profile.id;
      navigate(bootRoute.current, false);
      void call("refresh");
    }
    if (!state.profile) loadedAccount.current = "";
  }, [state.profile, navigate, call]);
  useEffect(() => {
    if (!state.profile || !query.trim()) return;
    const timer = setTimeout(() => {
      const key = `search:${query.trim()}`;
      if (routeRef.current !== key) navigate(key);
    }, 250);
    return () => clearTimeout(timer);
  }, [query, state.profile, navigate]);
  useEffect(() => {
    if (state.toast) {
      const timer = setTimeout(() => dispatch({ type: "toast_clear" }), 6000);
      return () => clearTimeout(timer);
    }
  }, [state.toast]);
  const updateSettings = useCallback(
    (changes: Partial<Settings>) => {
      const settings = { ...stateRef.current.settings, ...changes };
      stateRef.current = { ...stateRef.current, settings };
      dispatch({ type: "settings", settings });
      void call("save_settings", { settings });
    },
    [call],
  );
  useAppZoom(
    state.settings.ui_zoom_percent ?? 100,
    (percent) => updateSettings({ ui_zoom_percent: percent }),
    notify,
  );
  const togglePin = useCallback(
    (playlist: Playlist) => {
      try {
        const current = stateRef.current;
        if (!current.profile) return;
        updateSettings(
          saveAccountOrder(
            current,
            togglePlaylistPin(accountOrder(current), playlist),
          ),
        );
      } catch (error) {
        notify(
          error instanceof Error ? error.message : "Could not pin playlist",
          true,
        );
      }
    },
    [notify, updateSettings],
  );
  useEffect(() => {
    if (!entityMenu && !songMenu) return;
    document.querySelector<HTMLButtonElement>(".song-menu button")?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setEntityMenu(null);
        setSongMenu(null);
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [entityMenu, songMenu]);
  const toggleIntent = useRef<ToggleIntent | undefined>(undefined);
  const refreshHome = useCallback(() => {
    void call("home", {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    });
  }, [call]);
  useEffect(() => {
    if (
      state.profile &&
      state.native_ready &&
      state.route === "home" &&
      (state.home?.account !== state.profile.id || state.home.cached)
    )
      refreshHome();
  }, [
    state.profile?.id,
    state.native_ready,
    state.route,
    state.home?.account,
    state.home?.cached,
    refreshHome,
  ]);
  const metadataKeys = useMemo(
    () =>
      [
        ...new Set([
          ...(state.playback.item?.artists.flatMap((artist) =>
            artist.id ? [`artist:${artist.id}`] : [],
          ) || []),
          ...(state.playback.item?.album.id
            ? [`album:${state.playback.item.album.id}`]
            : []),
          ...state.tracks
            .slice(0, 8)
            .flatMap((track) =>
              track.artists.flatMap((artist) =>
                artist.id ? [`artist:${artist.id}`] : [],
              ),
            ),
          ...(state.home?.account === state.profile?.id
            ? state.home?.sections.flatMap((section) =>
                section.items
                  .filter(
                    (item) => item.kind === "artist" || item.kind === "album",
                  )
                  .map((item) => item.route),
              ) || []
            : []),
        ]),
      ].slice(0, 8),
    [state.playback.item?.uri, state.tracks, state.home, state.profile?.id],
  );
  const metadataSignature = metadataKeys.join("|");
  useEffect(() => {
    if (state.profile && state.native_ready && metadataKeys.length)
      void rpc("prefetch_metadata", { keys: metadataKeys }).catch(() => {});
  }, [state.profile?.id, state.native_ready, metadataSignature]);
  const play = useCallback(
    (request: PlayerRequest) => {
      const current = stateRef.current,
        item = playlistForManualPlay(current, request);
      if (item && current.profile)
        updateSettings(
          saveAccountOrder(
            current,
            recordManualPlay(accountOrder(current), item),
          ),
        );
      if (
        request.command === "pause" ||
        (request.command === "play" && !request.uri)
      )
        toggleIntent.current = {
          wanted: request.command === "play",
          at: performance.now(),
        };
      if (request.track)
        dispatch({ type: "play_requested", track: request.track });
      if (request.command === "dj") dispatch({ type: "dj_requested" });
      void call("player", { request, target });
    },
    [call, target, updateSettings],
  );
  const homeNavigate = useCallback(
    (route: string) =>
      route === "playlist:37i9dQZF1EYkqdzj48dyYq"
        ? play({ command: "dj" })
        : navigate(route),
    [navigate, play],
  );
  const homePlay = useCallback(
    (item: HomeItem) => {
      if (!item.playable) return;
      if (item.route === "liked") navigate("liked");
      else
        play(
          item.uri === "spotify:playlist:37i9dQZF1EYkqdzj48dyYq"
            ? { command: "dj" }
            : { command: "play_home", context: item.uri },
        );
    },
    [navigate, play],
  );
  const startDJ = useCallback(() => play({ command: "dj" }), [play]);
  const toggle = useCallback(() => {
    const intent = nextToggle(
      stateRef.current.playback.is_playing,
      toggleIntent.current,
      performance.now(),
    );
    play({ command: intent.wanted ? "play" : "pause" });
  }, [play]);
  useEffect(() => {
    if (!state.dj_pending) return;
    const timer = setTimeout(
      () => dispatch({ type: "dj_pending_expired" }),
      5000,
    );
    return () => clearTimeout(timer);
  }, [state.dj_pending]);
  // Taskbar buttons, media keys and the Windows media flyout.
  useEffect(() => {
    let unlisten: (() => void) | undefined,
      disposed = false;
    void subscribe((event) => {
      if (event.type !== "media_control" || !stateRef.current.profile) return;
      if (event.action === "toggle") toggle();
      else if (event.action === "seek") {
        if (event.position_ms != null)
          play({ command: "seek", positionMs: event.position_ms });
      } else play({ command: event.action });
    }).then((stop) => (disposed ? stop() : (unlisten = stop)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [toggle, play]);
  const item = state.playback.item;
  useEffect(() => {
    void rpc("media_state", {
      state: {
        title: state.narrating ? "DJ" : (item?.name ?? ""),
        artists: item?.artists.map((artist) => artist.name).join(", ") ?? "",
        album: item?.album.name ?? "",
        cover: item?.album.images?.[0]?.url ?? "",
        durationMs: item?.duration_ms ?? 0,
        positionMs: Math.round(state.playback.progress_ms ?? 0),
        playing: state.playback.is_playing,
        loaded: !!item,
      },
    }).catch(() => {});
  }, [
    item?.uri,
    state.narrating,
    state.playback.is_playing,
    state.clock_revision,
  ]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      // Only typing keeps Space and Escape; a focused button or slider still
      // leaves Space for play and pause.
      const target = event.target as HTMLElement | null,
        editing =
          !!target?.closest('textarea,select,[contenteditable="true"]') ||
          (target instanceof HTMLInputElement &&
            !NON_TEXT_INPUTS.has(target.type));
      if (
        (event.ctrlKey || event.metaKey) &&
        ["k", "l"].includes(event.key.toLowerCase())
      ) {
        event.preventDefault();
        searchInput.current?.focus();
        return;
      }
      if (event.key === "F5") {
        event.preventDefault();
        void call("refresh");
        return;
      }
      if (!stateRef.current.profile || editing) return;
      if (event.code === "Space") {
        // Space always plays or pauses, even on a focused button.
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) toggle();
      }
      if (event.key === "Escape") {
        setSongMenu(null);
        setDeviceMenu(false);
        setPicker(null);
        setFolderDialog(false);
      }
    };
    // A focused button activates on Space keyup; cancel that so Space never
    // also presses whatever button was clicked last.
    const keyup = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.code === "Space" &&
        !target?.closest('textarea,select,[contenteditable="true"]') &&
        !(
          target instanceof HTMLInputElement &&
          !NON_TEXT_INPUTS.has(target.type)
        )
      )
        event.preventDefault();
    };
    // Capture so no other handler can see or stop Space first.
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("keyup", keyup, true);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keyup", keyup, true);
    };
  }, [toggle, call]);
  const prefetchOn = useCallback(
    (key: string) => ({
      onMouseEnter: () => {
        const current = stateRef.current;
        if (
          current.profile &&
          key !== current.route &&
          !current.pages[key]?.tracks
        )
          prefetchPage(key);
      },
      onMouseLeave: cancelPrefetch,
    }),
    [],
  );
  const openAlbum = useCallback(
    (album: Album) => {
      const id = album.id || album.uri?.split(":")[2];
      if (id) navigate(`album:${id}`);
      else {
        const current = stateRef.current,
          track = [current.playback.item, ...current.tracks].find(
            (track) => track?.album === album,
          );
        if (track)
          void call("resolve_album", { uri: track.uri }).then((value) => {
            const resolved = value as Album | undefined;
            const id = resolved?.id || resolved?.uri?.split(":")[2];
            if (id) navigate(`album:${id}`);
          });
        else if (album.name) setQuery(album.name);
      }
    },
    [navigate, call],
  );
  const openArtist = useCallback(
    (artist: Artist) => {
      const id = artist.id || artist.uri?.split(":")[2];
      if (id) {
        const known =
          stateRef.current.details.artists.find(
            (item) => item.id === id && item.images?.length,
          ) || artist;
        dispatch({
          type: "info_prefetch",
          info: {
            key: `artist:${id}`,
            title: artist.name,
            subtitle: "Artist",
            images: known.images || [],
            artist: known,
            albums: [],
          },
        });
        navigate(`artist:${id}`);
      } else setQuery(artist.name);
    },
    [navigate],
  );
  const follow = useCallback(
    (artist: Artist) => {
      if (!artist.id) return;
      if (!stateRef.current.can_follow) {
        setCenter("settings");
        notify(
          "Enable artist following by updating Spotify permissions in Settings.",
        );
        return;
      }
      const uri = artist.uri || `spotify:artist:${artist.id}`;
      void call("save_item", { uri, saved: !stateRef.current.saved[uri] });
    },
    [call, notify],
  );
  const save = useCallback(
    (track: Track) => {
      void call("save_item", {
        uri: track.uri,
        saved: !stateRef.current.saved[track.uri],
      });
    },
    [call],
  );
  const playTrack = useCallback(
    (track: Track, index?: number) => {
      const current = stateRef.current;
      let complete = track;
      if (current.browse_info?.album)
        complete = { ...track, album: current.browse_info.album };
      if (
        current.route.startsWith("playlist:") ||
        current.route.startsWith("album:")
      )
        play({
          command: "play_context",
          context: `spotify:${current.route}`,
          uri: track.uri,
          track: complete,
        });
      else if (index !== undefined) {
        const tracks = (
          current.browse_info?.artist
            ? (current.browse_info.overview?.popular.map(
                (item) => item.track,
              ) ?? [])
            : current.tracks
        ).filter((track) => !track.is_local);
        const clicked = tracks.findIndex((item) => item.uri === track.uri);
        const start = Math.max(0, clicked - 30),
          uris = tracks.slice(start, start + 100).map((item) => item.uri);
        play({
          command: "play_uris",
          uris,
          offset: clicked - start,
          track: complete,
        });
      } else play({ command: "play", uri: track.uri, track: complete });
    },
    [play],
  );
  const importFile = async (file: File) => {
    if (file.size > 2_000_000) {
      notify("Lyric file exceeds 2 MB", true);
      return;
    }
    await call("import_lyrics", {
      filename: file.name,
      contents: await file.text(),
    });
    notify("Lyric file imported for this song.");
  };
  const back = () => {
    if (center !== "browse") {
      setCenter("browse");
      return;
    }
    const key = history.current.pop();
    if (key) {
      future.current.push(state.route);
      navigate(key, false);
    }
  };
  const forward = () => {
    const key = future.current.pop();
    if (key) {
      history.current.push(state.route);
      navigate(key, false);
    }
  };
  const fullscreen = async (force?: boolean) => {
    if (fullscreenBusy.current) return;
    fullscreenBusy.current = true;
    try {
      const next = force ?? !(await windowHandle().isFullscreen());
      if (next) restoreMaximized.current = await windowHandle().isMaximized();
      await windowHandle().setFullscreen(next);
      if (!next && restoreMaximized.current) {
        await windowHandle().unmaximize();
        await windowHandle().maximize();
      }
      setImmersive(next);
      if (next) setCenter("lyrics");
    } catch (error) {
      notify(String(error), true);
    } finally {
      fullscreenBusy.current = false;
    }
  };
  useEffect(() => {
    void windowHandle()
      .isFullscreen()
      .then((value) => setImmersive(!!value));
  }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "F11" || (event.key === "Escape" && immersive)) {
        event.preventDefault();
        void fullscreen(event.key === "Escape" ? false : undefined);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [immersive]);
  const playlist = state.playlists.find(
    (playlist) => state.route === `playlist:${playlist.id}`,
  );
  const albumFallback = state.route.startsWith("album:")
    ? state.tracks.find((track) => track.album.id === state.route.slice(6))
        ?.album
    : undefined;
  const fallbackInfo: typeof state.browse_info = albumFallback
    ? {
        key: state.route,
        title: albumFallback.name,
        subtitle: "",
        images: albumFallback.images,
        album: albumFallback,
        albums: [],
      }
    : undefined;
  const entity: typeof state.browse_info = state.browse_info
    ? {
        ...fallbackInfo,
        ...state.browse_info,
        title: state.browse_info.title || fallbackInfo?.title || "",
        images: state.browse_info.images?.length
          ? state.browse_info.images
          : (fallbackInfo?.images ?? []),
        album: state.browse_info.album ?? fallbackInfo?.album,
      }
    : fallbackInfo;
  const artistBanner = useStickyLoadedImage(
    entity?.overview?.header_image,
    state.route,
  );
  const heroImages = entity?.images.length ? entity.images : playlist?.images;
  const artworkColor = useArtworkColor(
    state.route === "liked" ? undefined : imageOf(heroImages),
  );
  const heroColor =
    state.route === "liked"
      ? "rgb(80 56 160)"
      : (artworkColor ?? "rgb(83 83 83)");
  const playlistInfo = entity?.playlist;
  const personalizedMix = playlistInfo?.format.startsWith("daily-mix");
  const playlistDuration =
    playlistInfo?.total_tracks === state.tracks.length &&
    state.tracks.length > 0 &&
    state.tracks.every((track) => track.duration_ms > 0)
      ? state.tracks.reduce((sum, track) => sum + track.duration_ms, 0)
      : undefined;
  const heroSongCount =
    entity?.album?.total_tracks ??
    playlistInfo?.total_tracks ??
    (state.tracks.length > 0 && !state.more ? state.tracks.length : undefined);
  const heroDuration = entity?.album_details?.complete_duration
    ? entity.album_details.duration_ms
    : playlistDuration;
  const title =
    entity?.title ||
    playlist?.name ||
    (state.route === "liked"
      ? "Liked Songs"
      : state.route === "queue"
        ? "Queue"
        : state.route === "recent"
          ? "Recently played"
          : state.route.startsWith("search:")
            ? `Results for “${state.route.slice(7)}”`
            : state.route.startsWith("playlist:")
              ? "Playlist"
              : state.route.startsWith("artist:")
                ? state.playback.item?.artists.find(
                    (artist) => artist.id === state.route.slice(7),
                  )?.name || "Artist"
                : state.route.startsWith("album:")
                  ? "Album"
                  : "Good to see you");
  const profileName = state.profile?.display_name || state.profile?.id || "You";
  const account = state.profile?.id ?? "";
  useEffect(() => setRecentSearches(loadRecentSearches(account)), [account]);
  const updateRecentSearches = (
    change: (list: RecentSearch[]) => RecentSearch[],
  ) =>
    setRecentSearches((list) => {
      const next = change(list);
      saveRecentSearches(account, next);
      return next;
    });
  const openRecentSearch = (item: RecentSearch) => {
    setSearchFocused(false);
    searchInput.current?.blur();
    if (item.track)
      play({ command: "play", uri: item.track.uri, track: item.track });
    else navigate(item.route);
  };
  // Native playlist info gives the owner's user ID; show their display name.
  const ownerId = playlistInfo?.owner || playlist?.owner.id;
  const ownerName =
    state.route === "liked" || (ownerId && ownerId === state.profile?.id)
      ? profileName
      : ownerId === "spotify"
        ? "Spotify"
        : (playlist?.owner.id === ownerId && playlist?.owner.display_name) ||
          state.playlists.find(
            (item) => item.owner.id === ownerId && item.owner.display_name,
          )?.owner.display_name ||
          ownerId ||
          "Your collection";
  const profileImage = useLoadedImage(imageOf(state.profile?.images));
  const collection =
    state.route === "liked" || state.route.startsWith("playlist:");
  const collectionPlays =
    collection &&
    state.route !== "liked" &&
    (playlist
      ? playlist.owner.id === "spotify"
      : entity?.playlist?.owner === "Spotify");
  const filtering = !!(
    songQuery.trim() ||
    songGenre ||
    songAge ||
    songSort !== "order"
  );

  const displayTracks = entity?.artist
    ? (entity.overview?.popular.map((item) => item.track) ?? [])
    : collection
      ? collectionTracks(state.tracks, state.facts, {
          query: songQuery,
          genre: songGenre,
          age: songAge,
          sort: songSort,
        })
      : state.tracks;
  const songGenres = [
    ...new Set(state.tracks.flatMap((track) => genresFor(track, state.facts))),
  ].sort();
  const visibleLibrary = libraryItems(state)
    .filter((playlist) =>
      playlist.name.toLowerCase().includes(libraryQuery.toLowerCase()),
    )
    .filter((playlist) =>
      libraryFilter === "owned"
        ? playlist.owner.id === state.profile?.id
        : libraryFilter === "collaborative"
          ? playlist.collaborative
          : true,
    );
  const select = (track: Track, multiple: boolean) => {
    setSelected((old) => {
      const next = multiple ? new Set(old) : new Set<string>();
      if (multiple && next.has(track.uri)) next.delete(track.uri);
      else next.add(track.uri);
      return next;
    });
  };
  const loadMore = useCallback(() => {
    const current = stateRef.current;
    const key = `${current.generation}:${current.tracks.length}`;
    if (current.loading || !current.more || pendingPage.current === key) return;
    pendingPage.current = key;
    dispatch({ type: "page_loading", generation: current.generation });
    void rpc("browse", {
      key: current.route,
      generation: current.generation,
      offset: current.tracks.length,
    }).catch((error) =>
      dispatch({
        type: "tracks_failed",
        generation: current.generation,
        message: String(error),
      }),
    );
  }, []);
  useEffect(() => {
    if (!state.loading) pendingPage.current = "";
  }, [state.loading, state.tracks.length, state.generation]);
  // Playlists, Liked Songs and albums load every page at once, like Spotify.
  const loadAll = collection || state.route.startsWith("album:");
  useEffect(() => {
    if (loadAll && state.more && !state.loading) loadMore();
  }, [
    loadAll,
    state.more,
    state.loading,
    state.tracks.length,
    loadMore,
  ]);
  useEffect(() => {
    const sentinel = pageSentinel.current,
      root = mainScroll.current;
    if (center !== "browse" || !sentinel || !root || !state.more) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root, rootMargin: "1200px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    center,
    state.route,
    state.more,
    state.loading,
    state.tracks.length,
    loadMore,
  ]);
  const resizeRight = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (event: PointerEvent) =>
      setRightWidth(
        Math.max(300, Math.min(520, window.innerWidth - event.clientX - 8)),
      );
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const showTrackList =
    state.route !== "home" && (!entity?.artist || displayTracks.length > 0);
  return (
    <div
      className={`application ${state.settings.reduce_motion ? "reduce-motion" : ""} ${immersive ? "immersive" : ""} ${state.settings.liquid_glass ? "liquid-glass" : ""}`}
      style={
        {
          fontFamily: fontFamily(state.settings.ui_font),
          "--lyric-font":
            fontFamily(state.settings.lyric_font) || DEFAULT_LYRIC_FONT,
        } as CSSProperties
      }
      onDragOver={(event) => event.preventDefault()}
      onContextMenu={(event) => {
        if (event.defaultPrevented) return;
        setSongMenu(null);
        setEntityMenu(null);
        const target = event.target as HTMLElement;
        if (target.closest('input,textarea,[contenteditable="true"]')) {
          setSongMenu(null);
          setEntityMenu(null);
          return;
        }
        event.preventDefault();
        if (!stateRef.current.profile) return;
        const element = target.closest<HTMLElement>("[data-context-route]");
        const route = element?.dataset.contextRoute;
        if (!element || !route) {
          setSongMenu(null);
          setEntityMenu(null);
          return;
        }
        const match = /^(playlist|album|artist|track):([A-Za-z0-9]{22})$/.exec(
          route,
        );
        if (match?.[1] === "track") {
          const current = stateRef.current,
            track = [
              ...current.tracks,
              ...current.details.queue,
              ...(current.playback.item ? [current.playback.item] : []),
            ].find(
              (item) =>
                item.id === match[2] ||
                item.uri === `spotify:track:${match[2]}`,
            );
          if (track) {
            setEntityMenu(null);
            setSongMenu({ track, x: event.clientX, y: event.clientY });
          }
          return;
        }
        if (match || route === "liked") {
          setSongMenu(null);
          setEntityMenu({
            kind:
              route === "liked" ? "liked" : (match![1] as EntityMenu["kind"]),
            id: match?.[2] ?? "",
            name:
              element.dataset.contextName || element.textContent?.trim() || "",
            x: event.clientX,
            y: event.clientY,
          });
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        const file = event.dataTransfer.files[0];
        if (file) void importFile(file);
      }}
    >
      {state.settings.liquid_glass && (
        <GlassBackdrop
          track={state.playback.item}
          playing={state.playback.is_playing}
          reduceMotion={state.settings.reduce_motion}
        />
      )}
      <header className="topbar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region aria-label="SpotiFlex">
          <Logo size={30} />
        </div>
        <div className="history-buttons">
          <button className="icon-button" title="Go back" onClick={back}>
            <ArrowLeft size={19} />
          </button>
          <button className="icon-button" title="Go forward" onClick={forward}>
            <ArrowRight size={19} />
          </button>
        </div>
        <div className="search-group">
          <button
            className={`icon-button home-button ${state.route === "home" && center === "browse" ? "active" : ""}`}
            title="Home"
            onClick={() => navigate("home")}
          >
            <Home size={23} />
          </button>
          <div className="search-box">
            <Search size={21} />
            <input
              ref={searchInput}
              aria-label="Search Spotify"
              placeholder="What do you want to play?"
              value={query}
              disabled={!state.profile}
              onChange={(event) => setQuery(event.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              onKeyDown={(event) => {
                if (event.key === "Escape") event.currentTarget.blur();
                if (event.key === "Enter" && query.trim()) {
                  event.preventDefault();
                  navigate(`search:${query.trim()}`);
                }
              }}
            />
            {query && (
              <button
                className="icon-button"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("");
                  if (state.route.startsWith("search:")) navigate("home");
                }}
              >
                <X size={17} />
              </button>
            )}
            {searchFocused && !query && recentSearches.length > 0 && (
              <div
                className="recent-searches popover"
                role="listbox"
                aria-label="Recent searches"
                // Keep focus in the box so clicks land before it closes.
                onMouseDown={(event) => event.preventDefault()}
              >
                <h3>Recent searches</h3>
                {recentSearches.map((item) => (
                  <div className="recent-search" key={item.uri}>
                    <button
                      role="option"
                      aria-selected={false}
                      onClick={() => openRecentSearch(item)}
                    >
                      <Cover
                        images={item.images}
                        className={item.kind === "Artist" ? "round" : ""}
                      />
                      <span>
                        <strong>{item.name}</strong>
                        <small>
                          {item.kind}
                          {item.subtitle && item.kind !== "Artist"
                            ? ` • ${item.subtitle}`
                            : ""}
                        </small>
                      </span>
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Remove ${item.name} from recent searches`}
                      onClick={() =>
                        updateRecentSearches((list) =>
                          list.filter((entry) => entry.uri !== item.uri),
                        )
                      }
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
                <button
                  className="recent-searches-clear"
                  onClick={() => updateRecentSearches(() => [])}
                >
                  Clear recent searches
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="top-actions">
          <ProfileMenu
            name={profileName}
            image={profileImage}
            onAction={(action) => {
              if (action === "account")
                void call("open_link", {
                  url: "https://www.spotify.com/account/overview/",
                });
              else if (action === "profile") setCenter("profile");
              else if (action === "recents") navigate("recent");
              else if (action === "settings") setCenter("settings");
              else void call("sign_out");
            }}
          />
        </div>
        <div className="window-controls">
          <button
            aria-label="Minimize window"
            onClick={() => void windowHandle().minimize()}
          >
            <Minus size={15} />
          </button>
          <button
            aria-label="Maximize or restore window"
            onClick={() => void windowHandle().toggleMaximize()}
          >
            <Square size={13} />
          </button>
          <button
            className="window-close"
            aria-label="Close window"
            onClick={() => void windowHandle().close()}
          >
            <X size={18} />
          </button>
        </div>
      </header>
      <div
        className="workspace"
        style={
          { "--right-width": `${sidebar ? rightWidth : 0}px` } as CSSProperties
        }
        inert={!state.profile}
      >
        <aside
          className={`library-panel ${state.settings.compact_library ? "compact-library" : ""}`}
        >
          <div className="library-heading">
            <button
              className="text-link"
              onClick={() =>
                updateSettings({
                  compact_library: !state.settings.compact_library,
                })
              }
            >
              <Library size={20} />
              <strong>Your Library</strong>
            </button>
            <div>
              <button
                className="icon-button"
                title="Refresh library"
                onClick={() => void call("refresh")}
              >
                <RefreshCw size={16} />
              </button>
              <button
                className="icon-button"
                title="Create folder"
                onClick={() => setFolderDialog(true)}
              >
                <FolderPlus size={18} />
              </button>
            </div>
          </div>
          <div className="library-filters">
            {[
              ["all", "Playlists"],
              ["owned", "By you"],
              ["collaborative", "Collaborative"],
            ].map(([key, label]) => (
              <button
                key={key}
                className={`chip ${libraryFilter === key ? "selected" : ""}`}
                onClick={() => setLibraryFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="library-search">
            <Search size={16} />
            <input
              placeholder="Search in your library"
              aria-label="Search library"
              value={libraryQuery}
              onChange={(event) => setLibraryQuery(event.target.value)}
            />
          </label>
          <div className="library-list">
            <button
              className={`library-item ${state.route === "liked" ? "current" : ""}`}
              data-context-route="liked"
              data-context-name="Liked Songs"
              onClick={() => navigate("liked")}
              {...prefetchOn("liked")}
            >
              <div className="liked-cover">
                <Heart size={22} fill="currentColor" />
              </div>
              <div>
                <strong>Liked Songs</strong>
                <small>Playlist · Pinned</small>
              </div>
            </button>
            {visibleLibrary.map((playlist) => (
              <div
                className="library-row"
                key={playlist.id}
                data-playlist-id={playlist.id}
                data-context-route={`playlist:${playlist.id}`}
                data-context-name={playlist.name}
              >
                <button
                  className={`library-item ${state.route === `playlist:${playlist.id}` ? "current" : ""}`}
                  onClick={() =>
                    playlist.id === DJ_ID
                      ? play({ command: "dj" })
                      : navigate(`playlist:${playlist.id}`)
                  }
                  {...(playlist.id === DJ_ID
                    ? {}
                    : prefetchOn(`playlist:${playlist.id}`))}
                >
                  {playlist.id === DJ_ID ? (
                    <DJArtwork />
                  ) : (
                    <Cover images={playlist.images} />
                  )}
                  <div>
                    <strong>{playlist.name}</strong>
                    <small>
                      {accountOrder(state).pinned.includes(playlist.id) && (
                        <Pin size={12} className="pinned-mark" />
                      )}
                      {playlist.id === DJ_ID
                        ? "Click to start listening"
                        : `Playlist · ${playlist.owner.display_name || playlist.owner.id}`}
                    </small>
                  </div>
                </button>
                <button
                  className={`library-pin icon-button ${accountOrder(state).pinned.includes(playlist.id) ? "pinned" : ""}`}
                  title={`${accountOrder(state).pinned.includes(playlist.id) ? "Unpin" : "Pin"} ${playlist.name}`}
                  aria-pressed={accountOrder(state).pinned.includes(
                    playlist.id,
                  )}
                  onClick={() => togglePin(playlist)}
                >
                  <Pin size={14} />
                </button>
              </div>
            ))}
            {state.settings.folders.map((folder, index) => (
              <details
                className="library-folder"
                key={`${folder.name}-${index}`}
              >
                <summary>
                  {folder.name}
                  <span>{folder.playlist_ids.length}</span>
                </summary>
                {state.playlists
                  .filter((playlist) =>
                    folder.playlist_ids.includes(playlist.id),
                  )
                  .map((playlist) => (
                    <button
                      className="library-item"
                      key={playlist.id}
                      data-context-route={`playlist:${playlist.id}`}
                      data-context-name={playlist.name}
                      onClick={() => navigate(`playlist:${playlist.id}`)}
                      {...prefetchOn(`playlist:${playlist.id}`)}
                    >
                      <Cover images={playlist.images} />
                      <div>
                        <strong>{playlist.name}</strong>
                        <small>Playlist</small>
                      </div>
                    </button>
                  ))}
              </details>
            ))}
            {!visibleLibrary.length && state.playlists.length > 0 && (
              <p className="empty-library">No playlists match.</p>
            )}
          </div>
        </aside>
        <main
          className={`center-panel ${center === "lyrics" ? "showing-lyrics" : ""}`}
        >
          {center === "lyrics" ? (
            <LyricsPage
              state={state}
              onPlayer={play}
              onAlbum={openAlbum}
              onArtist={openArtist}
              onImport={() => fileInput.current?.click()}
              onRetry={() => void call("retry_lyrics")}
            >
              <div
                className="lyrics-toolbar"
                role="toolbar"
                aria-label="Lyrics"
              >
                {(
                  [
                    ["romanized", "Romanization", Languages],
                    [
                      "experimental_word_sync",
                      "Experimental word sync",
                      AudioLines,
                    ],
                    ["lyrics_compact", "Compact lyrics", Rows3],
                    ["lyrics_hide_artwork", "Hide artwork", PanelLeftClose],
                    [
                      "lyrics_artwork_right",
                      "Artwork on the right",
                      ArrowLeftRight,
                    ],
                  ] as const
                ).map(([key, label, Icon]) => {
                  const on = !!state.settings[key];
                  return (
                    <button
                      key={key}
                      className={`icon-button ${on ? "active" : ""}`}
                      title={label}
                      aria-pressed={on}
                      onClick={() => updateSettings({ [key]: !on })}
                    >
                      <Icon size={18} />
                    </button>
                  );
                })}
                <span className="toolbar-divider" aria-hidden="true" />
                <button
                  className="icon-button"
                  title="Import lyrics"
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload size={18} />
                </button>
                <button
                  className="icon-button"
                  title="Retry lyrics"
                  onClick={() => void call("retry_lyrics")}
                >
                  <RefreshCw size={18} />
                </button>
                <button
                  className="icon-button"
                  title="Full screen"
                  onClick={() => void fullscreen()}
                >
                  <Maximize2 size={18} />
                </button>
                <button
                  className="icon-button"
                  title="Lyrics settings"
                  onClick={() => {
                    if (immersive) void fullscreen(false);
                    setCenter("settings");
                  }}
                >
                  <SettingsIcon size={18} />
                </button>
              </div>
            </LyricsPage>
          ) : center === "settings" ? (
            <SettingsPage
              state={state}
              onSettings={updateSettings}
              onCall={call}
              onNotice={notify}
            />
          ) : center === "profile" ? (
            <ProfilePage
              profile={state.profile}
              playlists={state.playlists}
              onPlaylist={(playlist) => navigate(`playlist:${playlist.id}`)}
              onRecents={() => navigate("recent")}
              onOpen={(url) => void call("open_link", { url })}
            />
          ) : state.route === "recent" ? (
            <div className="browse-scroll" ref={mainScroll}>
              <RecentsPage
                tracks={state.tracks}
                playlists={state.playlists}
                loading={state.loading}
                onOpen={(route) => navigate(route)}
                onPlay={playTrack}
              />
            </div>
          ) : state.route.startsWith("search:") ? (
            <div className="browse-scroll search-scroll" ref={mainScroll}>
              <SearchPage
                key={state.route}
                state={state}
                navigate={homeNavigate}
                play={homePlay}
                playTrack={playTrack}
                openArtist={openArtist}
                openAlbum={openAlbum}
                save={save}
                follow={follow}
                retry={() => navigate(state.route, false)}
                remember={(entry: SearchEntry) =>
                  updateRecentSearches((list) => rememberSearch(list, entry))
                }
              />
            </div>
          ) : (
            <div className="browse-scroll" ref={mainScroll}>
              {state.route === "home" ? (
                <HomePage
                  data={state.home}
                  playlists={state.playlists}
                  loading={state.home_loading}
                  error={state.home_error}
                  ready={state.native_ready}
                  navigate={homeNavigate}
                  play={homePlay}
                  dj={startDJ}
                  refresh={refreshHome}
                />
              ) : (
                <div
                  className={`entity-header ${entity?.artist ? "artist-header" : ""}`}
                  style={{ "--hero": heroColor } as CSSProperties}
                >
                  <section
                    className={`page-hero ${state.route.startsWith("artist:") ? "artist-hero" : ""}`}
                    style={
                      state.route.startsWith("artist:") && artistBanner
                        ? {
                            backgroundImage: `linear-gradient(0deg,#000c,#0000 65%),url("${artistBanner}")`,
                          }
                        : undefined
                    }
                  >
                    {state.route === "liked" ? (
                      <div className="liked-cover hero-cover">
                        <Heart size={84} fill="currentColor" />
                      </div>
                    ) : (
                      (!!entity?.images.length || !!playlist?.images.length) &&
                      !entity?.artist && (
                        <Cover
                          images={heroImages}
                          className="hero-cover"
                          contextRoute={state.route}
                          contextName={title}
                        />
                      )
                    )}
                    <div className="hero-copy">
                      {entity?.overview?.verified ? (
                        <p className="artist-verified">
                          <BadgeCheck size={22} /> Verified Artist
                        </p>
                      ) : (
                        <span className="eyebrow">
                          {state.route.startsWith("artist:")
                            ? "Artist"
                            : state.route.startsWith("album:")
                              ? entity?.album?.album_type || "Album"
                              : state.route.startsWith("search:")
                                ? "Search"
                                : state.route === "queue"
                                  ? "Up next"
                                  : "Playlist"}
                        </span>
                      )}
                      <h1 className={title.length > 28 ? "long-title" : ""}>
                        <span
                          data-context-route={state.route}
                          data-context-name={title}
                        >
                          {title}
                        </span>
                      </h1>
                      {entity?.overview?.monthly_listeners != null && (
                        <p className="artist-monthly">
                          {entity.overview.monthly_listeners.toLocaleString()}{" "}
                          monthly listeners
                        </p>
                      )}
                      {state.route.startsWith("playlist:") &&
                        entity?.subtitle &&
                        entity.subtitle !== playlistInfo?.owner && (
                          <p className="hero-description">
                            <SpotifyText
                              text={entity.subtitle}
                              navigate={homeNavigate}
                            />
                          </p>
                        )}
                      {!entity?.artist && (
                        <p
                          className={`hero-meta ${entity?.album ? "" : "playlist-meta"}`}
                        >
                          {entity?.album ? (
                            <strong>
                              <ArtistLinks
                                artists={entity.album.artists || []}
                                onArtist={openArtist}
                              />
                            </strong>
                          ) : (
                            <>
                              {(state.route === "liked" ||
                                ownerId === state.profile?.id) &&
                                profileImage && (
                                  <img
                                    className="hero-owner"
                                    src={profileImage}
                                    alt=""
                                  />
                                )}
                              <strong>
                                {personalizedMix
                                  ? `Made for ${profileName}`
                                  : ownerName}
                              </strong>
                            </>
                          )}
                          {entity?.album?.release_date && (
                            <span>{entity.album.release_date.slice(0, 4)}</span>
                          )}
                          {heroSongCount != null && (
                            <span>
                              {heroSongCount} songs
                              {heroDuration != null &&
                                `, ${longDuration(heroDuration)}`}
                            </span>
                          )}
                        </p>
                      )}
                    </div>
                  </section>
                  {!state.route.startsWith("search:") && (
                    <div className="browse-actions">
                      <button
                        className="primary-play"
                        title={`Play ${title}`}
                        onClick={() => {
                          if (state.route.startsWith("artist:"))
                            play({
                              command: "play_context",
                              context: `spotify:${state.route}`,
                            });
                          else if (state.tracks[0])
                            playTrack(state.tracks[0], 0);
                        }}
                      >
                        <Play fill="currentColor" size={24} />
                      </button>
                      <button
                        className={`icon-button action-icon ${state.playback.shuffle_state ? "active" : ""}`}
                        title={
                          state.playback.shuffle_state
                            ? "Turn off shuffle"
                            : "Turn on shuffle"
                        }
                        onClick={() =>
                          play({
                            command: "shuffle",
                            enabled: !state.playback.shuffle_state,
                          })
                        }
                      >
                        <Shuffle size={28} />
                      </button>
                      {entity?.artist && (
                        <button
                          className="pill outline"
                          onClick={() => follow(entity.artist!)}
                        >
                          Follow
                        </button>
                      )}
                      <button
                        className="icon-button action-icon"
                        title="Refresh page"
                        onClick={() => navigate(state.route, false)}
                      >
                        <RefreshCw size={22} />
                      </button>
                      {collection && (
                        <div className="song-filters">
                          <small aria-live="polite">
                            {filtering
                              ? `${displayTracks.length} songs${state.more ? " · loading the rest…" : ""}`
                              : ""}
                          </small>
                          {songSearch || songQuery ? (
                            <label className="playlist-search">
                              <Search size={16} />
                              <input
                                autoFocus
                                aria-label="Search songs in this playlist"
                                placeholder="Search in playlist"
                                value={songQuery}
                                onChange={(event) =>
                                  setSongQuery(event.target.value)
                                }
                                onBlur={() => setSongSearch(false)}
                                onKeyDown={(event) => {
                                  if (event.key === "Escape") {
                                    setSongQuery("");
                                    setSongSearch(false);
                                  }
                                }}
                              />
                            </label>
                          ) : (
                            <button
                              className="icon-button"
                              title="Search in playlist"
                              onClick={() => setSongSearch(true)}
                            >
                              <Search size={18} />
                            </button>
                          )}
                          <SongSortMenu
                            sort={songSort}
                            genre={songGenre}
                            age={songAge}
                            genres={songGenres}
                            onSort={setSongSort}
                            onGenre={setSongGenre}
                            onAge={setSongAge}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {selected.size > 0 && (
                <div className="selection-bar">
                  <span>{selected.size} selected</span>
                  <button
                    className="pill"
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      setPicker({
                        tracks: displayTracks.filter((track) =>
                          selected.has(track.uri),
                        ),
                        x: rect.left,
                        y: rect.bottom + 6,
                      });
                    }}
                  >
                    <Plus size={15} />
                    Add to playlist
                  </button>
                  <button
                    className="text-link"
                    onClick={() => setSelected(new Set())}
                  >
                    Clear
                  </button>
                </div>
              )}
              <div className={entity?.artist ? "artist-top" : "track-section"}>
                <section>
                  {entity?.artist && displayTracks.length > 0 && (
                    <div className="browse-section-title">
                      <h2>Popular</h2>
                    </div>
                  )}
                  {showTrackList && (
                    <>
                      <div
                        className={`track-table ${collectionPlays ? "collection-table" : ""} ${entity?.album ? "album-table" : ""}`}
                      >
                        <div className="track-table-head">
                          <span>#</span>
                          <span>Title</span>
                          <span>
                            {entity?.artist
                              ? "Streams"
                              : entity?.album
                                ? "Plays"
                                : "Album"}
                          </span>
                          {collectionPlays && <span>Plays</span>}
                          <span>
                            <Clock3 size={16} />
                          </span>
                        </div>
                        {(entity?.artist && !popularMore
                          ? displayTracks.slice(0, 5)
                          : displayTracks
                        ).map((track, index) => {
                          const current =
                            track.uri === state.playback.item?.uri;
                          return (
                            <div
                              className={`track-row ${current ? "playing" : ""} ${selected.has(track.uri) ? "selected" : ""}`}
                              key={`${track.uri}-${index}`}
                              onClick={(event) =>
                                select(
                                  track,
                                  event.ctrlKey ||
                                    event.metaKey ||
                                    event.shiftKey,
                                )
                              }
                              onDoubleClick={() => playTrack(track, index)}
                              onMouseEnter={() => prefetchCanvas(track.uri)}
                              onContextMenu={(event) => {
                                // Anywhere on the row opens the song menu;
                                // artist and album links keep their own menus.
                                const link = (
                                  event.target as HTMLElement
                                ).closest<HTMLElement>("[data-context-route]");
                                if (
                                  link &&
                                  !link.dataset.contextRoute?.startsWith(
                                    "track:",
                                  )
                                )
                                  return;
                                event.preventDefault();
                                setEntityMenu(null);
                                setSongMenu({
                                  track,
                                  fromList: true,
                                  x: event.clientX,
                                  y: event.clientY,
                                });
                              }}
                            >
                              <div className="track-number">
                                <span>
                                  {current && state.playback.is_playing ? (
                                    <span className="equalizer">
                                      <i />
                                      <i />
                                      <i />
                                    </span>
                                  ) : (
                                    index + 1
                                  )}
                                </span>
                                <button
                                  className="row-play"
                                  title={
                                    current && state.playback.is_playing
                                      ? "Pause"
                                      : "Play"
                                  }
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    if (current && state.playback.is_playing)
                                      play({ command: "pause" });
                                    else playTrack(track, index);
                                  }}
                                >
                                  {current && state.playback.is_playing ? (
                                    <Pause size={17} fill="currentColor" />
                                  ) : (
                                    <Play size={17} fill="currentColor" />
                                  )}
                                </button>
                              </div>
                              <div className="track-cell">
                                <Cover
                                  images={
                                    track.album.images.length
                                      ? track.album.images
                                      : entity?.album?.images
                                  }
                                />
                                <div>
                                  <button
                                    className="text-link track-name"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      playTrack(track, index);
                                    }}
                                  >
                                    {track.name}
                                  </button>
                                  <div className="track-artists">
                                    <ExplicitBadge track={track} />
                                    <ArtistLinks
                                      artists={track.artists}
                                      onArtist={openArtist}
                                    />
                                  </div>
                                </div>
                              </div>
                              {entity?.album ? (
                                <span
                                  className="track-streams"
                                  title="Spotify play count"
                                >
                                  {entity.album_details?.streams[
                                    track.uri
                                  ]?.toLocaleString() ?? "—"}
                                </span>
                              ) : (
                                <button
                                  className="text-link album-link"
                                  data-context-route={
                                    (entity?.album || track.album).id
                                      ? `album:${(entity?.album || track.album).id}`
                                      : (
                                          entity?.album || track.album
                                        ).uri?.replace("spotify:", "")
                                  }
                                  data-context-name={
                                    (entity?.album || track.album).name
                                  }
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    openAlbum(entity?.album || track.album);
                                  }}
                                >
                                  {entity?.artist
                                    ? entity.overview?.popular[
                                        index
                                      ].streams?.toLocaleString()
                                    : track.album.name || entity?.album?.name}
                                </button>
                              )}
                              {collectionPlays && (
                                <span
                                  className="track-streams"
                                  title={
                                    state.facts[track.uri]?.plays == null
                                      ? "Spotify play count unavailable"
                                      : "Spotify play count"
                                  }
                                >
                                  {state.facts[
                                    track.uri
                                  ]?.plays?.toLocaleString() ?? "—"}
                                </span>
                              )}
                              <div className="row-end">
                                <span>
                                  {track.duration_ms > 0
                                    ? formatTime(track.duration_ms)
                                    : ""}
                                </span>
                                <button
                                  className="icon-button"
                                  title="Song options"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setSongMenu({
                                      track,
                                      fromList: true,
                                      x: event.clientX - 160,
                                      y: event.clientY,
                                    });
                                  }}
                                >
                                  <MoreHorizontal size={19} />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {entity?.artist && displayTracks.length > 5 && (
                        <button
                          className="text-link see-more"
                          onClick={() => setPopularMore(!popularMore)}
                        >
                          {popularMore ? "Show less" : "See more"}
                        </button>
                      )}
                    </>
                  )}
                </section>
                {entity?.artist && (
                  <aside className="artist-liked">
                    <h2>You Liked</h2>
                    <div>
                      <div className="liked-artist-image">
                        <Cover images={entity.images} />
                        {displayTracks.some(
                          (track) => state.saved[track.uri],
                        ) && (
                          <Heart
                            className="liked-heart"
                            fill="currentColor"
                            size={25}
                          />
                        )}
                      </div>
                      <span>
                        {displayTracks.filter((track) => state.saved[track.uri])
                          .length > 0 ? (
                          <>
                            <strong>
                              {
                                displayTracks.filter(
                                  (track) => state.saved[track.uri],
                                ).length
                              }{" "}
                              song
                              {displayTracks.filter(
                                (track) => state.saved[track.uri],
                              ).length === 1
                                ? ""
                                : "s"}
                            </strong>
                            <button
                              className="text-link"
                              onClick={() =>
                                setSelected(
                                  new Set(
                                    displayTracks
                                      .filter((track) => state.saved[track.uri])
                                      .map((track) => track.uri),
                                  ),
                                )
                              }
                            >
                              By {entity.artist.name}
                            </button>
                          </>
                        ) : (
                          <>
                            <strong>Your saved songs</strong>
                            <button
                              className="text-link"
                              onClick={() => navigate("liked")}
                            >
                              Open Liked Songs
                            </button>
                          </>
                        )}
                      </span>
                    </div>
                  </aside>
                )}
              </div>
              {entity?.album && (
                <section className="album-release-details">
                  <p>
                    {entity.album.release_date?.length === 10
                      ? new Date(
                          `${entity.album.release_date}T00:00:00`,
                        ).toLocaleDateString(undefined, {
                          year: "numeric",
                          month: "long",
                          day: "numeric",
                        })
                      : entity.album.release_date}
                  </p>
                  {(entity.album.copyrights?.length
                    ? entity.album.copyrights
                    : entity.album_details?.copyrights || []
                  ).map((credit, index) => (
                    <small key={index}>{credit.text}</small>
                  ))}
                </section>
              )}
              {(entity?.artist || !!entity?.album_details?.more?.length) && (
                <>
                  <div className="browse-section-title">
                    <h2>
                      {entity?.artist
                        ? "Discography"
                        : `More by ${entity?.album?.artists?.[0]?.name ?? "this artist"}`}
                    </h2>
                    <button
                      className="text-link muted"
                      onClick={() => setAllAlbums(!allAlbums)}
                    >
                      {allAlbums ? "Show less" : "Show all"}
                    </button>
                  </div>
                  <div className="discography-filters">
                    {[
                      ["all", "Popular releases"],
                      ["album", "Albums"],
                      ["single", "Singles and EPs"],
                    ].map(([value, label]) => (
                      <button
                        key={value}
                        className={`pill ${albumFilter === value ? "active" : ""}`}
                        onClick={() => setAlbumFilter(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="album-grid">
                    {(entity?.artist
                      ? entity.albums
                      : entity?.album_details?.more || []
                    )
                      .filter(
                        (album) =>
                          albumFilter === "all" ||
                          album.album_type === albumFilter,
                      )
                      .slice(0, allAlbums ? undefined : 10)
                      .map((album) => (
                        <button
                          key={album.id}
                          className="album-tile"
                          onClick={() => openAlbum(album)}
                          {...prefetchOn(`album:${album.id}`)}
                        >
                          <Cover images={album.images} />
                          <strong>{album.name}</strong>
                          <small>
                            {album.release_date?.slice(0, 4)} ·{" "}
                            {album.album_type || "Album"}
                          </small>
                        </button>
                      ))}
                  </div>
                </>
              )}
              {entity?.overview && (
                <section className="artist-about">
                  <h2>About {entity.artist?.name}</h2>
                  <div className="artist-stats">
                    {entity.overview.monthly_listeners != null && (
                      <span>
                        <strong>
                          {entity.overview.monthly_listeners.toLocaleString()}
                        </strong>
                        Monthly listeners
                      </span>
                    )}
                    {entity.overview.followers != null && (
                      <span>
                        <strong>
                          {entity.overview.followers.toLocaleString()}
                        </strong>
                        Followers
                      </span>
                    )}
                  </div>
                  {entity.overview.biography && (
                    <p>{entity.overview.biography}</p>
                  )}
                  <button
                    className="text-link muted"
                    onClick={() =>
                      void call("open_link", {
                        url: entity.overview!.source_url,
                      })
                    }
                  >
                    Source: Spotify · Updated{" "}
                    {new Date(
                      entity.overview.fetched_at * 1000,
                    ).toLocaleString()}
                  </button>
                </section>
              )}
              {state.route.startsWith("artist:") && !entity?.overview && (
                <div className="artist-loading" role="status">
                  <LoaderCircle className="spin" size={18} />
                  Loading artist details…
                </div>
              )}
              {state.loading &&
                !state.tracks.length &&
                !state.route.startsWith("artist:") && (
                  <div
                    className="skeleton-rows"
                    role="status"
                    aria-label={
                      state.route.startsWith("search:")
                        ? "Searching Spotify"
                        : "Loading"
                    }
                  >
                    {Array.from({ length: 8 }, (_, index) => (
                      <div className="skeleton-row" key={index}>
                        <i />
                        <i />
                        <div>
                          <i />
                          <i />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              {!state.loading && state.pageError && (
                <div className="empty-page">
                  <h2>Couldn’t load this page</h2>
                  <p>{state.pageError}</p>
                  <button
                    className="pill"
                    onClick={() => navigate(state.route, false)}
                  >
                    Try again
                  </button>
                </div>
              )}
              {state.route !== "home" &&
                !state.route.startsWith("artist:") &&
                !state.loading &&
                !state.pageError &&
                !state.tracks.length &&
                (!state.route.startsWith("search:") ||
                  (!state.search_playlists_loading &&
                    !state.search_playlists.length)) &&
                !entity?.artist && (
                  <div className="empty-page">
                    <Search size={32} />
                    <h2>
                      {state.route.startsWith("search:")
                        ? "No songs found"
                        : "Nothing here yet"}
                    </h2>
                    <p>
                      {state.route.startsWith("search:")
                        ? "Try another song, album or artist name."
                        : "Choose something from your library."}
                    </p>
                  </div>
                )}
              <div
                ref={pageSentinel}
                className="page-sentinel"
                aria-hidden="true"
              />
            </div>
          )}
        </main>
        {sidebar && (
          <>
            <div className="panel-resizer" onPointerDown={resizeRight} />
            {panel === "queue" ? (
              <QueuePanel
                state={state}
                onPlayer={play}
                onClose={() => setPanel("now")}
              />
            ) : (
              <NowPlaying
                state={state}
                onPlayer={play}
                onAlbum={openAlbum}
                onArtist={openArtist}
                onLyrics={() => setCenter("lyrics")}
                onQueue={() => setPanel("queue")}
                onFollow={follow}
                onSave={save}
                showLyricsPreview={center !== "lyrics"}
              />
            )}
          </>
        )}
      </div>
      {state.creator_profile_open && (
        // The profile sheet is a separate window; clicking here moves focus
        // back to this window, which closes it.
        <div className="creator-profile-dim" aria-hidden="true" />
      )}
      {djRequest && state.profile && state.native_ready && (
        <DJRequest
          key={state.profile.id}
          account={state.profile.id}
          onClose={() => setDJRequest(false)}
          onSuccess={(transcript) =>
            notify(transcript ? `DJ heard: “${transcript}”` : "DJ request sent")
          }
        />
      )}
      <PlayerBar
        state={state}
        onPlayer={play}
        onDJRequest={() => setDJRequest(true)}
        onToggle={toggle}
        onAlbum={openAlbum}
        onArtist={openArtist}
        onSave={save}
        onLyrics={() => setCenter(center === "lyrics" ? "browse" : "lyrics")}
        onQueue={toggleQueue}
        onDevices={() => {
          setDeviceMenu(!deviceMenu);
          if (!deviceMenu) void call("refresh");
        }}
        onSidebar={() => {
          if (sidebar && panel === "queue") setPanel("now");
          else {
            setSidebar(!sidebar);
            setPanel("now");
          }
        }}
        onFullscreen={() => void fullscreen()}
        lyricsActive={center === "lyrics"}
        queueActive={sidebar && panel === "queue"}
        sidebarActive={sidebar && panel === "now"}
      />
      {deviceMenu && (
        <div className="device-menu popover">
          <h3>Connect to a device</h3>
          <button
            className={target === "native" ? "selected" : ""}
            onClick={() => {
              if (target !== "native")
                void call("player", {
                  request: { command: "transfer", uri: "native" },
                  target: "native",
                });
              setTarget("native");
              setDeviceMenu(false);
            }}
          >
            <Speaker size={21} />
            <div>
              <strong>This computer</strong>
              <small>
                {state.native_ready
                  ? "Ready for native playback"
                  : state.native_status}
              </small>
            </div>
            {target === "native" && <Check size={18} />}
          </button>
          {state.devices
            .filter((device) => device.name !== state.local_device_name)
            .map((device) => (
              <button
                key={device.id}
                className={target === device.id ? "selected" : ""}
                onClick={() => {
                  setTarget(device.id || "native");
                  setDeviceMenu(false);
                  if (device.id)
                    void call("player", {
                      request: { command: "transfer", uri: device.id },
                      target: device.id,
                    });
                }}
              >
                <Speaker size={20} />
                <div>
                  <strong>{device.name}</strong>
                  <small>
                    {device.is_active ? "Active device" : "Spotify Connect"}
                  </small>
                </div>
              </button>
            ))}
        </div>
      )}
      {songMenu && (
        <>
          <div
            className="popover-dismiss"
            onClick={() => {
              setSongMenu(null);
              setPicker(null);
            }}
          />
          <div
            className="song-menu popover"
            role="menu"
            aria-label="Song actions"
            style={{
              left: Math.min(songMenu.x, window.innerWidth - 240),
              top: Math.max(8, Math.min(songMenu.y, window.innerHeight - 320)),
            }}
          >
            {[
              [
                "Play",
                Play,
                () =>
                  songMenu.fromList
                    ? playTrack(songMenu.track)
                    : play({
                        command: "play",
                        uri: songMenu.track.uri,
                        track: songMenu.track,
                      }),
              ],
              [
                state.saved[songMenu.track.uri]
                  ? "Remove from Liked Songs"
                  : "Save to Liked Songs",
                Heart,
                () => save(songMenu.track),
              ],
              [
                "Add to queue",
                ListMusic,
                () => play({ command: "enqueue", uri: songMenu.track.uri }),
              ],
              ["Add to playlist", Plus, () => {}],
              ["Open album", Music2, () => openAlbum(songMenu.track.album)],
              [
                "Go to artist",
                Music2,
                () => {
                  const artist = songMenu.track.artists[0];
                  if (artist) openArtist(artist);
                },
              ],
              [
                "Copy clean link",
                Copy,
                () => {
                  void navigator.clipboard
                    .writeText(
                      `https://open.spotify.com/track/${songMenu.track.id}`,
                    )
                    .then(() => notify("Song link copied."))
                    .catch(() => notify("Could not copy the link.", true));
                },
              ],
            ].map(([label, Icon, action]) => {
              const ItemIcon = Icon as typeof Play;
              // Add to playlist opens a flyout beside the menu, like Spotify.
              const submenu = label === "Add to playlist";
              const openFlyout = (button: HTMLElement) => {
                const rect = button.getBoundingClientRect(),
                  right = rect.right + 300 + 8 <= window.innerWidth;
                setPicker({
                  tracks: [songMenu.track],
                  x: right ? rect.right + 4 : rect.left - 304,
                  y: rect.top - 8,
                });
              };
              return (
                <button
                  key={String(label)}
                  role="menuitem"
                  aria-haspopup={submenu ? "menu" : undefined}
                  aria-expanded={submenu ? !!picker : undefined}
                  className={submenu && picker ? "active" : undefined}
                  onMouseEnter={(event) =>
                    submenu ? openFlyout(event.currentTarget) : setPicker(null)
                  }
                  onClick={(event) => {
                    if (submenu) return openFlyout(event.currentTarget);
                    (action as () => void)();
                    setSongMenu(null);
                  }}
                >
                  <ItemIcon size={17} />
                  {String(label)}
                  {submenu && <ChevronRight size={17} className="menu-chevron" />}
                </button>
              );
            })}
          </div>
        </>
      )}
      {entityMenu &&
        (() => {
          const menu = entityMenu,
            current = stateRef.current;
          const playlist =
            menu.kind === "playlist"
              ? libraryItems(current).find((item) => item.id === menu.id) ||
                playlistForManualPlay(current, {
                  command: "play_home",
                  context: `spotify:playlist:${menu.id}`,
                }) || {
                  id: menu.id,
                  name: menu.name,
                  images: [],
                  owner: { id: "" },
                  collaborative: false,
                }
              : undefined;
          const actions: { label: string; run: () => void }[] = [];
          if (menu.kind === "liked")
            actions.push({
              label: "Open Liked Songs",
              run: () => navigate("liked"),
            });
          else {
            actions.push({
              label: `Go to ${menu.kind}`,
              run: () =>
                menu.id === DJ_ID
                  ? play({ command: "dj" })
                  : navigate(`${menu.kind}:${menu.id}`),
            });
            actions.push({
              label: "Play",
              run: () =>
                play(
                  menu.id === DJ_ID
                    ? { command: "dj" }
                    : {
                        command: "play_home",
                        context: `spotify:${menu.kind}:${menu.id}`,
                      },
                ),
            });
            if (playlist)
              actions.push({
                label: accountOrder(current).pinned.includes(playlist.id)
                  ? "Unpin playlist"
                  : "Pin playlist",
                run: () => togglePin(playlist),
              });
            if (menu.kind === "artist")
              actions.push({
                label: current.saved[`spotify:artist:${menu.id}`]
                  ? "Unfollow artist"
                  : "Follow artist",
                run: () =>
                  follow({
                    id: menu.id,
                    name: menu.name,
                    uri: `spotify:artist:${menu.id}`,
                  }),
              });
            actions.push({
              label: `Copy link to ${menu.kind}`,
              run: () => {
                void navigator.clipboard
                  .writeText(`https://open.spotify.com/${menu.kind}/${menu.id}`)
                  .then(() => notify("Link copied."))
                  .catch(() => notify("Could not copy the link.", true));
              },
            });
          }
          return (
            <>
              <div
                className="popover-dismiss"
                onClick={() => setEntityMenu(null)}
              />
              <div
                role="menu"
                aria-label={`${menu.kind} actions`}
                className="song-menu popover entity-menu"
                style={{
                  left: Math.max(8, Math.min(menu.x, window.innerWidth - 250)),
                  top: Math.max(8, Math.min(menu.y, window.innerHeight - 280)),
                }}
                onKeyDown={(event) => {
                  if (
                    !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
                  )
                    return;
                  event.preventDefault();
                  const buttons = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      "button",
                    ),
                  );
                  const index = buttons.indexOf(
                    document.activeElement as HTMLButtonElement,
                  );
                  buttons[
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? buttons.length - 1
                        : (index +
                            (event.key === "ArrowDown" ? 1 : -1) +
                            buttons.length) %
                          buttons.length
                  ]?.focus();
                }}
              >
                {actions.map((action) => (
                  <button
                    role="menuitem"
                    key={action.label}
                    onClick={() => {
                      action.run();
                      setEntityMenu(null);
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            </>
          );
        })()}
      {picker && (
        <>
          {!songMenu && (
            <div
              className="popover-dismiss"
              onClick={() => setPicker(null)}
            />
          )}
          <PlaylistFlyout
            key={`${picker.x}:${picker.y}`}
            x={picker.x}
            y={picker.y}
            playlists={state.playlists.filter(
              (playlist) =>
                playlist.owner.id === state.profile?.id ||
                playlist.collaborative,
            )}
            onPick={(playlist) => {
              void call("add_tracks", { playlist, tracks: picker.tracks });
              setPicker(null);
              setSongMenu(null);
            }}
            onCreate={() => {
              const own = state.playlists.filter(
                (playlist) => playlist.owner.id === state.profile?.id,
              ).length;
              void call("create_playlist", {
                name:
                  picker.tracks.length === 1
                    ? picker.tracks[0].name
                    : `My Playlist #${own + 1}`,
                tracks: picker.tracks,
              });
              setPicker(null);
              setSongMenu(null);
            }}
          />
        </>
      )}
      {folderDialog && (
        <div className="modal-backdrop" onClick={() => setFolderDialog(false)}>
          <section
            className="dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <h2>Create a folder</h2>
            <p>Organize playlists in SpotiFlex.</p>
            <input
              className="field"
              placeholder="Folder name"
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              autoFocus
            />
            <div className="inline-actions">
              <button className="pill" onClick={() => setFolderDialog(false)}>
                Cancel
              </button>
              <button
                className="pill primary"
                disabled={!folderName.trim()}
                onClick={() => {
                  updateSettings({
                    folders: [
                      ...state.settings.folders,
                      {
                        name: folderName.trim(),
                        playlist_ids: selected.size
                          ? state.playlists
                              .filter(
                                (playlist) =>
                                  playlist.id === state.route.slice(9),
                              )
                              .map((playlist) => playlist.id)
                          : [],
                        show_in_picker: true,
                      },
                    ],
                  });
                  setFolderName("");
                  setFolderDialog(false);
                }}
              >
                Create folder
              </button>
            </div>
          </section>
        </div>
      )}
      {sessionScreen(state) === "restoring" && (
        <div
          className="startup-screen"
          role="status"
          aria-label="Restoring session"
        >
          <LoaderCircle className="spin" size={28} />
          <strong>SpotiFlex</strong>
          <span>Restoring session…</span>
        </div>
      )}
      {sessionScreen(state) === "setup" && (
        <Setup
          state={state}
          onSignIn={(clientId) => {
            dispatch({ type: "login_pending" });
            void rpc("sign_in", { clientId }).catch((error) =>
              dispatch({
                type: "login_failed",
                issue: { message: String(error), retry_saved: false },
              }),
            );
          }}
          onRetry={() => {
            dispatch({ type: "login_pending", restoring: true });
            void rpc("retry_sign_in").catch((error) =>
              dispatch({
                type: "login_failed",
                issue: { message: String(error), retry_saved: true },
              }),
            );
          }}
          onCancel={() => void call("cancel_sign_in")}
          onOpenDashboard={() =>
            void call("open_link", {
              url: "https://developer.spotify.com/dashboard",
            })
          }
        />
      )}
      {state.toast && (
        <div
          className={`toast ${state.toast.error ? "error" : ""}`}
          role="status"
        >
          <span>{state.toast.message}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => dispatch({ type: "toast_clear" })}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <input
        className="file-input"
        type="file"
        accept=".ttml,.xml,.lrc"
        ref={fileInput}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importFile(file);
          event.target.value = "";
        }}
      />
    </div>
  );
}

function PlayerBar({
  state,
  onPlayer,
  onDJRequest,
  onToggle,
  onAlbum,
  onArtist,
  onSave,
  onLyrics,
  onQueue,
  onDevices,
  onSidebar,
  onFullscreen,
  lyricsActive,
  sidebarActive,
  queueActive,
}: {
  state: AppState;
  onPlayer: (request: PlayerRequest) => void;
  onDJRequest: () => void;
  onToggle: () => void;
  onAlbum: (album: Album) => void;
  onArtist: (artist: Artist) => void;
  onSave: (track: Track) => void;
  onLyrics: () => void;
  onQueue: () => void;
  onDevices: () => void;
  onSidebar: () => void;
  onFullscreen: () => void;
  lyricsActive: boolean;
  sidebarActive: boolean;
  queueActive: boolean;
}) {
  const current = usePosition(state),
    track = state.playback.item;
  const [seeking, setSeeking] = useState<number | null>(null),
    [volume, setVolume] = useState(70);
  const volumeCallback = useRef(onPlayer);
  volumeCallback.current = onPlayer;
  const volumeControl = useMemo(
    () =>
      new VolumeControl(
        (value) => volumeCallback.current({ command: "volume", volume: value }),
        setVolume,
      ),
    [],
  );
  useEffect(() => () => volumeControl.dispose(), [volumeControl]);
  const saved = track && state.saved[track.uri];
  useEffect(() => {
    volumeControl.observe(
      state.playback.device.volume_percent,
      state.playback.device.id ?? state.playback.device.name,
    );
  }, [
    state.playback.device.volume_percent,
    state.playback.device.id,
    state.playback.device.name,
    volumeControl,
  ]);
  const seek = () => {
    if (seeking !== null) {
      onPlayer({ command: "seek", positionMs: seeking });
      setSeeking(null);
    }
  };
  useEffect(() => setSeeking(null), [track?.uri]);
  return (
    <footer className="player-bar" inert={!state.profile}>
      <div className="player-song">
        {state.narrating ? (
          <DJPresentation playing={state.playback.is_playing} />
        ) : track ? (
          <>
            <Cover
              images={track.album.images}
              contextRoute={
                track.album.id
                  ? `album:${track.album.id}`
                  : track.album.uri?.replace("spotify:", "")
              }
              contextName={track.album.name}
              onClick={() => onAlbum(track.album)}
            />
            <div>
              <TrackTitle
                track={track}
                onAlbum={onAlbum}
                reduceMotion={state.settings.reduce_motion}
              />
              <Marquee
                text={artistNames(track)}
                reduceMotion={state.settings.reduce_motion}
              >
                <ExplicitBadge track={track} />
                <ArtistLinks artists={track.artists} onArtist={onArtist} />
              </Marquee>
            </div>
            <button
              className={`icon-button ${saved ? "is-saved" : ""}`}
              title="Save to Liked Songs"
              onClick={() => onSave(track)}
            >
              {saved ? (
                <CircleCheck size={20} fill="currentColor" stroke="#000" />
              ) : (
                <CirclePlus size={20} />
              )}
            </button>
          </>
        ) : (
          <div className="player-placeholder">
            Make room for your next favourite.
          </div>
        )}
      </div>
      <div className="player-transport">
        <div className="transport-buttons">
          <button
            className={`icon-button ${state.playback.shuffle_state ? "active" : ""}`}
            title="Shuffle"
            onClick={() =>
              onPlayer({
                command: "shuffle",
                enabled: !state.playback.shuffle_state,
              })
            }
          >
            <Shuffle size={22} />
          </button>
          <button
            className="icon-button"
            title="Previous song"
            onClick={() => onPlayer({ command: "previous" })}
          >
            <SkipBack size={23} fill="currentColor" />
          </button>
          <button
            className="play-toggle"
            aria-label={state.playback.is_playing ? "Pause" : "Play"}
            title="Play / pause · Space"
            onClick={onToggle}
            disabled={!track}
          >
            {state.pending ? (
              <LoaderCircle className="spin" size={22} />
            ) : state.playback.is_playing ? (
              <Pause size={22} fill="currentColor" />
            ) : (
              <Play size={22} fill="currentColor" />
            )}
          </button>
          <button
            className="icon-button"
            title="Next song"
            onClick={() => onPlayer({ command: "next" })}
          >
            <SkipForward size={23} fill="currentColor" />
          </button>
          <button
            className={`icon-button ${state.playback.repeat_state !== "off" && state.playback.repeat_state ? "active" : ""}`}
            title="Repeat"
            onClick={() =>
              onPlayer({
                command: "repeat",
                repeat:
                  state.playback.repeat_state === "off" ||
                  !state.playback.repeat_state
                    ? "context"
                    : state.playback.repeat_state === "context"
                      ? "track"
                      : "off",
              })
            }
          >
            {state.playback.repeat_state === "track" ? (
              <Repeat1 size={22} />
            ) : (
              <Repeat size={22} />
            )}
          </button>
        </div>
        <div className="seek-row">
          <time>{formatTime(seeking ?? current)}</time>
          <input
            aria-label="Seek position"
            type="range"
            min="0"
            max={track?.duration_ms || 1}
            value={seeking ?? current}
            style={
              {
                "--range": `${((seeking ?? current) / Math.max(1, track?.duration_ms || 1)) * 100}%`,
              } as CSSProperties
            }
            onChange={(event) => setSeeking(Number(event.target.value))}
            onPointerDown={(event) =>
              event.currentTarget.setPointerCapture(event.pointerId)
            }
            onPointerUp={seek}
            onKeyUp={seek}
            onPointerCancel={() => setSeeking(null)}
            onLostPointerCapture={() => setSeeking(null)}
            onBlur={seek}
          />
          <time>{formatTime(track?.duration_ms || 0)}</time>
        </div>
      </div>
      <div className="player-extras">
        {(state.dj_context || state.narrating || state.dj_pending) && (
          <DJButton
            onRefresh={() => onPlayer({ command: "dj" })}
            onHold={onDJRequest}
          />
        )}
        <button
          className={`icon-button ${lyricsActive ? "active" : ""}`}
          title="Lyrics"
          onClick={onLyrics}
        >
          <Mic2 size={20} />
        </button>
        <button
          className={`icon-button ${queueActive ? "active" : ""}`}
          title="Queue"
          onClick={onQueue}
        >
          <ListMusic size={21} />
        </button>
        <button className="icon-button" title="Devices" onClick={onDevices}>
          <Speaker size={20} />
        </button>
        <button
          className={`icon-button ${sidebarActive ? "active" : ""}`}
          title="Now playing"
          onClick={onSidebar}
        >
          <PanelRight size={20} />
        </button>
        <button
          className="icon-button volume-button"
          title={volume ? "Mute" : "Unmute"}
          onClick={() => {
            const next = volume ? 0 : 70;
            volumeControl.edit(next);
            volumeControl.finish();
          }}
        >
          {volume ? <Volume2 size={21} /> : <VolumeX size={21} />}
        </button>
        <input
          className="volume-range"
          aria-label="Volume"
          type="range"
          min="0"
          max="100"
          value={volume}
          onPointerDown={() => volumeControl.begin()}
          onPointerUp={() => volumeControl.finish()}
          onPointerCancel={() => volumeControl.finish()}
          onKeyUp={() => volumeControl.finish()}
          onBlur={() => volumeControl.finish()}
          style={{ "--range": `${volume}%` } as CSSProperties}
          onChange={(event) => {
            const next = Number(event.target.value);
            volumeControl.edit(next);
          }}
        />
        <button
          className="icon-button"
          title="Full screen lyrics"
          onClick={onFullscreen}
        >
          <Maximize2 size={19} />
        </button>
      </div>
    </footer>
  );
}

function Setup({
  state,
  onSignIn,
  onRetry,
  onCancel,
  onOpenDashboard,
}: {
  state: AppState;
  onSignIn: (id: string) => void;
  onRetry: () => void;
  onCancel: () => void;
  onOpenDashboard: () => void;
}) {
  const [id, setId] = useState(state.settings.client_id);
  useEffect(() => {
    setId(state.settings.client_id);
  }, [state.settings.client_id]);
  return (
    <div className="setup-backdrop">
      <section
        className="setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation();
        }}
      >
        <div className="setup-logo">
          <Logo size={44} />
        </div>
        <span className="premium-badge">Spotify Premium required</span>
        <h1 id="setup-title">
          {state.login_issue ? "Reconnect Spotify" : "Make yourself at home."}
        </h1>
        <p>
          Connect your Spotify account to play your music and bring your lyrics
          to life.
        </p>
        {state.login_issue && (
          <div className="setup-recovery" role="alert">
            <p>{state.login_issue.message}</p>
            {state.login_issue.retry_saved &&
              id === state.settings.client_id && (
                <button
                  className="pill"
                  disabled={state.login_pending}
                  onClick={onRetry}
                >
                  Retry saved sign-in
                </button>
              )}
          </div>
        )}
        <div className="setup-steps">
          <button className="text-link" onClick={onOpenDashboard}>
            1. Create an app in Spotify Developer Dashboard{" "}
            <ExternalLink size={14} />
          </button>
          <label>
            2. Add this redirect URI<code>http://127.0.0.1:43821/callback</code>
          </label>
          <label htmlFor="client-id">3. Enter your Client ID</label>
          <input
            className="field"
            id="client-id"
            value={id}
            onChange={(event) => setId(event.target.value.trim())}
            placeholder="32-character Spotify Client ID"
            autoComplete="off"
            spellCheck={false}
            disabled={state.login_pending}
          />
        </div>
        <button
          className="pill primary setup-sign-in"
          disabled={
            state.login_pending ||
            !state.booted ||
            !/^[a-fA-F0-9]{32}$/.test(id)
          }
          onClick={() => onSignIn(id)}
        >
          {state.login_pending || !state.booted ? (
            <>
              <LoaderCircle size={18} className="spin" />
              Connecting…
            </>
          ) : state.login_issue ? (
            "Sign in again"
          ) : (
            "Sign in with Spotify"
          )}
        </button>
        {state.login_pending && (
          <>
            <p className="setup-help">
              Complete sign-in in your browser. First-time audio playback may
              ask for a second authorization.
            </p>
            <button className="text-link muted" onClick={onCancel}>
              Cancel sign-in
            </button>
          </>
        )}
        <small>No password or client secret is stored in SpotiFlex.</small>
      </section>
    </div>
  );
}

export default App;
