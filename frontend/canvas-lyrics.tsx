import { useEffect, useRef, useState, type RefObject } from "react";

/** One sharp video; its small, graded frame supplies the blurred lyrics backdrop. */
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
      context = canvas?.getContext("2d", { alpha: false });
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
      const height = Math.max(1, Math.round((512 * box.height) / box.width));
      if (canvas.width !== 512) canvas.width = 512;
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
      if (now - last >= 100 && element.readyState >= 2 && !document.hidden) {
        last = now;
        context.filter = "blur(8px) saturate(1.25) brightness(0.5)";
        if (root?.classList.contains("narrow")) fillPage();
        else {
          const bounds = root?.getBoundingClientRect(),
            frame = cover.getBoundingClientRect(),
            rootWidth = bounds?.width ?? 1,
            rootHeight = bounds?.height ?? 1,
            edge = (frame.width / rootWidth) * canvas.width,
            top =
              ((frame.top - (bounds?.top ?? 0)) / rootHeight) * canvas.height,
            height = (frame.height / rootHeight) * canvas.height;
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
            0,
            top,
            edge,
            height,
          );
          context.save();
          context.translate(edge * 2, 0);
          context.scale(-1, 1);
          context.drawImage(
            element,
            sourceX + sourceWidth * 0.8,
            sourceY,
            sourceWidth * 0.2,
            sourceHeight,
            edge * 2 - canvas.width - 24,
            top,
            canvas.width - edge + 24,
            height,
          );
          context.restore();
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
          onPlaying={() => onActive?.(true)}
          onPause={() => onActive?.(false)}
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
