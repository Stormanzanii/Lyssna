import { useEffect, useState } from "react";

type Rgb = [number, number, number];

function toHsl([r, g, b]: Rgb): Rgb {
  const red = r / 255,
    green = g / 255,
    blue = b / 255;
  const max = Math.max(red, green, blue),
    min = Math.min(red, green, blue),
    lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation =
    lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const hue =
    max === red
      ? (green - blue) / delta + (green < blue ? 6 : 0)
      : max === green
        ? (blue - red) / delta + 2
        : (red - green) / delta + 4;
  return [hue / 6, saturation, lightness];
}

function toRgb([h, s, l]: Rgb): Rgb {
  if (!s) return [l * 255, l * 255, l * 255].map(Math.round) as Rgb;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s,
    p = 2 * l - q;
  const channel = (t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)].map((value) =>
    Math.round(value * 255),
  ) as Rgb;
}

/**
 * Picks a header colour from RGBA pixels the way Spotify does: the most
 * common vivid hue, darkened enough for white text to stay readable.
 */
export function headerColor(pixels: Uint8ClampedArray): Rgb {
  const buckets = new Map<number, { weight: number; sum: Rgb }>();
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    if (pixels[index + 3] < 128) continue;
    const rgb: Rgb = [pixels[index], pixels[index + 1], pixels[index + 2]];
    const [hue, saturation, lightness] = toHsl(rgb);
    // Favour saturated mid-tones; near-white and near-black say little.
    const weight =
      0.05 + saturation * (1 - Math.abs(lightness - 0.5) * 1.6) ** 2;
    const key = saturation < 0.12 ? -1 : Math.round(hue * 12) % 12;
    const bucket = buckets.get(key) ?? { weight: 0, sum: [0, 0, 0] };
    bucket.weight += weight;
    bucket.sum = bucket.sum.map(
      (value, channel) => value + rgb[channel] * weight,
    ) as Rgb;
    buckets.set(key, bucket);
  }
  const best = [...buckets.values()].sort((a, b) => b.weight - a.weight)[0];
  if (!best) return [83, 83, 83];
  const average = best.sum.map((value) => value / best.weight) as Rgb;
  const [hue, saturation, lightness] = toHsl(average);
  return toRgb([
    hue,
    Math.min(saturation, 0.62),
    Math.min(Math.max(lightness, 0.22), 0.38),
  ]);
}

const cache = new Map<string, string>();

/** Header colour for an artwork URL, or undefined until it is known. */
export function useArtworkColor(url?: string) {
  const [color, setColor] = useState(() => (url ? cache.get(url) : undefined));
  useEffect(() => {
    if (!url) return setColor(undefined);
    const known = cache.get(url);
    if (known) return setColor(known);
    setColor(undefined);
    let live = true;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 24;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return;
        context.drawImage(image, 0, 0, 24, 24);
        const rgb = headerColor(context.getImageData(0, 0, 24, 24).data);
        const value = `rgb(${rgb.join(" ")})`;
        cache.set(url, value);
        if (live) setColor(value);
      } catch {
        // Artwork without CORS headers cannot be sampled; keep the default.
      }
    };
    image.src = url;
    return () => {
      live = false;
    };
  }, [url]);
  return color;
}
