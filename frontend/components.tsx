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
import {
  Music2,
  Plus,
  Check,
  Maximize2,
  Upload,
  RotateCw,
  Mic2,
  ArrowUpRight,
  ChevronUp,
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
import { useCreatorProfile, creatorEmbed } from "./creator-profile";
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
}: {
  images?: { url: string }[];
  className?: string;
  onClick?: () => void;
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
    >
      {inner}
    </button>
  ) : (
    <div className={`cover ${className}`}>{inner}</div>
  );
}
const ambientCovers = new Map<string, Promise<string | undefined>>();
function ambientCover(source: string): Promise<string | undefined> {
  const cached = ambientCovers.get(source);
  if (cached) return cached;
  const result = new Promise<string | undefined>((resolve) => {
    const cover = new Image();
    cover.crossOrigin = "anonymous";
    cover.referrerPolicy = "no-referrer";
    cover.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        const context = canvas.getContext("2d");
        if (!context) {
          resolve(undefined);
          return;
        }
        context.filter = "blur(8px) saturate(1.3)";
        context.drawImage(cover, -16, -16, 96, 96);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      } catch {
        resolve(undefined);
      }
    };
    cover.onerror = () => resolve(undefined);
    cover.src = source;
  });
  if (ambientCovers.size >= 64) ambientCovers.clear();
  ambientCovers.set(source, result);
  return result;
}

export const Ambience = memo(function Ambience({
  track,
  reduceMotion = false,
  animate = false,
}: {
  track?: Track;
  reduceMotion?: boolean;
  animate?: boolean;
}) {
  const source = imageOf(track?.album.images);
  const [background, setBackground] = useState<{
    source: string;
    image?: string;
  }>();
  const surface = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    if (source)
      void ambientCover(source).then((image) => {
        if (!cancelled) setBackground({ source, image });
      });
    return () => {
      cancelled = true;
    };
  }, [source]);
  useEffect(() => {
    const canvas = surface.current;
    if (
      !canvas ||
      !background ||
      background.source !== source ||
      !background.image
    )
      return;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    const texture = new Image();
    let timer: ReturnType<typeof setTimeout> | undefined,
      cancelled = false,
      visible = true,
      phase = 0;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const draw = () => {
      context.globalCompositeOperation = "source-over";
      context.globalAlpha = 1;
      context.drawImage(texture, 0, 0, 128, 128);
      for (let layer = 0; layer < 2; layer++) {
        context.save();
        context.globalCompositeOperation = "source-over";
        context.globalAlpha = 0.5;
        context.translate(
          64 + Math.sin(phase + layer * 2) * 15,
          64 + Math.cos(phase * 0.7 + layer) * 12,
        );
        context.rotate(phase * (layer === 0 ? 1 : -0.7) + layer * 2);
        context.drawImage(texture, -110, -110, 220, 220);
        context.restore();
      }
    };
    const loop = () => {
      timer = undefined;
      if (
        cancelled ||
        !visible ||
        document.hidden ||
        !animate ||
        reduceMotion ||
        reduced.matches
      )
        return;
      phase += 0.0035;
      draw();
      timer = setTimeout(loop, 50);
    };
    const resume = () => {
      clearTimeout(timer);
      timer = undefined;
      if (texture.complete && texture.naturalWidth) {
        draw();
        loop();
      }
    };
    const observer = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? false;
      resume();
    });
    observer.observe(canvas);
    texture.onload = () => {
      if (!cancelled) resume();
    };
    texture.src = background.image;
    document.addEventListener("visibilitychange", resume);
    reduced.addEventListener("change", resume);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener("visibilitychange", resume);
      reduced.removeEventListener("change", resume);
    };
  }, [background, source, animate, reduceMotion]);
  return (
    <div
      className={`ambience ${reduceMotion ? "still" : ""}`}
      aria-hidden="true"
    >
      <canvas
        width={128}
        height={128}
        ref={surface}
        className="ambient-layer"
        style={{
          backgroundImage:
            background && background.source === source && background.image
              ? `url("${background.image}")`
              : undefined,
        }}
      />
      <div className="ambient-shade" />
    </div>
  );
});

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
            onClick={() => onArtist(artist)}
          >
            {artist.name}
          </button>
        </span>
      ))}
    </>
  );
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
        onClick={() => onAlbum(track.album)}
      >
        {track.name}
      </button>
    </Marquee>
  );
}

export function usePosition(
  state: Pick<AppState, "playback" | "observed_at" | "clock_revision">,
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
  const [centered, setCentered] = useState(false);
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
        className="lyric-wait"
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
    setCentered(false);
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
        .closest(".lyrics-layout")
        ?.querySelector(".lyrics-album>.cover");
      const anchor = centered
        ? container.clientHeight * 0.46
        : compact
          ? 0
          : Math.max(
              8,
              (cover?.getBoundingClientRect().top ??
                container.getBoundingClientRect().top + 40) -
                container.getBoundingClientRect().top,
            );
      container.style.setProperty("--lead-top", `${anchor}px`);
      spring.current.target = Math.max(
        0,
        Math.min(
          container.scrollHeight - container.clientHeight,
          line.offsetTop - anchor,
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
      .closest(".lyrics-layout")
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
    centered,
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
    >
      <div
        className="lyric-scroll"
        ref={scroll}
        onWheel={() => setFollowing(false)}
        onTouchStart={() => setFollowing(false)}
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
                  setCentered(true);
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
      {!following && (
        <button
          className="follow-lyrics icon-button"
          title="Resume following"
          aria-label="Resume following"
          onClick={() => setFollowing(true)}
        >
          <ChevronUp size={23} />
        </button>
      )}
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
              {creatorEmbed(person.id) || url ? (
                <button
                  className="text-link"
                  onClick={() =>
                    creatorEmbed(person.id)
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
        return (
          <span key={index} className="lyric-word-group">
            {whitespace}
            <span
              className="lyric-word"
              style={
                {
                  "--word-lift": 0,
                  "--word-scale": 1,
                  "--word-glow": 0,
                } as CSSProperties
              }
            >
              {group.map((word, part) => {
                const text =
                  part === 0 ? word.text.slice(whitespace.length) : word.text;
                const letters = Array.from(text);
                const syllableMotion = wordMotion(
                  word.start_ms,
                  word.end_ms,
                  time,
                );
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
                          reduceMotion || emphasis ? 0 : syllableMotion.lift,
                        "--syllable-scale":
                          reduceMotion || emphasis ? 1 : syllableMotion.scale,
                        "--syllable-glow":
                          reduceMotion || emphasis ? 0 : syllableMotion.glow,
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
                                  "--letter-lift": motion.lift,
                                  "--letter-scale": motion.scale,
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
export function LyricsPage({
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
  return (
    <section
      className={`lyrics-page ${state.settings.reduce_motion ? "reduce-motion" : ""}`}
    >
      <Ambience
        track={track}
        reduceMotion={state.settings.reduce_motion}
        animate={state.playback.is_playing}
      />
      {track ? (
        <>
          <div className="lyrics-album">
            <Cover
              images={track.album.images}
              onClick={() => onAlbum(track.album)}
            />
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
            {state.lyrics ? (
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
  return (
    <aside className="now-playing">
      <Ambience track={track} reduceMotion={state.settings.reduce_motion} />
      <div className="now-playing-scroll">
        <div className="section-heading">
          <h2>Now playing</h2>
          <button
            className="icon-button"
            onClick={onLyrics}
            title="Open lyrics"
          >
            <Maximize2 size={17} />
          </button>
        </div>
        {track ? (
          <>
            <Cover
              images={track.album.images}
              className="now-artwork"
              onClick={() => onAlbum(track.album)}
            />
            <div className="now-track">
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
