/**
 * Player transport icons drawn in the style of Spotify's desktop player:
 * solid, rounded skip and play shapes and thin-stroked shuffle and repeat,
 * on a 16-unit grid. Original artwork, not Spotify's.
 */
type IconProps = { size?: number };

const solid = (size: number, children: React.ReactNode) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
  >
    {children}
  </svg>
);
const stroked = (size: number, children: React.ReactNode) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

// Skip buttons: a bar joined to a full-height triangle, edge to edge on
// the grid like Spotify's.
export const PreviousIcon = ({ size = 16 }: IconProps) =>
  solid(
    size,
    <>
      <rect x="1.25" y="1.25" width="2.5" height="13.5" rx="0.6" />
      <path d="M14.75 2.05v11.9a.7.7 0 0 1-1.07.6L3.4 8 13.68 1.45a.7.7 0 0 1 1.07.6Z" />
    </>,
  );

export const NextIcon = ({ size = 16 }: IconProps) =>
  solid(
    size,
    <>
      <rect x="12.25" y="1.25" width="2.5" height="13.5" rx="0.6" />
      <path d="M1.25 2.05v11.9a.7.7 0 0 0 1.07.6L12.6 8 2.32 1.45a.7.7 0 0 0-1.07.6Z" />
    </>,
  );

export const PlayIcon = ({ size = 16 }: IconProps) =>
  solid(
    size,
    // Spans x 3 to 13.6: a touch right of the box centre, the optical
    // middle of a triangle, so it looks centred in the round button.
    <path d="M3 2.2v11.6a.8.8 0 0 0 1.22.68l9.02-5.8a.8.8 0 0 0 0-1.36L4.22 1.52A.8.8 0 0 0 3 2.2Z" />,
  );

export const PauseIcon = ({ size = 16 }: IconProps) =>
  solid(
    size,
    <>
      <rect x="2.75" y="1.5" width="3.5" height="13" rx="0.9" />
      <rect x="9.75" y="1.5" width="3.5" height="13" rx="0.9" />
    </>,
  );

/** Two crossing paths with open arrowheads; the one passing under starts
 *  as a short stroke at the top left. */
export const ShuffleIcon = ({ size = 16 }: IconProps) =>
  stroked(
    size,
    <>
      <path d="M1 2.9c1 .3 1.75.95 2.4 1.9" />
      <path d="M1 14.4 5.55 7.35C6.6 5.75 7.85 4.6 10.1 4.6h4.4" />
      <path d="M6.85 10.25c1.05 1.65 2.15 2.7 3.95 2.7h3.7" />
      <path d="m12.35 2.1 2.5 2.5-2.5 2.5M12.35 10.45l2.5 2.5-2.5 2.5" />
    </>,
  );

/** A rounded box whose bottom edge ends in an open arrowhead pointing
 *  back; the repeat-one form adds a small 1. */
export const RepeatIcon = ({
  size = 16,
  one = false,
}: IconProps & { one?: boolean }) =>
  stroked(
    size,
    <>
      <path d="M4.6 12.85H4a3 3 0 0 1-3-3v-5.1a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v5.1a3 3 0 0 1-3 3H8.4" />
      <path d="m10.35 10.9-1.95 1.95 1.95 1.95" />
      {one && <path d="M7.1 5.4 8.25 4.55V9.1" strokeWidth="1.3" />}
    </>,
  );
