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
import { LyricsCanvas } from "./canvas-lyrics";
import { FloatingLyrics } from "./floating-lyrics";
import {
  Music2,
  Plus,
  Check,
  Maximize2,
  Upload,
  RotateCw,
  Mic2,
  ArrowUpRight,
  Headphones,
} from "lucide-react";
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
import { activeLines, progress } from "./state";
import { PlaybackClock } from "./playback-clock";
import { rpc } from "./bridge";
import { useCreatorProfile } from "./creator-profile";
import {
  stepScroll,
  vocalGaps,
  type VocalGap,
  wordMotion,
  letterMotion,
  wordGroups,
  vocalGap,
  type ScrollSpring,
} from "./lyric-motion";

export const imageOf = (images?: { url: string }[]) =>
  images?.find((image) => image.url.startsWith("https://"))?.url;
export const artistNames = (track?: Track) =>
  track?.artists.map((artist) => artist.name).join(", ") ?? "";
export function Cover({
  images,
  className = "",
  onClick,
  contextRoute,
  contextName,
}: {
  images?: { url: string }[];
  className?: string;
  onClick?: () => void;
  contextRoute?: string;
  contextName?: string;
}) {
  const src = imageOf(images);
  const inner = src ? (
    <img src={src} alt="" draggable={false} />
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

export function ArtistLinks({
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
}
export function ExplicitBadge({ track }: { track: Track }) {
  return track.explicit ? (
    <span className="explicit-badge" aria-label="Explicit" title="Explicit">
      E
    </span>
  ) : null;
}
export function TrackTitle({
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
}

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
  const browse = () => {
    setFollowing(false);
    clearTimeout(resume.current);
    resume.current = setTimeout(() => setFollowing(true), 3000);
  };
  useEffect(() => () => clearTimeout(resume.current), []);
  const lines = useRef<(HTMLButtonElement | null)[]>([]);
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
      <div
        key={item.start}
        ref={visible ? waiting : undefined}
        aria-hidden={!visible}
        className={`lyric-wait ${item.opposite ? "opposite" : ""}`}
        role="status"
        aria-label="Instrumental break"
      >
        {[0, 1, 2].map((index) => {
          const phase = Math.max(
            0,
            Math.min(
              1,
              ((positionMs - item.start) / (item.end - item.start)) * 3 - index,
            ),
          );
          const lift = settings.reduce_motion ? 0 : Math.sin(phase * Math.PI);
          return (
            <i
              key={index}
              style={
                {
                  "--dot-opacity": 0.35 + phase * 0.65,
                  "--dot-lift": lift,
                } as CSSProperties
              }
            />
          );
        })}
      </div>
    );
  };
  const active = activeLines(lyrics.lines, positionMs);
  const primary =
    active.find((index) => !lyrics.lines[index].background) ??
    lyrics.lines.reduce(
      (last, line, index) =>
        line.start_ms <= positionMs && !line.background ? index : last,
      0,
    );
  useEffect(() => {
    setFollowing(true);
  }, [lyrics]);
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
      const motion = spring.current;
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
      const coverBox = cover?.getBoundingClientRect();
      const focus = compact
        ? 56
        : coverBox
          ? coverBox.top +
            coverBox.height / 2 -
            container.getBoundingClientRect().top
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
      className={`lyrics-display ${compact ? "compact" : ""} ${!lyrics.synced ? "static-lyrics" : ""} ${settings.reduce_motion ? "reduce-motion" : ""}`}
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
          {
            "--lyric-size": `${compact ? 28 : Math.round(settings.lyric_size * 1.6)}px`,
          } as CSSProperties
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
                ref={(element) => {
                  lines.current[index] = element;
                }}
                key={`${line.start_ms}-${index}`}
                className={`lyric-line ${playing ? "active" : ""} ${line.background ? "background-vocal" : ""} ${line.opposite ? "opposite" : ""} ${index < primary ? "past" : ""}`}
                style={{ "--distance": Math.min(5, distance) } as CSSProperties}
                onClick={() => {
                  if (lyrics.synced) {
                    onSeek(line.words[0]?.start_ms ?? line.start_ms);
                    setFollowing(true);
                  }
                }}
                disabled={!lyrics.synced}
              >
                <span className="lyric-main">
                  <LyricWords
                    line={line}
                    time={
                      playing ||
                      (positionMs >= line.start_ms &&
                        positionMs <= line.end_ms + 450)
                        ? positionMs
                        : -1
                    }
                    reduceMotion={settings.reduce_motion}
                  />
                </span>
                {settings.romanized && line.romanization && (
                  <span className="lyric-romanization">
                    {line.romanization}
                  </span>
                )}
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
  return (
    <div className={`lyric-source ${expanded ? "expanded" : ""}`}>
      Lyrics provided by: {source}
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

const LyricWords = memo(function LyricWords({
  line,
  time,
  reduceMotion,
}: {
  line: Line;
  time: number;
  reduceMotion: boolean;
}) {
  const groups = useMemo(() => wordGroups(line.words), [line]);
  if (!line.words.length) return <>{line.text}</>;
  return (
    <>
      {groups.map((group, index) => {
        const whitespace = group[0].text.match(/^\s+/u)?.[0] ?? "";
        const motion = wordMotion(
          group[0].start_ms,
          group.at(-1)!.end_ms,
          time,
        );
        const held = group.some((word) => word.end_ms - word.start_ms >= 1000);
        const split = group.length > 1;
        return (
          <span key={index} className="lyric-word-group">
            {whitespace}
            <span
              className="lyric-word"
              style={
                {
                  "--word-lift": reduceMotion || split ? 0 : motion.lift,
                  "--word-scale":
                    reduceMotion || split
                      ? 1
                      : 1 + (motion.scale - 1) * (held ? 0.4 : 1),
                  "--word-glow": reduceMotion ? 0 : motion.glow,
                } as CSSProperties
              }
            >
              {group.map((word, part) => {
                const text =
                  part === 0 ? word.text.slice(whitespace.length) : word.text;
                const letters = Array.from(text);
                const syllable = wordMotion(word.start_ms, word.end_ms, time);
                const emphasis =
                  !reduceMotion &&
                  word.end_ms - word.start_ms >= 1000 &&
                  letters.length <= 32 &&
                  !/[\s\u0590-\u08ff]/u.test(text);
                return (
                  <span
                    key={part}
                    className={`lyric-syllable ${emphasis ? "emphasis" : ""}`}
                    style={
                      {
                        "--word-progress": `${progress(word.start_ms, word.end_ms, time) * 120 - 20}%`,
                        "--syllable-lift":
                          split && !reduceMotion ? syllable.lift * 1.6 : 0,
                        "--syllable-scale":
                          split && !reduceMotion
                            ? 1 + (syllable.scale - 1) * 0.8
                            : 1,
                        "--syllable-glow": reduceMotion ? 0 : motion.glow,
                      } as CSSProperties
                    }
                  >
                    {emphasis
                      ? letters.map((letter, index) => {
                          const motion = letterMotion(
                            word.start_ms,
                            word.end_ms,
                            time,
                            index,
                            letters.length,
                          );
                          return (
                            <span
                              key={index}
                              className="lyric-letter"
                              style={
                                {
                                  "--letter-lift": motion.lift * 0.5,
                                  "--letter-scale":
                                    1 + (motion.scale - 1) * 0.5,
                                  "--letter-glow": motion.glow,
                                  "--word-progress": `${motion.fill * 120 - 20}%`,
                                } as CSSProperties
                              }
                            >
                              {letter}
                            </span>
                          );
                        })
                      : text}
                  </span>
                );
              })}
            </span>
          </span>
        );
      })}
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
  return state.lyrics ? (
    <LyricsDisplay
      lyrics={state.lyrics}
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
export function DJArtwork() {
  return (
    <div className="dj-art" aria-label="DJ artwork">
      <Headphones aria-hidden="true" />
    </div>
  );
}
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
export function LyricsPage(props: Parameters<typeof SongLyricsPage>[0]) {
  return props.state.narrating ? (
    <section className="lyrics-page dj-view">
      <DJPresentation playing={props.state.playback.is_playing} />
    </section>
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
}: {
  state: AppState;
  onPlayer: (request: PlayerRequest) => void;
  onImport: () => void;
  onRetry: () => void;
} & Links) {
  const current = usePosition(state) + state.settings.lyric_offset_ms,
    track = state.playback.item;
  const backdrop = useRef<HTMLCanvasElement>(null);
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
  const floating = !!(
    state.settings.floating_lyrics &&
    state.lyrics?.synced &&
    motionAllowed
  );
  return (
    <section
      className={`lyrics-page ${canvas ? "canvas-lyrics" : ""} ${state.settings.reduce_motion ? "reduce-motion" : ""}`}
    >
      {(!canvas || !canvasPlaying) && (
        <Ambience
          track={track}
          reduceMotion={state.settings.reduce_motion}
          animate={state.playback.is_playing}
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
            <Marquee
              text={`${track.album.release_date?.slice(0, 4) ? track.album.release_date.slice(0, 4) + " · " : ""}${artistNames(track)}`}
              reduceMotion={state.settings.reduce_motion}
              className="lyrics-artists"
            >
              {track.album.release_date && (
                <span>{track.album.release_date.slice(0, 4)} · </span>
              )}
              <ArtistLinks artists={track.artists} onArtist={onArtist} />
            </Marquee>
          </div>
          <div className="lyrics-body">
            {state.lyrics && floating ? (
              <FloatingLyrics
                lyrics={state.lyrics}
                time={current}
                onSeek={(positionMs) =>
                  onPlayer({ command: "seek", positionMs })
                }
                credits={
                  <>
                    <p>
                      Written by:{" "}
                      {(state.lyrics.songwriters?.length
                        ? state.lyrics.songwriters
                        : (track.songwriters ?? [])
                      ).join(", ") || "Songwriter credits unavailable"}
                    </p>
                    <LyricCredits lyrics={state.lyrics} expanded />
                  </>
                }
              />
            ) : state.lyrics ? (
              <LyricsDisplay
                lyrics={state.lyrics}
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
        <DJPresentation playing={state.playback.is_playing} />
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
      <Ambience track={track} reduceMotion={state.settings.reduce_motion} />
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
                {saved ? <Check size={20} /> : <Plus size={20} />}
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
                  <div className="artist-card-heading">
                    <button
                      className="text-link"
                      onClick={() => onArtist(artist)}
                    >
                      {artist.name}
                    </button>
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
                  {artist.monthly_listeners != null && (
                    <p className="artist-stat">
                      {artist.monthly_listeners.toLocaleString()} monthly
                      listeners
                    </p>
                  )}
                  {artist.followers && (
                    <p className="artist-stat">
                      {artist.followers.total.toLocaleString()} followers
                    </p>
                  )}
                  {!!artist.genres?.length && (
                    <p className="artist-genres">
                      {artist.genres.slice(0, 3).join(" · ")}
                    </p>
                  )}
                  <button
                    className="text-link muted artist-profile-link"
                    onClick={() => onArtist(artist)}
                  >
                    Explore artist
                    <ArrowUpRight size={15} />
                  </button>
                </div>
              </article>
            )}
            <article className="now-card">
              <div className="card-heading">Credits</div>
              <div className="card-content credit-list">
                {track.artists.map((credit) => (
                  <div key={credit.id ?? credit.name} className="credit">
                    <div>
                      <button
                        className="text-link"
                        onClick={() => onArtist(credit)}
                      >
                        {credit.name}
                      </button>
                      <p>Artist</p>
                    </div>
                    {credit.id && (
                      <button
                        className="pill outline"
                        onClick={() => onFollow(credit)}
                      >
                        {state.saved[
                          credit.uri ?? `spotify:artist:${credit.id}`
                        ]
                          ? "Following"
                          : "Follow"}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </article>
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
