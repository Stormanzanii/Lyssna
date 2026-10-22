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
      <rect x="2.6" y="2.4" width="1.9" height="11.2" rx="0.7" />
      <path d="M13.9 3.06v9.88a.8.8 0 0 1-1.23.67L5.9 8.67a.8.8 0 0 1 0-1.34l6.77-4.94a.8.8 0 0 1 1.23.67Z" />
    </>,
  );

export const NextIcon = ({ size = 16 }: IconProps) =>
  solid(
    size,
    <>
      <rect x="11.5" y="2.4" width="1.9" height="11.2" rx="0.7" />
      <path d="M2.1 3.06v9.88a.8.8 0 0 0 1.23.67l6.77-4.94a.8.8 0 0 0 0-1.34L3.33 2.39a.8.8 0 0 0-1.23.67Z" />
    </>,
  );

export const PlayIcon = ({ size = 16 }: IconProps) =>
  solid(
    size,
    <path d="M4.2 2.4v11.2a.8.8 0 0 0 1.2.69l9.4-5.6a.8.8 0 0 0 0-1.38l-9.4-5.6a.8.8 0 0 0-1.2.69Z" />,
  );

export const PauseIcon = ({ size = 16 }: IconProps) =>
  solid(
    size,
    <>
      <rect x="3.2" y="2.2" width="3.2" height="11.6" rx="0.8" />
      <rect x="9.6" y="2.2" width="3.2" height="11.6" rx="0.8" />
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
