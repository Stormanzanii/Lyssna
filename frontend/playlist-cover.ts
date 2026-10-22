/** Largest image file accepted before cropping. */
export const MAX_COVER_FILE = 20 * 1024 * 1024;

/** The square region of a width × height image that a centre crop keeps. */
export function centreSquare(width: number, height: number) {
  const side = Math.min(width, height);
  return {
    x: Math.round((width - side) / 2),
    y: Math.round((height - side) / 2),
    side,
  };
}

/** Centre-crop an image file to a 640 px square JPEG, as Spotify stores
 *  playlist covers. Returns a data URL for the preview. */
export async function coverJpeg(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > MAX_COVER_FILE) throw new Error("Choose an image under 20 MB.");
  const bitmap = await createImageBitmap(file);
  try {
    const { x, y, side } = centreSquare(bitmap.width, bitmap.height);
    const size = Math.min(640, side);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Cannot prepare the image.");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, x, y, side, side, 0, 0, size, size);
    return canvas.toDataURL("image/jpeg", 0.88);
  } finally {
    bitmap.close();
  }
}
