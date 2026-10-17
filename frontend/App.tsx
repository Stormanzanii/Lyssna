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
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  FolderPlus,
  Heart,
  Home,
  Library,
  LoaderCircle,
  Maximize2,
  Menu,
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
  Settings as SettingsIcon,
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
  LogOut,
  ExternalLink,
} from "lucide-react";
import { rpc, subscribe } from "./bridge";
import { HomePage } from "./HomePage";
import {
  emptyState,
  reducer,
  formatTime,
  nextToggle,
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
} from "./types";
import {
  Ambience,
  ArtistLinks,
  Cover,
  LyricsPage,
  Marquee,
  NowPlaying,
  TrackTitle,
  artistNames,
  imageOf,
  preloadCanvas,
  prefetchCanvas,
  prefetchPage,
  cancelPrefetch,
  useLoadedImage,
  ExplicitBadge,
  usePosition,
} from "./components";
import "./styles.css";
import { VolumeControl } from "./volume-control";
import { FontSettings, fontFamily, loadSelectedFonts } from "./custom-fonts";
import { collectionTracks, genresFor } from "./collection";

type Center = "browse" | "lyrics" | "settings";
const windowHandle = () => getCurrentWindow();

function App() {
  const [state, dispatch] = useReducer(reducer, emptyState);
  const [center, setCenter] = useState<Center>("browse");
  const [query, setQuery] = useState("");
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryFilter, setLibraryFilter] = useState("all");
  const [sidebar, setSidebar] = useState(true);
  const [rightWidth, setRightWidth] = useState(360);
  const [target, setTarget] = useState("native");
  const [deviceMenu, setDeviceMenu] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [picker, setPicker] = useState<Track[] | null>(null);
  const [folderDialog, setFolderDialog] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [songMenu, setSongMenu] = useState<{
    track: Track;
    x: number;
    y: number;
  } | null>(null);
  const [immersive, setImmersive] = useState(false);
  const restoreMaximized = useRef(false),
    fullscreenBusy = useRef(false);
  const [albumFilter, setAlbumFilter] = useState("all");
  const [allAlbums, setAllAlbums] = useState(false);
  const [songQuery, setSongQuery] = useState(""),
    [songGenre, setSongGenre] = useState(""),
    [songAge, setSongAge] = useState(""),
    [songSort, setSongSort] = useState("order");
  useEffect(() => {
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
    pendingPage = useRef<string>(""),
    targetChosen = useRef(false);
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
      setSelected(new Set());
      setSongMenu(null);
      const next = ++generation.current;
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
      try {
        unlisten = await subscribe((event) => {
          if (disposed) return;
          if (event.type === "canvas_prefetch") preloadCanvas(event.url);
          dispatch(event);
        });
        const snapshot = await rpc<Snapshot>("bootstrap");
        if (!disposed) {
          generation.current = snapshot.generation;
          bootRoute.current = snapshot.route || "home";
          setQuery(
            snapshot.route.startsWith("search:") ? snapshot.route.slice(7) : "",
          );
          dispatch({ type: "bootstrap", snapshot });
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
  useEffect(() => {
    if (
      !targetChosen.current &&
      state.playback.is_playing &&
      state.playback.device.id &&
      state.playback.device.name
    )
      setTarget(
        state.playback.device.name === state.local_device_name
          ? "native"
          : state.playback.device.id,
      );
  }, [state.playback, state.local_device_name]);
  const updateSettings = useCallback(
    (changes: Partial<Settings>) => {
      const settings = { ...stateRef.current.settings, ...changes };
      dispatch({ type: "settings", settings });
      void call("save_settings", { settings });
    },
    [call],
  );
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
      state.home?.account !== state.profile.id
    )
      refreshHome();
  }, [
    state.profile?.id,
    state.native_ready,
    state.route,
    state.home?.account,
    refreshHome,
  ]);
  const play = useCallback(
    (request: PlayerRequest) => {
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
      void call("player", { request, target });
    },
    [call, target],
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
    const keydown = (event: KeyboardEvent) => {
      const editing = (event.target as HTMLElement)?.closest(
        'input,textarea,select,[contenteditable="true"],button',
      );
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
        event.preventDefault();
        toggle();
      }
      if (event.key === "Escape") {
        setSongMenu(null);
        setDeviceMenu(false);
        setPicker(null);
        setFolderDialog(false);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
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
      if (id) navigate(`artist:${id}`);
      else setQuery(artist.name);
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
  const artistBanner = useLoadedImage(entity?.overview?.header_image);
  const heroImages = entity?.images.length ? entity.images : playlist?.images;
  const playlistInfo = entity?.playlist;
  const personalizedMix = playlistInfo?.format.startsWith("daily-mix");
  const playlistDuration =
    playlistInfo?.total_tracks === state.tracks.length &&
    state.tracks.length > 0 &&
    state.tracks.every((track) => track.duration_ms > 0)
      ? state.tracks.reduce((sum, track) => sum + track.duration_ms, 0)
      : undefined;
  const title =
    entity?.title ||
    playlist?.name ||
    (state.route === "liked"
      ? "Liked Songs"
      : state.route === "queue"
        ? "Queue"
        : state.route.startsWith("search:")
          ? `Results for “${state.route.slice(7)}”`
          : state.route.startsWith("playlist:")
            ? "Playlist"
            : "Good to see you");
  const profileName = state.profile?.display_name || state.profile?.id || "You";
  const profileImage = useLoadedImage(imageOf(state.profile?.images));
  const collection =
    state.route === "liked" || state.route.startsWith("playlist:");
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
  const visibleLibrary = state.playlists
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
  useEffect(() => {
    if (collection && filtering && state.more && !state.loading) loadMore();
  }, [
    collection,
    filtering,
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
      className={`application ${state.settings.reduce_motion ? "reduce-motion" : ""} ${immersive ? "immersive" : ""}`}
      style={
        {
          fontFamily: fontFamily(state.settings.ui_font),
          "--lyric-font":
            fontFamily(state.settings.lyric_font || state.settings.ui_font) ||
            "inherit",
        } as CSSProperties
      }
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const file = event.dataTransfer.files[0];
        if (file) void importFile(file);
      }}
    >
      <header className="topbar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region aria-label="SpotiFlex">
          <span />
          <span />
          <span />
          <span />
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
              onKeyDown={(event) => {
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
          </div>
        </div>
        <div className="top-actions">
          <button
            className={`icon-button ${center === "settings" ? "active" : ""}`}
            title="Settings"
            onClick={() => setCenter("settings")}
          >
            <SettingsIcon size={20} />
          </button>
          <button
            className="avatar"
            title={profileName}
            onClick={() => setCenter("settings")}
          >
            {profileImage ? (
              <img src={profileImage} alt="Your Spotify profile" />
            ) : (
              profileName.slice(0, 1).toUpperCase()
            )}
          </button>
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
            {visibleLibrary.map((playlist) => (
              <button
                key={playlist.id}
                className={`library-item ${state.route === `playlist:${playlist.id}` ? "current" : ""}`}
                onClick={() => navigate(`playlist:${playlist.id}`)}
                {...prefetchOn(`playlist:${playlist.id}`)}
              >
                <Cover images={playlist.images} />
                <div>
                  <strong>{playlist.name}</strong>
                  <small>
                    Playlist ·{" "}
                    {playlist.owner.display_name || playlist.owner.id}
                  </small>
                </div>
              </button>
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
            <>
              <LyricsPage
                state={state}
                onPlayer={play}
                onAlbum={openAlbum}
                onArtist={openArtist}
                onImport={() => fileInput.current?.click()}
                onRetry={() => void call("retry_lyrics")}
              />
              <div className="lyrics-toolbar">
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
                  title="Close lyrics"
                  onClick={() => {
                    if (immersive) void fullscreen(false);
                    setCenter("browse");
                  }}
                >
                  <X size={18} />
                </button>
              </div>
            </>
          ) : center === "settings" ? (
            <SettingsPage
              state={state}
              onSettings={updateSettings}
              onCall={call}
              onNotice={notify}
            />
          ) : (
            <div className="browse-scroll" ref={mainScroll}>
              {state.route === "home" ? (
                <HomePage
                  data={state.home}
                  loading={state.home_loading}
                  error={state.home_error}
                  ready={state.native_ready}
                  navigate={homeNavigate}
                  play={homePlay}
                  dj={startDJ}
                  refresh={refreshHome}
                />
              ) : (
                <section
                  className={`page-hero ${state.route.startsWith("artist:") ? "artist-hero" : ""}`}
                  style={
                    entity?.artist && artistBanner
                      ? {
                          backgroundImage: `linear-gradient(0deg,#000b,#0001 70%),url("${artistBanner}")`,
                        }
                      : undefined
                  }
                >
                  {imageOf(heroImages) && (
                    <div
                      className="hero-wash"
                      style={{
                        backgroundImage: `url("${imageOf(heroImages)}")`,
                      }}
                    />
                  )}
                  {state.route === "liked" ? (
                    <div className="liked-cover hero-cover">
                      <Heart size={65} fill="currentColor" />
                    </div>
                  ) : (
                    (!!entity?.images.length || !!playlist?.images.length) &&
                    !entity?.artist && (
                      <Cover images={heroImages} className="hero-cover" />
                    )
                  )}
                  <div className="hero-copy">
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
                    <h1>{title}</h1>
                    {entity?.overview?.verified && (
                      <p className="artist-verified">
                        <Check size={18} /> Verified by Spotify
                      </p>
                    )}
                    {entity?.overview?.monthly_listeners != null && (
                      <p className="artist-monthly">
                        {entity.overview.monthly_listeners.toLocaleString()}{" "}
                        monthly listeners
                      </p>
                    )}
                    <div>
                      {entity?.album ? (
                        <ArtistLinks
                          artists={entity.album.artists || []}
                          onArtist={openArtist}
                        />
                      ) : entity?.artist ? (
                        ""
                      ) : (
                        entity?.subtitle ||
                        playlist?.owner.display_name ||
                        playlist?.owner.id ||
                        "Your collection"
                      )}
                    </div>
                    {entity?.album?.release_date && (
                      <small>
                        {entity.album.release_date.slice(0, 4)} ·{" "}
                        {entity.album.total_tracks} songs
                        {entity.album_details?.complete_duration && (
                          <> · {formatTime(entity.album_details.duration_ms)}</>
                        )}
                      </small>
                    )}
                    {playlistInfo &&
                      (personalizedMix ||
                        playlistInfo.owner ||
                        playlistInfo.total_tracks != null) && (
                        <small className="playlist-meta">
                          {personalizedMix
                            ? `Made for ${profileName}`
                            : playlistInfo.owner === "spotify"
                              ? "Spotify"
                              : playlistInfo.owner}
                          {playlistInfo.total_tracks != null && (
                            <>
                              {personalizedMix || playlistInfo.owner
                                ? " · "
                                : ""}
                              {playlistInfo.total_tracks} songs
                            </>
                          )}
                          {playlistDuration != null && (
                            <>
                              {" "}
                              ·{" "}
                              {playlistDuration >= 3_600_000
                                ? `${Math.floor(playlistDuration / 3_600_000)} hr `
                                : ""}
                              {Math.floor(playlistDuration / 60_000) % 60} min
                            </>
                          )}
                        </small>
                      )}
                  </div>
                </section>
              )}
              {state.route !== "home" && !state.route.startsWith("search:") && (
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
                      else if (state.tracks[0]) playTrack(state.tracks[0], 0);
                    }}
                  >
                    <Play fill="currentColor" size={26} />
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
                    className="icon-button"
                    title="Refresh page"
                    onClick={() => navigate(state.route, false)}
                  >
                    <RefreshCw size={21} />
                  </button>
                  <span>
                    {state.tracks.length > 0
                      ? `${state.tracks.length}${state.more ? "+" : ""} songs`
                      : ""}
                  </span>
                </div>
              )}
              {selected.size > 0 && (
                <div className="selection-bar">
                  <span>{selected.size} selected</span>
                  <button
                    className="pill"
                    onClick={() =>
                      setPicker(
                        displayTracks.filter((track) =>
                          selected.has(track.uri),
                        ),
                      )
                    }
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
                      {collection && (
                        <div className="song-filters">
                          <label className="playlist-search">
                            <Search size={17} />
                            <input
                              aria-label="Search songs in this playlist"
                              placeholder="Search songs in this playlist"
                              value={songQuery}
                              onChange={(event) =>
                                setSongQuery(event.target.value)
                              }
                            />
                          </label>
                          <select
                            aria-label="Genre"
                            value={songGenre}
                            onChange={(event) =>
                              setSongGenre(event.target.value)
                            }
                          >
                            <option value="">All genres</option>
                            {songGenres.map((genre) => (
                              <option key={genre}>{genre}</option>
                            ))}
                            <option value="unknown">Unknown genre</option>
                          </select>
                          <select
                            aria-label="Release age"
                            value={songAge}
                            onChange={(event) => setSongAge(event.target.value)}
                          >
                            <option value="">Any release age</option>
                            <option value="year">Past year</option>
                            <option value="five">1–5 years old</option>
                            <option value="ten">5–10 years old</option>
                            <option value="older">10+ years old</option>
                          </select>
                          <select
                            aria-label="Sort songs"
                            value={songSort}
                            onChange={(event) =>
                              setSongSort(event.target.value)
                            }
                          >
                            <option value="order">Playlist order</option>
                            <option value="recent">Recently added</option>
                            <option value="newest">Newest releases</option>
                            <option value="oldest">Oldest releases</option>
                            <option value="popular">Most played</option>
                          </select>
                          <small aria-live="polite">
                            {displayTracks.length} songs
                            {filtering && state.more
                              ? " · Loading remaining songs…"
                              : ""}
                          </small>
                        </div>
                      )}
                      <div
                        className={`track-table ${collection ? "collection-table" : ""}`}
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
                          {collection && <span>Plays</span>}
                          <span>
                            <Clock3 size={16} />
                          </span>
                        </div>
                        {displayTracks.map((track, index) => {
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
                                event.preventDefault();
                                setSongMenu({
                                  track,
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
                              {collection && (
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
              {state.loading && !state.tracks.length && (
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
                !state.loading &&
                !state.pageError &&
                !state.tracks.length &&
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
            <NowPlaying
              state={state}
              onPlayer={play}
              onAlbum={openAlbum}
              onArtist={openArtist}
              onLyrics={() => setCenter("lyrics")}
              onQueue={() => navigate("queue")}
              onFollow={follow}
              onSave={save}
              showLyricsPreview={center !== "lyrics"}
            />
          </>
        )}
      </div>
      <PlayerBar
        state={state}
        onPlayer={play}
        onToggle={toggle}
        onAlbum={openAlbum}
        onArtist={openArtist}
        onSave={save}
        onLyrics={() => setCenter(center === "lyrics" ? "browse" : "lyrics")}
        onQueue={() => navigate("queue")}
        onDevices={() => {
          setDeviceMenu(!deviceMenu);
          void call("refresh");
        }}
        onSidebar={() => setSidebar(!sidebar)}
        onFullscreen={() => void fullscreen()}
        lyricsActive={center === "lyrics"}
        sidebarActive={sidebar}
      />
      {deviceMenu && (
        <div className="device-menu popover">
          <h3>Connect to a device</h3>
          <button
            className={target === "native" ? "selected" : ""}
            onClick={() => {
              setTarget("native");
              targetChosen.current = true;
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
                  targetChosen.current = true;
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
          <div className="popover-dismiss" onClick={() => setSongMenu(null)} />
          <div
            className="song-menu popover"
            style={{
              left: Math.min(songMenu.x, window.innerWidth - 240),
              top: Math.min(songMenu.y, window.innerHeight - 260),
            }}
          >
            {[
              ["Play", Play, () => playTrack(songMenu.track)],
              [
                "Add to queue",
                ListMusic,
                () => play({ command: "enqueue", uri: songMenu.track.uri }),
              ],
              ["Add to playlist", Plus, () => setPicker([songMenu.track])],
              ["Open album", Music2, () => openAlbum(songMenu.track.album)],
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
              return (
                <button
                  key={String(label)}
                  onClick={() => {
                    (action as () => void)();
                    setSongMenu(null);
                  }}
                >
                  <ItemIcon size={17} />
                  {String(label)}
                </button>
              );
            })}
          </div>
        </>
      )}
      {picker && (
        <div className="modal-backdrop" onClick={() => setPicker(null)}>
          <section
            className="dialog playlist-picker"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="section-heading">
              <h2>Add to playlist</h2>
              <button className="icon-button" onClick={() => setPicker(null)}>
                <X />
              </button>
            </div>
            <p>
              {picker.length} song{picker.length === 1 ? "" : "s"} · existing
              songs will be skipped
            </p>
            <div>
              {state.playlists
                .filter(
                  (playlist) =>
                    playlist.owner.id === state.profile?.id ||
                    playlist.collaborative,
                )
                .map((playlist) => (
                  <button
                    className="library-item"
                    key={playlist.id}
                    onClick={() => {
                      void call("add_tracks", { playlist, tracks: picker });
                      setPicker(null);
                    }}
                  >
                    <Cover images={playlist.images} />
                    <strong>{playlist.name}</strong>
                  </button>
                ))}
            </div>
          </section>
        </div>
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
      {(!state.profile || !state.booted) && (
        <Setup
          state={state}
          onSignIn={(clientId) => {
            dispatch({ type: "login_pending" });
            void call("sign_in", { clientId });
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
}: {
  state: AppState;
  onPlayer: (request: PlayerRequest) => void;
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
        {track ? (
          <>
            <Cover
              images={track.album.images}
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
              {saved ? <Check size={17} /> : <Plus size={17} />}
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
            <Shuffle size={17} />
          </button>
          <button
            className="icon-button"
            title="Previous song"
            onClick={() => onPlayer({ command: "previous" })}
          >
            <SkipBack size={19} fill="currentColor" />
          </button>
          <button
            className="play-toggle"
            aria-label={state.playback.is_playing ? "Pause" : "Play"}
            title="Play / pause · Space"
            onClick={onToggle}
            disabled={!track}
          >
            {state.pending ? (
              <LoaderCircle className="spin" size={21} />
            ) : state.playback.is_playing ? (
              <Pause size={21} fill="currentColor" />
            ) : (
              <Play size={21} fill="currentColor" />
            )}
          </button>
          <button
            className="icon-button"
            title="Next song"
            onClick={() => onPlayer({ command: "next" })}
          >
            <SkipForward size={19} fill="currentColor" />
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
              <Repeat1 size={17} />
            ) : (
              <Repeat size={17} />
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
        <button
          className={`icon-button ${lyricsActive ? "active" : ""}`}
          title="Lyrics"
          onClick={onLyrics}
        >
          <Mic2 size={18} />
        </button>
        <button className="icon-button" title="Queue" onClick={onQueue}>
          <ListMusic size={19} />
        </button>
        <button className="icon-button" title="Devices" onClick={onDevices}>
          <Speaker size={18} />
        </button>
        <button
          className={`icon-button ${sidebarActive ? "active" : ""}`}
          title="Now playing"
          onClick={onSidebar}
        >
          <Menu size={18} />
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
          {volume ? <Volume2 size={18} /> : <VolumeX size={18} />}
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
          <Maximize2 size={17} />
        </button>
      </div>
    </footer>
  );
}

function Setup({
  state,
  onSignIn,
  onCancel,
  onOpenDashboard,
}: {
  state: AppState;
  onSignIn: (id: string) => void;
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
          <span />
          <span />
          <span />
          <span />
        </div>
        <span className="premium-badge">Spotify Premium required</span>
        <h1 id="setup-title">Make yourself at home.</h1>
        <p>
          Connect your Spotify account to play your music and bring your lyrics
          to life.
        </p>
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

function SettingsPage({
  state,
  onSettings,
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
}) {
  const [consent, setConsent] = useState(false);
  const [lyricsKey, setLyricsKey] = useState("");
  return (
    <div className="settings-page">
      <h1>Settings</h1>
      <section>
        <h2>Your account</h2>
        <div className="setting-row">
          <div>
            <strong>{state.profile?.display_name || state.profile?.id}</strong>
            <p>Spotify connected</p>
          </div>
          <button
            className="pill outline"
            onClick={() => void onCall("sign_out")}
          >
            <LogOut size={16} />
            Sign out
          </button>
        </div>
        {!state.can_follow && (
          <div className="setting-row">
            <div>
              <strong>Artist following</strong>
              <p>Allow SpotiFlex to follow your favourite artists.</p>
            </div>
            <button
              className="pill"
              onClick={() =>
                void onCall("sign_in", { clientId: state.settings.client_id })
              }
            >
              Update Spotify permissions
            </button>
          </div>
        )}
      </section>
      <section>
        <h2>Playback</h2>
        <div className="setting-row">
          <div>
            <strong>Native audio</strong>
            <p className={state.native_ready ? "native-ready" : ""}>
              {state.native_status}
            </p>
          </div>
          <button
            className="pill outline"
            onClick={() => void onCall("retry_audio")}
          >
            Reconnect native audio
          </button>
        </div>
      </section>
      <section>
        <h2>Lyrics & appearance</h2>
        <label className="setting-row">
          <span>
            <strong>Lyric text size</strong>
            <p>Make room for every word.</p>
          </span>
          <input
            type="range"
            min="18"
            max="60"
            value={state.settings.lyric_size}
            onChange={(event) =>
              onSettings({ lyric_size: Number(event.target.value) })
            }
          />
        </label>
        <label className="setting-row">
          <span>
            <strong>Timing offset</strong>
            <p>Adjust lyrics to match what you hear.</p>
          </span>
          <span>
            <input
              className="number-field"
              type="number"
              min="-10000"
              max="10000"
              step="50"
              value={state.settings.lyric_offset_ms}
              onChange={(event) =>
                onSettings({ lyric_offset_ms: Number(event.target.value) })
              }
            />{" "}
            ms
          </span>
        </label>
        <FontSettings
          settings={state.settings}
          onSettings={onSettings}
          onNotice={onNotice}
        />
        {[
          ["romanized", "Show romanized lyrics"],
          ["reduce_motion", "Reduce motion"],
          ["canvas_lyrics", "Canvas in lyrics"],
          ["floating_lyrics", "Floating lyrics"],
          ["compact_library", "Compact library"],
        ].map(([key, label]) => (
          <label className="setting-row" key={key}>
            <strong>{label}</strong>
            <input
              className="toggle"
              type="checkbox"
              checked={Boolean(state.settings[key as keyof Settings])}
              onChange={(event) => onSettings({ [key]: event.target.checked })}
            />
          </label>
        ))}
      </section>
      {!state.provider_configured && (
        <section>
          <h2>Spicy Lyrics</h2>
          {state.provider_builtin ? (
            <p>
              Spicy Lyrics is included and ready to use. It receives the current
              track ID and your IP address; Spotify tokens stay on this
              computer.
            </p>
          ) : (
            <>
              <p>
                Spicy Lyrics is built into SpotiFlex. Add your publishable API
                key once to enable synced lyrics.
              </p>
              <p>
                {state.provider_kind === "spicy"
                  ? "Your Spicy Lyrics key is saved in Windows Credential Manager."
                  : state.provider_configured
                    ? "A previous lyrics provider is configured. Save your Spicy Lyrics key below to switch."
                    : "Create an application in the Spicy Lyrics dashboard. Enable Client access and No origin header for this desktop app."}
              </p>
              <button
                className="text-link"
                onClick={() =>
                  void onCall("open_link", {
                    url: "https://developers.spicylyrics.org/dashboard",
                  })
                }
              >
                Open Spicy Lyrics dashboard
              </button>
              <input
                className="field"
                aria-label="Lyrics API key"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={lyricsKey}
                placeholder="sl_pk_…"
                onChange={(event) => {
                  setLyricsKey(event.target.value);
                  setConsent(false);
                }}
              />
              <p>
                Spicy Lyrics receives the current track ID and your IP address.
                Spotify tokens stay on this computer.
              </p>
              {state.lyric_error && state.provider_kind === "spicy" && (
                <p className="source-error">{state.lyric_error}</p>
              )}
              <label className="consent-row">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                <span>
                  Allow SpotiFlex to request lyrics from Spicy Lyrics using this
                  key and the current Spotify track ID.
                </span>
              </label>
              <button
                className="pill"
                disabled={
                  !lyricsKey.trim() ||
                  !consent ||
                  lyricsKey.trim().startsWith("sl_sk_")
                }
                onClick={() => {
                  void onCall("configure_spicy_lyrics", {
                    key: lyricsKey.trim(),
                    consent,
                  });
                  setLyricsKey("");
                  setConsent(false);
                  onNotice("Saving Spicy Lyrics key…");
                }}
              >
                Save lyrics key
              </button>
              {lyricsKey.trim().startsWith("sl_sk_") && (
                <p className="source-error">
                  Use a publishable sl_pk_ key. Secret sl_sk_ keys belong on
                  your server.
                </p>
              )}
            </>
          )}
        </section>
      )}
      <section>
        <h2>App updates</h2>
        <div className="setting-row">
          <div>
            <strong>
              {state.update_version
                ? `SpotiFlex ${state.update_version}`
                : "SpotiFlex 0.1.0"}
            </strong>
            <p>{state.update_status}</p>
          </div>
          <button
            className="pill outline"
            onClick={() =>
              void onCall("app_update", {
                action:
                  state.update_status === "Ready to install"
                    ? "install"
                    : "check",
              })
            }
          >
            {state.update_status === "Ready to install"
              ? "Install update and restart"
              : "Check for updates"}
          </button>
        </div>
        <label className="setting-row">
          <span>Download updates automatically</span>
          <input
            type="checkbox"
            className="toggle"
            checked={state.settings.auto_download_updates}
            onChange={(event) =>
              onSettings({ auto_download_updates: event.target.checked })
            }
          />
        </label>
      </section>
    </div>
  );
}

export default App;
