import { useEffect, useReducer } from "react";
import { rpc, subscribe } from "./bridge";
import { setFrameCap } from "./frame-cap";
import { emptyState, reducer, type AppState } from "./state";
import type { PlayerRequest, Snapshot } from "./types";

/** App state for a secondary window (the lyrics popout or Cinema): the
 *  desktop's snapshot, then the same events the main window follows. */
export function useDesktopState() {
  const [state, dispatch] = useReducer(reducer, emptyState);
  useEffect(() => {
    let disposed = false,
      unlisten: (() => void) | undefined;
    const pending: Parameters<typeof dispatch>[0][] = [];
    let bootstrapped = false;
    void (async () => {
      unlisten = await subscribe((event) => {
        if (disposed) return;
        if (bootstrapped) dispatch(event);
        else pending.push(event);
      });
      const snapshot = await rpc<Snapshot>("bootstrap");
      if (disposed) return;
      dispatch({ type: "bootstrap", snapshot });
      bootstrapped = true;
      pending.splice(0).forEach(dispatch);
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    setFrameCap(
      state.settings.animation_fps_cap_enabled
        ? (state.settings.animation_fps_cap ?? 60)
        : 0,
    );
  }, [
    state.settings.animation_fps_cap_enabled,
    state.settings.animation_fps_cap,
  ]);
  return [state, dispatch] as const;
}

/** Where the main window sends controls: this computer, or the device
 *  Spotify reports active. */
export function playerTarget(state: AppState) {
  const active = state.devices.find((device) => device.is_active);
  return !active || active.name === state.local_device_name || !active.id
    ? "native"
    : active.id;
}

/** Sends a player command to the device the main window would. */
export const sendPlayer = (state: AppState, request: PlayerRequest) =>
  void rpc("player", { request, target: playerTarget(state) }).catch(() => {});
