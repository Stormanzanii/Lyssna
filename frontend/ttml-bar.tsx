import { useEffect, useRef, useState } from "react";
import { ChevronUp, FilePenLine, Pause, Play } from "lucide-react";
import { formatTime } from "./ttml-creator-model";

export interface BarSpan {
  start: number;
  end: number;
  current: boolean;
}

export function TtmlBar({
  position,
  duration,
  playing,
  peaks,
  spans,
  onToggle,
  onSeek,
  onShowPlayer,
  onClose,
}: {
  position: number;
  duration: number;
  playing: boolean;
  peaks: Uint8Array | null;
  spans: BarSpan[];
  onToggle: () => void;
  onSeek: (ms: number) => void;
  onShowPlayer: () => void;
  onClose?: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const shown = dragging ?? position;
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context || !width) return;
    const scale = devicePixelRatio;
    const height = element.clientHeight;
    element.width = Math.round(width * scale);
    element.height = Math.round(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    const span = Math.max(1, duration);
    const x = (ms: number) => (Math.min(span, Math.max(0, ms)) / span) * width;
    for (const line of spans) {
      context.fillStyle = line.current ? "#1ed76040" : "#ffffff17";
      context.fillRect(
        x(line.start),
        0,
        Math.max(1, x(line.end) - x(line.start)),
        height,
      );
    }
    const played = x(shown);
    const middle = height / 2;
    const step = 2;
    for (let left = 0; left < width; left += step) {
      let loud = 0.02;
      if (peaks?.length) {
        const from = Math.floor((left / width) * peaks.length);
        const to = Math.max(
          from + 1,
          Math.floor(((left + step) / width) * peaks.length),
        );
        for (let index = from; index < to && index < peaks.length; index++)
          loud = Math.max(loud, peaks[index] / 255);
      }
      const half = Math.max(0.5, loud * (middle - 2));
      context.fillStyle = left < played ? "#ffffffcc" : "#ffffff4d";
      context.fillRect(left, middle - half, step - 0.5, half * 2);
    }
    context.fillStyle = "#fff";
    context.fillRect(Math.round(played) - 1, 0, 2, height);
  }, [width, peaks, spans, shown, duration]);

  const timeAt = (clientX: number) => {
    const box = canvas.current!.getBoundingClientRect();
    return (
      (Math.min(box.width, Math.max(0, clientX - box.left)) / box.width) *
      duration
    );
  };
  return (
    <div className="ttml-bar">
      <button
        className="ttml-bar-play"
        onClick={onToggle}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? (
          <Pause size={16} fill="currentColor" />
        ) : (
          <Play size={16} fill="currentColor" />
        )}
      </button>
      <span className="ttml-bar-time">{formatTime(shown)}</span>
      <canvas
        ref={canvas}
        className={`ttml-bar-wave${peaks ? "" : " loading"}`}
        role="slider"
        aria-label="Song position"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={Math.round(shown)}
        tabIndex={0}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(timeAt(event.clientX));
        }}
        onPointerMove={(event) =>
          dragging !== null && setDragging(timeAt(event.clientX))
        }
        onPointerUp={(event) => {
          if (dragging === null) return;
          onSeek(timeAt(event.clientX));
          setDragging(null);
        }}
        onPointerCancel={() => setDragging(null)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          event.stopPropagation();
          onSeek(position + (event.key === "ArrowLeft" ? -3000 : 3000));
        }}
      />
      <span className="ttml-bar-time">{formatTime(duration)}</span>
      <div className="player-extras ttml-bar-extras">
        {onClose && (
          <button
            className="icon-button ttml-button active"
            title="TTML Creator"
            onClick={onClose}
          >
            <FilePenLine size={19} />
          </button>
        )}
        <button
          className="icon-button"
          onClick={onShowPlayer}
          title="Show the player bar"
          aria-label="Show the player bar"
        >
          <ChevronUp size={18} />
        </button>
      </div>
    </div>
  );
}
