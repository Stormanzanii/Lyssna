import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { rpc } from "./bridge";
import type { Artist, Track } from "./types";

type Credit = { name: string; roles: string[]; uri: string | null };
type TrackCredits = {
  name: string;
  groups: { name: string; credits: Credit[] }[];
  sources: string[];
};

/** Spotify's Credits dialog: every contributor, grouped by what they did,
 *  with the song's sources at the end. */
export function CreditsDialog({
  track,
  saved,
  onArtist,
  onFollow,
  onClose,
}: {
  track: Track;
  saved: Record<string, boolean>;
  onArtist: (artist: Artist) => void;
  onFollow: (artist: Artist) => void;
  onClose: () => void;
}) {
  const [credits, setCredits] = useState<TrackCredits | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setCredits(null);
    setFailed(false);
    if (!track.id) {
      setFailed(true);
      return;
    }
    rpc<TrackCredits>("track_credits", { id: track.id })
      .then((found) => live && setCredits(found))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [track.id]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  // An artist the dialog names, as the rest of the app knows them.
  const artistOf = (credit: Credit): Artist | undefined => {
    if (!credit.uri) return undefined;
    const id = credit.uri.split(":")[2];
    return (
      track.artists.find((artist) => artist.id === id) ?? {
        id,
        uri: credit.uri,
        name: credit.name,
      }
    );
  };
  return (
    <div className="modal-backdrop credits-backdrop" onClick={onClose}>
      <section
        className="credits-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Credits"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h1>Credits</h1>
            <h2>{credits?.name || track.name}</h2>
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="credits-dialog-body">
          {!credits && !failed && <p className="credits-note">Loading…</p>}
          {failed && (
            <p className="credits-note">
              Spotify has no credits for this song.
            </p>
          )}
          {credits?.groups.map((group) => (
            <section key={group.name} className="credits-group">
              <h3>{group.name}</h3>
              {group.credits.map((credit) => {
                const artist = artistOf(credit);
                return (
                  <div key={credit.name} className="credits-person">
                    <div>
                      {artist ? (
                        <button
                          className="text-link"
                          onClick={() => {
                            onClose();
                            onArtist(artist);
                          }}
                        >
                          {credit.name}
                        </button>
                      ) : (
                        <span>{credit.name}</span>
                      )}
                      <p>{credit.roles.join(" • ")}</p>
                    </div>
                    {artist && (
                      <button
                        className="pill outline"
                        onClick={() => onFollow(artist)}
                      >
                        {saved[credit.uri!] ? "Following" : "Follow"}
                      </button>
                    )}
                  </div>
                );
              })}
            </section>
          ))}
          {!!credits?.sources.length && (
            <div className="credits-sources">
              <strong>Sources</strong>
              <p>{credits.sources.join(", ")}</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
