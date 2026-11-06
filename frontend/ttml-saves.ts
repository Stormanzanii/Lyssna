import type { CreatorLine } from "./ttml-creator-model";
import type { Track } from "./types";

// Like amll-ttml-tool's autosave: the latest state per song plus a few dated
// versions. The latest state stays in localStorage so it is written
// synchronously and survives the window closing mid-edit.
export const DRAFT_PREFIX = "lyssna.ttml-draft.";
export const VERSION_LIMIT = 10;
export const VERSION_INTERVAL_MS = 10 * 60_000;

export interface Draft {
  lines: CreatorLine[];
  text: string;
  savedAt?: number;
  song?: Track;
}
export interface SavedSong {
  uri: string;
  savedAt?: number;
  song?: Track;
  lines: number;
}
export interface DraftVersion {
  id?: number;
  uri: string;
  savedAt: number;
  lines: CreatorLine[];
  text: string;
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private storage is a convenience; the draft still lives in memory.
  }
}

export function parseDraft(raw: string | null): Draft | null {
  if (!raw) return null;
  try {
    const draft = JSON.parse(raw) as Draft;
    return Array.isArray(draft.lines) && typeof draft.text === "string"
      ? draft
      : null;
  } catch {
    return null;
  }
}

export const loadDraft = (uri: string) =>
  parseDraft(readStorage(DRAFT_PREFIX + uri));

export function writeDraft(uri: string, draft: Draft | null) {
  writeStorage(DRAFT_PREFIX + uri, draft ? JSON.stringify(draft) : null);
}

export function listDrafts(): SavedSong[] {
  const songs: SavedSong[] = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(DRAFT_PREFIX)) continue;
      const draft = parseDraft(localStorage.getItem(key));
      if (!draft) continue;
      songs.push({
        uri: key.slice(DRAFT_PREFIX.length),
        savedAt: draft.savedAt,
        song: draft.song,
        lines: draft.lines.length,
      });
    }
  } catch {
    return songs;
  }
  return songs.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
}

export function newVersionDue(
  last: number | undefined,
  now: number,
  leaving: boolean,
) {
  return leaving || last === undefined || now - last >= VERSION_INTERVAL_MS;
}

/** Ids of versions past the newest `limit`. */
export function staleVersions(versions: DraftVersion[], limit = VERSION_LIMIT) {
  return [...versions]
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(limit)
    .flatMap((version) => (version.id === undefined ? [] : [version.id]));
}

export function savedLabel(savedAt: number, now = Date.now()) {
  const date = new Date(savedAt);
  const today = new Date(now).toDateString() === date.toDateString();
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return today
    ? time
    : `${date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: date.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" })}, ${time}`;
}

let database: Promise<IDBDatabase> | undefined;
function openVersions() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("lyssna-ttml-saves", 1);
    request.onupgradeneeded = () =>
      request.result
        .createObjectStore("versions", { keyPath: "id", autoIncrement: true })
        .createIndex("uri", "uri");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(new Error("TTML save history is unavailable"));
    };
  }));
}

function done(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
}

export async function listVersions(uri: string): Promise<DraftVersion[]> {
  const db = await openVersions();
  const versions = await new Promise<DraftVersion[]>((resolve, reject) => {
    const request = db
      .transaction("versions")
      .objectStore("versions")
      .index("uri")
      .getAll(uri);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return versions.sort((a, b) => b.savedAt - a.savedAt);
}

export async function addVersion(version: DraftVersion) {
  const db = await openVersions();
  const transaction = db.transaction("versions", "readwrite");
  transaction.objectStore("versions").add(version);
  await done(transaction);
  const stale = staleVersions(await listVersions(version.uri));
  if (!stale.length) return;
  const pruning = db.transaction("versions", "readwrite");
  for (const id of stale) pruning.objectStore("versions").delete(id);
  await done(pruning);
}

export async function deleteSaves(uri: string) {
  writeDraft(uri, null);
  const versions = await listVersions(uri).catch(() => []);
  if (!versions.length) return;
  const db = await openVersions();
  const transaction = db.transaction("versions", "readwrite");
  for (const version of versions)
    if (version.id !== undefined)
      transaction.objectStore("versions").delete(version.id);
  await done(transaction);
}
