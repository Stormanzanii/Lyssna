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
        <button
          className="icon-button about-close"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={22} />
        </button>
        <header className="about-brand">
          <Logo size={56} />
          <span className="about-wordmark">SpotiFlex</span>
        </header>
        <div className="about-version">
          <div>
            <p>SpotiFlex for {PLATFORM_LABEL}</p>
            <p>
              {__APP_VERSION__} · {build}
            </p>
          </div>
          <button
            className="about-copy"
            title="Copy version details"
            aria-label="Copy version details"
            onClick={() =>
              void navigator.clipboard
                .writeText(details)
                .then(() => onNotice("Version details copied."))
                .catch(() => onNotice("Could not copy.", true))
            }
          >
            <ClipboardCopy size={22} />
          </button>
        </div>
        <p className="about-update">
          {ready && updateVersion ? (
            <>
              SpotiFlex has been updated to version {updateVersion}.{" "}
              <button className="text-link" onClick={onUpdate}>
                Restart to install.
              </button>
            </>
          ) : (
            updateStatus || "SpotiFlex is up to date."
          )}
        </p>
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
