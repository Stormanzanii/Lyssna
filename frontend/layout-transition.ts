import { flushSync } from "react-dom";

/**
 * What a layout change moves. Only those parts are named for the
 * transition (see styles.css): named parts are drawn above the page and
 * unclipped while they move, so naming everything let lyrics cover the
 * closing Now playing panel and Canvas spill over the bars.
 */
export type LayoutChange = "panels" | "lyrics";

/**
 * Apply a layout change with a short morph between the old and new layout,
 * using the browser's View Transitions. Without support, or with reduced
 * motion, it applies at once.
 */
export function animateLayout(
  update: () => void,
  change: LayoutChange,
  reduceMotion = false,
) {
  const start = (
    document as Document & {
      startViewTransition?: (callback: () => void) => {
        finished: Promise<void>;
      };
    }
  ).startViewTransition;
  if (
    reduceMotion ||
    typeof start !== "function" ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    update();
    return;
  }
  const root = document.documentElement;
  root.dataset.layoutChange = change;
  const transition = start.call(document, () => flushSync(update));
  void transition.finished.finally(() => {
    if (root.dataset.layoutChange === change) delete root.dataset.layoutChange;
  });
}
