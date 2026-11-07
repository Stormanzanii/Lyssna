import { useState } from "react";
import { Plus, RotateCcw, Trash2, X } from "lucide-react";
import { type MetaEntry, META_KEYS, metaProblem } from "./ttml-creator-model";

const LABELS: Record<string, { label: string; hint?: string }> = {
  musicName: {
    label: "Song title",
    hint: "Add other titles too, like the name in its original script.",
  },
  artists: { label: "Artists" },
  album: { label: "Album" },
  songwriters: { label: "Songwriters" },
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
  const [newKey, setNewKey] = useState("");
  const update = (index: number, entry: MetaEntry | null) =>
    onChange(
      entry
        ? entries.map((old, at) => (at === index ? entry : old))
        : entries.filter((_, at) => at !== index),
    );
  const key = newKey.trim();
  const taken = entries.some((entry) => entry.key === key);
  const addKey = () => {
    if (!key || taken) return;
    onChange([...entries, { key, values: [""] }]);
    setNewKey("");
  };
  return (
    <div className="ttml-dialog-backdrop" onClick={onClose}>
      <div
        className="ttml-dialog ttml-saves ttml-metadata"
        role="dialog"
        aria-label="Song metadata"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && onClose()}
      >
        <header>
          <h3>Metadata</h3>
          <button onClick={onClose} aria-label="Close metadata">
            <X size={16} />
          </button>
        </header>
        <p className="ttml-hint">
          Saved into the TTML the way the AMLL TTML DB reads it. Empty fields
          are left out.
        </p>
        {entries.map((entry, index) => {
          const preset = (META_KEYS as readonly string[]).includes(entry.key);
          const info = LABELS[entry.key];
          const values = entry.values.length ? entry.values : [""];
          return (
            <section key={preset ? entry.key : index} className="ttml-meta">
              <h4>
                {preset ? (
                  <>
                    {info?.label ?? entry.key} <code>{entry.key}</code>
                  </>
                ) : (
                  <input
                    aria-label="Key name"
                    value={entry.key}
                    onChange={(event) =>
                      update(index, { ...entry, key: event.target.value })
                    }
                  />
                )}
              </h4>
              {values.map((value, at) => {
                const problem = metaProblem(entry.key, value);
                return (
                  <div key={at} className="ttml-meta-value">
                    <input
                      aria-label={`${info?.label ?? entry.key} ${at + 1}`}
                      aria-invalid={!!problem}
                      value={value}
                      onChange={(event) =>
                        update(index, {
                          ...entry,
                          values: values.map((old, i) =>
                            i === at ? event.target.value : old,
                          ),
                        })
                      }
                    />
                    {(values.length > 1 || value) && (
                      <button
                        aria-label={`Remove ${info?.label ?? entry.key} ${at + 1}`}
                        onClick={() =>
                          update(index, {
                            ...entry,
                            values: values.filter((_, i) => i !== at),
                          })
                        }
                      >
                        <X size={14} />
                      </button>
                    )}
                    {problem && <small role="alert">{problem}</small>}
                  </div>
                );
              })}
              <div className="ttml-row">
                <button
                  onClick={() =>
                    update(index, { ...entry, values: [...values, ""] })
                  }
                >
                  <Plus size={14} />
                  Add another
                </button>
                {!preset && (
                  <button
                    className="danger"
                    aria-label={`Remove key ${entry.key}`}
                    onClick={() => update(index, null)}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
              {info?.hint && <small className="ttml-hint">{info.hint}</small>}
            </section>
          );
        })}
        <section className="ttml-meta">
          <h4>Other key</h4>
          <div className="ttml-meta-value">
            <input
              aria-label="New key name"
              placeholder="Key name"
              value={newKey}
              onChange={(event) => setNewKey(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && addKey()}
            />
            <button onClick={addKey} disabled={!key || taken}>
              <Plus size={14} />
              Add key
            </button>
          </div>
        </section>
        <div className="ttml-dialog-row end">
          <button onClick={onReset} title="Fill the song's details in again">
            <RotateCcw size={14} />
            Reset to song
          </button>
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
