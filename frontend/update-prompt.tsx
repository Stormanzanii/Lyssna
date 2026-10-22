import { useEffect, useRef, useState } from "react";
import { rpc } from "./bridge";
import type { AppState } from "./state";

/** Updates belong to the app, independently of the Spotify account. */
export function UpdatePrompt({
  state,
  enabled,
}: {
  state: Pick<
    AppState,
    "update_version" | "update_notes" | "update_status" | "settings"
  >;
  enabled: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [dismissed, setDismissed] = useState<string>();
  const [requested, setRequested] = useState<"download" | "install">();
  const [error, setError] = useState("");
  const version = state.update_version;
  const status = state.update_status;
  const ready = status === "Ready to install";
  const downloading =
    status.startsWith("Downloading update") ||
    (status === "Update available" && state.settings.auto_download_updates);
  const open =
    enabled && !!version && version !== dismissed && status !== "Up to date";
  useEffect(() => {
    setRequested(undefined);
    setError("");
  }, [status, version]);
  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) element.showModal();
    if (!open && element?.open) element.close();
  }, [open]);
  const apply = async () => {
    const action = ready ? "install" : "download";
    setRequested(action);
    setError("");
    try {
      await rpc("app_update", { action });
    } catch (reason) {
      setRequested(undefined);
      setError(String(reason));
    }
  };
  const dismiss = () => {
    if (requested === "install") return;
    setDismissed(version);
    dialog.current?.close();
  };
  return (
    <dialog
      ref={dialog}
      className="dialog update-dialog"
      aria-labelledby="update-title"
      aria-describedby="update-description"
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        );
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (!first) {
          event.preventDefault();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <h2 id="update-title">SpotiFlex {version} is available</h2>
      <p id="update-description">
        You're using version {__APP_VERSION__}. Updating restarts SpotiFlex.
      </p>
      {state.update_notes && (
        <section aria-label="Release notes">
          <h3>What changed</h3>
          <p className="update-notes">{state.update_notes}</p>
        </section>
      )}
      <p role="status" aria-live="polite">
        {requested === "install"
          ? "Installing update…"
          : error || (ready ? "Download verified. Ready to install." : status)}
      </p>
      <div className="inline-actions">
        <button
          className="pill outline"
          disabled={requested === "install"}
          onClick={dismiss}
        >
          Not now
        </button>
        <button
          className="pill primary"
          disabled={!!requested || downloading}
          onClick={() => void apply()}
        >
          {requested === "install"
            ? "Installing…"
            : ready
              ? "Install and restart"
              : downloading || requested === "download"
                ? "Downloading…"
                : "Download update"}
        </button>
      </div>
    </dialog>
  );
}
