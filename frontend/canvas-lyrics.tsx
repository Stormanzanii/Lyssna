import { useEffect, useRef, useState, type RefObject } from "react";

/** One sharp video; its small, graded frame supplies the blurred lyrics backdrop. */
export function LyricsCanvas({
  url,
  poster,
  playing,
  backdrop,
}: {
  url: string;
  poster?: string;
  playing: boolean;
  backdrop: RefObject<HTMLCanvasElement | null>;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    if (playing) void element.play().catch(() => {});
    else element.pause();
  }, [playing, url]);
  useEffect(() => {
    const element = video.current,
      canvas = backdrop.current,
      context = canvas?.getContext("2d", { alpha: false });
    if (!element || !canvas || !context) return;
    let frame = 0,
      last = 0;
    const draw = (now: number) => {
      if (now - last >= 100 && element.readyState >= 2 && !document.hidden) {
        last = now;
        context.filter = "blur(9px) saturate(1.25) brightness(0.5)";
        context.drawImage(element, -24, -24, 176, 176);
      }
      if (!element.paused && !element.ended)
        frame = requestAnimationFrame(draw);
    };
    const start = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    };
    element.addEventListener("playing", start);
    element.addEventListener("loadeddata", start);
    element.addEventListener("seeked", start);
    start();
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("playing", start);
      element.removeEventListener("loadeddata", start);
      element.removeEventListener("seeked", start);
      context.clearRect(0, 0, 128, 128);
    };
  }, [url, backdrop]);
  return (
    <div className="cover lyrics-canvas-cover">
      {failed ? (
        <img src={poster} alt="Album artwork" />
      ) : (
        <video
          ref={video}
          src={url}
          poster={poster}
          muted
          loop
          playsInline
          preload="auto"
          autoPlay={playing}
          onError={() => setFailed(true)}
          aria-label="Spotify Canvas"
        />
      )}
    </div>
  );
}
