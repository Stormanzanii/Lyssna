const INTERVAL = 3 * 24 * 60 * 60 * 1000;

/** Per-account reminder; a failed storage write avoids repeating within this run. */
export function createDJReminder(
  storage: Pick<Storage, "getItem" | "setItem">,
) {
  const shown = new Map<string, number>();
  return (account: string, now = Date.now()): boolean => {
    if (!account) return false;
    const key = `spotiflex.dj-hint.${account}`;
    let previous = shown.get(account);
    if (previous === undefined) {
      try {
        const saved = Number(storage.getItem(key));
        if (Number.isFinite(saved) && saved > 0) previous = saved;
      } catch {
        /* Private storage can be unavailable. */
      }
    }
    if (previous !== undefined && now >= previous && now - previous < INTERVAL)
      return false;
    shown.set(account, now);
    try {
      storage.setItem(key, String(now));
    } catch {
      /* Retain this run's timestamp. */
    }
    return true;
  };
}
