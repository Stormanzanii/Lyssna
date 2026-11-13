import { Check } from "lucide-react";
import {
  DeviceIcon,
  type DeviceKind as Kind,
  type Platform,
} from "./device-icons";
import { LevelBars } from "./level-bars";
import { IS_MAC } from "./platform";
import type { Device } from "./types";

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

const PLATFORMS: Platform[] = ["windows", "mac", "linux", "android"];

function devicePlatform(device: Pick<Device, "platform">): Platform {
  const platform = (device.platform ?? "") as Platform;
  return PLATFORMS.includes(platform) ? platform : "";
}

const LOCAL_PLATFORM: Platform = IS_MAC
  ? "mac"
  : __APP_PLATFORM__ === "linux"
    ? "linux"
    : "windows";

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

interface Row {
  key: string;
  name: string;
  kind: Kind;
  platform: Platform;
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
    platform: LOCAL_PLATFORM,
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
        platform: devicePlatform(device),
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
        <DeviceIcon kind={current.kind} platform={current.platform} size={26} />
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
          <DeviceIcon kind={row.kind} platform={row.platform} size={22} />
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
