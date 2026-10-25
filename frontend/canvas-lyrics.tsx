import { useEffect, useRef, useState, type RefObject } from "react";
import { IS_MAC } from "./platform";

/** One sharp video; its small, graded frame supplies the blurred lyrics backdrop. */
export function LyricsCanvas({
  url,
  poster,
  playing,
  backdrop,
  onActive,
  artworkRight = false,
}: {
  url: string;
  poster?: string;
  playing: boolean;
  backdrop: RefObject<HTMLCanvasElement | null>;
  onActive?: (active: boolean) => void;
  artworkRight?: boolean;
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
      // A small, smoothly scaled frame provides the Mac blur without applying
      // WebKit's filter pipeline to a continuously changing video texture.
      const width = IS_MAC ? 64 : 512;
      const height = Math.max(
        1,
        Math.round((width * box.height) / Math.max(1, box.width)),
      );
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    };
    resize();
    const observer = new ResizeObserver(resize);
    if (root) observer.observe(root);
    observer.observe(cover);
    element.addEventListener("loadedmetadata", resize);
    let frame = 0,
      last = 0;
    // Stacked layout shows the video as a small header thumbnail, so the
    // backdrop covers the whole page instead of extending the sharp video.
    const fillPage = () => {
      const fit = Math.max(
          canvas.width / element.videoWidth,
          canvas.height / element.videoHeight,
        ),
        width = canvas.width / fit,
        height = canvas.height / fit;
      context.drawImage(
        element,
        (element.videoWidth - width) / 2,
        (element.videoHeight - height) / 2,
        width,
        height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    };
    const draw = (now: number) => {
      if (
        now - last >= 100 &&
        element.readyState >= 2 &&
        element.videoWidth > 0 &&
        element.videoHeight > 0 &&
        !document.hidden
      ) {
        last = now;
        // Clear the whole opaque surface, including pixels outside the two
        // reflected crops. Otherwise old frames accumulate along their edges.
        context.filter = "none";
        context.fillStyle = "#000";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        if (!IS_MAC)
          context.filter = "blur(8px) saturate(2.5) brightness(0.65)";
        fillPage();
        if (!root?.classList.contains("narrow")) {
          const bounds = root?.getBoundingClientRect(),
            frame = cover.getBoundingClientRect(),
            rootWidth = Math.max(1, bounds?.width ?? 1),
            rootHeight = Math.max(1, bounds?.height ?? 1),
            edge = Math.max(
              1,
              Math.min(
                canvas.width,
                Math.round((frame.width / rootWidth) * canvas.width),
              ),
            ),
            sharpX = artworkRight ? canvas.width - edge : 0,
            boundary = artworkRight ? sharpX : edge,
            top =
              ((frame.top - (bounds?.top ?? 0)) / rootHeight) * canvas.height,
            height = (frame.height / rootHeight) * canvas.height,
            bleed = Math.max(2, Math.ceil((canvas.width * 24) / 512));
          const scale = Math.max(
              frame.width / element.videoWidth,
              frame.height / element.videoHeight,
            ),
            sourceWidth = frame.width / scale,
            sourceHeight = frame.height / scale,
            sourceX = (element.videoWidth - sourceWidth) / 2,
            sourceY = (element.videoHeight - sourceHeight) / 2;
          context.drawImage(
            element,
            sourceX,
            sourceY,
            sourceWidth,
            sourceHeight,
            sharpX,
            top,
            edge,
            height,
          );
          context.save();
          context.translate(boundary * 2, 0);
          context.scale(-1, 1);
          context.drawImage(
            element,
            sourceX + sourceWidth * (artworkRight ? 0 : 0.8),
            sourceY,
            sourceWidth * 0.2,
            sourceHeight,
            artworkRight ? boundary - 1 : edge * 2 - canvas.width - bleed,
            top,
            canvas.width - edge + bleed + 1,
            height,
          );
          context.restore();
        }
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
  }, [url, backdrop, failed, artworkRight]);
  return (
    <div className="cover lyrics-canvas-cover">
      {failed ? (
        <img src={poster} alt="Album artwork" />
      ) : (
        <video
          ref={video}
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
