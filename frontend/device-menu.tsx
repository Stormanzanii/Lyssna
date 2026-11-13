import {
  Car,
  Cast,
  Check,
  Gamepad2,
  Monitor,
  Radio,
  Smartphone,
  Speaker,
  Tablet,
  Tv,
  Watch,
} from "lucide-react";
import { LevelBars } from "./level-bars";
import type { Device } from "./types";

type Kind =
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

// The native list sends Lyssna's own kinds; the Web API sends Spotify's
// device type names.
const KINDS: Record<string, Kind> = {
  smartphone: "phone",
  stb: "tv",
  castvideo: "tv",
  avr: "receiver",
  gameconsole: "console",
  automobile: "car",
  carthing: "car",
  smartwatch: "watch",
  castaudio: "cast",
  audiodongle: "cast",
};

export function deviceKind(device: Pick<Device, "name" | "kind">): Kind {
  const kind = (device.kind ?? "").toLowerCase();
  if (kind === "alexa" || /\b(echo|alexa)\b/i.test(device.name)) return "alexa";
  if (KINDS[kind]) return KINDS[kind];
  const known: Kind[] = [
    "computer",
    "phone",
    "tablet",
    "tv",
    "receiver",
    "console",
    "car",
    "watch",
    "cast",
    "group",
  ];
  return known.includes(kind as Kind) ? (kind as Kind) : "speaker";
}

const LABELS: Record<Kind, string> = {
  computer: "Computer",
  phone: "Phone",
  tablet: "Tablet",
  tv: "TV",
  receiver: "AV receiver",
  console: "Game console",
  car: "Car",
  watch: "Watch",
  cast: "Cast speaker",
  alexa: "Alexa speaker",
  group: "Speaker group",
  speaker: "Speaker",
};

function SmartSpeaker({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 6.5v10c0 1.7 3.1 3 7 3s7-1.3 7-3v-10" />
      <ellipse className="device-ring" cx="12" cy="6.5" rx="7" ry="2.6" />
      <path d="M9 13h.01M12 13.5h.01M15 13h.01" />
    </svg>
  );
}

export function DeviceIcon({ kind, size = 20 }: { kind: Kind; size?: number }) {
  switch (kind) {
    case "computer":
      return <Monitor size={size} />;
    case "phone":
      return <Smartphone size={size} />;
    case "tablet":
      return <Tablet size={size} />;
    case "tv":
      return <Tv size={size} />;
    case "receiver":
      return <Radio size={size} />;
    case "console":
      return <Gamepad2 size={size} />;
    case "car":
      return <Car size={size} />;
    case "watch":
      return <Watch size={size} />;
    case "cast":
      return <Cast size={size} />;
    case "alexa":
      return <SmartSpeaker size={size} />;
    default:
      return <Speaker size={size} />;
  }
}

interface Row {
  key: string;
  name: string;
  kind: Kind;
  status: string;
  standby?: boolean;
  pick: () => void;
}

export function DeviceMenu({
  devices,
  localName,
  target,
  nativeStatus,
  playing,
  onPick,
}: {
  devices: Device[];
  localName: string;
  target: string;
  nativeStatus: string;
  playing: boolean;
  onPick: (target: string) => void;
}) {
  const local: Row = {
    key: "native",
    name: "This computer",
    kind: "computer",
    status: nativeStatus,
    pick: () => onPick("native"),
  };
  const remote: Row[] = devices
    .filter((device) => device.name !== localName)
    .map((device) => {
      const kind = deviceKind(device);
      return {
        key: device.id || device.name,
        name: device.name,
        kind,
        standby: !device.is_active && !!device.is_offline,
        status: device.is_active
          ? "Active device"
          : device.is_offline
            ? "Standby"
            : LABELS[kind],
        pick: () => onPick(device.id || "native"),
      };
    });
  const rows = [local, ...remote];
  const current = rows.find((row) => row.key === target) ?? local;
  const others = rows.filter((row) => row !== current);

  return (
    <div className="device-menu popover">
      <h3>Connect to a device</h3>
      <button className="device-row current selected" onClick={current.pick}>
        <DeviceIcon kind={current.kind} size={26} />
        <div>
          <small>Current device</small>
          <strong>{current.name}</strong>
        </div>
        {playing ? (
          <LevelBars className="device-bars" live={current === local} />
        ) : (
          <Check size={18} />
        )}
      </button>
      <h4 className="device-section">Select another device</h4>
      {others.map((row) => (
        <button
          key={row.key}
          className={`device-row${row.standby ? " standby" : ""}`}
          title={row.standby ? "Start Spotify on the speaker first" : undefined}
          onClick={row.pick}
        >
          <DeviceIcon kind={row.kind} size={22} />
          <div>
            <strong>{row.name}</strong>
            <small>{row.status}</small>
          </div>
        </button>
      ))}
      {others.length === 0 && (
        <p className="device-empty">
          Open Spotify on a phone, speaker or TV signed in to this account and
          it will show up here.
        </p>
      )}
    </div>
  );
}
