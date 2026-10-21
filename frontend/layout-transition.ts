import { flushSync } from "react-dom";

/**
 * Apply a layout change (artwork side, Now playing open or closed) with a
 * short morph between the old and new layout, using the browser's View
 * Transitions. Without support, or with reduced motion, it applies at once.
 */
export function animateLayout(update: () => void, reduceMotion = false) {
  const start = (
    document as Document & {
      startViewTransition?: (callback: () => void) => unknown;
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
  start.call(document, () => flushSync(update));
}
