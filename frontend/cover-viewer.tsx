import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { artworkFor } from "./artwork";

export function CoverViewer({
  images,
  title,
  onClose,
}: {
  images: { url: string; width?: number | null }[];
  title: string;
  onClose: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const src = artworkFor(images, 2000);
  return createPortal(
    <div
      className="cover-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={`${title} cover`}
      onClick={onClose}
    >
      {src && (
        <img
          src={src}
          alt={title}
          draggable={false}
          onClick={(event) => event.stopPropagation()}
        />
      )}
      <button ref={close} className="cover-viewer-close" onClick={onClose}>
        Close
      </button>
    </div>,
    document.body,
  );
}
