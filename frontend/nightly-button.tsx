import { RefreshCw } from "lucide-react";
import { nightlyProgress } from "./nightly-dialog";
import type { NightlyReport } from "./types";

const RING = 2 * Math.PI * 14;

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
  const label = ready
    ? "Restart to update"
    : building
      ? `Building Nightly update, ${percent}%`
      : "Check for a newer Nightly";
  return (
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
            strokeDasharray={RING}
            strokeDashoffset={RING * (1 - percent / 100)}
          />
        </svg>
      )}
      <RefreshCw className="nightly-icon" size={building ? 11 : 18} />
      <span className="nightly-restart-label">Restart to update</span>
    </button>
  );
}
