import { expect, it } from "vitest";
import { PlaybackClock } from "./playback-clock";
import { emptyState } from "./state";

const playback = {
  ...emptyState.playback,
  item: {
    uri: "spotify:track:test",
    name: "test",
    artists: [],
    album: { name: "test", images: [] },
    duration_ms: 100000,
    is_local: false,
  },
  is_playing: true,
  progress_ms: 1000,
};
it("keeps every frame moving forward through quantized audio position corrections", () => {
  const clock = new PlaybackClock();
  clock.observe(playback, 0, 0, 0, 0);
  let previous = clock.read(0);
  for (let time = 16; time < 5000; time += 16) {
    if (time % 256 === 0)
      clock.observe(
        {
          ...playback,
          progress_ms: 1000 + time + (time % 512 === 0 ? -280 : 280),
        },
        time,
        0,
        time,
        time,
      );
    const current = clock.read(time);
    expect(current - previous).toBeGreaterThan(0);
    expect(current - previous).toBeLessThanOrEqual(20.01);
    previous = current;
  }
});
it("immediately applies seeks, pause, and track changes", () => {
  const clock = new PlaybackClock();
  clock.observe(playback, 0, 0, 0, 0);
  clock.observe({ ...playback, progress_ms: 1200 }, 200, 1, 200, 200);
  expect(clock.read(200)).toBe(1200);
  clock.observe(
    { ...playback, is_playing: false, progress_ms: 1300 },
    300,
    1,
    300,
    300,
  );
  expect(clock.read(5000)).toBe(1300);
});
it("does not rewind lyrics after a delayed decoder position report", () => {
  const clock = new PlaybackClock();
  clock.observe(playback, 0, 0, 0, 0);
  const before = clock.read(2500);
  clock.observe({ ...playback, progress_ms: 1500 }, 2500, 0, 2500, 2500);
  expect(clock.read(2500)).toBeGreaterThanOrEqual(before);
  expect(clock.read(2516)).toBeGreaterThan(before);
});
it("applies a requested backward seek immediately", () => {
  const clock = new PlaybackClock();
  clock.observe(playback, 0, 0, 0, 0);
  clock.read(2500);
  clock.observe({ ...playback, progress_ms: 500 }, 2500, 1, 2500, 2500);
  expect(clock.read(2500)).toBe(500);
});
it("stops extrapolating beyond a missing native audio observation", () => {
  const clock = new PlaybackClock();
  clock.observe(playback, 0, 0, 0, 0);
  expect(clock.read(5000)).toBeLessThanOrEqual(1500);
});
it("holds lyrics while narration or buffering repeats the same song position", () => {
  const clock = new PlaybackClock();
  clock.observe(playback, 0, 0, 0, 0);
  const before = clock.read(250);
  clock.observe(playback, 250, 0, 250, 250);
  expect(clock.read(5000)).toBe(before);
});
it("keeps remote playback moving between polls and applies a remote seek", () => {
  const clock = new PlaybackClock();
  clock.observe(playback, 0, 0, 0, 0, false);
  expect(clock.read(5000)).toBe(6000);
  clock.observe({ ...playback, progress_ms: 500 }, 5000, 0, 5000, 5000, false);
  expect(clock.read(5000)).toBe(500);
});
it("keeps moving when a correction and ordinary tick report the same packet", () => {
  const clock = new PlaybackClock();
  clock.observe(playback, 0, 0, 0, 0);
  const update = { ...playback, progress_ms: 1250 };
  clock.observe(update, 250, 0, 250, 250);
  const before = clock.read(251);
  clock.observe(update, 251, 0, 251, 251);
  expect(clock.read(267)).toBeGreaterThan(before);
});
it("snaps back to the start when repeat restarts the same song", () => {
  // Repeat replays the song in place: same track, still playing, no seek
  // flag. The clock used to ease back over minutes, pinned at the end.
  const clock = new PlaybackClock();
  clock.observe({ ...playback, progress_ms: 99000 }, 0, 0, 0, 0);
  expect(clock.read(500)).toBeGreaterThan(99000);
  clock.observe({ ...playback, progress_ms: 0 }, 1200, 0, 1200, 1200);
  expect(clock.read(1200)).toBeLessThan(100);
  expect(clock.read(1700)).toBeLessThan(700);
});
it("does not jump back for a slightly late position report", () => {
  const clock = new PlaybackClock();
  clock.observe({ ...playback, progress_ms: 50000 }, 0, 0, 0, 0);
  clock.observe({ ...playback, progress_ms: 49700 }, 300, 0, 300, 300);
  expect(clock.read(300)).toBeGreaterThan(50000);
});
