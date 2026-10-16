import { createContext, useContext, type ReactNode } from "react";
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
    ? `https://spicylyrics.org/embed/${encodeURIComponent(name)}`
    : undefined;
}
export function CreatorProfiles({ children }: { children: ReactNode }) {
  const open = (person: Contributor) => {
    const url = creatorEmbed(person.username);
    if (url)
      void rpc("open_creator_profile", {
        username: person.username,
      }).catch(() => rpc("open_link", { url }));
  };
  return (
    <CreatorContext.Provider value={open}>{children}</CreatorContext.Provider>
  );
}
