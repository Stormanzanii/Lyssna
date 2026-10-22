import { useEffect, useRef, useState } from "react";
import type { Settings } from "./types";
import { SettingRow } from "./setting-row";
type StoredFont = { family: string; name: string; data: Blob };
let database: Promise<IDBDatabase> | undefined;
function openFonts() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("spotiflex-fonts", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("fonts", { keyPath: "family" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(new Error("Custom font storage is unavailable"));
    };
  }));
}
async function storedFonts() {
  const db = await openFonts();
  return new Promise<StoredFont[]>((resolve, reject) => {
    const request = db.transaction("fonts").objectStore("fonts").getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
const loaded = new Map<string, Promise<void>>();
async function registerFont(font: StoredFont) {
  if (!loaded.has(font.family))
    loaded.set(
      font.family,
      (async () => {
        const face = new FontFace(font.family, await font.data.arrayBuffer(), {
          weight: "100 900",
        });
        await face.load();
        document.fonts.add(face);
      })().catch((error) => {
        loaded.delete(font.family);
        throw error;
      }),
    );
  return loaded.get(font.family);
}
export async function loadSelectedFonts(families: (string | undefined)[]) {
  const wanted = [
    ...new Set(
      families.filter(
        (family): family is string => !!family?.startsWith("SpotiFlexFont_"),
      ),
    ),
  ];
  if (!wanted.length) return;
  const fonts = await storedFonts();
  await Promise.all(
    fonts.filter((font) => wanted.includes(font.family)).map(registerFont),
  );
}
export function fontFamily(family?: string) {
  if (!family?.trim() || family.length > 100 || /[\x00-\x1f\x7f]/.test(family))
    return undefined;
  return `"${family.trim().replace(/["\\]/g, "\\$&")}", "Segoe UI", sans-serif`;
}
const systemFonts = [
  "Segoe UI",
  "Arial",
  "Georgia",
  "Verdana",
  "Trebuchet MS",
  "Consolas",
];
export function FontSettings({
  field,
  settings,
  onSettings,
  onNotice,
}: {
  /** Which font this panel sets: the app's or the lyrics'. */
  field: "ui_font" | "lyric_font";
  settings: Settings;
  onSettings: (patch: Partial<Settings>) => void;
  onNotice: (message: string) => void;
}) {
  const [fonts, setFonts] = useState<StoredFont[]>([]),
    [importing, setImporting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let disposed = false;
    void storedFonts()
      .then((fonts) => {
        if (!disposed) setFonts(fonts);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);
  const importFont = async (file: File) => {
    setImporting(true);
    try {
      if (
        !/\.(ttf|otf|woff2?)$/i.test(file.name) ||
        file.size > 5 * 1024 * 1024 ||
        !file.size
      )
        throw new Error("Choose a TTF, OTF, WOFF or WOFF2 font up to 5 MB.");
      const hash = await crypto.subtle.digest(
          "SHA-256",
          await file.arrayBuffer(),
        ),
        family = `SpotiFlexFont_${Array.from(new Uint8Array(hash))
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("")}`;
      if (fonts.length >= 20 && !fonts.some((font) => font.family === family))
        throw new Error("Up to 20 custom fonts can be imported.");
      const font = {
        family,
        name: file.name.replace(/\.(ttf|otf|woff2?)$/i, ""),
        data: file,
      };
      await registerFont(font);
      const db = await openFonts();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("fonts", "readwrite");
        transaction.objectStore("fonts").put(font);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      setFonts((previous) => [
        ...previous.filter((font) => font.family !== family),
        font,
      ]);
      onSettings({ [field]: family });
      onNotice(
        field === "lyric_font"
          ? "Font imported and applied to lyrics."
          : "Font imported and applied to the app.",
      );
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : "Could not import this font.",
      );
    } finally {
      setImporting(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <>
      {(
        [
          ["ui_font", "App font", "Used across menus, lists and the player."],
          ["lyric_font", "Lyrics font", "Used for lyric lines only."],
        ] as const
      )
        .filter(([key]) => key === field)
        .map(([key, label, help]) => (
          <SettingRow
            key={key}
            label={label}
            help={`${help} Type an installed Windows font name to apply immediately.`}
            keywords="font typeface"
          >
            <div className="font-control">
              <input
                className="settings-select font-select"
                type="text"
                aria-label={label}
                list={`${key}-fonts`}
                placeholder="Default"
                autoComplete="off"
                spellCheck={false}
                maxLength={100}
                value={
                  fonts.find((font) => font.family === settings[key])?.name ??
                  (settings[key]?.startsWith("SpotiFlexFont_")
                    ? "Saved custom font"
                    : (settings[key] ?? ""))
                }
                onChange={(event) => {
                  const name = event.target.value;
                  const imported = fonts.find(
                    (font) => font.name.toLowerCase() === name.toLowerCase(),
                  );
                  onSettings({ [key]: imported?.family ?? name });
                }}
              />
              <datalist id={`${key}-fonts`}>
                {systemFonts.map((name) => (
                  <option key={name} value={name} />
                ))}
                {fonts.map((font) => (
                  <option key={font.family} value={font.name} />
                ))}
              </datalist>
            </div>
          </SettingRow>
        ))}
      <SettingRow
        label="Custom fonts"
        help="Import a TTF, OTF, WOFF or WOFF2 file up to 5 MB."
        keywords="font import upload"
      >
        <input
          ref={input}
          className="file-input"
          type="file"
          accept=".ttf,.otf,.woff,.woff2"
          aria-label="Import custom font"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importFont(file);
          }}
        />
        <button
          className="pill outline"
          disabled={importing}
          onClick={() => input.current?.click()}
        >
          {importing ? "Importing font…" : "Import custom font"}
        </button>
      </SettingRow>
    </>
  );
}
