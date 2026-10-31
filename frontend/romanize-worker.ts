/// <reference lib="webworker" />
/* Romanization off the UI thread: loading the Japanese dictionary and
 * converting a whole song otherwise stalls the page for a moment. */
import { romanizeLyrics } from "./romanization";
import type { Lyrics } from "./types";

self.onmessage = async (
  event: MessageEvent<{ id: number; lyrics: Lyrics }>,
) => {
  const { id, lyrics } = event.data;
  let result: Lyrics | null = null;
  try {
    const converted = await romanizeLyrics(lyrics);
    if (converted !== lyrics) result = converted;
  } catch {
    /* The page keeps the lyrics as they are. */
  }
  self.postMessage({ id, lyrics: result });
};
