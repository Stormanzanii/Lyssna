import { useState } from "react";
import { ExternalLink, Info } from "lucide-react";
import type { AppState } from "./state";
import { SettingRow } from "./setting-row";

/** The Spicy Lyrics provider: built-in status, or the publishable key form. */
export function LyricsProvider({
  state,
  onCall,
  onNotice,
}: {
  state: AppState;
  onCall: <T = void>(
    command: string,
    args?: Record<string, unknown>,
  ) => Promise<T | undefined>;
  onNotice: (message: string, error?: boolean) => void;
}) {
  const [consent, setConsent] = useState(false);
  const [lyricsKey, setLyricsKey] = useState("");
  // The built-in provider needs no setup; its source row says what it receives.
  if (state.provider_builtin) return null;
  if (state.provider_configured && state.provider_kind !== "spicy") return null;
  return (
    <SettingRow
      stacked
      label="Lyrics API key"
      help={
        state.provider_kind === "spicy"
          ? "Your Spicy Lyrics key is saved securely on this device."
          : state.provider_configured
            ? "A previous lyrics provider is configured. Save your Spicy Lyrics key below to switch."
            : "Create an application in the Spicy Lyrics dashboard. Enable Client access and No origin header for this desktop app."
      }
      keywords="lyrics provider spicy key"
    >
      <div className="settings-key-form">
        <button
          className="text-link"
          onClick={() =>
            void onCall("open_link", {
              url: "https://developers.spicylyrics.org/dashboard",
            })
          }
        >
          Open Spicy Lyrics dashboard
          <ExternalLink size={13} />
        </button>
        <input
          className="field"
          aria-label="Lyrics API key"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={lyricsKey}
          placeholder="sl_pk_…"
          onChange={(event) => {
            setLyricsKey(event.target.value);
            setConsent(false);
          }}
        />
        <p className="setting-help">
          <Info size={13} />
          Spicy Lyrics receives the current track ID and your IP address.
          Spotify tokens stay on this computer.
        </p>
        {state.lyric_error && state.provider_kind === "spicy" && (
          <p className="source-error">{state.lyric_error}</p>
        )}
        <label className="consent-row">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
          />
          <span>
            Allow SpotiFlex to request lyrics from Spicy Lyrics using this key
            and the current Spotify track ID.
          </span>
        </label>
        {lyricsKey.trim().startsWith("sl_sk_") && (
          <p className="source-error">
            Use a publishable sl_pk_ key. Secret sl_sk_ keys belong on your
            server.
          </p>
        )}
        <button
          className="pill"
          disabled={
            !lyricsKey.trim() ||
            !consent ||
            lyricsKey.trim().startsWith("sl_sk_")
          }
          onClick={() => {
            void onCall("configure_spicy_lyrics", {
              key: lyricsKey.trim(),
              consent,
            });
            setLyricsKey("");
            setConsent(false);
            onNotice("Saving Spicy Lyrics key…");
          }}
        >
          Save lyrics key
        </button>
      </div>
    </SettingRow>
  );
}
