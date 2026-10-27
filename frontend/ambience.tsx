import { memo, useEffect, useRef, useState } from "react";
import Kawarp from "@kawarp/core";
import type { Track } from "./types";
import {
  ambienceFps,
  ambienceSize,
  onWindowActivity,
  windowActivity,
} from "./window-activity";
export const Ambience = memo(function Ambience({
  track,
  image,
  reduceMotion = false,
  animate = false,
  warp = 1,
  speed = 1,
  shade = true,
  saturation = 3,
  followCanvas = false,
}: {
  track?: Track;
  /** Artwork URL used instead of the track's album art. */
  image?: string;
  reduceMotion?: boolean;
  animate?: boolean;
  /** Kawarp warp intensity; 1 matches the lyrics page. */
  warp?: number;
  /** Kawarp animation speed; 1 matches the lyrics page. */
  speed?: number;
  /** Omit when the parent applies this same gradient with its other shading. */
  shade?: boolean;
  /** Kawarp colour boost. 3, its maximum, stands in for Spicy Lyrics'
   * `saturate(2.5)` filter on top of 1.5 without a full-panel filter pass. */
  saturation?: number;
  /** Warp the panel's playing Canvas video instead of the artwork, as Spicy
   * Lyrics' Now Playing background does. */
  followCanvas?: boolean;
}) {
  const source = image ?? track?.album.images?.[0]?.url ?? "",
    surface = useRef<HTMLCanvasElement>(null),
    renderer = useRef<Kawarp | null>(null),
    resume = useRef<((settleMs?: number) => void) | null>(null),
    following = useRef<HTMLVideoElement | null>(null),
    artwork = useRef(source),
    motion = useRef({ animate, reduceMotion });
  motion.current = { animate, reduceMotion };
  // A GPU reset, as a game can cause, loses the canvas's WebGL context and
  // leaves a flat colour. Each loss swaps in a fresh canvas and renderer.
  const [generation, setGeneration] = useState(0);
  artwork.current = source;
  useEffect(() => {
    const canvas = surface.current;
    if (!canvas) return;
    let engine: Kawarp;
    try {
      engine = new Kawarp(canvas, {
        warpIntensity: 1,
        blurPasses: 8,
        animationSpeed: 1,
        saturation,
        dithering: 0.008,
        transitionDuration: 500,
        tintIntensity: 0,
        scale: 1,
        highPrecisionOutput: true,
      });
    } catch {
      // The GPU may still be coming back; try again shortly.
      const retry = setTimeout(() => setGeneration((value) => value + 1), 2000);
      return () => clearTimeout(retry);
    }
    renderer.current = engine;
    const lost = (event: Event) => {
      event.preventDefault();
      setGeneration((value) => value + 1);
    };
    canvas.addEventListener("webglcontextlost", lost);
    let frame = 0,
      last = 0,
      // Still ambience keeps drawing until this time so artwork crossfades,
      // which run on the wall clock, finish instead of freezing at the start.
      settle = 0,
      visible = true,
      disposed = false;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)"),
      allowed = () =>
        !disposed &&
        visible &&
        !document.hidden &&
        ambienceFps(windowActivity()) > 0 &&
        motion.current.animate &&
        !motion.current.reduceMotion &&
        !reduced.matches;
    const settling = () =>
      !disposed &&
      visible &&
      !document.hidden &&
      !windowActivity().minimized &&
      performance.now() < settle;
    const tick = (time: number) => {
      if (!allowed() && !settling()) return;
      if (time - last >= 1000 / Math.max(1, ambienceFps(windowActivity()))) {
        engine.renderFrame();
        last = time;
      }
      frame = requestAnimationFrame(tick);
    };
    const restart = () => {
      cancelAnimationFrame(frame);
      if (disposed) return;
      engine.start();
      engine.stop();
      engine.renderFrame();
      // Kawarp samples video frames only while its own loop runs. Ours paces
      // the drawing, so the engine is marked playing without that loop.
      if (following.current && allowed())
        (engine as unknown as { isPlaying: boolean }).isPlaying = true;
      if (allowed() || settling()) frame = requestAnimationFrame(tick);
    };
    resume.current = (settleMs = 0) => {
      settle = Math.max(settle, performance.now() + settleMs);
      restart();
    };
    const resize = () => {
      const box = canvas.getBoundingClientRect(),
        longest = ambienceSize(windowActivity()),
        scale = Math.min(
          1,
          longest / Math.max(1, box.width),
          longest / Math.max(1, box.height),
        ),
        width = Math.max(1, Math.round(box.width * scale)),
        height = Math.max(1, Math.round(box.height * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        engine.resize();
      }
      restart();
    };
    const sizes = new ResizeObserver(resize);
    sizes.observe(canvas);
    resize();
    const observer = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? false;
      restart();
    });
    observer.observe(canvas);
    document.addEventListener("visibilitychange", restart);
    // Background windows redraw a smaller canvas at a lower frame rate.
    const stopActivity = onWindowActivity(resize);
    reduced.addEventListener("change", restart);
    return () => {
      disposed = true;
      canvas.removeEventListener("webglcontextlost", lost);
      cancelAnimationFrame(frame);
      sizes.disconnect();
      observer.disconnect();
      document.removeEventListener("visibilitychange", restart);
      stopActivity();
      reduced.removeEventListener("change", restart);
      resume.current = null;
      renderer.current = null;
      engine.dispose();
    };
  }, [generation]);
  useEffect(() => {
    if (!followCanvas) return;
    const engine = renderer.current;
    if (!engine) return;
    let failed: HTMLVideoElement | null = null;
    const stopFollowing = () => {
      if (!following.current) return;
      following.current = null;
      delete surface.current?.dataset.source;
      engine.unloadVideo();
      if (artwork.current)
        void engine
          .loadImage(artwork.current)
          .then(() => resume.current?.(engine.transitionDuration + 100))
          .catch(() => {});
    };
    // The panel's own Canvas comes and goes with songs; look for it twice a
    // second rather than threading the element through every parent. Only
    // this ambience's panel is searched, so the lyrics page's Canvas never
    // tints Now Playing.
    const panel = surface.current?.parentElement?.parentElement;
    const look = () => {
      const video = panel?.querySelector<HTMLVideoElement>(
        "video[data-canvas-video]",
      );
      if (!video || video === failed) return stopFollowing();
      if (video === following.current) return;
      try {
        engine.loadVideo(video, {
          // Canvases are 9:16; keep that shape in the colour map.
          sampleWidth: 72,
          sampleHeight: 128,
          // Background windows sample fewer frames, as they draw fewer.
          frameRate: Math.max(1, ambienceFps(windowActivity())),
          // Fast cuts ease in instead of flashing across the panel.
          smoothing: 100,
          onError: () => {
            failed = video;
            stopFollowing();
          },
        });
      } catch {
        failed = video;
        return;
      }
      following.current = video;
      if (surface.current) surface.current.dataset.source = "canvas";
      resume.current?.();
    };
    look();
    const timer = setInterval(look, 500);
    return () => {
      clearInterval(timer);
      stopFollowing();
    };
  }, [followCanvas, generation]);
  useEffect(() => {
    if (!source || following.current) return;
    let cancelled = false;
    const engine = renderer.current;
    void engine
      ?.loadImage(source)
      .then(() => {
        if (!cancelled) resume.current?.(engine.transitionDuration + 100);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [source, generation]);
  useEffect(() => resume.current?.(), [animate, reduceMotion]);
  useEffect(() => {
    renderer.current?.setOptions({
      warpIntensity: warp,
      animationSpeed: speed,
      saturation,
    });
  }, [warp, speed, saturation, generation]);
  return (
    <div
      className={`ambience ${reduceMotion ? "still" : ""}`}
      aria-hidden="true"
    >
      <canvas
        key={generation}
        width={512}
        height={288}
        ref={surface}
        className="ambient-layer"
      />
      {shade && <div className="ambient-shade" />}
    </div>
  );
});
