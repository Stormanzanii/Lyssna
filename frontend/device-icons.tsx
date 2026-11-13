import type { ReactNode } from "react";
import { ANDROID, APPLE, LINUX } from "./device-logos";

export type DeviceKind =
  | "computer"
  | "phone"
  | "tablet"
  | "tv"
  | "receiver"
  | "console"
  | "car"
  | "watch"
  | "cast"
  | "alexa"
  | "group"
  | "speaker";

export type Platform =
  "windows" | "mac" | "linux" | "android" | "playstation" | "xbox" | "";

const WINDOWS =
  "M0 0h11.4v11.4H0zM12.6 0H24v11.4H12.6zM0 12.6h11.4V24H0zM12.6 12.6H24V24H12.6z";

const LOGOS: Partial<Record<Platform, string>> = {
  windows: WINDOWS,
  mac: APPLE,
  linux: LINUX,
  android: ANDROID,
};

function Logo({
  platform,
  x,
  y,
  size,
}: {
  platform: Platform;
  x: number;
  y: number;
  size: number;
}) {
  const path = LOGOS[platform];
  if (!path) return null;
  const scale = size / 24;
  return (
    <path
      d={path}
      fill="currentColor"
      stroke="none"
      transform={`translate(${x - size / 2} ${y - size / 2}) scale(${scale})`}
    />
  );
}

function Lens({ x, y, r = 0.55 }: { x: number; y: number; r?: number }) {
  return <circle cx={x} cy={y} r={r} fill="currentColor" stroke="none" />;
}

// Laptops are drawn from behind, as the person across the room sees them,
// so the maker's logo sits in the middle of the lid.
function Laptop({ platform }: { platform: Platform }) {
  switch (platform) {
    case "mac":
      return (
        <>
          <rect x="3.5" y="4" width="17" height="12" rx="1.4" />
          <path d="M2 17.6h20l-.6 1.3a1.1 1.1 0 0 1-1 .7H3.6a1.1 1.1 0 0 1-1-.7z" />
          <Logo platform="mac" x={12} y={9.8} size={6.6} />
        </>
      );
    case "windows":
      return (
        <>
          <rect x="3.5" y="3.8" width="17" height="12.6" rx="0.5" />
          <path d="M3.5 14.4h17" strokeWidth={1.1} />
          <rect x="2.5" y="17.6" width="19" height="2.2" rx="0.4" />
          <Logo platform="windows" x={12} y={9.1} size={5.4} />
        </>
      );
    case "linux":
      return (
        <>
          <rect x="3.5" y="3.8" width="17" height="12.6" rx="0.3" />
          <rect x="2.5" y="17.4" width="19" height="2.6" rx="0.3" />
          <Logo platform="linux" x={12} y={10.1} size={7.4} />
        </>
      );
    default:
      return (
        <>
          <rect x="3.5" y="4" width="17" height="12" rx="1.6" />
          <rect x="2.5" y="17.6" width="19" height="2.2" rx="1.1" />
        </>
      );
  }
}

function Phone({ platform }: { platform: Platform }) {
  switch (platform) {
    case "mac":
      return (
        <>
          <rect x="6.5" y="2.5" width="11" height="19" rx="2.8" />
          <rect
            x="8"
            y="4"
            width="4.6"
            height="4.6"
            rx="1.3"
            strokeWidth={1.1}
          />
          <Lens x={9.3} y={5.3} />
          <Lens x={9.3} y={7.3} />
          <Lens x={11.3} y={6.3} />
          <Logo platform="mac" x={12} y={13.4} size={5} />
        </>
      );
    case "android":
      return (
        <>
          {/* Galaxy S24 Ultra: square corners and free-standing lenses. */}
          <rect x="6.5" y="2.5" width="11" height="19" rx="1.3" />
          <g strokeWidth={1}>
            <circle cx="9.2" cy="5.1" r="0.9" />
            <circle cx="9.2" cy="8.1" r="0.9" />
            <circle cx="9.2" cy="11.1" r="0.9" />
            <circle cx="11.9" cy="8.1" r="0.6" />
          </g>
          <Lens x={11.9} y={5.1} r={0.35} />
          <Logo platform="android" x={12} y={16.6} size={4} />
        </>
      );
    default:
      return (
        <>
          <rect x="6.5" y="2.5" width="11" height="19" rx="2.6" />
          <circle cx="9.3" cy="5.3" r="0.9" strokeWidth={1.1} />
        </>
      );
  }
}

function Console({ platform }: { platform: Platform }) {
  switch (platform) {
    case "playstation":
      // PS5 standing: black core between two curved white plates.
      return (
        <>
          <path d="M10.6 2.5H6.8c-.9 0-1.5.8-1.3 1.6l2 15.8c.1.9.8 1.6 1.7 1.6h1.4z" />
          <path d="M13.4 2.5h3.8c.9 0 1.5.8 1.3 1.6l-2 15.8c-.1.9-.8 1.6-1.7 1.6h-1.4z" />
          <path d="M10.6 2.5h2.8v19h-2.8z" fill="currentColor" stroke="none" />
        </>
      );
    case "xbox":
      // Series X: a tower with its vented top in view.
      return (
        <>
          <rect x="7" y="2.5" width="10" height="19" rx="1.2" />
          <path d="M7 6.2h10" />
          <Lens x={9.2} y={4.35} r={0.45} />
          <Lens x={11.2} y={4.35} r={0.45} />
          <Lens x={13.2} y={4.35} r={0.45} />
          <Lens x={15.2} y={4.35} r={0.45} />
          <path d="M11 9.5h4" strokeWidth={1.1} />
          <circle cx="9.2" cy="9.5" r="0.7" strokeWidth={1} />
        </>
      );
    default:
      return (
        <g transform="translate(12 12) scale(0.88) translate(-12 -12.8)">
          <path d="M7 7h10a4.5 4.5 0 0 1 4.4 3.6l.9 5a2.6 2.6 0 0 1-4.6 2.1L15.6 16H8.4l-2.1 1.7a2.6 2.6 0 0 1-4.6-2.1l.9-5A4.5 4.5 0 0 1 7 7z" />
          <path d="M7.5 10v3.5M5.75 11.75h3.5" />
          <Lens x={16} y={10.6} r={0.6} />
          <Lens x={17.8} y={12.6} r={0.6} />
        </g>
      );
  }
}

function Tablet({ platform }: { platform: Platform }) {
  return (
    <>
      <rect x="4" y="2.5" width="16" height="19" rx="2.2" />
      <circle cx="6.9" cy="5.3" r="0.8" strokeWidth={1.1} />
      <Logo platform={platform} x={12} y={12} size={5.4} />
    </>
  );
}

function Svg({ children, size }: { children: ReactNode; size: number }) {
  return (
    <svg
      className="device-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function DeviceIcon({
  kind,
  platform = "",
  size = 22,
}: {
  kind: DeviceKind;
  platform?: Platform;
  size?: number;
}) {
  switch (kind) {
    case "computer":
      return (
        <Svg size={size}>
          <Laptop platform={platform} />
        </Svg>
      );
    case "phone":
      return (
        <Svg size={size}>
          <Phone platform={platform} />
        </Svg>
      );
    case "tablet":
      return (
        <Svg size={size}>
          <Tablet platform={platform} />
        </Svg>
      );
    case "tv":
      return (
        <Svg size={size}>
          <rect x="2.5" y="4.5" width="19" height="12.5" rx="1.2" />
          <path d="M6 17 5 19.5M18 17l1 2.5" />
        </Svg>
      );
    case "receiver":
      return (
        <Svg size={size}>
          <g transform="translate(12 12) scale(0.92) translate(-12 -12.8)">
            <rect x="2" y="7" width="20" height="10" rx="1.6" />
            <rect
              x="4.5"
              y="9.5"
              width="7"
              height="2.6"
              rx="0.6"
              strokeWidth={1.2}
            />
            <circle cx="17.5" cy="12" r="2.4" />
            <path
              d="M4.5 14.6h2M8 14.6h2M5 17v1.5M19 17v1.5"
              strokeWidth={1.2}
            />
          </g>
        </Svg>
      );
    case "console":
      return (
        <Svg size={size}>
          <Console platform={platform} />
        </Svg>
      );
    case "car":
      return (
        <Svg size={size}>
          <path d="M5 11l1.6-4.2A2 2 0 0 1 8.5 5.5h7a2 2 0 0 1 1.9 1.3L19 11" />
          <rect x="3" y="11" width="18" height="6" rx="1.8" />
          <path d="M5.5 17v2M18.5 17v2" />
          <circle cx="7" cy="14" r="1" fill="currentColor" stroke="none" />
          <circle cx="17" cy="14" r="1" fill="currentColor" stroke="none" />
        </Svg>
      );
    case "watch":
      return (
        <Svg size={size}>
          <path d="M8.5 6.5 9.3 2.5h5.4l.8 4M8.5 17.5l.8 4h5.4l.8-4" />
          <rect x="6.5" y="6.5" width="11" height="11" rx="3" />
          <path d="M12 9.5V12l1.6 1.2" strokeWidth={1.3} />
        </Svg>
      );
    case "cast":
      return (
        <Svg size={size}>
          <circle cx="12" cy="12" r="8.5" />
          <circle cx="12" cy="12" r="2" />
          <path d="M12 3.5v3" />
        </Svg>
      );
    case "alexa":
      return (
        <Svg size={size}>
          <path d="M5 7v9.5c0 1.9 3.1 3.5 7 3.5s7-1.6 7-3.5V7" />
          <ellipse className="device-ring" cx="12" cy="7" rx="7" ry="2.8" />
          <path
            d="M8.5 12.5h.01M12 13.2h.01M15.5 12.5h.01M10.2 15.6h.01M13.8 15.6h.01"
            strokeWidth={1.4}
          />
        </Svg>
      );
    case "group":
      return (
        <Svg size={size}>
          <rect x="2.5" y="4.5" width="9" height="15" rx="2" />
          <circle cx="7" cy="14" r="2.3" />
          <circle cx="7" cy="8" r="0.6" fill="currentColor" stroke="none" />
          <path d="M14 4.5h5.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14" />
          <circle cx="17" cy="14" r="1.6" />
        </Svg>
      );
    default:
      return (
        <Svg size={size}>
          <rect x="5.5" y="2.5" width="13" height="19" rx="2.4" />
          <circle cx="12" cy="14.5" r="3.6" />
          <circle cx="12" cy="14.5" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="12" cy="6.6" r="1.3" />
        </Svg>
      );
  }
}
