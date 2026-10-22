/**
 * Spotify serves each cover at several sizes behind a size code in the URL.
 * Choosing by the laid-out size lets small covers load and decode a small file:
 * a 640 px cover decodes to 1.6 MB, the 300 px one to 0.35 MB.
 */
const FAMILIES: [number, string][][] = [
  // Albums.
  [
    [640, "ab67616d0000b273"],
    [300, "ab67616d00001e02"],
    [64, "ab67616d00004851"],
  ],
  // Artists.
  [
    [640, "ab6761610000e5eb"],
    [320, "ab67616100005174"],
    [160, "ab6761610000f178"],
  ],
  // Uploaded playlist covers.
  [
    [640, "ab67706c0000bebb"],
    [300, "ab67706c0000da84"],
  ],
];
const IMAGE = "https://i.scdn.co/image/";
const MOSAIC = /^https:\/\/mosaic\.scdn\.co\/(640|300|60)\//;

function variants(url: string): [number, string][] {
  const mosaic = MOSAIC.exec(url);
  if (mosaic)
    return [640, 300, 60].map((size) => [
      size,
      url.replace(MOSAIC, `https://mosaic.scdn.co/${size}/`),
    ]);
  if (!url.startsWith(IMAGE)) return [];
  const code = url.slice(IMAGE.length, IMAGE.length + 16);
  const family = FAMILIES.find((sizes) => sizes.some(([, id]) => id === code));
  return (
    family?.map(([size, id]) => [
      size,
      IMAGE + id + url.slice(IMAGE.length + 16),
    ]) ?? []
  );
}

function sized(images?: { url: string; width?: number | null }[]) {
  const sizes = new Map<string, number>();
  for (const image of images ?? []) {
    if (!image.url.startsWith("https://")) continue;
    for (const [size, url] of variants(image.url)) sizes.set(url, size);
    if (image.width && !sizes.has(image.url)) sizes.set(image.url, image.width);
  }
  return [...sizes].sort((a, b) => a[1] - b[1]);
}

/**
 * The smallest Spotify size at least `pixels` wide (the largest when none
 * is), or the first secure image when sizes are unknown. Without a width,
 * aims for 300 px, which suits covers up to about 190 CSS pixels.
 */
export function artworkFor(
  images: { url: string; width?: number | null }[] | undefined,
  pixels = 300,
) {
  const sizes = sized(images);
  if (!sizes.length)
    return images?.find(
      (image) =>
        image.url.startsWith("https://") ||
        image.url.startsWith("data:image/jpeg;base64,"),
    )?.url;
  return (sizes.find(([, size]) => size >= pixels) ?? sizes.at(-1)!)[0];
}
