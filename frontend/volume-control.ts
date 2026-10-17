/** Keep drag feedback local; send only the newest value in each short window. */
export class VolumeControl {
  private timer?: ReturnType<typeof setTimeout>;
  private queued?: number;
  private wanted?: { value: number; until: number };
  private dragging = false;
  private device?: string;
  constructor(
    private send: (value: number) => void,
    private show: (value: number) => void,
  ) {}
  begin() {
    this.dragging = true;
  }
  edit(value: number) {
    value = Math.max(0, Math.min(100, Math.round(value)));
    this.wanted = { value, until: Date.now() + 2500 };
    this.queued = value;
    this.show(value);
    if (this.timer === undefined) {
      this.flush();
      this.timer = setTimeout(() => this.tick(), 16);
    }
  }
  private tick() {
    this.timer = undefined;
    if (this.queued !== undefined) {
      this.flush();
      this.timer = setTimeout(() => this.tick(), 16);
    }
  }
  finish() {
    this.dragging = false;
    this.flush();
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const value = this.queued;
    this.queued = undefined;
    if (value !== undefined) this.send(value);
  }
  observe(value: number | undefined, device: string) {
    if (this.device !== device) {
      this.dispose();
      this.device = device;
    }
    if (
      value == null ||
      this.dragging ||
      (this.wanted &&
        Date.now() < this.wanted.until &&
        value !== this.wanted.value)
    )
      return;
    this.show(value);
  }
  dispose() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.queued = undefined;
    this.wanted = undefined;
    this.dragging = false;
  }
}
