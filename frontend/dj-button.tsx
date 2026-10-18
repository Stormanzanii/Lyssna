import { useEffect, useRef } from "react";
import { DJArtwork } from "./brand";

export function DJButton({
  onRefresh,
  onHold,
}: {
  onRefresh: () => void;
  onHold: () => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressClick = useRef(false);
  const callbacks = useRef({ onRefresh, onHold });
  callbacks.current = { onRefresh, onHold };
  const clear = () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  };
  const cancel = () => {
    clear();
    suppressClick.current = true;
  };
  useEffect(() => clear, []);
  return (
    <button
      className="icon-button dj-refresh"
      title="Refresh DJ. Text and voice requests unavailable."
      aria-label="Refresh DJ"
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        clear();
        suppressClick.current = false;
        timer.current = setTimeout(() => {
          timer.current = undefined;
          suppressClick.current = true;
          callbacks.current.onHold();
        }, 500);
      }}
      onPointerUp={clear}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onBlur={cancel}
      onContextMenu={(event) => event.preventDefault()}
      onClick={(event) => {
        clear();
        const held = suppressClick.current;
        suppressClick.current = false;
        if (event.detail !== 0 && held) return;
        callbacks.current.onRefresh();
      }}
    >
      <DJArtwork />
    </button>
  );
}
