import { memo, useEffect, useRef } from "react";
import Kawarp from "@kawarp/core";
import type { Track } from "./types";
export const Ambience = memo(function Ambience({
  track,
  reduceMotion = false,
  animate = false,
}: {
  track?: Track;
  reduceMotion?: boolean;
  animate?: boolean;
}) {
  const source = track?.album.images?.[0]?.url ?? "",
    surface = useRef<HTMLCanvasElement>(null),
    renderer = useRef<Kawarp | null>(null),
    resume = useRef<(() => void) | null>(null),
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
    const tick = (time: number) => {
      if (!allowed()) return;
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
      if (allowed()) frame = requestAnimationFrame(tick);
    };
    resume.current = restart;
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
    void renderer.current
      ?.loadImage(source)
      .then(() => {
        if (!cancelled) resume.current?.();
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
