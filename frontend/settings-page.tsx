import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ExternalLink, Info, LogOut, Search, X } from "lucide-react";
import type { AppState } from "./state";
import type { Settings, SpotifyPlus } from "./types";
import { FontSettings } from "./custom-fonts";
import { SettingRow, SettingsQuery } from "./setting-row";
import { Credits } from "./credits";
import { IS_MAC } from "./platform";

export function Toggle({
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
  onLyricsSettings,
}: {
  state: AppState;
  onSettings: (settings: Partial<Settings>) => void;
  /** Opens the Lyrics settings window. */
  onLyricsSettings: () => void;
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
  const [cacheBytes, setCacheBytes] = useState<number | null>(null);
  const [clearingCache, setClearingCache] = useState(false);
  useEffect(() => {
    let active = true;
    void onCall<number>("audio_cache_size").then((bytes) => {
      if (active && typeof bytes === "number") setCacheBytes(bytes);
    });
    return () => {
      active = false;
    };
  }, [onCall]);
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
  const plus = settings.spotify_plus ?? {};
  const setPlus = (change: Partial<SpotifyPlus>) =>
    onSettings({ spotify_plus: { ...plus, ...change } });
  const chosenFolders = new Set(plus.playlist_folders ?? []);
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
                  onClick={() => void onCall("sign_in", { clientId: "" })}
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
                  onClick={() => void onCall("sign_in", { clientId: "" })}
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
            {settings.liquid_glass && (
              <SettingRow
                label="Refraction"
                help="Bends what's behind glass controls like real curved glass. Uses noticeably more GPU."
                keywords="liquid glass refraction lens distortion gpu"
              >
                <Toggle
                  label="Refraction"
                  checked={Boolean(settings.liquid_glass_refraction)}
                  onChange={(liquid_glass_refraction) =>
                    onSettings({ liquid_glass_refraction })
                  }
                />
              </SettingRow>
            )}
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
            <SettingRow
              stacked
              label="Add to playlist folders"
              help={
                state.library_folders?.length
                  ? "Offer only playlists directly inside the folders you choose. Choose none to offer every playlist you can edit."
                  : "Your library has no folders."
              }
              keywords="add playlist folders menu"
            >
              <div className="settings-folder-picks">
                {(state.library_folders ?? []).map((folder) => (
                  <label key={folder.id}>
                    <input
                      type="checkbox"
                      checked={chosenFolders.has(folder.id)}
                      onChange={(event) => {
                        const next = new Set(chosenFolders);
                        if (event.target.checked) next.add(folder.id);
                        else next.delete(folder.id);
                        setPlus({ playlist_folders: [...next] });
                      }}
                    />
                    <span>
                      {[
                        ...folder.parents.map(
                          (parent) =>
                            state.library_folders?.find(
                              (item) => item.id === parent,
                            )?.name ?? "",
                        ),
                        folder.name,
                      ]
                        .filter(Boolean)
                        .join(" / ")}
                    </span>
                  </label>
                ))}
              </div>
            </SettingRow>
          </section>

          <section className="settings-section">
            <h2>Lyrics</h2>
            <SettingRow
              label="Lyrics settings"
              help="Lyric size, timing, font, effects, sources and Space Gravity live in their own window."
              keywords="lyrics font size offset romanized canvas gravity word sync spicy provider key sources"
            >
              <button className="pill outline" onClick={onLyricsSettings}>
                Open
              </button>
            </SettingRow>
          </section>

          <section className="settings-section">
            <h2>Fonts</h2>
            <FontSettings
              field="ui_font"
              settings={settings}
              onSettings={onSettings}
              onNotice={onNotice}
            />
          </section>

          <section className="settings-section">
            <h2>Storage</h2>
            <SettingRow
              label={`Cache: ${cacheBytes === null ? "…" : `${Math.round(cacheBytes / 1_048_576).toLocaleString()} MB`}`}
              help="Songs you have played, kept on this computer so they start faster and use less data."
              keywords="cache storage disk offline data clear"
            >
              <button
                className="pill outline"
                disabled={clearingCache || !cacheBytes}
                onClick={() => {
                  setClearingCache(true);
                  void onCall<number>("clear_audio_cache")
                    .then((freed) => {
                      setCacheBytes(0);
                      onNotice(
                        `Cleared ${Math.round((freed ?? 0) / 1_048_576).toLocaleString()} MB of cached songs.`,
                      );
                    })
                    .finally(() => setClearingCache(false));
                }}
              >
                Clear cache
              </button>
            </SettingRow>
          </section>

          <section className="settings-section">
            <h2>About SpotiFlex</h2>
            <SettingRow
              label={`Version ${__APP_VERSION__}`}
              help={
                state.update_version
                  ? `${state.update_status} · v${state.update_version}`
                  : state.update_status
              }
              keywords="updates version check install"
            >
              <button
                className="pill outline"
                disabled={
                  IS_MAC || state.update_status.startsWith("Downloading update")
                }
                onClick={() =>
                  void onCall("app_update", {
                    action:
                      state.update_status === "Ready to install"
                        ? "install"
                        : state.update_status === "Update available"
                          ? "download"
                          : "check",
                  })
                }
              >
                {state.update_status === "Ready to install"
                  ? "Install update and restart"
                  : state.update_status === "Update available"
                    ? "Download update"
                    : "Check for updates"}
              </button>
            </SettingRow>
            {!IS_MAC && (
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
            )}
          </section>

          <section className="settings-section">
            <h2>Credits and licences</h2>
            <SettingRow
              stacked
              label="Built with thanks to"
              keywords="about credits licence license spicy lyrics spotify plus pixel spikerko librespot"
            >
              <Credits onOpen={(url) => void onCall("open_link", { url })} />
            </SettingRow>
          </section>

          <p className="settings-empty">No settings match “{query.trim()}”.</p>
        </div>
      </div>
    </SettingsQuery.Provider>
  );
}
