import { useEffect, useState } from "react";
import { SettingRow } from "./setting-row";

/** Optional Musixmatch user token, kept in the system credential store.
 *  Settings only learns whether one is saved, never the token itself. */
export function MusixmatchToken({
  onCall,
  onNotice,
}: {
  onCall: <T = void>(
    command: string,
    args?: Record<string, unknown>,
  ) => Promise<T | undefined>;
  onNotice: (message: string, error?: boolean) => void;
}) {
  const [saved, setSaved] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void onCall<boolean>("musixmatch_token_saved").then((value) => {
      if (active) setSaved(!!value);
    });
    return () => {
      active = false;
    };
  }, [onCall]);
  const save = async (value: string) => {
    setBusy(true);
    try {
      await onCall("save_musixmatch_token", { token: value });
      const now = !!(await onCall<boolean>("musixmatch_token_saved"));
      setSaved(now);
      // A failed save has already said why; keep what was typed.
      if (now === !!value) {
        setToken("");
        onNotice(
          now ? "Musixmatch token saved" : "Using automatic Musixmatch tokens",
        );
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingRow
      stacked
      label="Musixmatch token"
      help={
        saved
          ? "Your own token is saved securely on this device and used for Musixmatch lyrics."
          : "Optional. Leave empty to use automatic tokens, which Refresh renews."
      }
      keywords="musixmatch token user key refresh"
    >
      <div className="settings-key-form">
        <input
          className="field"
          aria-label="Musixmatch token"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={token}
          placeholder={saved ? "Saved" : "Musixmatch user token"}
          onChange={(event) => setToken(event.target.value)}
        />
        <div className="inline-actions">
          <button
            className="pill"
            disabled={busy || !token.trim()}
            onClick={() => void save(token.trim())}
          >
            Save token
          </button>
          {saved ? (
            <button
              className="pill outline"
              disabled={busy}
              onClick={() => void save("")}
            >
              Remove token
            </button>
          ) : (
            <button
              className="pill outline"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onCall<boolean>("renew_musixmatch_token")
                  .then((renewed) => {
                    if (renewed) onNotice("Musixmatch token refreshed");
                  })
                  .finally(() => setBusy(false));
              }}
            >
              Refresh token
            </button>
          )}
        </div>
      </div>
    </SettingRow>
  );
}
