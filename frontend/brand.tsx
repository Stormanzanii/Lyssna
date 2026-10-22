// App mark and DJ artwork, drawn locally so no Spotify assets are bundled.

// Mirrors src/ui/icon_pixels.rs so the window icon and in-app mark match:
// Lucide's MicVocal (ISC) in black on a Spotify-green disc, with strokes
// thickened from 2 to 2.8 units and the glyph centred at 56% of the height.
const MIC_PATHS = [
  "m11 7.601-5.994 8.19a1 1 0 0 0 .1 1.298l.817.818a1 1 0 0 0 1.314.087L15.09 12",
  "M16.5 21.174C15.5 20.5 14.372 20 13 20c-2.058 0-3.928 2.356-6 2-2.072-.356-2.775-3.369-1.5-4.5",
];
const MIC_SCALE = 0.56 / 23;

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg
      className="logo"
      width={size}
      height={size}
      viewBox="0 0 1 1"
      aria-hidden="true"
    >
      <circle cx={0.5} cy={0.5} r={0.5} fill="#1ed760" />
      <g
        transform={`translate(0.5 0.5) scale(${MIC_SCALE}) translate(-13.41 -11.52)`}
        fill="none"
        stroke="#000"
        strokeWidth={2.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {MIC_PATHS.map((d) => (
          <path key={d} d={d} />
        ))}
        <circle cx={16} cy={7} r={5} />
      </g>
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
