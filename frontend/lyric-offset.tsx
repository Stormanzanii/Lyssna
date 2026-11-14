import { useState, type CSSProperties } from "react";
import { SettingRow } from "./setting-row";
import type { Settings } from "./types";

const LIMIT = 10_000;
const SLIDER = 2_000;

const clamp = (value: number) =>
  Math.max(-LIMIT, Math.min(LIMIT, Math.round(value)));

/** How far lyrics shift for `uri`: the offset for all songs plus the song's
 *  own. */
export function lyricOffset(
  settings: Pick<Settings, "lyric_offset_ms" | "lyric_song_offsets">,
  uri?: string,
) {
  const own = uri ? (settings.lyric_song_offsets?.[uri] ?? 0) : 0;
  return (settings.lyric_offset_ms ?? 0) + own;
}

export function OffsetSetting({
  settings,
  uri,
  title,
  onSettings,
}: {
  settings: Settings;
  uri?: string;
  title?: string;
  onSettings: (settings: Partial<Settings>) => void;
}) {
  const [scope, setScope] = useState<"all" | "song">("all");
  const song = scope === "song" && !!uri;
  const value = song
    ? (settings.lyric_song_offsets?.[uri] ?? 0)
    : (settings.lyric_offset_ms ?? 0);
  const set = (next: number) => {
    const amount = clamp(next);
    if (!song) return onSettings({ lyric_offset_ms: amount });
    const offsets = { ...settings.lyric_song_offsets };
    if (amount) offsets[uri] = amount;
    else delete offsets[uri];
    onSettings({ lyric_song_offsets: offsets });
  };
  const fill =
    ((Math.max(-SLIDER, Math.min(SLIDER, value)) + SLIDER) / (2 * SLIDER)) *
    100;
  return (
    <SettingRow
      label="Timing offset"
      help={
        song
          ? `Shifts lyrics for ${title || "this song"} only, on top of the offset for all songs.`
          : "Shift lyrics earlier or later to match what you hear. A song's own offset adds to this one."
      }
      keywords="lyrics sync delay offset milliseconds per song this song all songs"
      stacked
    >
      <div className="offset-setting">
        <div
          className="offset-scope"
          role="radiogroup"
          aria-label="Offset applies to"
        >
          <button
            role="radio"
            aria-checked={!song}
            onClick={() => setScope("all")}
          >
            All songs
          </button>
          <button
            role="radio"
            aria-checked={song}
            disabled={!uri}
            title={uri ? undefined : "Play a song first"}
            onClick={() => setScope("song")}
          >
            This song
          </button>
        </div>
        <span className="settings-range">
          <input
            type="range"
            aria-label="Timing offset"
            min={-SLIDER}
            max={SLIDER}
            step={10}
            value={Math.max(-SLIDER, Math.min(SLIDER, value))}
            style={{ "--fill": `${fill}%` } as CSSProperties}
            onChange={(event) => set(Number(event.target.value))}
          />
        </span>
        <div className="offset-steps">
          {[-100, -10].map((step) => (
            <button key={step} onClick={() => set(value + step)}>
              {step}
            </button>
          ))}
          <input
            key={`${scope}:${value}`}
            className="number-field"
            type="number"
            aria-label="Offset in milliseconds"
            min={-LIMIT}
            max={LIMIT}
            step={10}
            defaultValue={value}
            onBlur={(event) => {
              const typed = Number(event.target.value);
              if (Number.isFinite(typed)) set(typed);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <span className="offset-unit">ms</span>
          {[10, 100].map((step) => (
            <button key={step} onClick={() => set(value + step)}>
              +{step}
            </button>
          ))}
        </div>
      </div>
    </SettingRow>
  );
}
