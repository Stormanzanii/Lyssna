import { useEffect, useState } from "react";
import { rpc } from "./bridge";

// Discord IDs pass as strings: they exceed what a JavaScript number holds.
const DISCORD_ID = /^\d{15,20}$/;

/** The person's Discord username, once the background lookup answers. */
export function useDiscordUsername(id: string | undefined, enabled: boolean) {
  const [found, setFound] = useState<{ id: string; name: string }>();
  useEffect(() => {
    if (!enabled || !id || !DISCORD_ID.test(id)) return;
    let current = true;
    rpc<string | null>("discord_username", { id })
      .then((name) => {
        if (current && typeof name === "string" && name) setFound({ id, name });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [id, enabled]);
  return enabled && found && found.id === id ? found.name : undefined;
}
