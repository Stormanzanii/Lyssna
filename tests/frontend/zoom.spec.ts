import { expect, test } from "@playwright/test";
import { emptyState } from "../../frontend/state";

test("zoom shortcuts persist scale, work in search, reset and restore", async ({
  page,
}) => {
  await page.addInitScript(
    (snapshot) => {
      const host = window as any;
      let serial = 0;
      host.__zoomCalls = [];
      host.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        transformCallback: () => ++serial,
        unregisterCallback: () => {},
        invoke: async (command: string, args: any = {}) => {
          host.__zoomCalls.push({ command, args });
          if (command === "bootstrap") {
            const saved = localStorage.getItem("test-zoom");
            return {
              ...snapshot,
              settings: {
                ...snapshot.settings,
                ui_zoom_percent: saved ? Number(saved) : 100,
              },
            };
          }
          if (command === "save_settings")
            localStorage.setItem(
              "test-zoom",
              String(args.settings.ui_zoom_percent),
            );
          if (command === "plugin:event|listen") return ++serial;
        },
      };
      host.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    },
    { ...emptyState, profile: { id: "zoom-test" } },
  );
  await page.goto("/");
  await expect(page.locator(".application")).toBeVisible();
  await expect(page.locator(".setup-backdrop")).toHaveCount(0);
  const zoom = () =>
    page.evaluate(
      () =>
        (window as any).__zoomCalls
          .filter(
            (call: any) => call.command === "plugin:webview|set_webview_zoom",
          )
          .at(-1)?.args.value,
    );
  await expect.poll(zoom).toBe(1);
  await page.keyboard.press("Control+=");
  await expect.poll(zoom).toBe(1.1);
  await page.keyboard.press("Control+Shift+=");
  await expect.poll(zoom).toBe(1.2);
  await page.keyboard.press("Control+-");
  await expect.poll(zoom).toBe(1.1);
  await page.locator(".search-box input").focus();
  await page.keyboard.press("Control+=");
  await expect.poll(zoom).toBe(1.2);
  await page.reload();
  await expect.poll(zoom).toBe(1.2);
  await page.keyboard.press("Control+0");
  await expect.poll(zoom).toBe(1);
});
