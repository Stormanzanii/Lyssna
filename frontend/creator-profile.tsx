import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import type { Contributor } from "./types";
import { rpc } from "./bridge";
const CreatorContext = createContext<(person: Contributor) => void>(() => {});
export const useCreatorProfile = () => useContext(CreatorContext);
export function creatorEmbed(username: string) {
  const name = username.trim().replace(/^@+/, "");
  return name &&
    name.length <= 80 &&
    !/[\u0000-\u001f\u007f/\\]/u.test(name) &&
    name !== "." &&
    name !== ".."
    ? `https://spicylyrics.org/${encodeURIComponent(name)}`
    : undefined;
}
export function CreatorProfiles({ children }: { children: ReactNode }) {
  const [error, setError] = useState("");
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(""), 7000);
    return () => clearTimeout(timer);
  }, [error]);
  const open = (person: Contributor) => {
    const url = creatorEmbed(person.username);
    if (url)
      void rpc("open_creator_profile", {
        username: person.username,
        userId: person.id,
      }).catch(() =>
        setError("Could not open creator profile. Try again shortly."),
      );
  };
  return (
    <CreatorContext.Provider value={open}>
      {children}
      {error && (
        <div className="toast error" role="alert" onClick={() => setError("")}>
          {error}
        </div>
      )}
    </CreatorContext.Provider>
  );
}
