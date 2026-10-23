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

export const PreviousIcon = ({ size = 16 }: IconProps) =>
  solid(
    size,
    <>
      <rect x="2" y="1.5" width="2.2" height="13" rx="0.7" />
      <path d="M14 2.3v11.4a.8.8 0 0 1-1.22.68L4.6 8.68a.8.8 0 0 1 0-1.36l8.18-5.7A.8.8 0 0 1 14 2.3Z" />
    </>,
  );

export const NextIcon = ({ size = 16 }: IconProps) =>
  solid(
    size,
    <>
      <rect x="11.8" y="1.5" width="2.2" height="13" rx="0.7" />
      <path d="M2 2.3v11.4a.8.8 0 0 0 1.22.68l8.18-5.7a.8.8 0 0 0 0-1.36L3.22 1.62A.8.8 0 0 0 2 2.3Z" />
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

export const ShuffleIcon = ({ size = 16 }: IconProps) =>
  stroked(
    size,
    <>
      <path d="M1.5 4.25h1.9c1.3 0 2.2.55 2.95 1.6l3.3 4.3c.75 1.05 1.65 1.6 2.95 1.6h1.4" />
      <path d="M1.5 11.75h1.9c1.3 0 2.2-.55 2.95-1.6M9.65 5.85c.75-1.05 1.65-1.6 2.95-1.6h1.4" />
      <path d="m12.6 2.4 1.85 1.85-1.85 1.85M12.6 9.9l1.85 1.85-1.85 1.85" />
    </>,
  );

/** A rounded loop with an arrowhead; the repeat-one form adds a small 1. */
export const RepeatIcon = ({
  size = 16,
  one = false,
}: IconProps & { one?: boolean }) =>
  stroked(
    size,
    <>
      <path d="M6 12.25H4.5A2.75 2.75 0 0 1 1.75 9.5v-3A2.75 2.75 0 0 1 4.5 3.75h7a2.75 2.75 0 0 1 2.75 2.75v3a2.75 2.75 0 0 1-2.75 2.75H9" />
      <path d="m10.75 10.5-1.75 1.75L10.75 14" />
      {one && <path d="M7.25 6.5 8.25 5.75v4" strokeWidth="1.3" />}
    </>,
  );
