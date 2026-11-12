import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { artworkFor } from "./artwork";
import { MotionVideo } from "./components";

export function CoverViewer({
  images,
  title,
  motion,
  onClose,
}: {
  images: { url: string; width?: number | null }[];
  title: string;
  motion?: string | null;
  onClose: () => void;
}) {
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
    root.current?.focus();
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
      tabIndex={-1}
      onClick={dismiss}
      onAnimationEnd={(event) =>
        closing && event.target === event.currentTarget && onClose()
      }
    >
      {src && (
        <div
          className="cover-viewer-art"
          onClick={(event) => event.stopPropagation()}
        >
          <img src={src} alt={title} draggable={false} />
          {motion && <MotionVideo key={motion} url={motion} />}
        </div>
      )}
    </div>,
    document.body,
  );
}
