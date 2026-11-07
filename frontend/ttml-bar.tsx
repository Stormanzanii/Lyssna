import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronUp, FilePenLine, Music2, Pause, Play } from "lucide-react";
import { formatTime } from "./ttml-creator-model";

export interface BarSpan {
  start: number;
  end: number;
  current: boolean;
  label: number;
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
  speed,
  minSpeed,
  maxSpeed,
  speedEnabled,
  onSpeed,
  volume,
  onVolume,
  song,
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
  speed: number;
  minSpeed: number;
  maxSpeed: number;
  speedEnabled: boolean;
  onSpeed: (speed: number) => void;
  volume: number;
  onVolume: (percent: number) => void;
  song: ReactNode;
}) {
  const [panel, setPanel] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!panel) return;
    const away = (event: PointerEvent) =>
      !root.current?.contains(event.target as Node) && setPanel(false);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setPanel(false);
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", escape, true);
    };
  }, [panel]);
  const fill = (value: number, min: number, max: number) => ({
    ["--fill" as string]: `${((value - min) / (max - min)) * 100}%`,
  });
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
    // Timed lines sit in their own lane above the waveform, numbered when
    // there is room, so each block reads apart from its neighbours.
    const lane = 18;
    const font = getComputedStyle(element).fontFamily;
    context.font = `600 10px ${font}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    const current = spans.find((line) => line.current);
    for (const line of spans) {
      const left = x(line.start) + 0.5;
      const span = Math.max(2, x(line.end) - x(line.start) - 1);
      context.fillStyle = line.current ? "#1ed760" : "#ffffff40";
      context.beginPath();
      context.roundRect(left, 2, span, lane - 4, 3);
      context.fill();
      if (span >= 18) {
        context.fillStyle = line.current ? "#000" : "#ffffffd9";
        context.fillText(String(line.label), left + span / 2, lane / 2 + 0.5);
      }
    }
    if (current) {
      context.fillStyle = "#1ed76014";
      context.fillRect(
        x(current.start),
        lane,
        Math.max(1, x(current.end) - x(current.start)),
        height - lane,
      );
    }
    const played = x(shown);
    const middle = lane + (height - lane) / 2;
    const reach = (height - lane) / 2 - 3;
    const step = 3;
    for (let left = 0; left < width; left += step) {
      let loud = 0.03;
      if (peaks?.length) {
        const from = Math.floor((left / width) * peaks.length);
        const to = Math.max(
          from + 1,
          Math.floor(((left + step) / width) * peaks.length),
        );
        for (let index = from; index < to && index < peaks.length; index++)
          loud = Math.max(loud, peaks[index] / 255);
      }
      const half = Math.max(1, loud * reach);
      context.fillStyle = left < played ? "#ffffffd9" : "#ffffff38";
      context.fillRect(left, middle - half, step - 1, half * 2);
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
    <div className="ttml-bar" ref={root}>
      {panel && (
        <div
          className="ttml-bar-panel"
          role="dialog"
          aria-label="Playback controls"
        >
          <div className="ttml-bar-panel-row">
            <strong>Playback speed</strong>
            <output>{speed.toFixed(2)}×</output>
          </div>
          <div className="ttml-bar-presets">
            {[0.5, 0.75, 1, 1.25].map((preset) => (
              <button
                key={preset}
                className={Math.abs(speed - preset) < 0.001 ? "active" : ""}
                disabled={!speedEnabled}
                onClick={() => onSpeed(preset)}
              >
                {preset}×
              </button>
            ))}
          </div>
          <input
            type="range"
            aria-label="Playback speed"
            min={minSpeed}
            max={maxSpeed}
            step={0.05}
            value={speed}
            disabled={!speedEnabled}
            style={fill(speed, minSpeed, maxSpeed)}
            onChange={(event) => onSpeed(Number(event.target.value))}
          />
          {!speedEnabled && (
            <small>Speed works when playing on this computer.</small>
          )}
          <div className="ttml-bar-panel-row">
            <strong>Volume</strong>
            <output>{Math.round(volume)}%</output>
          </div>
          <input
            type="range"
            aria-label="Volume"
            min={0}
            max={100}
            step={1}
            value={volume}
            style={fill(volume, 0, 100)}
            onChange={(event) => onVolume(Number(event.target.value))}
          />
          <div className="ttml-bar-song">{song}</div>
        </div>
      )}
      <button
        className={`ttml-bar-round${panel ? " active" : ""}`}
        aria-label="Playback controls"
        aria-expanded={panel}
        title="Speed and volume"
        onClick={() => setPanel(!panel)}
      >
        <Music2 size={16} />
      </button>
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
