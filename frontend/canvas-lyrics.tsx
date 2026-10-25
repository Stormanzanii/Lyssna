import { useEffect, useRef, useState, type RefObject } from "react";
import { IS_MAC } from "./platform";

const AMBIENT_WIDTH = 80;
// Canvases run at 24 to 30 fps, so redrawing the backdrop faster buys nothing.
const AMBIENT_INTERVAL_MS = 1000 / 30;
// Same grade as the lyrics ambience, so lyric contrast is unchanged.
const AMBIENT_FILTER = "blur(5px) saturate(2.5) brightness(0.65)";

/** One sharp video; its tiny, graded frame supplies the blurred lyrics backdrop. */
export function LyricsCanvas({
  url,
  poster,
  playing,
  backdrop,
  onActive,
}: {
  url: string;
  poster?: string;
  playing: boolean;
  backdrop: RefObject<HTMLCanvasElement | null>;
  onActive?: (active: boolean) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    onActive?.(false);
  }, [url, onActive]);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    if (playing) void element.play().catch(() => {});
    else element.pause();
  }, [playing, url]);
  useEffect(() => {
    const element = video.current,
      canvas = backdrop.current,
      context = canvas?.getContext("2d", {
        alpha: false,
        willReadFrequently: IS_MAC,
      });
    if (!element || !canvas || !context) return;
    const root = element.closest<HTMLElement>(".lyrics-page"),
      cover = element.parentElement!;
    const resize = () => {
      if (element.videoWidth)
        cover.style.aspectRatio = `${element.videoWidth}/${element.videoHeight}`;
      const box = root?.getBoundingClientRect();
      if (!box) return;
      root!.style.setProperty(
        "--canvas-sharp-edge",
        `${cover.getBoundingClientRect().width}px`,
      );
      // Spicy Lyrics' backdrop: an 80px frame, blurred there so the blur costs
      // a few thousand pixels instead of a full-page filter. CSS stretches it.
      const width = AMBIENT_WIDTH;
      const height = Math.max(
        1,
        Math.round((width * box.height) / Math.max(1, box.width)),
      );
      if (canvas.width !== width || canvas.height !== height) {
        // Resizing clears the canvas and its filter.
        canvas.width = width;
        canvas.height = height;
        primed = false;
      }
    };
    let frame = 0,
      last = 0,
      lastTime = -1,
      // False until the backdrop holds a real frame; the first draw replaces
      // instead of blending.
      primed = false;
    resize();
    const observer = new ResizeObserver(resize);
    if (root) observer.observe(root);
    observer.observe(cover);
    element.addEventListener("loadedmetadata", resize);
    const draw = (now: number) => {
      if (
        now - last >= AMBIENT_INTERVAL_MS &&
        element.readyState >= 2 &&
        element.videoWidth > 0 &&
        element.videoHeight > 0 &&
        element.currentTime !== lastTime &&
        !document.hidden
      ) {
        last = now;
        lastTime = element.currentTime;
        const scale =
            Math.max(
              canvas.width / element.videoWidth,
              canvas.height / element.videoHeight,
            ) * 1.3,
          width = element.videoWidth * scale,
          height = element.videoHeight * scale;
        context.imageSmoothingEnabled = true;
        context.filter = IS_MAC ? "none" : AMBIENT_FILTER;
        // Blending into the previous frame keeps the glow from flickering
        // with fast cuts.
        context.globalAlpha = primed ? 0.3 : 1;
        context.drawImage(
          element,
          (canvas.width - width) / 2,
          (canvas.height - height) / 2,
          width,
          height,
        );
        context.globalAlpha = 1;
        primed = true;
        // WebKit has no canvas filters, so the Mac backdrop is only darkened.
        if (IS_MAC) {
          context.fillStyle = "rgba(0, 0, 0, 0.35)";
          context.fillRect(0, 0, canvas.width, canvas.height);
        }
      }
      if (element.isConnected && !element.paused && !element.ended)
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
      element.removeEventListener("loadedmetadata", resize);
      observer.disconnect();
      context.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [url, backdrop, failed]);
  return (
    <div className="cover lyrics-canvas-cover">
      {failed ? (
        <img src={poster} alt="Album artwork" />
      ) : (
        <video
          ref={video}
          data-canvas-video
          // Active means a frame is on screen. A paused video keeps its
          // frame, so pausing must not swap the page back to the artwork.
          onLoadedData={() => onActive?.(true)}
          onPlaying={() => onActive?.(true)}
          src={url}
          poster={poster}
          muted
          loop
          playsInline
          preload="auto"
          autoPlay={playing}
          onError={() => {
            setFailed(true);
            onActive?.(false);
            if (backdrop.current) backdrop.current.style.display = "none";
          }}
          aria-label="Spotify Canvas"
        />
      )}
    </div>
  );
}
