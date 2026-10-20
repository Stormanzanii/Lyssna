import { memo } from "react";
import { Ambience } from "./ambience";
import type { Track } from "./types";

/**
 * The playing track's warped, moving artwork behind the whole window, the
 * same ambience the lyrics page uses, so Liquid Glass panels have colour to
 * refract. It animates while playing and holds still when paused or when
 * motion is reduced.
 */
export const GlassBackdrop = memo(function GlassBackdrop({
  track,
  playing,
  reduceMotion,
}: {
  track?: Track;
  playing: boolean;
  reduceMotion: boolean;
}) {
  return (
    <div className="glass-backdrop" aria-hidden="true">
      <Ambience track={track} animate={playing} reduceMotion={reduceMotion} />
      <div className="glass-backdrop-shade" />
    </div>
  );
});
