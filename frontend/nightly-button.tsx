import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
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
  automatic,
  onCheck,
  onShow,
  onRestart,
}: {
  status: string;
  report?: NightlyReport;
  checking: boolean;
  /** Whether new Nightlies build by themselves. */
  automatic: boolean;
  onCheck: () => void;
  onShow: () => void;
  onRestart: () => void;
}) {
  const ready = status === "Ready to install";
  const building =
    !ready && (!!report?.running || status.startsWith("Building update"));
  // Found while automatic builds are off: the button turns blue, and
  // clicking it shows what's new.
  const available =
    !automatic && !ready && !building && status === "Update available";
  const percent = report?.running
    ? Math.round(nightlyProgress(report) * 100)
    : 0;
  // A tag under the button tells of a build without covering the app: for
  // five seconds when it starts, then while the button is hovered.
  const tag = building ? `Building update · ${percent}%` : null;
  const [announcing, setAnnouncing] = useState(false);
  useEffect(() => {
    if (!building) return;
    setAnnouncing(true);
    const timer = setTimeout(() => setAnnouncing(false), 5000);
    return () => clearTimeout(timer);
  }, [building]);
  // Hover is tracked rather than left to CSS: a popup opened from the
  // button covers it, and WebKit keeps it hovered until the pointer comes
  // back. Focus shows the tag only from the keyboard, since closing a popup
  // hands focus back to the button.
  const [hovered, setHovered] = useState(false);
  const label = ready
    ? "Restart to update"
    : building
      ? `Building Nightly update, ${percent}%`
      : available
        ? "A newer Nightly is available"
        : "Check for a newer Nightly";
  return (
    <span
      className="nightly-wrap"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <button
        className={`icon-button nightly-refresh${checking || building ? " checking" : ""}${building ? " building" : ""}${ready ? " ready" : ""}${available ? " available" : ""}`}
        // While building, the tag says it; a native tooltip would repeat it.
        title={tag ? undefined : label}
        aria-label={label}
        disabled={checking && !building && !ready}
        onClick={() => {
          setHovered(false);
          (ready ? onRestart : building || available ? onShow : onCheck)();
        }}
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
        <button
          className={`nightly-tag${announcing || hovered ? " shown" : ""}`}
          onClick={() => {
            setHovered(false);
            onShow();
          }}
        >
          {tag}
        </button>
      )}
    </span>
  );
}
