import type { Playback } from "./types";

/** Audio observations correct a continuous clock; seeks and transport changes snap. */
export class PlaybackClock {
  private track?: string;
  private playing = false;
  private revision = -1;
  private observedAt = -1;
  private observedPosition = -1;
  private anchor = 0;
  private anchoredAt = 0;
  private correction = 0;
  private correctionDuration = 600;
  private duration = 0;

  observe(
    playback: Playback,
    observedAt: number,
    revision: number,
    time: number,
    wallTime: number,
  ) {
    if (
      this.observedAt === observedAt &&
      this.track === playback.item?.uri &&
      this.playing === playback.is_playing &&
      this.observedPosition === playback.progress_ms &&
      this.revision === revision
    )
      return;
    const current = this.read(time);
    const desired =
      (playback.progress_ms ?? 0) +
      (playback.is_playing ? Math.max(0, wallTime - observedAt) : 0);
    const snap =
      this.track !== playback.item?.uri ||
      this.playing !== playback.is_playing ||
      this.revision !== revision ||
      desired - current > 1000;
    this.track = playback.item?.uri;
    this.playing = playback.is_playing;
    this.revision = revision;
    this.observedAt = observedAt;
    this.observedPosition = playback.progress_ms ?? 0;
    this.duration = playback.item?.duration_ms ?? 0;
    this.anchor = snap || !this.playing ? desired : current;
    this.anchoredAt = time;
    this.correction = snap || !this.playing ? 0 : desired - current;
    this.correctionDuration = Math.max(600, Math.abs(this.correction) * 4);
  }

  read(time: number) {
    const elapsed = this.playing ? Math.max(0, time - this.anchoredAt) : 0;
    return Math.max(
      0,
      Math.min(
        this.duration,
        this.anchor +
          elapsed +
          this.correction * Math.min(1, elapsed / this.correctionDuration),
      ),
    );
  }
}
