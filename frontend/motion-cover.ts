import { useEffect, useState } from "react";
import { rpc } from "./bridge";
import type { Track } from "./types";

interface MotionCover {
  avc?: string | null;
  hevc?: string | null;
}

// One lookup per album for the whole session; the backend keeps its own
// cache across restarts.
const found = new Map<string, Promise<string | null>>();

let hevc: boolean | undefined;
function playsHevc() {
  if (hevc === undefined) {
    const probe = document.createElement("video");
    hevc = !!probe.canPlayType('video/mp4; codecs="hvc1.2.4.L123.B0"');
  }
  return hevc;
}

function lookUp(track: Track): Promise<string | null> {
  const key = track.album.id ?? track.uri;
  let pending = found.get(key);
  if (!pending) {
    pending = rpc<MotionCover | null>("motion_cover", {
      uri: track.uri,
      albumId: track.album.id ?? null,
      albumName: track.album.name ?? "",
    }).then(
      (cover) =>
        (playsHevc() ? cover?.hevc || cover?.avc : cover?.avc || cover?.hevc) ??
        null,
      () => {
        // Failures are retried the next time the album comes up.
        found.delete(key);
        return null;
      },
    );
    found.set(key, pending);
  }
  return pending;
}

/** Apple Music's animated cover for the track's album, when it has one. */
export function useMotionCover(track: Track | undefined, enabled: boolean) {
  const [shown, setShown] = useState<{ key: string; url: string | null }>();
  const usable = enabled && !!track?.uri.startsWith("spotify:track:");
  const key = usable && track ? (track.album.id ?? track.uri) : null;
  useEffect(() => {
    if (!key || !track) return;
    let current = true;
    void lookUp(track).then((url) => current && setShown({ key, url }));
    return () => {
      current = false;
    };
    // Every track on an album shares its cover; only the album matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return key && shown?.key === key ? shown.url : null;
}
