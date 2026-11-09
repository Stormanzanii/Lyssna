import { useEffect, useState } from "react";
import { rpc, subscribe } from "./bridge";
import type { DownloadStatus } from "./types";

const empty: DownloadStatus = {
  collections: [],
  locked: false,
  songs: 0,
  bytes: 0,
};

export type Downloads = { status: DownloadStatus; songs: Set<string> };

export function useDownloads(signedIn: boolean): Downloads {
  const [status, setStatus] = useState<DownloadStatus>(empty);
  const [songs, setSongs] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!signedIn) {
      setStatus(empty);
      return;
    }
    let live = true;
    rpc<DownloadStatus>("offline_status")
      .then((next) => live && next && setStatus(next))
      .catch(() => undefined);
    const stop = subscribe((event) => {
      if (event.type === "downloads") setStatus(event.status);
    });
    return () => {
      live = false;
      void stop.then((unlisten) => unlisten());
    };
  }, [signedIn]);
  useEffect(() => {
    if (!signedIn || !status.songs) {
      setSongs(new Set());
      return;
    }
    let live = true;
    rpc<string[]>("offline_songs")
      .then((uris) => live && uris && setSongs(new Set(uris)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [signedIn, status.songs]);
  return { status, songs };
}

const pending = (item: { done: number; total: number; downloading: boolean }) =>
  item.downloading || item.done < item.total;

export const isDownloaded = (status: DownloadStatus, uri: string) =>
  status.collections.some((item) => item.uri === uri && !pending(item));

const arrow = "M12 7v10.3m-3.5-3.5 3.5 3.5 3.5-3.5";

export function DownloadButton({
  status,
  uri,
  name,
  image,
  tracks,
}: {
  status: DownloadStatus;
  uri: string;
  name: string;
  image?: string;
  tracks: string[];
}) {
  const progress = status.collections.find((item) => item.uri === uri);
  const running = !!progress && pending(progress);
  const share = progress?.total ? progress.done / progress.total : 0;
  const label = running
    ? "Stop download"
    : progress
      ? "Remove from Downloads"
      : "Download";
  return (
    <button
      className={`icon-button action-icon download-button ${running ? "running" : progress ? "done" : ""}`}
      title={label}
      aria-label={`${label}: ${name}`}
      aria-pressed={!!progress}
      onClick={() => {
        if (progress)
          void rpc("offline_remove", { uri }).catch(() => undefined);
        else
          void rpc("offline_download", {
            uri,
            name,
            image: image ?? null,
            tracks: tracks.filter((track) =>
              track.startsWith("spotify:track:"),
            ),
          }).catch(() => undefined);
      }}
    >
      <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
        {progress && !running ? (
          <>
            <circle cx="12" cy="12" r="11" fill="var(--download-done)" />
            <path
              d={arrow}
              stroke="var(--download-arrow)"
              strokeWidth="2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : (
          <>
            <circle
              cx="12"
              cy="12"
              r="10"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
            {running ? (
              <>
                <circle
                  className="download-ring"
                  cx="12"
                  cy="12"
                  r="10"
                  fill="none"
                  stroke="var(--download-done)"
                  strokeWidth="2"
                  pathLength={100}
                  strokeDasharray={`${Math.max(2, share * 100)} 100`}
                  transform="rotate(-90 12 12)"
                />
                <rect
                  x="8.5"
                  y="8.5"
                  width="7"
                  height="7"
                  rx="1"
                  fill="var(--download-done)"
                />
              </>
            ) : (
              <path
                d={arrow}
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </>
        )}
      </svg>
    </button>
  );
}

/** The small green arrow Spotify puts beside downloaded songs and lists. */
export function DownloadedMark() {
  return (
    <svg
      className="downloaded-mark"
      viewBox="0 0 24 24"
      width="12"
      height="12"
      role="img"
      aria-label="Downloaded"
    >
      <circle cx="12" cy="12" r="12" fill="var(--spotify-green)" />
      <path
        d="M12 6v11.5m-4.5-4.5 4.5 4.5 4.5-4.5"
        stroke="#000"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Spotify's "Downloading 8 of 11" strip above Your Library. */
export function DownloadingBar({ status }: { status: DownloadStatus }) {
  const running = status.collections.filter(pending);
  if (!running.length) return null;
  const done = running.reduce((sum, item) => sum + item.done, 0);
  const total = running.reduce((sum, item) => sum + item.total, 0);
  return (
    <div className="downloading-bar" role="status">
      <div>
        <strong>Downloading</strong>
        <strong>
          {done} of {total}
        </strong>
      </div>
      <div className="downloading-track">
        <div style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </div>
    </div>
  );
}
