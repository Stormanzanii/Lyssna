import { useEffect } from "react";
import { ClipboardCopy, X } from "lucide-react";
import { Logo } from "./brand";
import { PLATFORM_LABEL } from "./platform";

/** Spotify-style About box: version, build, update state and copyright. */
export function AboutDialog({
  updateStatus,
  updateVersion,
  onUpdate,
  onNotice,
  onClose,
}: {
  updateStatus: string;
  updateVersion?: string;
  onUpdate: () => void;
  onNotice: (message: string, error?: boolean) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const build = import.meta.env.DEV ? "development build" : "release build";
  const details = `SpotiFlex for ${PLATFORM_LABEL}\n${__APP_VERSION__} (${build})`;
  const ready = updateStatus === "Ready to install";
  return (
    <div className="modal-backdrop about-backdrop" onClick={onClose}>
      <section
        className="about-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="About SpotiFlex"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="about-brand">
          <Logo size={48} />
          <div>
            <span className="about-wordmark">SpotiFlex</span>
            <span className="about-platform">
              SpotiFlex for {PLATFORM_LABEL}
            </span>
          </div>
          <button
            className="icon-button about-close"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <dl className="about-details">
          <div>
            <dt>Version</dt>
            <dd>
              {__APP_VERSION__}
              <button
                className="icon-button about-copy"
                title="Copy version details"
                aria-label="Copy version details"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(details)
                    .then(() => onNotice("Version details copied."))
                    .catch(() => onNotice("Could not copy.", true))
                }
              >
                <ClipboardCopy size={15} />
              </button>
            </dd>
          </div>
          <div>
            <dt>Build</dt>
            <dd>{build[0].toUpperCase() + build.slice(1)}</dd>
          </div>
          <div>
            <dt>Updates</dt>
            <dd>
              {ready && updateVersion ? (
                <>
                  <span className="about-status ready">
                    Version {updateVersion} ready
                  </span>
                  <button className="pill about-restart" onClick={onUpdate}>
                    Restart to install
                  </button>
                </>
              ) : (
                <span
                  className={`about-status ${updateStatus === "Up to date" ? "current" : ""}`}
                >
                  {updateStatus || "Up to date"}
                </span>
              )}
            </dd>
          </div>
        </dl>
        <footer className="about-legal">
          <p>Copyright © {new Date().getFullYear()} Arashii.</p>
          <p>
            SpotiFlex is an independent client and is not affiliated with
            Spotify AB. Spotify® is a registered trademark of the Spotify Group.
          </p>
        </footer>
      </section>
    </div>
  );
}
