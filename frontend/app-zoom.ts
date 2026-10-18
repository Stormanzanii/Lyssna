import { useEffect, useRef } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

function clampZoom(percent: number): number {
  return Math.min(200, Math.max(75, Number.isFinite(percent) ? percent : 100));
}

export function useAppZoom(
  percent: number,
  save: (percent: number) => void,
  reportError: (message: string, error: boolean) => void,
) {
  const desired = useRef(clampZoom(percent));
  const callbacks = useRef({ save, reportError });
  callbacks.current = { save, reportError };

  useEffect(() => {
    const zoom = clampZoom(percent);
    desired.current = zoom;
    void getCurrentWebview()
      .setZoom(zoom / 100)
      .catch(() => {
        if (desired.current === zoom)
          callbacks.current.reportError(
            "Cannot change zoom. Try again shortly.",
            true,
          );
      });
  }, [percent]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      let zoom: number;
      if (["+", "="].includes(event.key) || event.code === "NumpadAdd")
        zoom = clampZoom(desired.current + 10);
      else if (
        ["-", "_"].includes(event.key) ||
        event.code === "NumpadSubtract"
      )
        zoom = clampZoom(desired.current - 10);
      else if (event.key === "0" || event.code === "Numpad0") zoom = 100;
      else return;
      event.preventDefault();
      if (zoom === desired.current) return;
      desired.current = zoom;
      callbacks.current.save(zoom);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);
}
