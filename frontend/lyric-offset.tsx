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
  const shown = Math.max(-SLIDER, Math.min(SLIDER, value));
  const at = ((shown + SLIDER) / (2 * SLIDER)) * 100;
  const total = lyricOffset(settings, uri);
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
        <div className="offset-top">
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
          <div className="offset-stepper">
            {[-100, -10].map((step) => (
              <button
                key={step}
                aria-label={`${step}`}
                onClick={() => set(value + step)}
              >
                {`\u2212${-step}`}
              </button>
            ))}
            <label className="offset-value">
              <input
                key={`${scope}:${value}`}
                type="text"
                inputMode="numeric"
                aria-label="Offset in milliseconds"
                defaultValue={value > 0 ? `+${value}` : `${value}`}
                onFocus={(event) => event.currentTarget.select()}
                onBlur={(event) => {
                  const typed = Number(
                    event.target.value.replace(/\u2212/g, "-").trim(),
                  );
                  if (Number.isFinite(typed)) set(typed);
                  else event.target.value = `${value}`;
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                    event.preventDefault();
                    set(value + (event.key === "ArrowUp" ? 10 : -10));
                  }
                }}
              />
              <span>ms</span>
            </label>
            {[10, 100].map((step) => (
              <button
                key={step}
                aria-label={`+${step}`}
                onClick={() => set(value + step)}
              >
                +{step}
              </button>
            ))}
          </div>
          <button
            className="offset-reset"
            disabled={!value}
            onClick={() => set(0)}
          >
            Reset
          </button>
        </div>
        <div className="offset-track">
          <span>Later</span>
          <input
            type="range"
            aria-label="Timing offset"
            min={-SLIDER}
            max={SLIDER}
            step={10}
            value={shown}
            style={
              {
                "--from": `${Math.min(at, 50)}%`,
                "--to": `${Math.max(at, 50)}%`,
              } as CSSProperties
            }
            onChange={(event) => set(Number(event.target.value))}
          />
          <span>Earlier</span>
        </div>
        {song && (
          <p className="offset-total">
            With the offset for all songs, this song's lyrics shift{" "}
            {total > 0 ? `+${total}` : total} ms.
          </p>
        )}
      </div>
    </SettingRow>
  );
}
