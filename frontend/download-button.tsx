import { useEffect, useState } from "react";
import { rpc, subscribe } from "./bridge";
import type { DownloadStatus } from "./types";

const empty: DownloadStatus = {
  collections: [],
  locked: false,
  songs: 0,
  bytes: 0,
};

export function useDownloads(signedIn: boolean) {
  const [status, setStatus] = useState<DownloadStatus>(empty);
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
  return status;
}

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
  const done = !!progress && progress.done >= progress.total;
  const share = progress && progress.total ? progress.done / progress.total : 0;
  const label = done
    ? "Remove from Downloads"
    : progress
      ? `Downloading ${progress.done} of ${progress.total}`
      : "Download";
  return (
    <button
      className={`icon-button action-icon download-button ${done ? "done" : progress ? "running" : ""}`}
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
        {done ? (
          <>
            <circle cx="12" cy="12" r="11" fill="var(--download-done)" />
            <path
              d="M12 7v10.3m-3.5-3.5 3.5 3.5 3.5-3.5"
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
              opacity={progress ? 0.3 : 1}
            />
            {progress && (
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
            )}
            <path
              d="M12 7v10.3m-3.5-3.5 3.5 3.5 3.5-3.5"
              stroke="currentColor"
              strokeWidth="2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        )}
      </svg>
    </button>
  );
}

export function isDownloaded(status: DownloadStatus, uri: string) {
  const progress = status.collections.find((item) => item.uri === uri);
  return !!progress && progress.done >= progress.total;
}
