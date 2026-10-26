/**
 * Spotify-style overlay scrollbars for the main panels. Native bars reserve
 * a gutter whether or not anything scrolls; these draw a rounded thumb over
 * the panel's edge, shown while the pointer is over the panel.
 */
const SCROLLERS = ".library-list, .browse-scroll, .now-playing-scroll";
const MIN_THUMB = 32;
// Gap between the thumb and the panel's top, bottom and right edges.
const INSET = 4;

function attach(scroller: HTMLElement) {
  const host = scroller.parentElement;
  if (!host) return () => {};
  if (getComputedStyle(host).position === "static")
    host.style.position = "relative";
  host.classList.add("overlay-scroll-host");
  scroller.classList.add("overlay-scrolled");
  const track = document.createElement("div");
  track.className = "overlay-scrollbar";
  track.setAttribute("aria-hidden", "true");
  const thumb = document.createElement("div");
  thumb.className = "overlay-scrollbar-thumb";
  track.append(thumb);
  host.append(track);

  let frame = 0;
  const measure = () => {
    frame = 0;
    const { scrollTop, scrollHeight, clientHeight } = scroller;
    const range = scrollHeight - clientHeight;
    track.hidden = range <= 1 || !scroller.isConnected;
    if (track.hidden) return;
    // Follow the scroller's box inside the panel, below any heading.
    track.style.top = `${scroller.offsetTop + INSET}px`;
    track.style.height = `${clientHeight - INSET * 2}px`;
    track.style.right = `${host.clientWidth - scroller.offsetLeft - scroller.clientWidth + INSET}px`;
    const length = clientHeight - INSET * 2;
    const size = Math.max(MIN_THUMB, (length * clientHeight) / scrollHeight);
    thumb.style.height = `${size}px`;
    thumb.style.transform = `translateY(${((length - size) * scrollTop) / range}px)`;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure);
  };

  // Dragging the thumb scrolls in proportion; clicking the track pages.
  let drag: { y: number; top: number; ratio: number } | null = null;
  const press = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const length = track.clientHeight - thumb.offsetHeight;
    const range = scroller.scrollHeight - scroller.clientHeight;
    if (event.target === thumb) {
      drag = {
        y: event.clientY,
        top: scroller.scrollTop,
        ratio: length > 0 ? range / length : 0,
      };
      track.setPointerCapture(event.pointerId);
      track.classList.add("dragging");
    } else {
      const above = event.clientY < thumb.getBoundingClientRect().top;
      scroller.scrollBy({
        top: (above ? -1 : 1) * scroller.clientHeight * 0.9,
        behavior: "smooth",
      });
    }
  };
  const move = (event: PointerEvent) => {
    if (drag)
      scroller.scrollTop = drag.top + (event.clientY - drag.y) * drag.ratio;
  };
  const release = () => {
    drag = null;
    track.classList.remove("dragging");
  };
  track.addEventListener("pointerdown", press);
  track.addEventListener("pointermove", move);
  track.addEventListener("pointerup", release);
  track.addEventListener("pointercancel", release);

  scroller.addEventListener("scroll", schedule, { passive: true });
  const sizes = new ResizeObserver(schedule);
  sizes.observe(scroller);
  sizes.observe(host);
  // Content growing (pages loading, rows rendering) changes the range.
  const content = new MutationObserver(schedule);
  content.observe(scroller, { childList: true, subtree: true });
  measure();
  return () => {
    cancelAnimationFrame(frame);
    sizes.disconnect();
    content.disconnect();
    scroller.removeEventListener("scroll", schedule);
    scroller.classList.remove("overlay-scrolled");
    track.remove();
    if (!host.querySelector(".overlay-scrollbar"))
      host.classList.remove("overlay-scroll-host");
  };
}

/** Attaches overlay scrollbars to panel scrollers as they mount. */
export function installOverlayScrollbars(root: HTMLElement = document.body) {
  const attached = new Map<HTMLElement, () => void>();
  const sync = () => {
    for (const [scroller, detach] of attached)
      if (!scroller.isConnected) {
        detach();
        attached.delete(scroller);
      }
    for (const scroller of root.querySelectorAll<HTMLElement>(SCROLLERS))
      if (!attached.has(scroller)) attached.set(scroller, attach(scroller));
  };
  let pending = 0;
  const observer = new MutationObserver(() => {
    if (!pending)
      pending = requestAnimationFrame(() => {
        pending = 0;
        sync();
      });
  });
  observer.observe(root, { childList: true, subtree: true });
  sync();
  return () => {
    observer.disconnect();
    cancelAnimationFrame(pending);
    for (const detach of attached.values()) detach();
    attached.clear();
  };
}
