import {
  memo,
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { artworkFor } from "./artwork";
import { LyricsCanvas } from "./canvas-lyrics";
import { SpaceGravityLyrics } from "./space-gravity-lyrics";
import { displayLyrics } from "./word-sync";
import { useArtworkColor } from "./artwork-color";
import {
  BadgeCheck,
  Music2,
  Maximize2,
  Upload,
  RotateCw,
  Mic2,
  CirclePlus,
  CircleCheck,
  X,
} from "lucide-react";
import { DJArtwork, DJ_COVER } from "./brand";
import type {
  Album,
  Artist,
  Track,
  PlayerRequest,
  Lyrics,
  Settings,
  Line,
} from "./types";
import type { AppState } from "./state";
import { activeLines } from "./state";
import { PlaybackClock } from "./playback-clock";
import { rpc } from "./bridge";
import { useCreatorProfile } from "./creator-profile";
import {
  stepScroll,
  vocalGaps,
  type VocalGap,
  wordGroups,
  vocalGap,
  vocalEnd,
  lineBlur,
  glideScroll,
  GLIDE_MS,
  type ScrollSpring,
} from "./lyric-motion";
import { LyricAnimator } from "./lyric-animator";
import { LyricWord } from "./lyric-word";
import { LyricCountdown } from "./lyric-countdown";

/** Artwork is HTTPS, or a local JPEG preview of a cover being saved. */
export const usableImage = (url: string) =>
  url.startsWith("https://") || url.startsWith("data:image/jpeg;base64,");
export const imageOf = (images?: { url: string }[]) =>
  images?.find((image) => usableImage(image.url))?.url;
export const artistNames = (track?: Track) =>
  track?.artists.map((artist) => artist.name).join(", ") ?? "";
// Cover sizes are read during layout effects and applied together after
// them, so setting one image's src never forces layout for the next read.
const pendingSources: [HTMLImageElement, string][] = [];
function setSourceSoon(element: HTMLImageElement, url: string) {
  if (!pendingSources.length)
    queueMicrotask(() => {
      for (const [image, source] of pendingSources.splice(0))
        if (image.getAttribute("src") !== source) image.src = source;
    });
  pendingSources.push([element, url]);
}
/** Hero title size tier: longer names step down, like Spotify's headers. */
export const titleSize = (title: string) =>
  title.length > 28 ? "long-title" : title.length > 14 ? "medium-title" : "";

export function Cover({
  images,
  className = "",
  onClick,
  contextRoute,
  contextName,
}: {
  images?: { url: string; width?: number | null }[];
  className?: string;
  onClick?: () => void;
  contextRoute?: string;
  contextName?: string;
}) {
  const src = imageOf(images);
  const picture = useRef<HTMLImageElement>(null);
  const sources = images?.map((image) => image.url).join(" ");
  // Load the smallest Spotify size that fills the laid-out cover. Set here,
  // not through srcset/sizes="auto": Chromium keeps every image with
  // sizes="auto" (and its page) alive after it leaves the page.
  useLayoutEffect(() => {
    const element = picture.current;
    if (!element) return;
    const width = element.parentElement?.clientWidth ?? 0;
    const url = artworkFor(
      images,
      width ? Math.ceil(width * devicePixelRatio) : undefined,
    );
    if (url) setSourceSoon(element, url);
  }, [sources]);
  const inner = src ? (
    <img
      ref={picture}
      alt=""
      draggable={false}
      loading="lazy"
      decoding="async"
    />
  ) : (
    <Music2 aria-hidden="true" />
  );
  return onClick ? (
    <button
      className={`cover ${className}`}
      onClick={onClick}
      aria-label="Open album"
      data-context-route={contextRoute}
      data-context-name={contextName}
    >
      {inner}
    </button>
  ) : (
    <div
      className={`cover ${className}`}
      data-context-route={contextRoute}
      data-context-name={contextName}
    >
      {inner}
    </div>
  );
}
import { Ambience } from "./ambience";
export { Ambience };

export function Marquee({
  children,
  text,
  className = "",
  reduceMotion = false,
}: {
  children: ReactNode;
  text: string;
  className?: string;
  reduceMotion?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(0);
  useLayoutEffect(() => {
    const update = () =>
      setOverflow(
        Math.max(
          0,
          (content.current?.scrollWidth ?? 0) - (box.current?.clientWidth ?? 0),
        ),
      );
    update();
    const observer = new ResizeObserver(update);
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, [text]);
  return (
    <div
      className={`marquee ${overflow > 2 && !reduceMotion ? "scrolling" : ""} ${className}`}
      ref={box}
      title={text}
      style={
        {
          "--travel": `${overflow}px`,
          "--duration": `${Math.max(20, (overflow * 2) / 14 + 10)}s`,
        } as CSSProperties
      }
    >
      <div key={text} className="marquee-content" ref={content}>
        {children}
      </div>
    </div>
  );
}
// Load a page while the pointer rests on its link so opening it is instant.
// One background load at a time so it never delays a real click.
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
let lastPrefetch = 0;
const prefetched = new Set<string>();
export function prefetchPage(key: string) {
  clearTimeout(hoverTimer);
  if (prefetched.has(key)) return;
  hoverTimer = setTimeout(() => {
    if (Date.now() - lastPrefetch < 1200) return;
    lastPrefetch = Date.now();
    prefetched.add(key);
    if (prefetched.size > 200) prefetched.clear();
    void rpc("prefetch_page", { key }).catch(() => prefetched.delete(key));
  }, 180);
}
export const cancelPrefetch = () => clearTimeout(hoverTimer);

const decodedImages = new Set<string>();
const imageLoads = new Map<string, Promise<boolean>>();
export function preloadImage(url?: string): Promise<boolean> {
  if (!url) return Promise.resolve(false);
  if (decodedImages.has(url)) return Promise.resolve(true);
  const existing = imageLoads.get(url);
  if (existing) return existing;
  const request = new Promise<boolean>((resolve) => {
    const image = new Image();
    const finish = (success: boolean) => {
      image.onload = null;
      image.onerror = null;
      imageLoads.delete(url);
      if (success) {
        decodedImages.add(url);
        if (decodedImages.size > 512)
          decodedImages.delete(decodedImages.values().next().value!);
      }
      resolve(success);
    };
    image.onload = () => {
      void image
        .decode()
        .catch(() => {})
        .then(() => finish(true));
    };
    image.onerror = () => finish(false);
    image.src = url;
  });
  imageLoads.set(url, request);
  return request;
}
export function useLoadedImage(url?: string) {
  const [loaded, setLoaded] = useState<string>();
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    void preloadImage(url).then((success) => {
      if (success && !cancelled) setLoaded(url);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return loaded === url || (url && decodedImages.has(url)) ? url : undefined;
}

/**
 * Like useLoadedImage, but while a replacement for the same `key` decodes
 * (or the URL briefly disappears) it keeps returning the last decoded image,
 * so refreshed metadata does not flash an empty background.
 */
export function useStickyLoadedImage(url: string | undefined, key: string) {
  const loaded = useLoadedImage(url);
  const [last, setLast] = useState<{ key: string; url: string }>();
  useEffect(() => {
    if (loaded) setLast({ key, url: loaded });
  }, [loaded, key]);
  return loaded ?? (last?.key === key ? last.url : undefined);
}

export const ArtistLinks = memo(function ArtistLinks({
  artists,
  onArtist,
}: {
  artists: Artist[];
  onArtist: (artist: Artist) => void;
}) {
  return (
    <>
      {artists.map((artist, index) => (
        <span key={artist.id ?? `${artist.name}-${index}`}>
          {index > 0 && <span className="artist-separator">, </span>}
          <button
            className="text-link artist-link"
            data-context-route={artist.id ? `artist:${artist.id}` : undefined}
            data-context-name={artist.name}
            onClick={() => onArtist(artist)}
            onMouseEnter={() =>
              artist.id && prefetchPage(`artist:${artist.id}`)
            }
            onMouseLeave={cancelPrefetch}
          >
            {artist.name}
          </button>
        </span>
      ))}
    </>
  );
});
export function ExplicitBadge({ track }: { track: Track }) {
  return track.explicit ? (
    <span className="explicit-badge" aria-label="Explicit" title="Explicit">
      E
    </span>
  ) : null;
}
export const TrackTitle = memo(function TrackTitle({
  track,
  onAlbum,
  reduceMotion = false,
  className = "",
}: {
  track: Track;
  onAlbum: (album: Album) => void;
  reduceMotion?: boolean;
  className?: string;
}) {
  return (
    <Marquee
      text={track.name}
      className={className}
      reduceMotion={reduceMotion}
    >
      <button
        className="text-link song-title"
        data-context-route={track.id ? `track:${track.id}` : undefined}
        onClick={() => onAlbum(track.album)}
      >
        {track.name}
      </button>
    </Marquee>
  );
});

export function usePosition(
  state: Pick<AppState, "playback" | "observed_at" | "clock_revision"> &
    Partial<Pick<AppState, "local_device_name">>,
) {
  const clock = useRef(new PlaybackClock());
  const [time, setTime] = useState(performance.now());
  const now = performance.now();
  clock.current.observe(
    state.playback,
    state.observed_at,
    state.clock_revision,
    now,
    Date.now(),
    state.local_device_name
      ? state.playback.device.name === state.local_device_name
      : true,
  );
  useEffect(() => {
    setTime(performance.now());
    if (!state.playback.is_playing) return;
    let frame = 0;
    const tick = (time: number) => {
      setTime(time);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [state.playback.is_playing]);
  return clock.current.read(Math.max(time, now));
}

export function LyricsDisplay({
  lyrics,
  positionMs,
  settings,
  onSeek,
  compact = false,
  writers = [],
}: {
  lyrics: Lyrics;
  positionMs: number;
  settings: Settings;
  onSeek: (ms: number) => void;
  compact?: boolean;
  writers?: string[];
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [atEnd, setAtEnd] = useState(false);
  const resume = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Browsing pauses follow mode; it resumes on its own once scrolling stops.
  const glide = useRef<{ from: number; start: number }>(undefined);
  const browse = () => {
    glide.current = undefined;
    setFollowing(false);
    clearTimeout(resume.current);
    resume.current = setTimeout(() => setFollowing(true), 3000);
  };
  useEffect(() => () => clearTimeout(resume.current), []);
  const lines = useRef<(HTMLButtonElement | null)[]>([]);
  const seek = useRef(onSeek);
  useLayoutEffect(() => {
    seek.current = onSeek;
  }, [onSeek]);
  // Clock frames must not replace each button's native click listener or ref.
  const lineActions = useMemo(
    () =>
      lyrics.lines.map((line, index) => ({
        ref: (element: HTMLButtonElement | null) => {
          lines.current[index] = element;
        },
        click: () => {
          if (lyrics.synced) {
            seek.current(line.words[0]?.start_ms ?? line.start_ms);
            setFollowing(true);
          }
        },
      })),
    [lyrics],
  );
  const spring = useRef<ScrollSpring>({ position: 0, velocity: 0, target: 0 });
  const waiting = useRef<HTMLDivElement>(null);
  const gap = lyrics.synced ? vocalGap(lyrics.lines, positionMs) : undefined;
  const gaps = useMemo(
    () => new Map(vocalGaps(lyrics.lines).map((item) => [item.after, item])),
    [lyrics],
  );
  const waitingDots = (item: VocalGap) => {
    const visible = gap?.start === item.start;
    return (
      <LyricCountdown
        key={item.start}
        ref={visible ? waiting : undefined}
        gap={item}
        time={positionMs}
        reduceMotion={settings.reduce_motion}
        visible={visible}
      />
    );
  };
  // Early scroll follows the line about to be sung; highlighting still
  // follows the real song time.
  const scrollTime = positionMs + (settings.lyrics_early_scroll ? 350 : 0);
  const active = activeLines(lyrics.lines, scrollTime);
  const primary =
    active.find((index) => !lyrics.lines[index].background) ??
    lyrics.lines.reduce(
      (last, line, index) =>
        line.start_ms <= scrollTime && !line.background ? index : last,
      0,
    );
  useEffect(() => {
    setFollowing(true);
  }, [lyrics]);
  // A restart, Previous or seek moves song time far in one step. Lyrics then
  // slide straight there instead of springing through the whole song.
  const lastPosition = useRef(positionMs),
    jumped = useRef(false);
  if (Math.abs(positionMs - lastPosition.current) > 1500) jumped.current = true;
  lastPosition.current = positionMs;
  const animator = useRef<LyricAnimator>(undefined);
  useLayoutEffect(() => {
    const instance = new LyricAnimator(
      lyrics,
      (index) => lines.current[index] ?? null,
      settings.reduce_motion || !!settings.lyrics_simple,
    );
    animator.current = instance;
    return () => instance.dispose();
  }, [lyrics, settings.reduce_motion, settings.lyrics_simple]);
  useLayoutEffect(() => {
    if (!lyrics.synced) return;
    if (jumped.current) {
      animator.current?.reset();
      setFollowing(true);
    }
    animator.current?.update(positionMs);
  }, [positionMs, lyrics, settings.reduce_motion]);
  useLayoutEffect(() => {
    const container = scroll.current,
      line = gap ? waiting.current : lines.current[primary];
    if (!container || !line || !following || !lyrics.synced) {
      spring.current.velocity = 0;
      return;
    }
    let frame = 0,
      last = performance.now();
    spring.current.position = container.scrollTop;
    const tick = (time: number) => {
      frame = 0;
      const motion = spring.current,
        slide = glide.current;
      if (slide) {
        const elapsed = time - slide.start;
        container.scrollTop = motion.position = glideScroll(
          slide.from,
          motion.target,
          elapsed,
        );
        motion.velocity = 0;
        last = time;
        if (elapsed < GLIDE_MS) frame = requestAnimationFrame(tick);
        else glide.current = undefined;
        return;
      }
      container.scrollTop = stepScroll(
        motion,
        Math.min(0.064, Math.max(0, (time - last) / 1000)),
      );
      last = time;
      if (
        Math.abs(motion.position - motion.target) > 0.2 ||
        Math.abs(motion.velocity) > 0.5
      )
        frame = requestAnimationFrame(tick);
      else container.scrollTop = motion.target;
    };
    const retarget = () => {
      const cover = container
        .closest(".lyrics-page")
        ?.querySelector(".lyrics-album>.cover");
      const coverBox = cover?.getBoundingClientRect(),
        box = container.getBoundingClientRect();
      // Align with the cover only when it sits beside the lyrics; narrow
      // layouts stack a small cover above them, so centre in the view.
      const beside = !!coverBox && coverBox.right <= box.left + 1;
      const focus = compact
        ? Math.min(72, container.clientHeight * 0.25)
        : beside
          ? coverBox.top + coverBox.height / 2 - box.top
          : container.clientHeight / 2;
      container.style.setProperty("--lead-top", `${focus}px`);
      const lastLine = lines.current.at(-1),
        credits = container.querySelector(".lyric-end-credits");
      container.style.setProperty(
        "--tail-space",
        `${compact ? 0 : Math.max(0, container.clientHeight - focus - (lastLine?.offsetHeight ?? 0) / 2 - (credits?.getBoundingClientRect().height ?? 0))}px`,
      );
      spring.current.target = Math.max(
        0,
        Math.min(
          container.scrollHeight - container.clientHeight,
          line.offsetTop + (compact ? 0 : line.offsetHeight / 2) - focus,
        ),
      );
      if (jumped.current && !settings.reduce_motion)
        glide.current = {
          from: container.scrollTop,
          start: performance.now(),
        };
      if (settings.reduce_motion) {
        container.scrollTop = spring.current.target;
        spring.current.position = container.scrollTop;
        spring.current.velocity = 0;
      } else if (!frame) {
        last = performance.now();
        frame = requestAnimationFrame(tick);
      }
    };
    retarget();
    const observer = new ResizeObserver(retarget);
    observer.observe(container);
    observer.observe(line);
    container
      .querySelectorAll(".lyric-wait")
      .forEach((row) => observer.observe(row));
    const album = container
      .closest(".lyrics-page")
      ?.querySelector(".lyrics-album");
    if (album) observer.observe(album);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [
    primary,
    following,
    lyrics,
    settings.reduce_motion,
    settings.lyric_size,
    settings.romanized,
    gap?.start,
  ]);
  useLayoutEffect(() => {
    // Held until follow mode resumes, so a jump while browsing still snaps.
    if (following) jumped.current = false;
  }, [positionMs, following]);
  if (lyrics.instrumental)
    return (
      <div className="lyrics-message">
        <Music2 />
        <h2>Instrumental</h2>
        <p>Enjoy the music</p>
        <LyricCredits lyrics={lyrics} />
      </div>
    );
  return (
    <div
      className={`lyrics-display ${compact ? "compact" : ""} ${!lyrics.synced ? "static-lyrics" : ""} ${settings.reduce_motion ? "reduce-motion" : ""} ${settings.lyrics_right_align ? "lyrics-right" : ""} ${settings.lyrics_flip_duet ? "lyrics-flip-duet" : ""} ${settings.lyrics_wide_duet === false ? "" : "lyrics-wide-duet"} ${settings.lyrics_line_hover ? "lyrics-line-hover" : ""} ${lyrics.lines.some((line) => line.opposite) ? "has-duet" : ""}`}
      data-following={following}
    >
      <div
        className="lyric-scroll"
        data-at-end={atEnd}
        onScroll={(event) => {
          const node = event.currentTarget;
          setAtEnd(
            node.scrollTop + node.clientHeight >= node.scrollHeight - 24,
          );
        }}
        ref={scroll}
        onWheel={browse}
        onTouchStart={browse}
        style={
          compact
            ? undefined
            : ({
                "--lyric-size": `${Math.round(settings.lyric_size * 1.6)}px`,
              } as CSSProperties)
        }
      >
        <div className="lyric-spacer" />
        {gaps.has(-1) && waitingDots(gaps.get(-1)!)}
        {lyrics.lines.map((line, index) => {
          const playing = active.includes(index);
          const distance = Math.abs(index - primary);
          return (
            <Fragment key={`${line.start_ms}-${index}`}>
              <button
                ref={lineActions[index].ref}
                key={`${line.start_ms}-${index}`}
                className={`lyric-line ${playing ? "active" : ""} ${line.background ? "background-vocal" : ""} ${line.opposite ? "opposite" : ""} ${!playing && positionMs >= vocalEnd(line) ? "past" : ""}`}
                style={
                  {
                    "--blur": `${compact || playing ? 0 : lineBlur(distance)}px`,
                  } as CSSProperties
                }
                onClick={lineActions[index].click}
                disabled={!lyrics.synced}
                // Clicking seeks without taking focus, so Space stays with
                // play and pause.
                onMouseDown={(event) => event.preventDefault()}
              >
                <span className="lyric-main">
                  <LyricWords line={line} />
                </span>
                {line.translation && (
                  <span className="lyric-translation">{line.translation}</span>
                )}
              </button>
              {gaps.has(index) && waitingDots(gaps.get(index)!)}
            </Fragment>
          );
        })}
        <div className="lyric-end-credits">
          <p>
            Written by:{" "}
            {(lyrics.songwriters?.length ? lyrics.songwriters : writers).join(
              ", ",
            ) || "Songwriter credits unavailable"}
          </p>
          <LyricCredits lyrics={lyrics} expanded />
        </div>
      </div>
    </div>
  );
}

const LyricCredits = memo(function LyricCredits({
  lyrics,
  expanded = false,
}: {
  lyrics: Lyrics;
  expanded?: boolean;
}) {
  const source =
    (
      {
        spicy_lyrics: "Spicy Lyrics",
        apple_music: "Apple Music",
        spotify: "Spotify",
        musixmatch: "Musixmatch",
      } as Record<string, string>
    )[lyrics.source] ?? lyrics.source;
  const openCreator = useCreatorProfile();
  const profileUrl = (url?: string) => {
    try {
      const parsed = new URL(url ?? "");
      if (
        parsed.protocol === "https:" &&
        parsed.hostname === "spicylyrics.org" &&
        !parsed.username &&
        !parsed.password
      )
        return parsed.href;
    } catch {
      /* Missing profile links remain plain credit text. */
    }
  };
  const community =
    lyrics.source === "spicy_lyrics"
      ? (["maker", "uploader"] as const).flatMap((role) => {
          const person = lyrics.attribution?.[role];
          return person?.username ? [{ role, person }] : [];
        })
      : [];
  // Community lyrics read like the Spicy Lyrics fork:
  // "Community lyrics · Made by (avatar) @name".
  if (community.length)
    return (
      <div
        className={`lyric-source community-credits ${expanded ? "expanded" : ""}`}
      >
        <span className="community-lead">Community lyrics</span>
        {community.map(({ role, person }) => {
          const url = profileUrl(person.url);
          const label =
            role === "uploader" && community[0].role === "maker"
              ? "Uploaded by"
              : "Made by";
          const name = (
            <>
              {person.avatar?.startsWith("https://") && (
                <img src={person.avatar} alt="" />
              )}
              <span className="community-name">@{person.username}</span>
            </>
          );
          return (
            <span key={role} className="community-person">
              <span className="community-dot"> · </span>
              {label}{" "}
              {person.id || url ? (
                <button
                  className="community-profile"
                  onClick={() =>
                    person.id
                      ? openCreator(person)
                      : void rpc("open_link", { url }).catch(() => {})
                  }
                >
                  {name}
                </button>
              ) : (
                <span className="community-profile">{name}</span>
              )}
            </span>
          );
        })}
      </div>
    );
  return (
    <div className={`lyric-source ${expanded ? "expanded" : ""}`}>
      Lyrics provided by: {source}
      {lyrics.estimated_words &&
        (lyrics.estimated_lines
          ? " (+ estimated line and word timing)"
          : " (+ estimated word timing)")}
      {lyrics.source === "spicy_lyrics" &&
        (
          [
            ["uploader", "Uploaded by"],
            ["maker", "Made by"],
          ] as const
        ).map(([role, label]) => {
          const person = lyrics.attribution?.[role];
          if (!person?.username) return null;
          let url: string | undefined;
          try {
            const parsed = new URL(person.url ?? "");
            if (
              parsed.protocol === "https:" &&
              parsed.hostname === "spicylyrics.org" &&
              !parsed.username &&
              !parsed.password
            )
              url = parsed.href;
          } catch {
            /* Missing profile links remain plain credit text. */
          }
          return (
            <span key={role}>
              {" "}
              · {label}{" "}
              {person.id || url ? (
                <button
                  className="text-link"
                  onClick={() =>
                    person.id
                      ? openCreator(person)
                      : void rpc("open_link", { url }).catch(() => {})
                  }
                >
                  {expanded ? "@" : ""}
                  {person.username}
                </button>
              ) : (
                person.username
              )}
              {expanded && person.avatar?.startsWith("https://") && (
                <img className="credit-avatar" src={person.avatar} alt="" />
              )}
            </span>
          );
        })}
    </div>
  );
});

/** Static lyric markup. LyricAnimator moves the syllables and letters. */
const LyricWords = memo(function LyricWords({ line }: { line: Line }) {
  const groups = useMemo(() => wordGroups(line.words), [line]);
  if (!line.words.length)
    return <span className="lyric-plain">{line.text}</span>;
  return (
    <>
      {groups.map((group, index) => (
        <LyricWord key={index} words={group} />
      ))}
    </>
  );
});

function TimedLyricsPreview({
  state,
  onPlayer,
}: {
  state: AppState;
  onPlayer: (request: PlayerRequest) => void;
}) {
  const current = usePosition(state) + state.settings.lyric_offset_ms;
  const lyrics = displayLyrics(
    state.lyrics,
    !!state.settings.experimental_word_sync,
    state.settings.romanized,
    state.playback.item?.duration_ms,
  );
  return lyrics ? (
    <LyricsDisplay
      lyrics={lyrics}
      writers={state.playback.item?.songwriters}
      positionMs={current}
      settings={state.settings}
      compact
      onSeek={(ms) => onPlayer({ command: "seek", positionMs: ms })}
    />
  ) : null;
}

type Links = {
  onAlbum: (album: Album) => void;
  onArtist: (artist: Artist) => void;
};
export { DJArtwork };
export function DJPresentation({ playing }: { playing: boolean }) {
  return (
    <div className="dj-presentation">
      <DJArtwork />
      <div>
        <h2>DJ</h2>
        <p>{playing ? "Speaking…" : "Paused"}</p>
      </div>
    </div>
  );
}
/** Lyric views narrower than this stack a small header above the lyrics. */
const NARROW_LYRICS_PX = 760;
function useNarrowLyrics() {
  const page = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = page.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setNarrow(entry.contentRect.width < NARROW_LYRICS_PX),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [page, narrow] as const;
}
function DJLyricsPage({
  state,
  children,
}: {
  state: AppState;
  children?: ReactNode;
}) {
  const [page, narrow] = useNarrowLyrics();
  return (
    <section
      ref={page}
      className={`lyrics-page dj-view ${narrow ? "narrow" : ""} ${state.settings.reduce_motion ? "reduce-motion" : ""}`}
    >
      {children}
      <Ambience
        image={DJ_COVER}
        reduceMotion={state.settings.reduce_motion}
        animate={state.playback.is_playing}
      />
      <div className="lyrics-album">
        <DJArtwork />
        <div className="lyrics-title">
          <span className="song-title">DJ</span>
        </div>
        <div className="lyrics-artists">
          {state.playback.is_playing ? (
            // Centre the word; the ellipsis hangs past it.
            <span className="hanging-ellipsis">
              Speaking<span aria-hidden="true">…</span>
            </span>
          ) : (
            "Paused"
          )}
        </div>
      </div>
      <div className="lyrics-body dj-lyrics-message" role="status">
        <h2>Lyrics aren't available while the DJ talks</h2>
        <p>
          Your DJ is setting up what plays next. Lyrics return when the next
          song starts.
        </p>
      </div>
    </section>
  );
}
export function LyricsPage(props: Parameters<typeof SongLyricsPage>[0]) {
  return props.state.narrating ? (
    <DJLyricsPage state={props.state}>{props.children}</DJLyricsPage>
  ) : (
    <SongLyricsPage {...props} />
  );
}
function SongLyricsPage({
  state,
  onPlayer,
  onAlbum,
  onArtist,
  onImport,
  onRetry,
  children,
}: {
  state: AppState;
  onPlayer: (request: PlayerRequest) => void;
  onImport: () => void;
  onRetry: () => void;
  children?: ReactNode;
} & Links) {
  const current = usePosition(state) + state.settings.lyric_offset_ms,
    track = state.playback.item;
  const backdrop = useRef<HTMLCanvasElement>(null);
  const [page, measuredNarrow] = useNarrowLyrics();
  // The toolbar shows while the pointer moves over the lyrics and fades a
  // second after it stops. Kept as a data attribute so frequent re-renders
  // of this page do not reset it.
  const toolsTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wakeTools = () => {
    const element = page.current;
    if (!element) return;
    element.dataset.tools = "awake";
    clearTimeout(toolsTimer.current);
    toolsTimer.current = setTimeout(() => {
      delete element.dataset.tools;
    }, 1000);
  };
  const sleepTools = () => {
    clearTimeout(toolsTimer.current);
    if (page.current) delete page.current.dataset.tools;
  };
  useEffect(() => () => clearTimeout(toolsTimer.current), []);
  // The toolbar's compact toggle forces the stacked layout.
  const narrow = measuredNarrow || !!state.settings.lyrics_compact;
  const [canvasPlaying, setCanvasPlaying] = useState(false);
  const motionAllowed =
    !state.settings.reduce_motion &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canvas = !!(
    track &&
    state.canvas_url &&
    state.settings.canvas_lyrics &&
    motionAllowed
  );
  const coverColour =
    useArtworkColor(
      state.settings.lyrics_background === "color"
        ? imageOf(track?.album.images)
        : undefined,
    ) ?? "rgb(40 40 40)";
  // Space Gravity needs word timing, including estimates for static lyrics.
  const gravity = !!(
    state.settings.space_gravity &&
    state.lyrics &&
    !state.lyrics.instrumental &&
    (state.lyrics.synced || track?.duration_ms) &&
    motionAllowed
  );
  const lyrics = displayLyrics(
    state.lyrics,
    !!state.settings.experimental_word_sync || gravity,
    state.settings.romanized,
    track?.duration_ms,
  );
  return (
    <section
      ref={page}
      className={`lyrics-page ${canvas ? "canvas-lyrics" : ""} ${narrow ? "narrow" : ""} ${state.settings.reduce_motion ? "reduce-motion" : ""} ${gravity ? "space-gravity" : ""} ${state.settings.lyrics_hide_artwork ? "no-artwork" : ""} ${state.settings.lyrics_artwork_right ? "artwork-right" : ""} ${state.settings.lyrics_background === "color" ? "colour-background" : ""}`}
      style={
        state.settings.lyrics_background === "color"
          ? ({ "--hero": coverColour } as CSSProperties)
          : undefined
      }
      onMouseMove={wakeTools}
      onMouseLeave={sleepTools}
    >
      {children}
      {(!canvas || !canvasPlaying) &&
        state.settings.lyrics_background !== "color" && (
          <Ambience
            track={track}
            reduceMotion={state.settings.reduce_motion}
            animate={
              state.playback.is_playing &&
              state.settings.lyrics_background !== "static"
            }
          />
        )}
      {canvas && (
        <canvas
          className="lyrics-canvas-backdrop"
          ref={backdrop}
          width={128}
          height={128}
          aria-hidden="true"
        />
      )}
      {track ? (
        <>
          <div
            className="lyrics-album"
            data-context-route={track.id ? `track:${track.id}` : undefined}
          >
            {canvas ? (
              <LyricsCanvas
                key={track.uri}
                url={state.canvas_url!}
                poster={imageOf(track.album.images)}
                playing={state.playback.is_playing}
                backdrop={backdrop}
                onActive={setCanvasPlaying}
                artworkRight={!!state.settings.lyrics_artwork_right}
              />
            ) : (
              <Cover
                images={track.album.images}
                onClick={() => onAlbum(track.album)}
              />
            )}
            <TrackTitle
              track={track}
              onAlbum={onAlbum}
              reduceMotion={state.settings.reduce_motion}
              className="lyrics-title"
            />
            {/* The year stays put; only the artist names scroll. */}
            <div className="lyrics-artists">
              {track.album.release_date && !state.settings.lyrics_hide_year && (
                <span className="lyrics-year">
                  {track.album.release_date.slice(0, 4)} ·{" "}
                </span>
              )}
              <Marquee
                text={artistNames(track)}
                reduceMotion={state.settings.reduce_motion}
              >
                <ArtistLinks artists={track.artists} onArtist={onArtist} />
              </Marquee>
            </div>
          </div>
          <div className="lyrics-body">
            {lyrics && gravity ? (
              <SpaceGravityLyrics
                lyrics={lyrics}
                time={current}
                reduceMotion={!motionAllowed}
                onSeek={(positionMs) =>
                  onPlayer({ command: "seek", positionMs })
                }
                credits={
                  <>
                    <p>
                      Written by:{" "}
                      {(lyrics.songwriters?.length
                        ? lyrics.songwriters
                        : (track.songwriters ?? [])
                      ).join(", ") || "Songwriter credits unavailable"}
                    </p>
                    <LyricCredits lyrics={lyrics} expanded />
                  </>
                }
              />
            ) : lyrics ? (
              <LyricsDisplay
                lyrics={lyrics}
                writers={state.playback.item?.songwriters}
                positionMs={current}
                settings={state.settings}
                onSeek={(ms) => onPlayer({ command: "seek", positionMs: ms })}
              />
            ) : (
              <div className="lyrics-message">
                <Mic2 />
                <h2>
                  {state.lyric_error ? "Lyrics unavailable" : "Finding lyrics…"}
                </h2>
                <p>
                  {state.lyric_error
                    ? "Try another lyrics source or import your lyric file."
                    : "Synced lyrics will appear here."}
                </p>
                {state.lyric_error && (
                  <div className="inline-actions">
                    <button className="pill" onClick={onRetry}>
                      <RotateCw size={16} />
                      Retry
                    </button>
                    <button className="pill" onClick={onImport}>
                      <Upload size={16} />
                      Import lyrics
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="lyrics-message">
          <Music2 />
          <h2>Play something you love</h2>
          <p>Your lyrics will appear here.</p>
        </div>
      )}
    </section>
  );
}

// Videos warmed before playback so a Canvas starts at once instead of
// showing its still poster while it downloads.
const warmCanvases = new Map<string, HTMLVideoElement>();
export function preloadCanvas(url: string) {
  if (!url.startsWith("https://") || warmCanvases.has(url)) return;
  if (warmCanvases.size >= 6) {
    const [oldest, video] = warmCanvases.entries().next().value!;
    video.removeAttribute("src");
    video.load();
    warmCanvases.delete(oldest);
  }
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  video.load();
  warmCanvases.set(url, video);
}
const canvasRequests = new Set<string>();
export function prefetchCanvas(uri: string) {
  if (canvasRequests.has(uri)) return;
  canvasRequests.add(uri);
  void rpc("prefetch_canvas", { uris: [uri] }).catch(() =>
    canvasRequests.delete(uri),
  );
}

function CanvasArtwork({
  track,
  url,
  playing,
  reduceMotion,
  onOpen,
}: {
  track: Track;
  url?: string;
  playing: boolean;
  reduceMotion: boolean;
  onOpen: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let visible = true;
    const update = () => {
      if (playing && visible && !document.hidden && !reduceMotion)
        void element.play().catch(() => {});
      else element.pause();
    };
    const observer = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? false;
      update();
    });
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      element.pause();
    };
  }, [url, playing, reduceMotion]);
  if (!url || failed || reduceMotion)
    return (
      <Cover
        images={track.album.images}
        className="now-artwork"
        onClick={onOpen}
      />
    );
  return (
    <button className="canvas-artwork" aria-label="Open album" onClick={onOpen}>
      <video
        ref={video}
        src={url}
        muted
        loop
        playsInline
        autoPlay={playing && !reduceMotion}
        preload="auto"
        poster={imageOf(track.album.images)}
        onError={() => setFailed(true)}
      />
    </button>
  );
}

export function NowPlaying({
  state,
  onPlayer,
  onAlbum,
  onArtist,
  onLyrics,
  onQueue,
  onFollow,
  onSave,
  showLyricsPreview,
}: {
  state: AppState;
  onPlayer: (request: PlayerRequest) => void;
  onLyrics: () => void;
  onQueue: () => void;
  onFollow: (artist: Artist) => void;
  onSave: (track: Track) => void;
  showLyricsPreview: boolean;
} & Links) {
  const track = state.playback.item;
  const artist = state.details.artists[0] ?? track?.artists[0],
    next = state.details.queue[0];
  const saved = track && state.saved[track.uri];
  if (state.narrating)
    return (
      <aside className="now-playing dj-view">
        <Ambience
          image={DJ_COVER}
          reduceMotion={state.settings.reduce_motion}
          animate={state.playback.is_playing}
        />
        <div className="now-playing-scroll">
          <div className="section-heading">
            <h2>Now playing</h2>
          </div>
          <DJArtwork />
          <div className="now-track">
            <div className="now-track-text">
              <span className="song-title">DJ</span>
              <div className="now-artists">
                {state.playback.is_playing ? "Speaking…" : "Paused"}
              </div>
            </div>
          </div>
          <p className="dj-note">
            Your DJ picks music for you and talks between sets. Song details
            return when the next track starts.
          </p>
        </div>
      </aside>
    );
  // Spotify's Canvas layout: the video fills the panel top edge to edge with
  // the header and title laid over it.
  const canvas = !!track && !!state.canvas_url && !state.settings.reduce_motion;
  const heading = (
    <div className={`section-heading ${canvas ? "canvas-hero-head" : ""}`}>
      <h2>{canvas && track ? track.name : "Now playing"}</h2>
      <button className="icon-button" onClick={onLyrics} title="Open lyrics">
        <Maximize2 size={17} />
      </button>
    </div>
  );
  return (
    <aside className={`now-playing ${canvas ? "has-canvas" : ""}`}>
      <Ambience
        track={track}
        reduceMotion={state.settings.reduce_motion}
        animate={state.playback.is_playing}
      />
      <div className="now-playing-scroll">
        {!canvas && heading}
        {track ? (
          <>
            {canvas ? (
              <div className="canvas-hero">
                <CanvasArtwork
                  key={track.uri}
                  track={track}
                  url={state.canvas_url}
                  playing={state.playback.is_playing}
                  reduceMotion={state.settings.reduce_motion}
                  onOpen={() => onAlbum(track.album)}
                />
                <div className="canvas-hero-shade" />
                {heading}
              </div>
            ) : (
              <CanvasArtwork
                key={track.uri}
                track={track}
                url={state.canvas_url}
                playing={state.playback.is_playing}
                reduceMotion={state.settings.reduce_motion}
                onOpen={() => onAlbum(track.album)}
              />
            )}
            <div
              className={`now-track ${canvas ? "canvas-hero-track" : ""}`}
              data-context-route={track.id ? `track:${track.id}` : undefined}
            >
              <div className="now-track-text">
                <TrackTitle
                  track={track}
                  onAlbum={onAlbum}
                  reduceMotion={state.settings.reduce_motion}
                />
                <Marquee
                  text={artistNames(track)}
                  reduceMotion={state.settings.reduce_motion}
                  className="now-artists"
                >
                  <ExplicitBadge track={track} />
                  <ArtistLinks artists={track.artists} onArtist={onArtist} />
                </Marquee>
              </div>
              <button
                className={`icon-button save-track ${saved ? "is-saved" : ""}`}
                title={saved ? "Saved to Liked Songs" : "Save to Liked Songs"}
                onClick={() => onSave(track)}
              >
                {saved ? (
                  <CircleCheck size={24} fill="currentColor" stroke="#000" />
                ) : (
                  <CirclePlus size={24} />
                )}
              </button>
            </div>
            {showLyricsPreview && state.lyrics && (
              <article className="now-card lyric-preview">
                <div className="card-heading">
                  <span>Lyrics</span>
                  <button
                    className="icon-button"
                    onClick={onLyrics}
                    title="Open lyrics"
                  >
                    <Maximize2 size={16} />
                  </button>
                </div>
                <TimedLyricsPreview state={state} onPlayer={onPlayer} />
              </article>
            )}
            {artist && (
              <article className="now-card artist-card">
                {imageOf(artist.images) ? (
                  <button
                    className="artist-portrait"
                    onClick={() => onArtist(artist)}
                  >
                    <img src={imageOf(artist.images)} alt={artist.name} />
                    <strong>About the artist</strong>
                  </button>
                ) : (
                  <div className="card-heading">About the artist</div>
                )}
                <div className="card-content">
                  <button
                    className="text-link artist-card-name"
                    onClick={() => onArtist(artist)}
                  >
                    {artist.name}
                    {artist.verified && (
                      <BadgeCheck
                        className="verified-badge"
                        size={20}
                        aria-label="Verified artist"
                      />
                    )}
                  </button>
                  <div className="artist-card-row">
                    <p className="artist-stat">
                      {artist.monthly_listeners != null
                        ? `${artist.monthly_listeners.toLocaleString()} monthly listeners`
                        : artist.followers
                          ? `${artist.followers.total.toLocaleString()} followers`
                          : ""}
                    </p>
                    <button
                      className="pill outline"
                      onClick={() => onFollow(artist)}
                    >
                      {state.saved[artist.uri ?? `spotify:artist:${artist.id}`]
                        ? "Following"
                        : state.can_follow
                          ? "Follow"
                          : "Enable following"}
                    </button>
                  </div>
                  {artist.biography ? (
                    <p className="artist-bio">{artist.biography}</p>
                  ) : (
                    !!artist.genres?.length && (
                      <p className="artist-genres">
                        {artist.genres.slice(0, 3).join(" · ")}
                      </p>
                    )
                  )}
                </div>
              </article>
            )}
            <CreditsCard
              track={track}
              saved={state.saved}
              onArtist={onArtist}
              onFollow={onFollow}
            />
            {next && (
              <article className="now-card queue-card">
                <div className="card-heading">
                  <span>Next in queue</span>
                  <button className="text-link muted" onClick={onQueue}>
                    Open queue
                  </button>
                </div>
                <button
                  className="next-track"
                  onClick={() =>
                    onPlayer({ command: "play", uri: next.uri, track: next })
                  }
                >
                  <Cover images={next.album.images} />
                  <div>
                    <Marquee
                      text={next.name}
                      reduceMotion={state.settings.reduce_motion}
                    >
                      {next.name}
                    </Marquee>
                    <span>{artistNames(next)}</span>
                  </div>
                </button>
              </article>
            )}
            <div className="playing-on">
              <span className={state.native_ready ? "ready-dot" : ""} />
              <div>
                <small>Playing on</small>
                <strong>
                  {state.playback.device.name.startsWith("SpotiFlex")
                    ? "This computer"
                    : state.playback.device.name || "This computer"}
                </strong>
              </div>
            </div>
          </>
        ) : (
          <div className="empty-now">
            <Music2 />
            <h3>Nothing playing yet</h3>
            <p>Pick a song to make yourself at home.</p>
          </div>
        )}
      </div>
    </aside>
  );
}

/** The play queue, shown in the right panel in place of Now playing. */
export function QueuePanel({
  state,
  onPlayer,
  onClose,
}: {
  state: AppState;
  onPlayer: (request: PlayerRequest) => void;
  onClose: () => void;
}) {
  const track = state.playback.item,
    queue = state.details.queue;
  const row = (item: Track, current = false) => (
    <button
      className={`next-track queue-row ${current ? "current" : ""}`}
      onClick={
        current
          ? undefined
          : () => onPlayer({ command: "play", uri: item.uri, track: item })
      }
      disabled={current}
    >
      <Cover images={item.album.images} />
      <div>
        <Marquee text={item.name} reduceMotion={state.settings.reduce_motion}>
          {item.name}
        </Marquee>
        <span>{artistNames(item)}</span>
      </div>
    </button>
  );
  return (
    <aside className="now-playing queue-panel">
      {/* Liquid Glass already draws this artwork behind the window. */}
      {!state.settings.liquid_glass && (
        <Ambience
          track={track}
          reduceMotion={state.settings.reduce_motion}
          animate={state.playback.is_playing}
        />
      )}
      <div className="now-playing-scroll">
        <div className="section-heading">
          <h2>Queue</h2>
          <button className="icon-button" onClick={onClose} title="Close queue">
            <X size={18} />
          </button>
        </div>
        {track && !state.narrating && (
          <section className="queue-section">
            <h3>Now playing</h3>
            {row(track, true)}
          </section>
        )}
        <section className="queue-section">
          <h3>Next up</h3>
          {queue.length ? (
            queue.map((item, index) => (
              <Fragment key={`${item.uri}-${index}`}>{row(item)}</Fragment>
            ))
          ) : (
            <p className="queue-empty">Nothing is queued yet.</p>
          )}
        </section>
      </div>
    </aside>
  );
}

/** Performers plus songwriters, merged by name like Spotify's credits card. */
export function trackCredits(track: Track) {
  const credits = track.artists.map((artist) => ({
    name: artist.name,
    artist: artist as Artist | undefined,
    roles: ["Main Artist"],
  }));
  for (const writer of track.songwriters ?? []) {
    const existing = credits.find(
      (credit) => credit.name.toLowerCase() === writer.toLowerCase(),
    );
    if (existing) existing.roles.push("Writer");
    else credits.push({ name: writer, artist: undefined, roles: ["Writer"] });
  }
  return credits;
}

function CreditsCard({
  track,
  saved,
  onArtist,
  onFollow,
}: {
  track: Track;
  saved: Record<string, boolean>;
  onArtist: (artist: Artist) => void;
  onFollow: (artist: Artist) => void;
}) {
  const [all, setAll] = useState(false);
  useEffect(() => setAll(false), [track.uri]);
  const credits = trackCredits(track);
  return (
    <article className="now-card">
      <div className="card-heading">
        <span>Credits</span>
        {credits.length > 3 && (
          <button className="text-link muted" onClick={() => setAll(!all)}>
            {all ? "Show less" : "Show all"}
          </button>
        )}
      </div>
      <div className="card-content credit-list">
        {(all ? credits : credits.slice(0, 3)).map((credit) => (
          <div key={credit.name} className="credit">
            <div>
              {credit.artist ? (
                <button
                  className="text-link"
                  onClick={() => onArtist(credit.artist!)}
                >
                  {credit.name}
                </button>
              ) : (
                <span className="credit-name">{credit.name}</span>
              )}
              <p>{credit.roles.join(" • ")}</p>
            </div>
            {credit.artist?.id && (
              <button
                className="pill outline"
                onClick={() => onFollow(credit.artist!)}
              >
                {saved[
                  credit.artist.uri ?? `spotify:artist:${credit.artist.id}`
                ]
                  ? "Following"
                  : "Follow"}
              </button>
            )}
          </div>
        ))}
      </div>
    </article>
  );
}
