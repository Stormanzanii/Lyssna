import { expect, test, type Page } from "@playwright/test";
import { emptyState } from "../../frontend/state";

test.skip(
  !["macos", "darwin"].includes(
    process.env.TAURI_ENV_PLATFORM ?? process.platform,
  ),
  "Run with TAURI_ENV_PLATFORM=macos to exercise the macOS frontend.",
);

async function startMac(page: Page, signedIn: boolean) {
  await page.addInitScript(
    (snapshot) => {
      const host = window as any;
      let serial = 0;
      const callbacks = new Map<number, (event: any) => void>();
      const listeners = new Map<number, any>();
      const items = new Map<number, any>();
      const commands: any[] = [];
      host.__macTest = {
        commands,
        item: (text: string) =>
          [...items.values()].reverse().find((item) => item.text === text),
        activate: (text: string) =>
          host.__macTest.item(text).handler.onmessage(),
        signOut: () => {
          for (const { event, handler } of listeners.values()) {
            if (event === "spotiflex")
              callbacks.get(handler)?.({
                event,
                payload: { type: "signed_out" },
              });
          }
        },
      };
      host.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        transformCallback: (callback: (event: any) => void) => {
          callbacks.set(++serial, callback);
          return serial;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (command: string, args: any = {}) => {
          commands.push({ command, args });
          if (command === "bootstrap") return structuredClone(snapshot);
          if (command === "plugin:event|listen") {
            listeners.set(++serial, args);
            return serial;
          }
          if (command === "plugin:event|unlisten")
            listeners.delete(args.eventId);
          if (command === "plugin:menu|new") {
            const rid = ++serial;
            if (args.kind === "MenuItem")
              items.set(rid, { ...args.options, handler: args.handler });
            return [rid, args.options?.id ?? `menu-${rid}`];
          }
          if (command === "plugin:menu|set_text")
            items.get(args.rid).text = args.text;
          if (command === "plugin:menu|set_enabled")
            items.get(args.rid).enabled = args.enabled;
          if (command === "plugin:resources|close") items.delete(args.rid);
          if (command === "plugin:menu|set_as_app_menu") return null;
          if (command === "list_audio_outputs") return [];
          if (command === "audio_cache_size") return 0;
        },
      };
      host.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    },
    {
      ...emptyState,
      profile: signedIn
        ? { id: "mac-test", display_name: "Mac test" }
        : undefined,
    },
  );
  await page.goto("/");
  await expect(page.locator(".application.macos")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => !!(window as any).__macTest.item("About SpotiFlex")),
    )
    .toBe(true);
  await expect(page.locator(".app-menu")).toHaveCount(0);
}

test("native menus use current actions and keep signed-out playback locked", async ({
  page,
}) => {
  await startMac(page, true);
  await expect(page.getByLabel("Close window", { exact: true })).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).__macTest.activate("About SpotiFlex"),
  );
  await expect(
    page.getByRole("dialog", { name: "About SpotiFlex" }),
  ).toContainText("SpotiFlex for macOS");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(() => (window as any).__macTest.signOut());
  await expect(page.locator(".setup-backdrop")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__macTest.item("Play")?.enabled),
    )
    .toBe(false);
  // Simulate a queued callback arriving after sign-out, despite its native item
  // having just been disabled. It must not start a playback request.
  await page.evaluate(() => (window as any).__macTest.activate("Play"));
  const playerCalls = await page.evaluate(() =>
    (window as any).__macTest.commands.filter(
      (entry: any) => entry.command === "player",
    ),
  );
  expect(playerCalls).toHaveLength(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".setup-backdrop")).toBeVisible();
});

test("Mac settings prevent Windows update requests", async ({ page }) => {
  await startMac(page, true);
  await page.evaluate(() => (window as any).__macTest.activate("Settings"));
  await expect(
    page.getByRole("button", { name: "Check for updates", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("switch", { name: "Download updates automatically" }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).__macTest.activate("Check for updates"),
  );
  const updates = await page.evaluate(() =>
    (window as any).__macTest.commands.filter(
      (entry: any) => entry.command === "app_update",
    ),
  );
  expect(updates).toHaveLength(0);
});
