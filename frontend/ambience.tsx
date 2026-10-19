import { memo, useEffect, useRef } from "react";
import Kawarp from "@kawarp/core";
import type { Track } from "./types";
export const Ambience = memo(function Ambience({
  track,
  image,
  reduceMotion = false,
  animate = false,
}: {
  track?: Track;
  /** Artwork URL used instead of the track's album art. */
  image?: string;
  reduceMotion?: boolean;
  animate?: boolean;
}) {
  const source = image ?? track?.album.images?.[0]?.url ?? "",
    surface = useRef<HTMLCanvasElement>(null),
    renderer = useRef<Kawarp | null>(null),
    resume = useRef<((settleMs?: number) => void) | null>(null),
    motion = useRef({ animate, reduceMotion });
  motion.current = { animate, reduceMotion };
  useEffect(() => {
    const canvas = surface.current;
    if (!canvas) return;
    let engine: Kawarp;
    try {
      engine = new Kawarp(canvas, {
        warpIntensity: 1,
        blurPasses: 8,
        animationSpeed: 1,
        saturation: 1.5,
        dithering: 0.008,
        transitionDuration: 500,
        tintIntensity: 0,
        scale: 1,
        highPrecisionOutput: true,
      });
    } catch {
      return;
    }
    renderer.current = engine;
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
        motion.current.animate &&
        !motion.current.reduceMotion &&
        !reduced.matches;
    const settling = () =>
      !disposed && visible && !document.hidden && performance.now() < settle;
    const tick = (time: number) => {
      if (!allowed() && !settling()) return;
      if (time - last >= 1000 / 30) {
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
      if (allowed() || settling()) frame = requestAnimationFrame(tick);
    };
    resume.current = (settleMs = 0) => {
      settle = Math.max(settle, performance.now() + settleMs);
      restart();
    };
    const resize = () => {
      const box = canvas.getBoundingClientRect(),
        scale = Math.min(
          1,
          768 / Math.max(1, box.width),
          768 / Math.max(1, box.height),
        );
      canvas.width = Math.max(1, Math.round(box.width * scale));
      canvas.height = Math.max(1, Math.round(box.height * scale));
      engine.resize();
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
    reduced.addEventListener("change", restart);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      sizes.disconnect();
      observer.disconnect();
      document.removeEventListener("visibilitychange", restart);
      reduced.removeEventListener("change", restart);
      resume.current = null;
      renderer.current = null;
      engine.dispose();
    };
  }, []);
  useEffect(() => {
    if (!source) return;
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
  }, [source]);
  useEffect(() => resume.current?.(), [animate, reduceMotion]);
  return (
    <div
      className={`ambience ${reduceMotion ? "still" : ""}`}
      aria-hidden="true"
    >
      <canvas
        width={512}
        height={288}
        ref={surface}
        className="ambient-layer"
      />
      <div className="ambient-shade" />
    </div>
  );
});
