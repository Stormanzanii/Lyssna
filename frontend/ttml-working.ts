import { loadDraft } from "./ttml-saves";
import { type CreatorLine, toLyrics } from "./ttml-creator-model";
import type { Lyrics } from "./types";

// Songs whose draft was edited in the TTML Creator this session. Their
// timed draft shows on the Lyrics page until the user picks the original.
const working = new Set<string>();
const dismissed = new Set<string>();

export function markWorking(uri: string) {
  working.add(uri);
  dismissed.delete(uri);
}

export function forgetWorking(uri: string) {
  working.delete(uri);
}

export function dismissDraft(uri: string) {
  dismissed.add(uri);
}

const SHOW_KEY = "lyssna.ttml-show-preview";

export function showsPreview() {
  try {
    return localStorage.getItem(SHOW_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setShowsPreview(on: boolean) {
  try {
    localStorage.setItem(SHOW_KEY, on ? "1" : "0");
  } catch {
    // Without storage the choice lasts until Lyssna restarts.
  }
  shown = on;
}

let shown = showsPreview();

// The lines open in the TTML Creator, saved or not, so a song with nothing
// drafted yet still previews as a draft.
const live = new Map<string, CreatorLine[]>();

export function showLive(uri: string, lines: CreatorLine[]) {
  if (lines.length) live.set(uri, lines);
  else live.delete(uri);
}

export function draftPreview(uri: string | undefined): Lyrics | null {
  if (!uri || !shown || dismissed.has(uri)) return null;
  const lines =
    live.get(uri) ?? (working.has(uri) ? loadDraft(uri)?.lines : undefined);
  if (!lines?.length) return null;
  const lyrics = toLyrics(lines);
  return lyrics.lines.length ? lyrics : null;
}
