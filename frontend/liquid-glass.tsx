import { memo, useEffect, useState } from "react";

/**
 * Blurred artwork behind the whole window so Liquid Glass panels have colour
 * to refract. New artwork fades in over the previous one once it has loaded.
 */
export const GlassBackdrop = memo(function GlassBackdrop({
  image,
}: {
  image?: string;
}) {
  const [layers, setLayers] = useState<string[]>([]);
  useEffect(() => {
    if (!image) return;
    let cancelled = false;
    const loader = new Image();
    loader.onload = () => {
      if (!cancelled)
        setLayers((previous) =>
          previous.at(-1) === image ? previous : [...previous.slice(-1), image],
        );
    };
    loader.src = image;
    return () => {
      cancelled = true;
    };
  }, [image]);
  return (
    <div className="glass-backdrop" aria-hidden="true">
      {layers.map((url) => (
        <div
          key={url}
          className="glass-backdrop-art"
          style={{ backgroundImage: `url(${JSON.stringify(url)})` }}
        />
      ))}
      <div className="glass-backdrop-shade" />
    </div>
  );
});
