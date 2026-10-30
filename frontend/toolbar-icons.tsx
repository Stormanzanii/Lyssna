/**
 * Lyrics toolbar icons drawn in parts so each part can move on hover.
 * Shapes are Lucide's (lucide-react 0.577, ISC), split into groups.
 */
import type { ReactNode } from "react";

function Icon({ name, children }: { name: string; children: ReactNode }) {
  return (
    <svg
      className={`toolbar-icon toolbar-icon-${name}`}
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** 文A: the symbol comes forward on hover and stays while romanizing. */
export const TranslateIcon = () => (
  <Icon name="translate">
    <g className="part-symbol">
      <path d="m5 8 6 6" />
      <path d="m4 14 6-6 2-3" />
      <path d="M2 5h12" />
      <path d="M7 2h1" />
    </g>
    <g className="part-latin">
      <path d="m22 22-5-10-5 10" />
      <path d="M14 18h6" />
    </g>
  </Icon>
);

/** Bars that bounce like a level meter. */
export const WordSyncIcon = () => (
  <Icon name="word-sync">
    {["M2 10v3", "M6 6v11", "M10 3v18", "M14 8v7", "M18 5v13", "M22 10v3"].map(
      (d, index) => (
        <path key={d} d={d} className={`part-bar part-bar-${index}`} />
      ),
    )}
  </Icon>
);

/** Rows that squeeze together. */
export const CompactIcon = () => (
  <Icon name="compact">
    <rect width="18" height="18" x="3" y="3" rx="2" className="part-frame" />
    <path d="M21 9H3" className="part-row-top" />
    <path d="M21 15H3" className="part-row-bottom" />
  </Icon>
);

/** A panel that slides shut, its chevron pushing left. */
export const HideArtworkIcon = () => (
  <Icon name="hide-artwork">
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M9 3v18" className="part-divider" />
    <path d="m16 15-3-3 3-3" className="part-chevron" />
  </Icon>
);

/** Two arrows that pulse left and right. */
export const SwapSidesIcon = () => (
  <Icon name="swap">
    <g className="part-left">
      <path d="M8 3 4 7l4 4" />
      <path d="M4 7h16" />
    </g>
    <g className="part-right">
      <path d="m16 21 4-4-4-4" />
      <path d="M20 17H4" />
    </g>
  </Icon>
);

/** An arrow that shoots up while the next one rises into place. */
export const UploadIcon = () => (
  <Icon name="upload">
    <g className="part-arrow">
      <path d="M12 3v12" />
      <path d="m17 8-5-5-5 5" />
    </g>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
  </Icon>
);

/** Arrows that spin like a refresh. */
export const RetryIcon = () => (
  <Icon name="retry">
    <g className="part-spinner">
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </g>
  </Icon>
);

/** Corners that push out and draw back in. */
export const FullScreenIcon = () => (
  <Icon name="fullscreen">
    <g className="part-corner-out">
      <path d="M15 3h6v6" />
      <path d="m21 3-7 7" />
    </g>
    <g className="part-corner-in">
      <path d="m3 21 7-7" />
      <path d="M9 21H3v-6" />
    </g>
  </Icon>
);

/** A tray with an arrow rising out of it: lyrics in a window of their
 *  own. The pixels-spicy-lyrics fork's External Cinema glyph (AGPL-3.0). */
export const CinemaIcon = () => (
  <svg
    width="19"
    height="19"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M8 10.5H6.75A1.75 1.75 0 0 0 5 12.25v7.5c0 .97.78 1.75 1.75 1.75h10.5c.97 0 1.75-.78 1.75-1.75v-7.5a1.75 1.75 0 0 0-1.75-1.75H16" />
    <path d="M12 14V4" />
    <path d="m8.5 7.5 3.5-3.5 3.5 3.5" />
  </svg>
);

/** A screen with a small window in its corner: the lyrics popout, drawn
 *  in thin outlines like the Cinema glyph beside it. */
export const PopoutIcon = () => (
  <svg
    width="19"
    height="19"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <rect x="12" y="12" width="6" height="4" rx="1" />
  </svg>
);
