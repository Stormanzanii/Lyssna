import { it, expect, vi, afterEach } from "vitest";
import { VolumeControl } from "./volume-control";
afterEach(() => vi.useRealTimers());
it("coalesces bursts, ignores stale echoes, and flushes the final drag value", () => {
  vi.useFakeTimers();
  const send = vi.fn(),
    show = vi.fn(),
    control = new VolumeControl(send, show);
  control.observe(70, "native");
  control.begin();
  for (let i = 0; i < 100; i++) control.edit(i);
  control.observe(15, "native");
  expect(show).toHaveBeenLastCalledWith(99);
  expect(send).not.toHaveBeenCalled();
  vi.advanceTimersByTime(40);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenLastCalledWith(99);
  control.edit(27);
  control.finish();
  expect(send).toHaveBeenLastCalledWith(27);
  control.observe(99, "native");
  expect(show).toHaveBeenLastCalledWith(27);
  vi.advanceTimersByTime(2600);
  control.observe(30, "native");
  expect(show).toHaveBeenLastCalledWith(30);
});
it("drops queued edits when playback moves to another device", () => {
  vi.useFakeTimers();
  const send = vi.fn(),
    show = vi.fn(),
    control = new VolumeControl(send, show);
  control.observe(70, "native");
  control.edit(20);
  control.observe(85, "remote");
  vi.runAllTimers();
  expect(send).not.toHaveBeenCalled();
  expect(show).toHaveBeenLastCalledWith(85);
});
