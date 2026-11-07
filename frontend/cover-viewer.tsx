import { useEffect, useRef, useState } from "react";
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
  const root = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const dismiss = () => setClosing(true);
  useEffect(() => {
    // Reduce motion turns the fade off, so no animationend would arrive.
    if (
      closing &&
      root.current &&
      getComputedStyle(root.current).animationName === "none"
    )
      onClose();
  }, [closing, onClose]);
  useEffect(() => {
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setClosing(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const src = artworkFor(images, 2000);
  return createPortal(
    <div
      ref={root}
      className={`cover-viewer${closing ? " closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={`${title} cover`}
      onClick={dismiss}
      onAnimationEnd={(event) =>
        closing && event.target === event.currentTarget && onClose()
      }
    >
      {src && (
        <img
          src={src}
          alt={title}
          draggable={false}
          onClick={(event) => event.stopPropagation()}
        />
      )}
      <button ref={close} className="cover-viewer-close" onClick={dismiss}>
        Close
      </button>
    </div>,
    document.body,
  );
}
