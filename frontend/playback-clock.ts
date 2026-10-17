import type { Playback } from "./types";

/** Audio observations correct a continuous clock; seeks and transport changes snap. */
export class PlaybackClock {
  private track?: string;
  private playing = false;
  private advancing = false;
  private native = true;
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
    native = true,
  ) {
    if (
      this.observedAt === observedAt &&
      this.track === playback.item?.uri &&
      this.playing === playback.is_playing &&
      this.observedPosition === playback.progress_ms &&
      this.revision === revision &&
      this.native === native
    )
      return;
    const current = this.read(time);
    const stalled = !this.advancing || (native && time - this.anchoredAt > 500);
    const repeated =
      native &&
      this.track === playback.item?.uri &&
      this.revision === revision &&
      this.playing === playback.is_playing &&
      this.observedPosition === playback.progress_ms;
    const desired =
      (playback.progress_ms ?? 0) +
      (playback.is_playing
        ? Math.min(native ? 500 : Infinity, Math.max(0, wallTime - observedAt))
        : 0);
    const snap =
      this.track !== playback.item?.uri ||
      this.playing !== playback.is_playing ||
      this.revision !== revision ||
      (native ? desired - current : Math.abs(desired - current)) > 1000 ||
      (native && stalled && desired >= current && !repeated);
    this.track = playback.item?.uri;
    this.playing = playback.is_playing;
    this.advancing = playback.is_playing && !repeated;
    this.native = native;
    this.revision = revision;
    this.observedAt = observedAt;
    this.observedPosition = playback.progress_ms ?? 0;
    this.duration = playback.item?.duration_ms ?? 0;
    this.anchor = snap || !this.playing ? desired : current;
    this.anchoredAt = time;
    this.correction = snap || !this.advancing ? 0 : desired - current;
    this.correctionDuration = Math.max(600, Math.abs(this.correction) * 4);
  }

  read(time: number) {
    const elapsed = this.advancing
      ? Math.min(
          this.native ? 500 : Infinity,
          Math.max(0, time - this.anchoredAt),
        )
      : 0;
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
