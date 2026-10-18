// App mark and DJ artwork, drawn locally so no Spotify assets are bundled.

// Mirrors src/ui/icon_pixels.rs so the window icon and in-app mark match.
const BARS: [number, number][] = [
  [0.2, 0.17],
  [0.4, 0.37],
  [0.6, 0.25],
  [0.8, 0.31],
];
const BAR_HALF_WIDTH = 0.078;

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg
      className="logo"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
    >
      {BARS.map(([x, half]) => (
        <rect
          key={x}
          x={(x - BAR_HALF_WIDTH) * 100}
          y={(0.5 - half) * 100}
          width={BAR_HALF_WIDTH * 200}
          height={half * 200}
          rx={BAR_HALF_WIDTH * 100}
          fill="#fff"
        />
      ))}
    </svg>
  );
}

const DJ_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='512' height='512' viewBox='0 0 100 100'>" +
  "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>" +
  "<stop offset='0' stop-color='#1d74e6'/><stop offset='1' stop-color='#0a3a8c'/>" +
  "</linearGradient></defs>" +
  "<rect width='100' height='100' fill='url(#g)'/>" +
  "<circle cx='54' cy='48' r='26' fill='none' stroke='#38c8ff' stroke-opacity='.45' stroke-width='9'/>" +
  "<circle cx='49' cy='51' r='26' fill='none' stroke='#1ed760' stroke-width='8'/>" +
  "</svg>";
/** DJ cover as an image URL, also used to tint the DJ ambience. */
export const DJ_COVER = `data:image/svg+xml,${encodeURIComponent(DJ_SVG)}`;

export function DJArtwork() {
  return (
    <div className="dj-art" aria-label="DJ artwork">
      <img src={DJ_COVER} alt="" draggable={false} />
    </div>
  );
}
