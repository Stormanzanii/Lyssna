import { useEffect, useRef, useState } from "react";
import { rpc } from "./bridge";
import { nightlyProgress } from "./nightly-dialog";
import type { AppState } from "./state";

/** What a dismissal hides: one version, before or after it is ready. */
const key = (version: string, ready: boolean) =>
  `${version}${ready ? " ready" : ""}`;

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
  // Nightly updates that build by themselves show on the top bar's button
  // (a progress ring and tag, then Restart to update); this opens only when
  // that is clicked.
  const [asked, setAsked] = useState(false);
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
    enabled &&
    !!version &&
    key(version, ready) !== dismissed &&
    (!(nightly && state.settings.auto_download_updates) || asked) &&
    status !== "Up to date";
  // Checking for a Nightly by hand shows what was found again.
  useEffect(() => {
    const show = () => {
      setDismissed(undefined);
      setAsked(true);
    };
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
    // Hidden while it downloads or builds, it opens again once ready.
    if (version) setDismissed(key(version, ready));
    setAsked(false);
    dialog.current?.close();
  };
  return (
    <dialog
      ref={dialog}
      className="dialog update-dialog"
      aria-labelledby="update-title"
      aria-describedby="update-description"
      // Clicking outside it hides it, as Settings and creator profiles do.
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          dismiss();
      }}
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
          <NightlyChanges
            notes={state.update_notes}
            current={current}
            latest={version?.replace(/^Nightly /, "")}
          />
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
          {downloading || requested === "download" ? "Minimise" : "Not now"}
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

const KINDS = [
  ["new", "New"],
  ["fixed", "Fixed"],
  ["other", "Improved"],
] as const;

/**
 * The commits a Nightly brings, grouped into new, fixed and improved, each
 * with its short hash, and how many there are since this copy.
 */
function NightlyChanges({
  notes,
  current,
  latest,
}: {
  notes: string;
  current?: string | null;
  latest?: string;
}) {
  const lines = notes.split(NEWLINE).filter(Boolean);
  const commits = lines.flatMap((line) => {
    const match = /^([0-9a-f]{7}) (?:(new|fixed|other) )?(.+)$/.exec(line);
    return match
      ? [{ sha: match[1], kind: match[2] ?? "other", text: match[3] }]
      : [];
  });
  if (!commits.length)
    return (
      <section aria-label="Release notes">
        <h3>What changed</h3>
        <p className="update-notes">{notes}</p>
      </section>
    );
  const more = Number(/^and (\d+) more$/.exec(lines.at(-1) ?? "")?.[1] ?? 0);
  const total = commits.length + more;
  return (
    <section aria-label="Release notes" className="update-changes">
      <h3>
        {total === 1 ? "1 commit" : `${total} commits`} since your Nightly
      </h3>
      {current && latest && (
        <p className="update-range">
          <code>{current.slice(0, 7)}</code>
          <span aria-label="to">→</span>
          <code>{latest}</code>
        </p>
      )}
      <div className="update-commits">
        {KINDS.map(([kind, label]) => {
          const group = commits.filter((commit) => commit.kind === kind);
          if (!group.length) return null;
          return (
            <section key={kind} aria-label={label}>
              <h4>
                {label}
                <span>{group.length}</span>
              </h4>
              <ul>
                {group.map((commit) => (
                  <li key={commit.sha}>
                    <span>{commit.text}</span>
                    <code>{commit.sha}</code>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {more > 0 && (
        <p className="update-notes">
          {more === 1 ? "and 1 older commit" : `and ${more} older commits`}
        </p>
      )}
    </section>
  );
}

const NEWLINE = String.fromCharCode(10);
