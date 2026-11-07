import { useState } from "react";
import { ChevronDown, Plus, RotateCcw, Tags, Trash2, X } from "lucide-react";
import {
  type MetaEntry,
  META_KEYS,
  SONG_KEYS,
  metaProblem,
} from "./ttml-creator-model";

const LABELS: Record<
  string,
  { label: string; hint?: string; example?: string }
> = {
  musicName: {
    label: "Song title",
    hint: "Add other titles too, like the name in its original script.",
  },
  artists: { label: "Artist" },
  songwriters: { label: "Songwriter" },
  isrc: {
    label: "ISRC",
    hint: "One per region if the song has several.",
    example: "USUM71703861",
  },
  appleMusicId: {
    label: "Apple Music ID",
    hint: "The song's own ID: the ?i= number in a song link, not the album's.",
    example: "1440841766",
  },
  ncmMusicId: { label: "NetEase Cloud Music ID", example: "209803" },
  qqMusicId: { label: "QQ Music ID", example: "002Zm4JR3azmbY" },
  ttmlAuthorGithub: {
    label: "Your GitHub ID",
    hint: "The number on api.github.com/users/<your username>. Remembered for every song.",
    example: "12345678",
  },
  ttmlAuthorGithubLogin: {
    label: "Your GitHub username",
    hint: "Remembered for every song.",
    example: "username",
  },
};

const GROUPS: [string, string[]][] = [
  ["Song", ["musicName", "artists", "songwriters"]],
  ["Identifiers", ["isrc", "appleMusicId", "ncmMusicId", "qqMusicId"]],
  ["You", ["ttmlAuthorGithub", "ttmlAuthorGithubLogin"]],
];

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
    SONG_KEYS.includes(entry.key)
      ? []
      : entry.values.map((value, at) => ({ entry, index, value, at })),
  );
  type Row = (typeof rows)[number];
  const grouped = new Set(GROUPS.flatMap(([, keys]) => keys));
  const sections: [string, Row[]][] = [
    ...GROUPS.map(
      ([title, keys]) =>
        [
          title,
          keys.flatMap((key) => rows.filter((row) => row.entry.key === key)),
        ] as [string, Row[]],
    ),
    ["Custom", rows.filter((row) => !grouped.has(row.entry.key))] as [
      string,
      Row[],
    ],
  ].filter(([, list]) => list.length);
  const filled = rows.filter((row) => row.value.trim()).length;
  const renderRow = ({ entry, index, value, at }: Row) => {
    const info = LABELS[entry.key];
    const name = info?.label ?? (entry.key || "Custom key");
    const count = entry.values.length > 1 ? ` ${at + 1}` : "";
    const problem = metaProblem(entry.key, value);
    return (
      <div
        key={`${index}:${at}`}
        className={`ttml-meta-row${problem ? " invalid" : ""}`}
      >
        <div className="ttml-meta-key">
          {isPreset(entry.key) ? (
            <>
              <span title={info?.hint}>{info?.label ?? entry.key}</span>
              <code>{entry.key}</code>
            </>
          ) : (
            <input
              aria-label={`Key name ${index + 1}`}
              placeholder="key"
              value={entry.key}
              onChange={(event) =>
                onChange(
                  entries.map((old, i) =>
                    i === index ? { ...old, key: event.target.value } : old,
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
            placeholder={info?.example ?? "Value"}
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
          className="ttml-meta-remove"
          aria-label={`Remove ${name}${count}`}
          title="Remove"
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
  };
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
          <span className="ttml-meta-icon">
            <Tags size={18} />
          </span>
          <div>
            <h3>Metadata</h3>
            <p>
              {filled
                ? `${filled} field${filled === 1 ? "" : "s"} · saved into the TTML file`
                : "Saved into the TTML file"}
            </p>
          </div>
          <button
            className="ttml-meta-close"
            onClick={onClose}
            aria-label="Close metadata"
          >
            <X size={16} />
          </button>
        </header>
        <div className="ttml-meta-body">
          {sections.length ? (
            sections.map(([title, list]) => (
              <section key={title} className="ttml-meta-section">
                <h4>{title}</h4>
                <div className="ttml-meta-rows">{list.map(renderRow)}</div>
              </section>
            ))
          ) : (
            <div className="ttml-meta-empty">
              <Tags size={28} />
              <strong>No metadata yet</strong>
              <span>Add fields one at a time, or all the standard ones.</span>
            </div>
          )}
        </div>
        <footer className="ttml-meta-actions">
          <span className="ttml-meta-add">
            <button
              className="primary"
              aria-expanded={adding}
              onClick={() => setAdding(!adding)}
            >
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
          <span className="ttml-meta-spacer" />
          <button
            className="ttml-meta-quiet"
            onClick={onReset}
            title="Fill the song's details in again"
          >
            <RotateCcw size={14} />
            Reset
          </button>
          <button
            className="ttml-meta-quiet danger"
            onClick={() => onChange([])}
          >
            <Trash2 size={14} />
            Clear
          </button>
        </footer>
      </div>
    </div>
  );
}
