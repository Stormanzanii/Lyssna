/** Carries this window's saved preferences over from before the rename to
 * Lyssna: every `spotiflex.` key moves to `lyssna.` unless already set.
 * Imported first by the entry point, before anything reads them. */
const OLD_PREFIX = "spotiflex.";
const NEW_PREFIX = "lyssna.";
try {
  const old: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(OLD_PREFIX)) old.push(key);
  }
  for (const key of old) {
    try {
      const renamed = NEW_PREFIX + key.slice(OLD_PREFIX.length);
      const value = localStorage.getItem(key);
      if (value !== null && localStorage.getItem(renamed) === null)
        localStorage.setItem(renamed, value);
      localStorage.removeItem(key);
    } catch {
      // Storage full or blocked: leave this key for the next start.
    }
  }
} catch {
  // Storage unavailable.
}
export {};
