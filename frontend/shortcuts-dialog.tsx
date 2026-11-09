import { useEffect } from "react";
import { X } from "lucide-react";
import type { Shortcut } from "./shortcuts";

const SECTIONS: Shortcut["section"][] = [
  "Basic",
  "Playback",
  "Navigation",
  "Layout",
];

/** Spotify's keyboard shortcuts reference, opened with Ctrl+/. */
export function ShortcutsDialog({
  shortcuts,
  onClose,
}: {
  shortcuts: Shortcut[];
  onClose: () => void;
}) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="dialog shortcuts-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          <button
            className="icon-button"
            aria-label="Close"
            autoFocus
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className="shortcuts-body">
          {SECTIONS.map((section) => (
            <div key={section} className="shortcuts-section">
              <h3>{section}</h3>
              <dl>
                {shortcuts
                  .filter((shortcut) => shortcut.section === section)
                  .map((shortcut) => (
                    <div key={shortcut.label}>
                      <dt>{shortcut.label}</dt>
                      <dd>
                        {[shortcut.keys]
                          .flat()
                          .slice(0, 1)
                          .flatMap((keys) => keys.split("+"))
                          .map((key) => (
                            <kbd key={key}>{key}</kbd>
                          ))}
                      </dd>
                    </div>
                  ))}
              </dl>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
