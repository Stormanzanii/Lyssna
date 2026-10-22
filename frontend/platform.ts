/** Build platform supplied by the Tauri CLI, with a local Vite fallback. */
export const IS_MAC = ["macos", "darwin"].includes(__APP_PLATFORM__);
export const MODIFIER = IS_MAC ? "Cmd" : "Ctrl";
export const PLATFORM_LABEL = IS_MAC ? "macOS" : "Windows (64 bit)";
