import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  ChevronLeft,
  Database,
  Download,
  Music2,
  Play,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";

export type LoadMode = "persistent" | "temporary" | "session";

export interface SavedLyrics {
  key: string;
  uri: string;
  name: string;
  artists: string;
  kind: string;
  saved_at: number;
  image?: string;
}

const MODES: { mode: LoadMode; title: string; detail: string }[] = [
  {
    mode: "persistent",
    title: "Persistent Load",
    detail: "Saved on this computer, survives restarts",
  },
  {
    mode: "temporary",
    title: "Temporary Load",
    detail: "Applied only to the current song until lyrics reload",
  },
  {
    mode: "session",
    title: "Session Load",
    detail: "Used for this song until Lyssna restarts",
  },
];

/**
 * Spicy Lyrics' "Load TTML" window (iPixelGalaxy/spicy-lyrics,
 * UploadTTMLModal and LyricsManager, AGPL-3.0), reimplemented: three ways to
 * load a lyric file, a reset back to provider lyrics, and the saved files.
 */
export function LoadTtml({
  song,
  onLoad,
  onReset,
  onGuide,
  listSaved,
  deleteSaved,
  onPlay,
  onDownload,
  onClose,
  initialView = "load",
}: {
  initialView?: "load" | "database";
  song: string;
  onLoad: (file: File, mode: LoadMode) => Promise<void>;
  onReset: () => void;
  onGuide: () => void;
  listSaved: () => Promise<SavedLyrics[]>;
  deleteSaved: (key: string) => Promise<void>;
  onPlay: (uri: string) => void;
  onDownload: (item: SavedLyrics) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<"load" | "database">(initialView);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<SavedLyrics[] | null>(null);
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const words = filter.trim().toLocaleLowerCase();
    return (saved ?? []).filter(
      (item) =>
        !words ||
        `${item.name} ${item.artists}`.toLocaleLowerCase().includes(words),
    );
  }, [saved, filter]);
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<LoadMode>("persistent");
  useEffect(() => {
    if (view !== "database") return;
    let live = true;
    void listSaved().then((items) => live && setSaved(items ?? []));
    return () => {
      live = false;
    };
  }, [view, listSaved]);
  const pick = (mode: LoadMode) => {
    if (busy) return;
    pending.current = mode;
    if (input.current) {
      input.current.value = "";
      input.current.click();
    }
  };
  return (
    <div className="modal-backdrop load-ttml-backdrop" onClick={onClose}>
      <section
        className="dialog load-ttml"
        role="dialog"
        aria-label={view === "load" ? "Load TTML" : "TTML Database"}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="load-ttml-head">
          <h2>{view === "load" ? "Load TTML" : "TTML Database"}</h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        {view === "load" ? (
          <div className="load-ttml-body">
            <div className="load-ttml-row">
              <p>For: {song}</p>
              <div className="load-ttml-actions">
                <button onClick={onGuide} disabled={busy}>
                  <BookOpen size={14} />
                  Guide
                </button>
                <button onClick={onReset} disabled={busy}>
                  <RotateCcw size={14} />
                  Reset TTML
                </button>
                <button onClick={() => setView("database")} disabled={busy}>
                  <Database size={14} />
                  TTML Database
                </button>
              </div>
            </div>
            <input
              ref={input}
              type="file"
              accept=".ttml,.xml,.lrc"
              hidden
              aria-label="Lyric file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                setBusy(true);
                void onLoad(file, pending.current).finally(() => setBusy(false));
              }}
            />
            <div className="load-ttml-modes">
              {MODES.map(({ mode, title, detail }) => (
                <button
                  key={mode}
                  className="load-ttml-mode"
                  onClick={() => pick(mode)}
                  disabled={busy}
                >
                  <span className="load-ttml-icon">
                    <Upload size={15} />
                  </span>
                  <span>
                    <strong>{title}</strong>
                    <small>{detail}</small>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="load-ttml-body">
            <div className="load-ttml-tools">
              <button
                className="load-ttml-back"
                aria-label="Back to Load TTML"
                onClick={() => setView("load")}
              >
                <ChevronLeft size={16} />
                Back
              </button>
              <label className="load-ttml-search">
                <Search size={15} />
                <input
                  type="search"
                  placeholder="Search saved lyrics…"
                  aria-label="Search saved lyrics"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </label>
              <button className="load-ttml-reset" onClick={onReset}>
                <RotateCcw size={14} />
                Reset TTML
              </button>
            </div>
            {saved === null ? (
              <p className="load-ttml-empty">Loading saved lyrics…</p>
            ) : saved.length === 0 ? (
              <p className="load-ttml-empty">
                No saved lyrics yet. Persistent loads appear here.
              </p>
            ) : shown.length === 0 ? (
              <p className="load-ttml-empty">No saved lyrics match.</p>
            ) : (
              <ul className="load-ttml-saved">
                {shown.map((item) => {
                  const name = item.name || "Unknown song";
                  return (
                    <li key={item.key}>
                      {item.image ? (
                        <img src={item.image} alt="" loading="lazy" />
                      ) : (
                        <span className="load-ttml-art" aria-hidden="true">
                          <Music2 size={18} />
                        </span>
                      )}
                      <span className="load-ttml-song">
                        <strong title={name}>{name}</strong>
                        {item.artists && (
                          <small title={item.artists}>{item.artists}</small>
                        )}
                      </span>
                      <span className="load-ttml-row-actions">
                        <button
                          aria-label={`Play ${name}`}
                          title="Play"
                          disabled={!item.uri.startsWith("spotify:track:")}
                          onClick={() => onPlay(item.uri)}
                        >
                          <Play size={14} fill="currentColor" />
                        </button>
                        <button
                          aria-label={`Download lyrics for ${name}`}
                          title={`Download ${item.kind.toUpperCase()}`}
                          onClick={() => onDownload(item)}
                        >
                          <Download size={14} />
                        </button>
                        <button
                          aria-label={`Delete saved lyrics for ${name}`}
                          title="Delete"
                          onClick={() =>
                            void deleteSaved(item.key).then(() =>
                              setSaved((items) =>
                                (items ?? []).filter(
                                  (entry) => entry.key !== item.key,
                                ),
                              ),
                            )
                          }
                        >
                          <Trash2 size={14} />
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
