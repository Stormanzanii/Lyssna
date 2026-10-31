import type { Track } from "./types";

export interface RecentGroup {
  /** Spotify context URI the plays came from, or "" when Spotify gave none. */
  context: string;
  tracks: Track[];
}
export interface RecentDay {
  label: string;
  groups: RecentGroup[];
}

function dayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function dayLabel(date: Date, now: Date) {
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(date) === dayKey(now)) return "Today";
  if (dayKey(date) === dayKey(yesterday)) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Groups listening history (newest first, `added_at` = play time) by local
 * day, then merges consecutive plays from the same context.
 */
export function groupRecents(tracks: Track[], now = new Date()): RecentDay[] {
  const days: RecentDay[] = [];
  let lastDay = "";
  for (const track of tracks) {
    const played = new Date(track.added_at || "");
    if (Number.isNaN(played.getTime())) continue;
    const key = dayKey(played);
    if (key !== lastDay) {
      days.push({ label: dayLabel(played, now), groups: [] });
      lastDay = key;
    }
    const groups = days[days.length - 1].groups;
    const context = track.played_context || "";
    const previous = groups[groups.length - 1];
    if (previous && previous.context === context) previous.tracks.push(track);
    else groups.push({ context, tracks: [track] });
  }
  return days;
}

/** Maps a context URI to the in-app route, if Lyssna can open it. */
export function contextRoute(context: string) {
  if (/^spotify:user:[^:]+:collection$/.test(context)) return "liked";
  const match = /^spotify:(album|artist|playlist):([A-Za-z0-9]{22})$/.exec(
    context,
  );
  return match ? `${match[1]}:${match[2]}` : undefined;
}
