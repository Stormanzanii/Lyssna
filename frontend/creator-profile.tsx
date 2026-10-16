import { createContext, useContext, type ReactNode } from "react";
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
  const open = (person: Contributor) => {
    const url = creatorEmbed(person.id);
    if (url)
      void rpc("open_creator_profile", {
        id: person.id,
        name: person.username,
      }).catch(() => rpc("open_link", { url }));
  };
  return (
    <CreatorContext.Provider value={open}>{children}</CreatorContext.Provider>
  );
}
