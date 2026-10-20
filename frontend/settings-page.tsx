import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ExternalLink, Info, LogOut, Search, X } from "lucide-react";
import type { AppState } from "./state";
import type { Settings } from "./types";
import { FontSettings } from "./custom-fonts";
import { SettingRow, SettingsQuery } from "./setting-row";

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <input
      className="toggle"
      type="checkbox"
      role="switch"
      aria-label={label}
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

export function SettingsPage({
  state,
  onSettings,
  onCall,
  onNotice,
}: {
  state: AppState;
  onSettings: (settings: Partial<Settings>) => void;
  onCall: <T = void>(
    command: string,
    args?: Record<string, unknown>,
  ) => Promise<T | undefined>;
  onNotice: (message: string, error?: boolean) => void;
}) {
  const [consent, setConsent] = useState(false);
  const [lyricsKey, setLyricsKey] = useState("");
  const [audioOutputs, setAudioOutputs] = useState<string[] | null>(null);
  const [audioRefresh, setAudioRefresh] = useState(0);
  const [testingOutput, setTestingOutput] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const searchField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!state.profile?.id) return;
    let active = true;
    void onCall<string[]>("audio_outputs").then((outputs) => {
      if (active && Array.isArray(outputs)) setAudioOutputs(outputs);
    });
    return () => {
      active = false;
    };
  }, [onCall, state.profile?.id, audioRefresh]);
  useEffect(() => {
    if (searching) searchField.current?.focus();
  }, [searching]);
  const settings = state.settings;
  const lyricSize = settings.lyric_size;
  return (
    <SettingsQuery.Provider value={query}>
      <div className={`settings-page ${query.trim() ? "searching" : ""}`}>
        <div className="settings-column">
          <header className="settings-header">
            <h1>Settings</h1>
            {searching ? (
              <label className="settings-search">
                <Search size={16} />
                <input
                  ref={searchField}
                  aria-label="Search settings"
                  placeholder="Search settings"
                  spellCheck={false}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setQuery("");
                      setSearching(false);
                    }
                  }}
                />
                <button
                  className="icon-button"
                  title="Close search"
                  onClick={() => {
                    setQuery("");
                    setSearching(false);
                  }}
                >
                  <X size={16} />
                </button>
              </label>
            ) : (
              <button
                className="icon-button"
                title="Search settings"
                onClick={() => setSearching(true)}
              >
                <Search size={18} />
              </button>
            )}
          </header>

          <section className="settings-section">
            <h2>Account</h2>
            {state.login_issue && !query.trim() && (
              <div className="settings-alert" role="alert">
                <p>{state.login_issue.message}</p>
                <button
                  className="pill"
                  disabled={state.login_pending}
                  onClick={() =>
                    void onCall("sign_in", { clientId: settings.client_id })
                  }
                >
                  Sign in again
                </button>
              </div>
            )}
            <SettingRow
              label={
                state.profile?.display_name || state.profile?.id || "Spotify"
              }
              help="Spotify connected"
              keywords="account sign out log out profile"
            >
              <button
                className="pill outline"
                onClick={() => void onCall("sign_out")}
              >
                <LogOut size={15} />
                Sign out
              </button>
            </SettingRow>
            {!state.can_follow && (
              <SettingRow
                label="Artist following"
                help="Allow SpotiFlex to follow your favourite artists."
                keywords="permissions scopes"
              >
                <button
                  className="pill outline"
                  onClick={() =>
                    void onCall("sign_in", { clientId: settings.client_id })
                  }
                >
                  Update permissions
                  <ExternalLink size={14} />
                </button>
              </SettingRow>
            )}
          </section>

          <section className="settings-section">
            <h2>Playback</h2>
            <SettingRow
              label="Audio output"
              help="Choose speakers or headphones for this computer."
              keywords="device speaker headphones sound"
            >
              <select
                className="settings-select"
                aria-label="Audio output"
                value={settings.audio_output || ""}
                onChange={(event) =>
                  onSettings({ audio_output: event.target.value || null })
                }
              >
                <option value="">System default</option>
                {settings.audio_output &&
                  !audioOutputs?.includes(settings.audio_output) && (
                    <option value={settings.audio_output}>
                      {settings.audio_output}
                      {audioOutputs ? " (unavailable)" : ""}
                    </option>
                  )}
                {audioOutputs?.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </SettingRow>
            <SettingRow
              label="New headphones or speakers connected?"
              keywords="audio output device refresh"
            >
              <button
                className="pill outline"
                onClick={() => setAudioRefresh((value) => value + 1)}
              >
                Refresh outputs
              </button>
            </SettingRow>
            <SettingRow
              label="Check the selected output with two quiet tones."
              keywords="audio output test sound"
            >
              <button
                className="pill outline"
                disabled={testingOutput}
                onClick={async () => {
                  setTestingOutput(true);
                  try {
                    if (await onCall<boolean>("test_audio_output"))
                      onNotice("Test sound sent to the selected output");
                  } finally {
                    setTestingOutput(false);
                  }
                }}
              >
                {testingOutput ? "Playing test sound…" : "Test output"}
              </button>
            </SettingRow>
            <SettingRow
              label="Native audio"
              help={
                <span className={state.native_ready ? "native-ready" : ""}>
                  {state.native_status}
                </span>
              }
              keywords="native audio reconnect playback engine"
            >
              <button
                className="pill outline"
                onClick={() => void onCall("retry_audio")}
              >
                Reconnect native audio
              </button>
            </SettingRow>
          </section>

          <section className="settings-section">
            <h2>Appearance</h2>
            <SettingRow
              label="Liquid Glass"
              help="Frosted, translucent panels that pick up colour from the artwork you're playing."
              keywords="theme glass blur translucent apple transparency"
            >
              <Toggle
                label="Liquid Glass"
                checked={Boolean(settings.liquid_glass)}
                onChange={(liquid_glass) => onSettings({ liquid_glass })}
              />
            </SettingRow>
            <SettingRow
              label="Reduce motion"
              help="Turn off animated backgrounds and word animations."
              keywords="animation accessibility"
            >
              <Toggle
                label="Reduce motion"
                checked={settings.reduce_motion}
                onChange={(reduce_motion) => onSettings({ reduce_motion })}
              />
            </SettingRow>
          </section>

          <section className="settings-section">
            <h2>Your Library</h2>
            <SettingRow
              label="Use compact library layout"
              keywords="compact library sidebar"
            >
              <Toggle
                label="Compact library"
                checked={settings.compact_library}
                onChange={(compact_library) => onSettings({ compact_library })}
              />
            </SettingRow>
          </section>

          <section className="settings-section">
            <h2>Fonts</h2>
            <FontSettings
              settings={settings}
              onSettings={onSettings}
              onNotice={onNotice}
            />
          </section>

          <section className="settings-section">
            <h2>Lyrics</h2>
            <SettingRow
              label="Lyric text size"
              help="Make room for every word."
              keywords="lyrics size font scale"
            >
              <span className="settings-range">
                <input
                  type="range"
                  aria-label="Lyric text size"
                  min="18"
                  max="60"
                  value={lyricSize}
                  style={
                    {
                      "--fill": `${((lyricSize - 18) / 42) * 100}%`,
                    } as CSSProperties
                  }
                  onChange={(event) =>
                    onSettings({ lyric_size: Number(event.target.value) })
                  }
                />
                <output>{Math.round(lyricSize)}</output>
              </span>
            </SettingRow>
            <SettingRow
              label="Timing offset"
              help="Shift lyrics earlier or later to match what you hear."
              keywords="lyrics sync delay offset milliseconds"
            >
              <span className="settings-number">
                <input
                  className="number-field"
                  type="number"
                  aria-label="Timing offset"
                  min="-10000"
                  max="10000"
                  step="50"
                  value={settings.lyric_offset_ms}
                  onChange={(event) =>
                    onSettings({ lyric_offset_ms: Number(event.target.value) })
                  }
                />
                ms
              </span>
            </SettingRow>
            {(
              [
                [
                  "romanized",
                  "Show romanized lyrics",
                  "Show a Latin-alphabet reading under lyrics that use other scripts.",
                ],
                [
                  "canvas_lyrics",
                  "Canvas in lyrics",
                  "Play the track's Canvas video behind the lyrics page.",
                ],
                [
                  "floating_lyrics",
                  "Floating lyrics",
                  "Let synced words float around the lyrics page.",
                ],
              ] as const
            ).map(([key, label, help]) => (
              <SettingRow key={key} label={label} help={help}>
                <Toggle
                  label={label}
                  checked={Boolean(settings[key])}
                  onChange={(checked) => onSettings({ [key]: checked })}
                />
              </SettingRow>
            ))}
          </section>

          {!state.provider_configured && (
            <section className="settings-section">
              <h2>Spicy Lyrics</h2>
              {state.provider_builtin ? (
                <SettingRow
                  label="Built-in lyrics provider"
                  help="Spicy Lyrics is included and ready to use. It receives the current track ID and your IP address; Spotify tokens stay on this computer."
                  keywords="lyrics provider spicy"
                />
              ) : (
                <SettingRow
                  stacked
                  label="Lyrics API key"
                  help={
                    state.provider_kind === "spicy"
                      ? "Your Spicy Lyrics key is saved in Windows Credential Manager."
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
                      Spicy Lyrics receives the current track ID and your IP
                      address. Spotify tokens stay on this computer.
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
                        Allow SpotiFlex to request lyrics from Spicy Lyrics
                        using this key and the current Spotify track ID.
                      </span>
                    </label>
                    {lyricsKey.trim().startsWith("sl_sk_") && (
                      <p className="source-error">
                        Use a publishable sl_pk_ key. Secret sl_sk_ keys belong
                        on your server.
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
              )}
            </section>
          )}

          <section className="settings-section">
            <h2>About SpotiFlex</h2>
            <SettingRow
              label={
                state.update_version
                  ? `Version ${state.update_version}`
                  : "Version 0.1.0"
              }
              help={state.update_status}
              keywords="updates version check install"
            >
              <button
                className="pill outline"
                onClick={() =>
                  void onCall("app_update", {
                    action:
                      state.update_status === "Ready to install"
                        ? "install"
                        : "check",
                  })
                }
              >
                {state.update_status === "Ready to install"
                  ? "Install update and restart"
                  : "Check for updates"}
              </button>
            </SettingRow>
            <SettingRow
              label="Download updates automatically"
              help="New versions are verified before they install."
              keywords="updates auto"
            >
              <Toggle
                label="Download updates automatically"
                checked={settings.auto_download_updates}
                onChange={(auto_download_updates) =>
                  onSettings({ auto_download_updates })
                }
              />
            </SettingRow>
          </section>

          <p className="settings-empty">No settings match “{query.trim()}”.</p>
        </div>
      </div>
    </SettingsQuery.Provider>
  );
}
