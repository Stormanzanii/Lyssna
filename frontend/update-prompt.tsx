import { useEffect, useRef, useState } from "react";
import { rpc } from "./bridge";
import { nightlyProgress } from "./nightly-dialog";
import type { AppState } from "./state";

/** Updates belong to the app, independently of the Spotify account. */
export function UpdatePrompt({
  state,
  enabled,
  current,
}: {
  state: Pick<
    AppState,
    "update_version" | "update_notes" | "update_status" | "settings" | "nightly"
  >;
  enabled: boolean;
  /** This copy's Nightly commit, when it is one. */
  current?: string | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [dismissed, setDismissed] = useState<string>();
  const [requested, setRequested] = useState<"download" | "install">();
  const [error, setError] = useState("");
  const version = state.update_version;
  const status = state.update_status;
  const ready = status === "Ready to install";
  // Nightly updates are built on this computer rather than downloaded.
  const nightly = !!version?.startsWith("Nightly");
  const downloading =
    status.startsWith("Downloading update") ||
    status.startsWith("Building update") ||
    (status === "Update available" && state.settings.auto_download_updates);
  // A background Nightly build's progress, while it runs.
  const report = nightly && state.nightly?.running ? state.nightly : undefined;
  const step = report?.steps.find((item) => item.state === "running");
  const percent = report ? Math.round(nightlyProgress(report) * 100) : 0;
  const open =
    enabled && !!version && version !== dismissed && status !== "Up to date";
  // Checking for a Nightly by hand shows what was found again.
  useEffect(() => {
    const show = () => setDismissed(undefined);
    window.addEventListener("spotiflex:show-update", show);
    return () => window.removeEventListener("spotiflex:show-update", show);
  }, []);
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
        You're using{" "}
        {nightly && current
          ? `Nightly ${current.slice(0, 7)}`
          : `version ${__APP_VERSION__}`}
        . Updating restarts SpotiFlex.
      </p>
      {state.update_notes &&
        (nightly ? (
          <NightlyChanges notes={state.update_notes} />
        ) : (
          <section aria-label="Release notes">
            <h3>What changed</h3>
            <p className="update-notes">{state.update_notes}</p>
          </section>
        ))}
      {report && (
        <div className="update-progress">
          <div className="update-progress-label">
            <span>{step?.label ?? "Building"}</span>
            <span>{percent}%</span>
          </div>
          <div
            className="nightly-bar nightly-total"
            role="progressbar"
            aria-label="Building update"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
          {step?.detail && (
            <p className="update-progress-detail">{step.detail}</p>
          )}
        </div>
      )}
      <p role="status" aria-live="polite" hidden={!!report && !error}>
        {requested === "install"
          ? "Installing update…"
          : error ||
            (ready
              ? nightly
                ? "Built and checked. Ready to install."
                : "Download verified. Ready to install."
              : status)}
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
                ? nightly
                  ? "Building…"
                  : "Downloading…"
                : nightly
                  ? "Build update"
                  : "Download update"}
        </button>
      </div>
    </dialog>
  );
}

/** Each commit a Nightly brings: its short hash and subject. */
function NightlyChanges({ notes }: { notes: string }) {
  const lines = notes.split("\n").filter(Boolean);
  const commits = lines.filter((line) => /^[0-9a-f]{7} /.test(line));
  if (!commits.length)
    return (
      <section aria-label="Release notes">
        <h3>What changed</h3>
        <p className="update-notes">{notes}</p>
      </section>
    );
  const more = lines.find((line) => line.startsWith("and "));
  return (
    <section aria-label="Release notes">
      <h3>
        {commits.length === 1 && !more
          ? "1 new change"
          : `${commits.length + (more ? Number(more.split(" ")[1]) || 0 : 0)} new changes`}
      </h3>
      <ul className="update-commits">
        {commits.map((line) => (
          <li key={line}>
            <code>{line.slice(0, 7)}</code>
            <span>{line.slice(8)}</span>
          </li>
        ))}
      </ul>
      {more && <p className="update-notes">{more}</p>}
    </section>
  );
}
