import { loadDraft } from "./ttml-saves";
import { toLyrics } from "./ttml-creator-model";
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

export function draftPreview(uri: string | undefined): Lyrics | null {
  if (!uri || !working.has(uri) || dismissed.has(uri)) return null;
  const draft = loadDraft(uri);
  if (!draft?.lines.length) return null;
  const lyrics = toLyrics(draft.lines);
  return lyrics.lines.length ? lyrics : null;
}
