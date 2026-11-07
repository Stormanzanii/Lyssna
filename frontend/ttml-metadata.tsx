import { useState } from "react";
import { ChevronDown, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { type MetaEntry, META_KEYS, metaProblem } from "./ttml-creator-model";

const LABELS: Record<string, { label: string; hint?: string }> = {
  musicName: {
    label: "Song title",
    hint: "Add other titles too, like the name in its original script.",
  },
  artists: { label: "Artist" },
  album: { label: "Album" },
  songwriters: { label: "Songwriter" },
  isrc: { label: "ISRC", hint: "One per region if the song has several." },
  spotifyId: { label: "Spotify ID" },
  appleMusicId: {
    label: "Apple Music ID",
    hint: "The song's own ID: the ?i= number in a song link, not the album's.",
  },
  ncmMusicId: { label: "NetEase Cloud Music ID" },
  qqMusicId: { label: "QQ Music ID" },
  ttmlAuthorGithub: {
    label: "Your GitHub ID",
    hint: "The number on api.github.com/users/<your username>. Remembered for every song.",
  },
  ttmlAuthorGithubLogin: {
    label: "Your GitHub username",
    hint: "Remembered for every song.",
  },
};

const isPreset = (key: string) =>
  (META_KEYS as readonly string[]).includes(key);

export function MetadataDialog({
  entries,
  onChange,
  onReset,
  onClose,
}: {
  entries: MetaEntry[];
  onChange: (entries: MetaEntry[]) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const setValues = (index: number, values: string[]) =>
    onChange(
      entries
        .map((entry, at) => (at === index ? { ...entry, values } : entry))
        .filter((entry) => entry.values.length || isPreset(entry.key)),
    );
  const addField = (key: string) => {
    const index = key ? entries.findIndex((entry) => entry.key === key) : -1;
    onChange(
      index >= 0
        ? entries.map((entry, at) =>
            at === index ? { ...entry, values: [...entry.values, ""] } : entry,
          )
        : [...entries, { key, values: [""] }],
    );
    setAdding(false);
  };
  const addStandard = () =>
    onChange([
      ...entries.map((entry) =>
        isPreset(entry.key) && !entry.values.length
          ? { ...entry, values: [""] }
          : entry,
      ),
      ...META_KEYS.filter(
        (key) => !entries.some((entry) => entry.key === key),
      ).map((key) => ({ key, values: [""] })),
    ]);
  const rows = entries.flatMap((entry, index) =>
    entry.values.map((value, at) => ({ entry, index, value, at })),
  );
  return (
    <div className="ttml-dialog-backdrop" onClick={onClose}>
      <div
        className="ttml-dialog ttml-metadata"
        role="dialog"
        aria-label="Song metadata"
        onClick={(event) => {
          event.stopPropagation();
          if (!(event.target as Element).closest(".ttml-meta-add"))
            setAdding(false);
        }}
        onKeyDown={(event) => event.key === "Escape" && onClose()}
      >
        <header>
          <h3>Metadata</h3>
          <button onClick={onClose} aria-label="Close metadata">
            <X size={16} />
          </button>
        </header>
        <div className="ttml-meta-table">
          <div className="ttml-meta-head">
            <span>Key</span>
            <span>Value</span>
          </div>
          {rows.length ? (
            rows.map(({ entry, index, value, at }) => {
              const info = LABELS[entry.key];
              const name = info?.label ?? (entry.key || "Custom key");
              const count = entry.values.length > 1 ? ` ${at + 1}` : "";
              const problem = metaProblem(entry.key, value);
              return (
                <div key={`${index}:${at}`} className="ttml-meta-row">
                  <div className="ttml-meta-key">
                    {isPreset(entry.key) ? (
                      <>
                        <strong>{info?.label ?? entry.key}</strong>
                        <code>{entry.key}</code>
                      </>
                    ) : (
                      <input
                        aria-label={`Key name ${index + 1}`}
                        placeholder="Key name"
                        value={entry.key}
                        onChange={(event) =>
                          onChange(
                            entries.map((old, i) =>
                              i === index
                                ? { ...old, key: event.target.value }
                                : old,
                            ),
                          )
                        }
                      />
                    )}
                  </div>
                  <div className="ttml-meta-value">
                    <input
                      aria-label={`${name}${count}`}
                      aria-invalid={!!problem}
                      title={info?.hint}
                      value={value}
                      onChange={(event) =>
                        setValues(
                          index,
                          entry.values.map((old, i) =>
                            i === at ? event.target.value : old,
                          ),
                        )
                      }
                    />
                    {problem && <small role="alert">{problem}</small>}
                  </div>
                  <button
                    aria-label={`Remove ${name}${count}`}
                    onClick={() =>
                      setValues(
                        index,
                        entry.values.filter((_, i) => i !== at),
                      )
                    }
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })
          ) : (
            <p className="ttml-meta-empty">No metadata</p>
          )}
        </div>
        <footer className="ttml-meta-actions">
          <span className="ttml-meta-add">
            <button aria-expanded={adding} onClick={() => setAdding(!adding)}>
              <Plus size={14} />
              Add field
              <ChevronDown size={14} />
            </button>
            {adding && (
              <div className="ttml-meta-menu" role="menu">
                {META_KEYS.map((key) => (
                  <button
                    key={key}
                    role="menuitem"
                    onClick={() => addField(key)}
                  >
                    {LABELS[key]?.label ?? key}
                    <code>{key}</code>
                  </button>
                ))}
                <button role="menuitem" onClick={() => addField("")}>
                  Custom key…
                </button>
              </div>
            )}
          </span>
          <button onClick={addStandard}>Add all standard fields</button>
          <button onClick={onReset} title="Fill the song's details in again">
            <RotateCcw size={14} />
            Reset to song
          </button>
          <button className="danger" onClick={() => onChange([])}>
            <Trash2 size={14} />
            Clear
          </button>
        </footer>
      </div>
    </div>
  );
}
