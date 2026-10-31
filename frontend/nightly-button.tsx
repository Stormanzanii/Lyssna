import { RefreshCw } from "lucide-react";
import { nightlyProgress } from "./nightly-dialog";
import type { NightlyReport } from "./types";

const RING = 2 * Math.PI * 14;
/** The rounded ends add half the stroke each; the arc is shortened by them
 * so the opening shows the progress truly instead of closing early. */
const CAPS = 2.5;

/**
 * The top bar's Nightly button: checks for newer code, becomes a progress
 * ring with its icon turning while an update builds, then grows into
 * Restart to update once the build is ready.
 */
export function NightlyButton({
  status,
  report,
  checking,
  onCheck,
  onShow,
  onRestart,
}: {
  status: string;
  report?: NightlyReport;
  checking: boolean;
  onCheck: () => void;
  onShow: () => void;
  onRestart: () => void;
}) {
  const ready = status === "Ready to install";
  const building =
    !ready && (!!report?.running || status.startsWith("Building update"));
  const percent = report?.running
    ? Math.round(nightlyProgress(report) * 100)
    : 0;
  // A tag under the button shows an automatic build without covering the
  // app; the update prompt opens once it is ready.
  const tag = building ? `Building update · ${percent}%` : null;
  const label = ready
    ? "Restart to update"
    : building
      ? `Building Nightly update, ${percent}%`
      : "Check for a newer Nightly";
  return (
    <span className="nightly-wrap">
      <button
        className={`icon-button nightly-refresh${checking || building ? " checking" : ""}${building ? " building" : ""}${ready ? " ready" : ""}`}
        title={label}
        aria-label={label}
        disabled={checking && !building && !ready}
        onClick={ready ? onRestart : building ? onShow : onCheck}
      >
        {building && (
          <svg className="nightly-ring" viewBox="0 0 32 32" aria-hidden="true">
            <circle cx="16" cy="16" r="14" />
            <circle
              cx="16"
              cy="16"
              r="14"
              strokeDasharray={`${Math.max(0, (RING * percent) / 100 - CAPS)} ${RING}`}
            />
          </svg>
        )}
        <RefreshCw className="nightly-icon" size={building ? 14 : 18} />
        <span className="nightly-restart-label">Restart to update</span>
      </button>
      {tag && (
        <button className="nightly-tag" onClick={onShow}>
          {tag}
        </button>
      )}
    </span>
  );
}
