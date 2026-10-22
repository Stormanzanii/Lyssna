import { Fragment } from "react";

/**
 * Liquid Glass refraction: an SVG displacement filter for `backdrop-filter`.
 * The displacement map is flat in the middle and ramps near every edge, so
 * what's behind a glass control bends inward at its rim like light through
 * a curved lens, and the centre stays true. Red shifts sampling across,
 * green shifts it down; 50% grey means no shift.
 */
const ramp = (direction: "x" | "y") => {
  const [x2, y2] = direction === "x" ? ["1", "0"] : ["0", "1"];
  const colour = (value: number) =>
    direction === "x" ? `rgb(${value},0,0)` : `rgb(0,${value},0)`;
  // Edges sample from further inside; the middle 56% is untouched.
  const stops = [
    [0, 255],
    [0.22, 128],
    [0.78, 128],
    [1, 0],
  ]
    .map(
      ([offset, value]) =>
        `<stop offset="${offset}" stop-color="${colour(value)}"/>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" preserveAspectRatio="none"><linearGradient id="g" x2="${x2}" y2="${y2}">${stops}</linearGradient><rect width="100" height="100" fill="url(#g)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};
const X_MAP = ramp("x"),
  Y_MAP = ramp("y");

/** Rendered once while refraction is on; glass controls reference it. */
export function GlassRefractionFilter() {
  return (
    <svg className="glass-refraction-defs" aria-hidden="true" focusable="false">
      <filter
        id="glass-refraction"
        x="0"
        y="0"
        width="1"
        height="1"
        primitiveUnits="objectBoundingBox"
        colorInterpolationFilters="sRGB"
      >
        <feImage
          href={X_MAP}
          x="0"
          y="0"
          width="1"
          height="1"
          preserveAspectRatio="none"
          result="x"
        />
        <feImage
          href={Y_MAP}
          x="0"
          y="0"
          width="1"
          height="1"
          preserveAspectRatio="none"
          result="y"
        />
        <feComposite
          in="x"
          in2="y"
          operator="arithmetic"
          k2="1"
          k3="1"
          result="map"
        />
        <feGaussianBlur in="SourceGraphic" stdDeviation="0.004" result="soft" />
        {/* Red, green and blue bend by slightly different amounts, like
            glass dispersing light, which fringes colour at the rim. */}
        {(
          [
            ["r", 0.12, "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"],
            ["g", 0.135, "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"],
            ["b", 0.15, "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"],
          ] as const
        ).map(([channel, scale, matrix]) => (
          <Fragment key={channel}>
            <feDisplacementMap
              in="soft"
              in2="map"
              scale={scale}
              xChannelSelector="R"
              yChannelSelector="G"
              result={`${channel}-bent`}
            />
            <feColorMatrix
              in={`${channel}-bent`}
              type="matrix"
              values={matrix}
              result={channel}
            />
          </Fragment>
        ))}
        <feBlend in="r" in2="g" mode="screen" result="rg" />
        <feBlend in="rg" in2="b" mode="screen" />
      </filter>
    </svg>
  );
}
