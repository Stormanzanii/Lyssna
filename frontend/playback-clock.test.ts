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
