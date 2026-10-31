import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppEvent } from "./types";

export const rpc = <T = void>(
  command: string,
  args?: Record<string, unknown>,
) => invoke<T>(command, args);
export const subscribe = (callback: (event: AppEvent) => void) =>
  listen<AppEvent>("lyssna", (event) => callback(event.payload));
