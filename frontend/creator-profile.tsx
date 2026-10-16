import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Contributor } from "./types";
import { rpc } from "./bridge";

const CreatorContext = createContext<(person: Contributor) => void>(() => {});
export const useCreatorProfile = () => useContext(CreatorContext);
export function creatorEmbed(id: string) {
  return /^\d{15,22}$/.test(id)
    ? `https://spicylyrics.org/embed/${id}`
    : undefined;
}
export function CreatorProfiles({ children }: { children: ReactNode }) {
  const [person, setPerson] = useState<Contributor>();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (person) dialog.current?.showModal();
    else dialog.current?.close();
  }, [person]);
  const url = person && creatorEmbed(person.id);
  return (
    <CreatorContext.Provider value={setPerson}>
      {children}
      <dialog
        ref={dialog}
        className="creator-dialog"
        aria-labelledby="creator-name"
        onCancel={() => setPerson(undefined)}
        onClose={() => setPerson(undefined)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setPerson(undefined);
        }}
      >
        <div className="creator-panel">
          <div className="section-heading">
            <h2 id="creator-name">{person?.username}</h2>
            <div className="inline-actions">
              <button
                className="pill"
                onClick={() => {
                  if (url) void rpc("open_link", { url });
                }}
              >
                Open in browser
              </button>
              <button
                className="icon-button"
                aria-label="Close creator profile"
                onClick={() => setPerson(undefined)}
              >
                ×
              </button>
            </div>
          </div>
          <p className="creator-frame-note">
            Spicy Lyrics currently allows embedded profiles inside Spotify only.
            If this profile is blank, open it in your browser.
          </p>
          {url && (
            <iframe
              key={url}
              src={url}
              title={`${person?.username} on Spicy Lyrics`}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              referrerPolicy="no-referrer"
            />
          )}
        </div>
      </dialog>
    </CreatorContext.Provider>
  );
}
