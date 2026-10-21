import { test, expect, type Locator, type Page } from "@playwright/test";
import { emptyState } from "../../frontend/state";
import type { Track } from "../../frontend/types";

const track: Track = {
  id: "0123456789abcdefghijkl",
  uri: "spotify:track:0123456789abcdefghijkl",
  name: "Timing test",
  artists: [{ id: "0123456789abcdefghijkl", name: "Test artist" }],
  album: {
    id: "0123456789abcdefghijkl",
    name: "Test album",
    images: [{ url: "https://artwork.example.test/cover.svg" }],
  },
  duration_ms: 180_000,
  is_local: false,
};
test("playing on another device does not silently redirect local Play", async ({
  page,
}) => {
  await startClient(page);
  await page.evaluate(
    ({ track, base }) => {
      (window as any).__clientTest.emit({
        type: "playback",
        playback: {
          ...base,
          item: track,
          is_playing: true,
          device: {
            id: "remote-device",
            name: "Other device",
            is_active: true,
          },
        },
        observed_at: Date.now(),
        changed: false,
      });
    },
    { track, base: emptyState.playback },
  );
  await page.waitForTimeout(100);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const commands = (window as any).__clientTest.commands;
        return commands
          .filter((entry: any) => entry.command === "player")
          .at(-1)?.args.target;
      }),
    )
    .toBe("native");
});

test("artist links show the artist immediately while metadata is pending", async ({
  page,
}) => {
  await startClient(page);
  await page.locator(".player-bar .artist-link").first().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Test artist",
  );
  await expect(page.locator(".skeleton-rows")).toHaveCount(0);
});

test("Connect retains registered speakers and transfers back to this computer", async ({
  page,
}) => {
  await startClient(page);
  await page.evaluate(() =>
    (window as any).__clientTest.emit({
      type: "devices",
      devices: [
        { id: "registered-speaker", name: "Test Echo", is_active: false },
      ],
    }),
  );
  await page.getByTitle("Devices", { exact: true }).click();
  await page.getByRole("button", { name: /Test Echo/ }).click();
  await page.getByTitle("Devices", { exact: true }).click();
  await page.getByRole("button", { name: /^This computer/ }).click();
  const transfers = await page.evaluate(() =>
    (window as any).__clientTest.commands
      .filter(
        (entry: any) =>
          entry.command === "player" &&
          entry.args.request.command === "transfer",
      )
      .map((entry: any) => entry.args),
  );
  expect(transfers).toEqual([
    {
      request: { command: "transfer", uri: "registered-speaker" },
      target: "registered-speaker",
    },
    { request: { command: "transfer", uri: "native" }, target: "native" },
  ]);
});

test("audio output selection saves headphones and can return to system default", async ({
  page,
}) => {
  await startClient(page);
  await openSettings(page);
  const output = page.getByRole("combobox", {
    name: "Audio output",
    exact: true,
  });
  await expect(output.locator("option")).toHaveCount(3);
  await output.selectOption("Test headphones");
  await expect(output).toHaveValue("Test headphones");
  const savedOutput = () =>
    page.evaluate(
      () =>
        (window as any).__clientTest.commands
          .filter((entry: any) => entry.command === "save_settings")
          .at(-1)?.args.settings.audio_output,
    );
  await expect.poll(savedOutput).toBe("Test headphones");
  await output.selectOption("");
  await expect.poll(savedOutput).toBe(null);
  const outputRequests = () =>
    page.evaluate(
      () =>
        (window as any).__clientTest.commands.filter(
          (entry: any) => entry.command === "audio_outputs",
        ).length,
    );
  const previousRequests = await outputRequests();
  await page
    .getByRole("button", { name: "Refresh outputs", exact: true })
    .click();
  await expect.poll(outputRequests).toBe(previousRequests + 1);
  await page.getByRole("button", { name: "Test output", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__clientTest.commands.filter(
            (entry: any) => entry.command === "test_audio_output",
          ).length,
      ),
    )
    .toBe(1);
});

test("failed saved sign-in stays locked, supports retry and cancellable fresh sign-in", async ({
  page,
}) => {
  await startClient(page);
  await page.evaluate(
    ({ settings }) => {
      const emit = (window as any).__clientTest.emit;
      emit({ type: "signed_out" });
      emit({
        type: "settings",
        settings: { ...settings, client_id: "0".repeat(32) },
      });
      emit({
        type: "login_failed",
        issue: {
          message: "Cannot reach Spotify sign-in service",
          retry_saved: true,
        },
      });
    },
    { settings: emptyState.settings },
  );
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("Cannot reach Spotify");
  await expect(dialog).toContainText("Spotify Premium required");
  await page.keyboard.press("Escape");
  await page.locator(".setup-backdrop").click({ position: { x: 2, y: 2 } });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /close|skip/i })).toHaveCount(
    0,
  );
  await dialog
    .getByRole("button", { name: "Retry saved sign-in", exact: true })
    .click();
  await expect(
    page.getByRole("status", { name: "Restoring session" }),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as any).__clientTest.emit({
      type: "login_failed",
      issue: {
        message: "Spotify rejected the saved sign-in. Sign in again.",
        retry_saved: false,
      },
    }),
  );
  await expect(
    dialog.getByRole("button", { name: "Retry saved sign-in", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Sign in again", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Connecting…", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: "Cancel sign-in", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Sign in with Spotify", exact: true }),
  ).toBeEnabled();
  await expect(dialog).toBeVisible();
  const calls = await page.evaluate(() =>
    (window as any).__clientTest.commands.map((entry: any) => entry.command),
  );
  expect(calls).toContain("retry_sign_in");
  expect(calls).toContain("sign_in");
});

test("metadata menus stay off blank rows, backgrounds and player controls", async ({
  page,
}) => {
  await startClient(page);
  await page
    .locator(".track-row .track-name")
    .first()
    .click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  const row = await page.locator(".track-row").first().boundingBox();
  if (!row) throw Error("Track row missing");
  await page.mouse.click(row.x + 12, row.y + row.height / 2, {
    button: "right",
  });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page
    .locator(".page-hero")
    .click({ button: "right", position: { x: 5, y: 5 } });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page
    .locator('.player-song button[title="Save to Liked Songs"]')
    .click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.locator(".album-link").first().click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Go to album", exact: true }),
  ).toBeVisible();
});

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
}
async function startClient(page: Page, initialRoute = "liked") {
  await page.route("https://artwork.example.test/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#9670a7"/></svg>',
    }),
  );
  await page.addInitScript(
    ({ snapshot, track }) => {
      const host = window as any;
      const callbacks = new Map<number, Function>();
      const handlers = new Map<number, { event: string; handler: number }>();
      const commands: { command: string; args: any }[] = [];
      let serial = 0;
      const emitNamed = (event: string, payload: any) =>
        handlers.forEach(
          (handler) =>
            handler.event === event &&
            callbacks.get(handler.handler)?.({ event, payload }),
        );
      const emit = (payload: any) => emitNamed("spotiflex", payload);
      host.__clientTest = {
        commands,
        emit,
        emitVoice: (payload: any) => emitNamed("spotiflex-dj-voice", payload),
        pendingVoice: null,
        resolveVoice: null,
      };
      host.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: (_: string, id: number) => handlers.delete(id),
      };
      host.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        transformCallback: (callback: Function) => {
          callbacks.set(++serial, callback);
          return serial;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (command: string, args: any = {}) => {
          commands.push({ command, args });
          if (command === "audio_outputs")
            return ["Test speakers", "Test headphones"];
          if (command === "test_audio_output") return true;
          if (command === "cancel_sign_in") {
            emit({ type: "login_finished" });
            return;
          }
          if (command === "dj_voice") {
            host.__clientTest.emitVoice({
              id: args.id,
              account: args.account,
              level: 0,
              speech: false,
              stage: "listening",
            });
            return new Promise<string>((resolve) => {
              host.__clientTest.resolveVoice = resolve;
            });
          }
          if (command === "dj_request" && host.__clientTest.holdDJRequest)
            return new Promise<void>((resolve) => {
              host.__clientTest.resolveDJRequest = resolve;
            });
          if (command === "resolve_album")
            return {
              ...track.album,
              id: "abcdefghijklmnopqrstuv",
              uri: "spotify:album:abcdefghijklmnopqrstuv",
            };
          if (command === "plugin:event|listen") {
            handlers.set(++serial, {
              event: args.event,
              handler: args.handler,
            });
            return serial;
          }
          if (command === "plugin:event|unlisten") {
            handlers.delete(args.eventId);
            return;
          }
          if (command === "bootstrap") return structuredClone(snapshot);
          if (command === "home") {
            emit({ type: "home_loading", account: "test-user" });
            setTimeout(
              () =>
                emit({
                  type: "home",
                  page: {
                    account: "test-user",
                    greeting: "Hello",
                    sections: [
                      {
                        uri: "daily-mixes",
                        title: "Daily Mixes",
                        subtitle: "",
                        items: [
                          {
                            uri: "spotify:playlist:1123456789abcdefghijkl",
                            route: "playlist:1123456789abcdefghijkl",
                            name: "Daily Mix 1",
                            subtitle: "Your favorite artists",
                            images: track.album.images,
                            kind: "playlist",
                            playable: true,
                            format: "daily-mix",
                          },
                        ],
                      },
                      {
                        uri: "personal-releases",
                        title: "New releases for you",
                        subtitle: "New music from artists you love",
                        items: [
                          {
                            uri: "spotify:album:2123456789abcdefghijkl",
                            route: "album:2123456789abcdefghijkl",
                            name: "Your new album",
                            subtitle: "Your artist",
                            images: track.album.images,
                            kind: "album",
                            playable: true,
                            format: "",
                          },
                        ],
                      },
                      {
                        uri: "personal-stations",
                        title: "Recommended Stations",
                        subtitle: "",
                        items: [
                          {
                            uri: "spotify:playlist:3123456789abcdefghijkl",
                            route: "playlist:3123456789abcdefghijkl",
                            name: "Your station",
                            subtitle: "Based on your music",
                            images: track.album.images,
                            kind: "playlist",
                            playable: true,
                            format: "radio",
                          },
                        ],
                      },
                    ],
                  },
                }),
              20,
            );
            return;
          }
          if (command === "browse") {
            // Recents tests supply their own dated play history.
            if (args.key === "home" || args.key === "recent") return;
            if (args.key.startsWith("search:")) {
              setTimeout(
                () =>
                  emit({
                    type: "search_results",
                    account: "test-user",
                    key: args.key,
                    generation: args.generation,
                    message: "",
                    results: {
                      tracks: Array.from({ length: 20 }, (_, index) => {
                        const id = String(index + 1).padStart(22, "0");
                        return {
                          ...track,
                          id,
                          uri: `spotify:track:${id}`,
                          name: `Song ${index + 1}`,
                        };
                      }),
                      artists: [
                        {
                          ...track.artists[0],
                          uri: `spotify:artist:${track.artists[0].id}`,
                          images: track.album.images,
                        },
                      ],
                      albums: [
                        {
                          ...track.album,
                          uri: `spotify:album:${track.album.id}`,
                        },
                      ],
                      playlists: [],
                      top_results: [
                        "spotify:track:0000000000000000000001",
                        `spotify:artist:${track.artists[0].id}`,
                      ],
                    },
                  }),
                20,
              );
              return;
            }
            const offset = args.offset ?? 0;
            setTimeout(
              () =>
                emit({
                  type: "tracks",
                  key: args.key,
                  generation: args.generation,
                  offset,
                  more: offset < 100,
                  tracks: Array.from({ length: 50 }, (_, index) => ({
                    ...track,
                    uri: `spotify:track:item${offset + index}`,
                    name: `Song ${offset + index + 1}`,
                  })),
                }),
              offset ? 300 : 20,
            );
          }
          if (command === "import_lyrics") {
            emit({
              type: "lyrics",
              uri: track.uri,
              lyrics: {
                source: "Imported TTML",
                synced: true,
                instrumental: false,
                lines: Array.from({ length: 80 }, (_, index) => ({
                  text: `Test lyric line ${index + 1}`,
                  start_ms: index * 2000,
                  end_ms: (index + 1) * 2000,
                  translation: "",
                  romanization: "",
                  words: [
                    {
                      text: `Test lyric line ${index + 1}`,
                      start_ms: index * 2000,
                      end_ms: (index + 1) * 2000,
                    },
                  ],
                  background: false,
                  opposite: false,
                })),
              },
            });
          }
        },
      };
    },
    {
      snapshot: {
        ...emptyState,
        route: initialRoute,
        profile: { id: "test-user" },
        local_device_name: "SpotiFlex (test)",
        native_ready: true,
        playback: {
          ...emptyState.playback,
          item: track,
          progress_ms: 40_000,
          device: {
            name: "SpotiFlex (test)",
            id: "local-device",
            is_active: true,
          },
        },
        details: { artists: track.artists, queue: [] },
      },
      track,
    },
  );
  await page.goto("/");
  await page
    .locator(".application")
    .waitFor({ state: "visible", timeout: 20_000 });
  await expect(page.locator(".setup-backdrop")).toHaveCount(0);
  if (initialRoute === "home")
    await expect(
      page.getByRole("heading", { name: "Daily Mixes", exact: true }),
    ).toBeVisible();
  else await expect(page.locator(".track-row")).toHaveCount(50);
}

/** The player's DJ button only shows while a DJ session is playing. */
async function inDJSession(page: Page) {
  await page.evaluate(() =>
    (window as any).__clientTest.emit({ type: "dj_context", active: true }),
  );
}

async function askDJ(page: Page) {
  await inDJSession(page);
  await page.getByRole("button", { name: "Refresh DJ", exact: true }).focus();
  await page.keyboard.press("Shift+Enter");
  await expect(page.getByRole("dialog", { name: "Ask DJ" })).toBeVisible();
}

test("DJ sends arbitrary typed requests without opening the microphone", async ({
  page,
}) => {
  await startClient(page);
  await askDJ(page);
  await page
    .getByRole("textbox", { name: "DJ request", exact: true })
    .fill("Energetic 2000s rock, then calm ambient music");
  await page.getByRole("button", { name: "Send to DJ", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Ask DJ" })).toHaveCount(0);
  const commands = await page.evaluate(
    () => (window as any).__clientTest.commands,
  );
  expect(commands.filter((c: any) => c.command === "dj_voice")).toHaveLength(0);
  expect(
    commands.find((c: any) => c.command === "dj_request").args,
  ).toMatchObject({
    account: "test-user",
    input: "text",
    text: "Energetic 2000s rock, then calm ambient music",
  });
  expect(commands.filter((c: any) => c.command === "dj_cancel")).toHaveLength(
    0,
  );
});

test("DJ voice submits after speech ends without filling text and rejects cancelled results", async ({
  page,
}) => {
  await startClient(page);
  await askDJ(page);
  await page.getByRole("button", { name: "Use microphone" }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() =>
    (window as any).__clientTest.resolveVoice("Do not apply this old result"),
  );
  await expect(
    page.getByRole("textbox", { name: "DJ request", exact: true }),
  ).toHaveValue("");
  await page
    .getByRole("textbox", { name: "DJ request", exact: true })
    .fill("Keep my typed draft");
  await page.evaluate(
    () => ((window as any).__clientTest.holdDJRequest = true),
  );
  await page.getByRole("button", { name: "Use microphone" }).click();
  await page.evaluate(() =>
    (window as any).__clientTest.resolveVoice("Play acoustic folk"),
  );
  await expect(
    page.getByRole("textbox", { name: "DJ request", exact: true }),
  ).toHaveValue("Keep my typed draft");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__clientTest.commands.find(
            (c: any) => c.command === "dj_request",
          )?.args,
      ),
    )
    .toMatchObject({ text: "Play acoustic folk", input: "voice" });
  await expect(
    page.getByText("Heard: “Play acoustic folk”", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as any).__clientTest.commands.filter(
          (c: any) => c.command === "dj_request",
        ).length,
    ),
  ).toBe(1);
  await page.evaluate(() => (window as any).__clientTest.resolveDJRequest());
  await expect(page.getByRole("dialog", { name: "Ask DJ" })).toHaveCount(0);
  await expect(
    page.getByText("DJ heard: “Play acoustic folk”", { exact: true }),
  ).toBeVisible();
});

test("DJ microphone bars follow real level events and ignore other captures", async ({
  page,
}) => {
  await startClient(page);
  await askDJ(page);
  await page.getByRole("button", { name: "Use microphone" }).click();
  const meter = page.getByRole("meter", { name: "Microphone input" });
  await expect(meter).toHaveAttribute("aria-valuenow", "0");
  await expect(meter.locator("i")).toHaveCount(11);
  await page.evaluate(() => {
    const host = (window as any).__clientTest;
    const id = host.commands.find((c: any) => c.command === "dj_voice").args.id;
    host.voiceId = id;
    host.emitVoice({ id, account: "test-user", level: 75, speech: false });
  });
  await expect(meter).toHaveAttribute("aria-valuenow", "75");
  await expect(page.getByText("Sound detected", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      meter
        .locator("i")
        .first()
        .evaluate((e) => e.getBoundingClientRect().height),
    )
    .toBeGreaterThan(3);
  await page.evaluate(() => {
    const host = (window as any).__clientTest;
    host.emitVoice({
      id: "old-capture",
      account: "test-user",
      level: 99,
      speech: true,
    });
    host.emitVoice({
      id: host.voiceId,
      account: "other-user",
      level: 99,
      speech: true,
    });
  });
  await expect(meter).toHaveAttribute("aria-valuenow", "75");
  await page.evaluate(() => {
    const host = (window as any).__clientTest;
    host.emitVoice({
      id: host.voiceId,
      account: "test-user",
      level: 0,
      speech: true,
    });
  });
  await expect(meter).toHaveAttribute("aria-valuenow", "0");
  await expect(page.getByText("Hearing speech", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(meter).toHaveCount(0);
  await page.evaluate(() => {
    const host = (window as any).__clientTest;
    host.emitVoice({
      id: host.voiceId,
      account: "test-user",
      level: 100,
      speech: true,
    });
    host.resolveVoice("Old request");
  });
  expect(
    await page.evaluate(() =>
      (window as any).__clientTest.commands.some(
        (c: any) => c.command === "dj_request",
      ),
    ),
  ).toBe(false);
  await expect(meter).toHaveCount(0);
});

test("Ask DJ prewarms requests without starting capture and releases its model on close", async ({
  page,
}) => {
  await startClient(page);
  await askDJ(page);
  expect(
    await page.evaluate(() =>
      (window as any).__clientTest.commands.some(
        (c: any) =>
          c.command === "dj_prepare" && c.args.account === "test-user",
      ),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() =>
      (window as any).__clientTest.commands.some(
        (c: any) => c.command === "dj_voice",
      ),
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "Use microphone" }).click();
  const dialog = await page.evaluate(
    () =>
      (window as any).__clientTest.commands.find(
        (c: any) => c.command === "dj_voice",
      ).args.dialog,
  );
  await page.getByRole("button", { name: "Close DJ request" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__clientTest.commands
          .filter((c: any) => c.command === "dj_release_voice")
          .map((c: any) => c.args.dialog),
      ),
    )
    .toContain(dialog);
  await page.evaluate(() =>
    (window as any).__clientTest.resolveVoice("Do not submit after close"),
  );
  expect(
    await page.evaluate(() =>
      (window as any).__clientTest.commands.some(
        (c: any) => c.command === "dj_request",
      ),
    ),
  ).toBe(false);
});

test("DJ waits for local speech setup before inviting the user to speak", async ({
  page,
}) => {
  await startClient(page);
  await askDJ(page);
  await page.getByRole("button", { name: "Use microphone" }).click();
  await page.evaluate(() => {
    const host = (window as any).__clientTest;
    const id = host.commands.find((c: any) => c.command === "dj_voice").args.id;
    host.voiceId = id;
    host.emitVoice({
      id,
      account: "test-user",
      level: 0,
      speech: false,
      stage: "preparing",
      percent: 37,
    });
  });
  await expect(page.getByRole("status")).toHaveText(
    "Preparing local speech recognition… 37%",
  );
  await expect(
    page.getByRole("meter", { name: "Microphone input" }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    const host = (window as any).__clientTest;
    host.emitVoice({
      id: host.voiceId,
      account: "test-user",
      level: 30,
      speech: true,
      stage: "listening",
    });
  });
  await expect(
    page.getByRole("meter", { name: "Microphone input" }),
  ).toBeVisible();
  await page.evaluate(() => {
    const host = (window as any).__clientTest;
    host.emitVoice({
      id: host.voiceId,
      account: "test-user",
      level: 0,
      speech: false,
      stage: "transcribing",
    });
  });
  await expect(page.getByRole("status")).toHaveText(
    "Recognizing your request…",
  );
  await expect(
    page.getByRole("meter", { name: "Microphone input" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() =>
    (window as any).__clientTest.resolveVoice("Old voice request"),
  );
  expect(
    await page.evaluate(() =>
      (window as any).__clientTest.commands.some(
        (c: any) => c.command === "dj_request",
      ),
    ),
  ).toBe(false);
});

test("DJ dialog traps focus and closes on sign-out", async ({ page }) => {
  await startClient(page);
  await askDJ(page);
  await page.getByRole("button", { name: "Close DJ request" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.getByRole("button", { name: "Use microphone" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Close DJ request" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Use microphone" }).click();
  await page.evaluate(() =>
    (window as any).__clientTest.emit({ type: "signed_out" }),
  );
  await expect(page.getByRole("dialog", { name: "Ask DJ" })).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      (window as any).__clientTest.commands.some(
        (c: any) => c.command === "dj_cancel",
      ),
    ),
  ).toBe(true);
});

// Plays a short recorded purple video as the current track's Canvas.
async function emitCanvas(page: Page) {
  await page.evaluate(async (uri) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#7547c2";
    context.fillRect(0, 0, 64, 64);
    const recorder = new MediaRecorder(canvas.captureStream(2));
    const parts: BlobPart[] = [];
    const url = await new Promise<string>((resolve) => {
      recorder.ondataavailable = (event) => parts.push(event.data);
      recorder.onstop = () =>
        resolve(
          URL.createObjectURL(new Blob(parts, { type: recorder.mimeType })),
        );
      recorder.start();
      setTimeout(() => recorder.stop(), 300);
    });
    (window as any).__clientTest.emit({ type: "canvas", uri, url });
    (window as any).__clientTest.emit({
      type: "provider_configured",
      kind: "spicy",
    });
  }, track.uri);
}

test("sidebar preserves pins and changes recents only after manual playback", async ({
  page,
}) => {
  await startClient(page);
  await page.evaluate(() => {
    (window as any).__clientTest.emit({
      type: "library",
      playlists: Array.from({ length: 5 }, (_, index) => ({
        id: String(index).padStart(22, "0"),
        name: `Playlist ${index}`,
        images: [],
        owner: { id: "test-user" },
        collaborative: false,
      })),
    });
  });
  const names = () => page.locator(".library-row strong").allTextContents();
  await expect(page.locator(".library-row strong").first()).toHaveText("DJ");
  await page
    .locator(".library-row")
    .filter({ has: page.getByText("Playlist 2", { exact: true }) })
    .locator(".library-item")
    .click();
  expect((await names())[0]).toBe("DJ");
  await page.getByTitle("Play Playlist 2", { exact: true }).click();
  await expect(page.locator(".library-row strong").first()).toHaveText(
    "Playlist 2",
  );
  for (const name of ["Playlist 0", "Playlist 1", "Playlist 3"]) {
    await page
      .locator(".library-row")
      .filter({ has: page.getByText(name, { exact: true }) })
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Pin playlist", exact: true })
      .click();
  }
  expect((await names()).slice(0, 3)).toEqual([
    "Playlist 0",
    "Playlist 1",
    "Playlist 3",
  ]);
  await page
    .locator(".library-row")
    .filter({ has: page.getByText("Playlist 4", { exact: true }) })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Pin playlist", exact: true })
    .click();
  await expect(
    page.getByText("Four pins maximum, including Liked Songs.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.locator(".library-list > .library-item").first(),
  ).toContainText("Liked Songs");
  await expect(
    page
      .locator(".library-list > .library-item")
      .first()
      .locator(".pinned-mark"),
  ).toHaveCount(0);
});
test("artist and song right clicks offer relevant actions", async ({
  page,
}) => {
  await startClient(page);
  await page
    .locator(".player-song .artist-link")
    .first()
    .click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Go to artist", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Follow artist", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Pin playlist", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page
    .locator(".track-row .track-name")
    .first()
    .click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Add to queue", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Save to Liked Songs", exact: true }),
  ).toBeVisible();
});
test("DJ speech replaces song metadata across player, Now playing and lyrics", async ({
  page,
}) => {
  await startClient(page);
  await page.evaluate(() =>
    (window as any).__clientTest.emit({ type: "narration", active: true }),
  );
  await expect(page.locator(".player-song")).toContainText("DJ");
  await expect(page.locator(".now-playing")).toContainText("DJ");
  await page.getByTitle("Lyrics", { exact: true }).click();
  await expect(page.locator(".lyrics-page")).toContainText("DJ");
  await expect(page.locator(".lyrics-page")).not.toContainText("Timing test");
  await page.evaluate(() =>
    (window as any).__clientTest.emit({ type: "narration", active: false }),
  );
  await expect(page.locator(".player-song")).toContainText("Timing test");
  await expect(page.locator(".lyrics-page")).toContainText("Timing test");
});

test("holding hint appears at DJ startup and stays quiet during later segments", async ({
  page,
}) => {
  await startClient(page);
  await expect(
    page.getByText("Hold the DJ button to ask for music.", { exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).__clientTest.emit({ type: "narration", active: true }),
  );
  await expect(
    page.getByText("Hold the DJ button to ask for music.", { exact: true }),
  ).toBeVisible();
  const first = await page.evaluate(() =>
    localStorage.getItem("spotiflex.dj-hint.test-user"),
  );
  expect(Number(first)).toBeGreaterThan(0);
  await page.evaluate(() => {
    const host = (window as any).__clientTest;
    host.emit({ type: "notice", message: "Other notice", error: false });
    host.emit({ type: "narration", active: false });
  });
  await expect(page.getByText("Other notice", { exact: true })).toBeVisible();
  await page.evaluate(() =>
    (window as any).__clientTest.emit({ type: "narration", active: true }),
  );
  await expect(page.getByText("Other notice", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("spotiflex.dj-hint.test-user"),
    ),
  ).toBe(first);
});
test("player DJ button requests a fresh DJ selection on every click", async ({
  page,
}) => {
  await startClient(page);
  const button = page.getByRole("button", { name: "Refresh DJ", exact: true });
  await expect(button).toHaveCount(0);
  await inDJSession(page);
  await button.click();
  await button.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__clientTest.commands.filter(
            (entry: any) =>
              entry.command === "player" && entry.args.request.command === "dj",
          ).length,
      ),
    )
    .toBe(2);
});

test("holding DJ opens requests without refreshing", async ({ page }) => {
  await startClient(page);
  await page.clock.install();
  await inDJSession(page);
  const button = page.getByRole("button", { name: "Refresh DJ", exact: true });
  await button.hover();
  await page.mouse.down();
  await page.clock.runFor(600);
  await expect(page.getByRole("dialog", { name: "Ask DJ" })).toBeVisible({
    timeout: 1000,
  });
  await page.mouse.up();
  expect(
    await page.evaluate(
      () =>
        (window as any).__clientTest.commands.filter(
          (entry: any) =>
            entry.command === "player" && entry.args.request.command === "dj",
        ).length,
    ),
  ).toBe(0);
  await page.getByRole("button", { name: "Close DJ request" }).click();
  await button.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__clientTest.commands.filter(
            (entry: any) =>
              entry.command === "player" && entry.args.request.command === "dj",
          ).length,
      ),
    )
    .toBe(1);
});

test("cancelled DJ holds stay silent and preserve keyboard refresh", async ({
  page,
}) => {
  await startClient(page);
  await page.clock.install();
  await inDJSession(page);
  const button = page.getByRole("button", { name: "Refresh DJ", exact: true });
  await button.hover();
  await page.mouse.down();
  await page.clock.runFor(200);
  await page.mouse.move(0, 0);
  await page.clock.runFor(600);
  await page.mouse.up();
  await expect(
    page.getByText(
      "DJ text and voice requests aren't available yet. Click DJ for a new selection.",
      { exact: true },
    ),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as any).__clientTest.commands.filter(
          (entry: any) =>
            entry.command === "player" && entry.args.request.command === "dj",
        ).length,
    ),
  ).toBe(0);
  await button.focus();
  await button.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__clientTest.commands.filter(
            (entry: any) =>
              entry.command === "player" && entry.args.request.command === "dj",
          ).length,
      ),
    )
    .toBe(1);
});

test("personalized Home shelves launch native mixes and DJ", async ({
  page,
}) => {
  await startClient(page, "home");
  await expect(
    page.getByRole("heading", { name: "New releases for you", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Recommended Stations", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Nothing here yet", { exact: true })).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "Play Daily Mix 1", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__clientTest.commands
            .filter((command: any) => command.command === "player")
            .at(-1)?.args.request,
      ),
    )
    .toMatchObject({
      command: "play_home",
      context: "spotify:playlist:1123456789abcdefghijkl",
    });
  await page.getByRole("button", { name: "Start DJ", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__clientTest.commands
            .filter((command: any) => command.command === "player")
            .at(-1)?.args.request.command,
      ),
    )
    .toBe("dj");
  await page.screenshot({ path: "target/diagnostics/home-preview.png" });
});

test("cached Home shows at once and refreshes when native audio connects", async ({
  page,
}) => {
  await startClient(page, "home");
  const homeCalls = () =>
    page.evaluate(
      () =>
        (window as any).__clientTest.commands.filter(
          (command: any) => command.command === "home",
        ).length,
    );
  const before = await homeCalls();
  await page.evaluate(() => {
    const { emit } = (window as any).__clientTest;
    emit({ type: "native", ready: false, status: "Connecting native audio…" });
    emit({
      type: "library",
      playlists: [
        {
          id: "4123456789abcdefghijkl",
          name: "Road trip",
          images: [],
          owner: { id: "test-user" },
          collaborative: false,
        },
      ],
    });
    emit({
      type: "home",
      page: {
        account: "test-user",
        greeting: "",
        cached: true,
        sections: [
          {
            uri: "cached",
            title: "Cached shelf",
            subtitle: "",
            items: [
              {
                uri: "spotify:album:5123456789abcdefghijkl",
                route: "album:5123456789abcdefghijkl",
                name: "Cached album",
                subtitle: "Artist",
                images: [],
                kind: "album",
                playable: true,
                format: "",
              },
            ],
          },
        ],
      },
    });
  });
  await expect(
    page.getByRole("heading", { name: "Cached shelf", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".home-quick-links").getByText("Road trip", { exact: true }),
  ).toBeVisible();
  expect(await homeCalls()).toBe(before);
  await page.evaluate(() =>
    (window as any).__clientTest.emit({
      type: "native",
      ready: true,
      status: "Ready · this computer",
    }),
  );
  await expect.poll(homeCalls).toBe(before + 1);
  await expect(
    page.getByRole("heading", { name: "Daily Mixes", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Cached shelf", exact: true }),
  ).toHaveCount(0);
});

test("Daily Mix navigation retains title, artwork and description", async ({
  page,
}) => {
  await startClient(page, "home");
  await page
    .getByRole("button", { name: "Open Daily Mix 1", exact: true })
    .click();
  await expect(page.locator(".page-hero h1")).toHaveText("Daily Mix 1");
  await expect(page.locator(".page-hero")).toContainText(
    "Your favorite artists",
  );
  await expect(page.locator(".page-hero img")).toHaveAttribute(
    "src",
    "https://artwork.example.test/cover.svg",
  );
  await expect(page.locator(".track-row")).toHaveCount(50);
  await page.evaluate(() => {
    const request = (window as any).__clientTest.commands
      .filter((request: any) => request.command === "browse")
      .at(-1);
    (window as any).__clientTest.emit({
      type: "browse_info",
      generation: request.args.generation,
      info: {
        key: request.args.key,
        title: "Daily Mix 1",
        subtitle: "Your favorite artists",
        images: [],
        albums: [],
        playlist: { owner: "spotify", format: "daily-mix", total_tracks: 50 },
      },
    });
  });
  await expect(page.locator(".playlist-meta")).toContainText(
    "Made for test-user",
  );
  await expect(page.locator(".playlist-meta")).toContainText("50 songs");
  await page.getByTitle("Go back", { exact: true }).click();
  await page
    .getByRole("button", { name: "Open Daily Mix 1", exact: true })
    .click();
  await expect(page.locator(".page-hero h1")).toHaveText("Daily Mix 1");
});

test("Home shelves keep header, player and DJ inside the window", async ({
  page,
}) => {
  await startClient(page, "home");
  await page.evaluate(() => {
    const items = Array.from({ length: 25 }, (_, index) => ({
      uri: `spotify:playlist:${String(index).padStart(22, "0")}`,
      route: `playlist:${String(index).padStart(22, "0")}`,
      name: `Personal mix ${index + 1}`,
      subtitle: "Favorite artists and new discoveries",
      images: [],
      kind: "playlist",
      playable: true,
      format: "daily-mix",
    }));
    (window as any).__clientTest.emit({
      type: "home",
      page: {
        account: "test-user",
        greeting: "Hello",
        sections: [{ uri: "mixes", title: "Daily Mixes", subtitle: "", items }],
      },
    });
  });
  await expect(page.locator(".home-card")).toHaveCount(25);
  for (const viewport of [
    { width: 2560, height: 1323 },
    { width: 1600, height: 1000 },
    { width: 900, height: 600 },
  ]) {
    await page.setViewportSize(viewport);
    for (const selector of [
      ".application",
      ".topbar",
      ".window-controls",
      ".player-bar",
      ".player-extras",
      ".home-quick-links",
      '[aria-label="Start DJ"]',
    ]) {
      const box = await page.locator(selector).boundingBox();
      expect(box, selector).not.toBeNull();
      expect(
        box!.x,
        `${selector} extends past left edge`,
      ).toBeGreaterThanOrEqual(-1);
      expect(
        box!.x + box!.width,
        `${selector} extends past right edge at ${viewport.width}px`,
      ).toBeLessThanOrEqual(viewport.width + 1);
    }
    const player = await page.locator(".player-bar").boundingBox();
    expect(player!.y + player!.height).toBeLessThanOrEqual(viewport.height + 1);
  }
  // One row clipped at the edge with a fade, like Spotify; Show all wraps it.
  const shelf = page.locator(".home-shelf-items");
  await expect(shelf).toHaveClass(/clipped/);
  await page.getByRole("button", { name: "Show all", exact: true }).click();
  await expect(shelf).toHaveClass(/expanded/);
  await expect(shelf).not.toHaveClass(/clipped/);
  const width = await shelf.evaluate((element) => ({
    scroll: element.scrollWidth,
    client: element.clientWidth,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
  const footer = await page.locator(".player-bar").boundingBox();
  expect(footer!.y + footer!.height).toBeLessThanOrEqual(601);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole("button", { name: "Show less", exact: true }).click();
  await page.screenshot({ path: "target/diagnostics/home-layout-fixed.png" });
});

test("imported lyrics keep artwork and ambience in place, without a duplicate preview", async ({
  page,
}) => {
  await startClient(page);
  await page.getByTitle("Lyrics", { exact: true }).click();
  await page.locator(".file-input").setInputFiles({
    name: "timing.ttml",
    mimeType: "application/xml",
    buffer: Buffer.from(
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0s" end="2s">Test</p></div></body></tt>',
    ),
  });
  await expect(page.locator(".lyrics-page .lyric-line")).toHaveCount(80);
  await expect(page.locator(".now-playing .lyric-preview")).toHaveCount(0);
  for (const position of [40_500, 88_500, 150_500]) {
    await page.evaluate(
      ({ uri, position }) =>
        (window as any).__clientTest.emit({
          type: "native_position",
          uri,
          position_ms: position,
          playing: false,
          observed_at: Date.now(),
        }),
      { uri: track.uri, position },
    );
    const line = page.locator(".lyrics-page .lyric-line.active");
    await expect(line).toHaveText(
      `Test lyric line ${Math.floor(position / 2000) + 1}`,
    );
    await expect
      .poll(() =>
        page.evaluate(() => {
          const panel = document.querySelector<HTMLElement>(".lyrics-page")!;
          const ambience = panel.querySelector<HTMLElement>(".ambience")!;
          const body = panel.querySelector<HTMLElement>(".lyrics-body")!;
          const active =
            panel.querySelector<HTMLElement>(".lyric-line.active")!;
          const bounds = panel.getBoundingClientRect(),
            line = active.getBoundingClientRect();
          return (
            panel.scrollTop === 0 &&
            body.clientHeight <= panel.clientHeight &&
            Math.abs(ambience.getBoundingClientRect().top - bounds.top) < 1 &&
            line.top >= bounds.top &&
            line.bottom <= bounds.bottom
          );
        }),
      )
      .toBe(true);
  }
  await page.locator("footer").getByTitle("Lyrics", { exact: true }).click();
  const cards = page.locator(".now-playing .now-card");
  await expect(cards.first()).toHaveClass(/lyric-preview/);
  await expect(cards.nth(1)).toHaveClass(/artist-card/);
  // Card lyrics scale with the card and stay readable.
  const size = await cards
    .first()
    .locator(".lyric-line")
    .first()
    .evaluate((line) => parseFloat(getComputedStyle(line).fontSize));
  expect(size).toBeGreaterThanOrEqual(26);
  expect(size).toBeLessThanOrEqual(34);
});

test("album pages retain play counts, release date and licensing", async ({
  page,
}) => {
  await startClient(page);
  await page.locator(".album-link").first().click();
  await page.evaluate((track) => {
    const host = (window as any).__clientTest;
    const command = host.commands
      .filter((call: any) => call.command === "browse")
      .at(-1);
    host.emit({
      type: "browse_info",
      generation: command.args.generation,
      info: {
        key: command.args.key,
        title: "Test album",
        subtitle: "Test artist",
        images: track.album.images,
        album: {
          ...track.album,
          artists: track.artists,
          total_tracks: 50,
          release_date: "2026-10-15",
          copyrights: [{ text: "© 2026 Test Label", type: "C" }],
        },
        albums: [],
        album_details: {
          streams: { "spotify:track:item0": 2470 },
          duration_ms: 180000,
          complete_duration: true,
          copyrights: [],
          more: [],
        },
      },
    });
  }, track);
  await expect(page.locator(".track-table-head")).toContainText("Plays");
  await expect(page.locator(".track-streams").first()).toHaveText("2,470");
  await expect(page.locator(".album-release-details")).toContainText(
    "2026 Test Label",
  );
  await expect(page.locator(".album-release-details")).toContainText("2026");
});

test("Canvas defaults on, Space Gravity is optional, with sharp video left and metadata bottom-left", async ({
  page,
}) => {
  await startClient(page);
  await page.getByTitle("Lyrics", { exact: true }).click();
  await page.locator(".file-input").setInputFiles({
    name: "timing.ttml",
    mimeType: "application/xml",
    buffer: Buffer.from("<tt/>"),
  });
  await emitCanvas(page);
  await openSettings(page);
  await expect(page.getByLabel("Lyrics API key")).toHaveCount(0);
  await expect(page.getByLabel("Canvas in lyrics")).toBeChecked();
  await expect(page.getByLabel("Space Gravity")).not.toBeChecked();
  await page.getByLabel("Canvas in lyrics").check();
  await page.getByLabel("Space Gravity").check();
  await page.getByTitle("Lyrics", { exact: true }).click();
  await expect(page.locator(".canvas-lyrics video")).toBeVisible();
  await expect(page.locator(".gravity-stage")).toBeVisible();
  expect(
    await page
      .locator(".lyrics-canvas-cover video")
      .evaluate((element) => getComputedStyle(element).filter),
  ).toBe("none");
  expect(
    await page
      .locator(".lyrics-canvas-backdrop")
      .evaluate((element) => (element as HTMLCanvasElement).width),
  ).toBe(512);
  const layout = await page.evaluate(() => {
    const video = document
        .querySelector(".lyrics-canvas-cover")!
        .getBoundingClientRect(),
      body = document.querySelector(".lyrics-body")!.getBoundingClientRect(),
      title = document.querySelector(".lyrics-title")!.getBoundingClientRect(),
      section = document.querySelector(".lyrics-page")!.getBoundingClientRect();
    return {
      videoLeft:
        video.left <= section.left + 1 && video.width < section.width * 0.65,
      titleLeft: title.left < section.left + section.width / 2,
      titleBottom: title.top > section.top + section.height * 0.75,
    };
  });
  expect(layout).toEqual({
    videoLeft: true,
    titleLeft: true,
    titleBottom: true,
  });
  await openSettings(page);
  await page.getByLabel("Reduce motion").check();
  await page.getByTitle("Lyrics", { exact: true }).click();
  await expect(page.locator(".gravity-stage")).toHaveCount(0);
  await expect(page.locator(".lyrics-canvas-cover")).toHaveCount(0);
  await expect(page.locator(".lyrics-page .lyric-line")).toHaveCount(80);
});

test("Canvas and its toolbar move together without restarting the video", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await startClient(page);
  await page.getByTitle("Lyrics", { exact: true }).click();
  await emitCanvas(page);
  await expect(page.locator(".lyrics-canvas-cover video")).toBeVisible();
  await page.evaluate(() => {
    (window as any).__canvasBeforeMove = document.querySelector(
      ".lyrics-canvas-cover video",
    );
  });
  const layout = () =>
    page.evaluate(() => {
      const section = document
        .querySelector(".lyrics-page")!
        .getBoundingClientRect();
      const cover = document
        .querySelector(".lyrics-canvas-cover")!
        .getBoundingClientRect();
      const toolbar = document
        .querySelector(".lyrics-toolbar")!
        .getBoundingClientRect();
      const title = document
        .querySelector(".lyrics-title")!
        .getBoundingClientRect();
      return {
        right: cover.left >= section.left + section.width / 2,
        anchorX: Math.abs(
          cover.left >= section.left + section.width / 2
            ? toolbar.right - (section.right - 12)
            : toolbar.left - (Math.max(section.left, cover.left) + 12),
        ),
        anchorY: Math.abs(
          toolbar.top - (Math.max(section.top, cover.top) + 12),
        ),
        contained:
          toolbar.right <= Math.min(section.right, cover.right) &&
          toolbar.bottom < Math.min(section.bottom, cover.bottom),
        titleRight: title.left > section.left + section.width / 2,
      };
    });
  await expect.poll(layout).toMatchObject({ right: false, contained: true });
  await expect.poll(async () => (await layout()).anchorX).toBeLessThan(2);
  await expect.poll(async () => (await layout()).anchorY).toBeLessThan(2);
  const flip = page
    .getByRole("toolbar", { name: "Lyrics" })
    .getByTitle("Artwork on the right", { exact: true });
  await flip.click();
  await expect
    .poll(layout)
    .toMatchObject({ right: true, contained: true, titleRight: true });
  await expect.poll(async () => (await layout()).anchorX).toBeLessThan(2);
  await expect.poll(async () => (await layout()).anchorY).toBeLessThan(2);
  expect(
    await page.evaluate(
      () =>
        (window as any).__canvasBeforeMove ===
        document.querySelector(".lyrics-canvas-cover video"),
    ),
  ).toBe(true);
  await flip.click();
  await expect
    .poll(layout)
    .toMatchObject({ right: false, contained: true, titleRight: false });
});

test("timed syllables lift independently and font choices apply separately", async ({
  page,
}) => {
  await startClient(page);
  await page.getByTitle("Lyrics", { exact: true }).click();
  await page.evaluate((uri) => {
    const host = (window as any).__clientTest;
    host.emit({
      type: "lyrics",
      uri,
      lyrics: {
        source: "Imported TTML",
        synced: true,
        instrumental: false,
        lines: [
          {
            text: "Hello",
            start_ms: 1000,
            end_ms: 3300,
            translation: "",
            romanization: "",
            background: false,
            opposite: false,
            words: [
              { text: "Hel", start_ms: 1000, end_ms: 1300 },
              { text: "lo", start_ms: 1300, end_ms: 3300 },
            ],
          },
        ],
      },
    });
    host.emit({
      type: "native_position",
      uri,
      position_ms: 1070,
      playing: false,
      observed_at: Date.now(),
    });
  }, track.uri);
  await expect(page.locator(".lyrics-page .lyric-syllable")).toHaveCount(2);
  const motion = (target: Locator) =>
    target.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        lift:
          style.translate === "none"
            ? 0
            : parseFloat(style.translate.split(" ")[1] ?? "0"),
        scale: style.scale === "none" ? 1 : parseFloat(style.scale),
        glow: style.textShadow,
      };
    });
  const syllable = page.locator(".lyrics-page .lyric-syllable").first(),
    letter = page.locator(".lyrics-page .lyric-letter").first();
  // "Hel" is rising; the held "lo" moves by letter and eases down to rest
  // low at full size, so its spacing stays even.
  await expect.poll(async () => (await motion(syllable)).lift).toBeLessThan(0);
  await expect.poll(async () => (await motion(letter)).lift).toBeGreaterThan(0);
  expect((await motion(letter)).scale).toBeCloseTo(1, 2);
  await page.evaluate(
    (uri) =>
      (window as any).__clientTest.emit({
        type: "native_position",
        uri,
        position_ms: 2000,
        playing: false,
        observed_at: Date.now(),
      }),
    track.uri,
  );
  await expect.poll(async () => (await motion(letter)).lift).toBeLessThan(-1);
  await expect
    .poll(async () => (await motion(letter)).scale)
    .toBeGreaterThan(1.02);
  expect((await motion(letter)).glow).toMatch(/rgba\(255, 255, 255, 0\.[1-9]/);
  await openSettings(page);
  await page.getByLabel("App font", { exact: true }).fill("Georgia");
  await page.getByLabel("Lyrics font", { exact: true }).fill("Consolas");
  await page.getByTitle("Lyrics", { exact: true }).click();
  expect(
    await page
      .locator(".application")
      .evaluate((element) => getComputedStyle(element).fontFamily),
  ).toContain("Georgia");
  expect(
    await page
      .locator(".lyrics-page .lyric-line")
      .evaluate((element) => getComputedStyle(element).fontFamily),
  ).toContain("Consolas");
});

test("typed Windows font names apply immediately with a live preview", async ({
  page,
}) => {
  await startClient(page);
  await openSettings(page);
  const appFont = page.getByLabel("App font", { exact: true });
  const lyricFont = page.getByLabel("Lyrics font", { exact: true });
  await appFont.clear();
  await appFont.pressSequentially("Times New Roman", { delay: 10 });
  await expect(appFont).toHaveValue("Times New Roman");
  await expect(appFont).toBeFocused();
  expect(
    await page
      .locator(".application")
      .evaluate((node) => getComputedStyle(node).fontFamily),
  ).toContain("Times New Roman");
  await lyricFont.fill("Bahnschrift");
  await expect(lyricFont).toBeFocused();
  await expect(page.locator(".settings-page")).toBeVisible();
  expect(
    await page
      .getByLabel("Lyrics font preview", { exact: true })
      .evaluate((node) => getComputedStyle(node).fontFamily),
  ).toContain("Bahnschrift");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__clientTest.commands
            .filter((entry: any) => entry.command === "save_settings")
            .at(-1)?.args.settings.lyric_font,
      ),
    )
    .toBe("Bahnschrift");
  await lyricFont.clear();
  expect(
    await page
      .getByLabel("Lyrics font preview", { exact: true })
      .evaluate((node) => getComputedStyle(node).fontFamily),
  ).toContain("Inter");
  await appFont.clear();
  expect(
    await page
      .locator(".application")
      .evaluate((node) => getComputedStyle(node).fontFamily),
  ).not.toContain("Times New Roman");
});

test("playlist search spans unloaded pages and play counts drive sorting", async ({
  page,
}) => {
  await startClient(page);
  await page
    .locator(".library-item")
    .filter({ hasText: "Liked Songs" })
    .click();
  await page.getByTitle("Search in playlist", { exact: true }).click();
  await page.getByLabel("Search songs in this playlist").fill("Song 125");
  await expect(page.locator(".track-row")).toHaveCount(1);
  await expect(page.locator(".track-row")).toContainText("Song 125");
  await page.evaluate(() => {
    (window as any).__clientTest.emit({
      type: "track_facts",
      facts: {
        "spotify:track:item124": {
          plays: 123456,
          genres: ["rock"],
          release_date: "2020-01-01",
        },
      },
    });
  });
  await expect(page.locator(".track-streams")).toHaveCount(0);
  await page.getByLabel("Search songs in this playlist").clear();
  await page.getByTitle("Sort and filter", { exact: true }).click();
  await page.getByRole("button", { name: "Most played", exact: true }).click();
  await expect(page.locator(".track-row").first()).toContainText("Song 125");
  await page.getByLabel("Genre", { exact: true }).selectOption("rock");
  await expect(page.locator(".track-row")).toHaveCount(1);
});

test("near-bottom scrolling automatically loads one page per offset", async ({
  page,
}) => {
  await startClient(page);
  await page.locator(".browse-scroll").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    for (let i = 0; i < 20; i++) element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator(".track-row")).toHaveCount(100);
  await page.locator(".browse-scroll").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.locator(".track-row")).toHaveCount(150);
  expect(
    await page.evaluate(() =>
      (window as any).__clientTest.commands
        .filter(
          (entry: any) => entry.command === "browse" && entry.args.offset > 0,
        )
        .map((entry: any) => entry.args.offset),
    ),
  ).toEqual([50, 100]);
  await expect(
    page.getByRole("button", { name: "Load more songs" }),
  ).toHaveCount(0);
});

test("playlist toolbar stays above the track table", async ({ page }) => {
  await startClient(page);
  await page
    .getByRole("button", { name: "Liked Songs Playlist · Pinned" })
    .click();
  await expect(page.locator(".primary-play")).toBeVisible();
  await expect(page.locator(".browse-actions .track-table")).toHaveCount(0);
  const toolbar = await page.locator(".browse-actions").boundingBox();
  const rows = await page.locator(".track-row").first().boundingBox();
  expect(toolbar!.y + toolbar!.height).toBeLessThanOrEqual(rows!.y);
});

test("background-only vocals keep the main line anchored; long breaks show dots", async ({
  page,
}) => {
  await startClient(page);
  await page.getByTitle("Lyrics", { exact: true }).click();
  await page.evaluate((uri) => {
    const line = (
      text: string,
      start_ms: number,
      end_ms: number,
      background = false,
    ) => ({
      text,
      start_ms,
      end_ms,
      background,
      opposite: false,
      words: [],
      translation: "",
      romanization: "",
    });
    (window as any).__clientTest.emit({
      type: "lyrics",
      uri,
      lyrics: {
        source: "spicy_lyrics",
        synced: true,
        instrumental: false,
        attribution: {
          uploader: {
            id: "123456789012345678",
            username: "Uploader",
            url: "https://spicylyrics.org/uid/1",
          },
          maker: {
            id: "2",
            username: "Maker",
            url: "https://spicylyrics.org/uid/2",
          },
        },
        lines: [
          line("Main line", 1000, 3000),
          line("Background echo", 1800, 6000, true),
          line("Next main line", 10000, 12000),
        ],
      },
    });
    (window as any).__clientTest.emit({
      type: "native_position",
      uri,
      position_ms: 2500,
      observed_at: Date.now(),
      playing: false,
    });
  }, track.uri);
  await expect(page.locator(".lyrics-page .lyric-line.active")).toHaveCount(2);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const line = document
            .querySelector(".lyrics-page .lyric-line")!
            .getBoundingClientRect(),
          cover = document
            .querySelector(".lyrics-album>.cover")!
            .getBoundingClientRect();
        return Math.abs(
          line.top + line.height / 2 - cover.top - cover.height / 2,
        );
      }),
    )
    .toBeLessThan(0.5);
  const leadTop = await page
    .locator(".lyrics-page .lyric-line")
    .first()
    .evaluate((element) => element.getBoundingClientRect().top);
  await page.evaluate(
    (uri) =>
      (window as any).__clientTest.emit({
        type: "native_position",
        uri,
        position_ms: 4000,
        observed_at: Date.now(),
        playing: false,
      }),
    track.uri,
  );
  await expect(page.locator(".lyrics-page .lyric-line.active")).toHaveText(
    "Background echo",
  );
  await expect(
    page.getByRole("status", { name: "Instrumental break" }),
  ).toHaveCount(0);
  expect(
    await page
      .locator(".lyrics-page .lyric-line")
      .first()
      .evaluate((element) => element.getBoundingClientRect().top),
  ).toBeCloseTo(leadTop, 0);
  expect(
    await page
      .locator(".lyrics-page .lyric-wait")
      .first()
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBe(0);
  await page.evaluate(
    (uri) =>
      (window as any).__clientTest.emit({
        type: "native_position",
        uri,
        position_ms: 6500,
        observed_at: Date.now(),
        playing: false,
      }),
    track.uri,
  );
  await expect(
    page.getByRole("status", { name: "Instrumental break" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".lyrics-page .lyric-wait[aria-hidden='false']")
        .evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBeCloseTo(48, 0);
  await expect(
    page.locator(".lyrics-page .lyric-source.expanded"),
  ).toContainText("Spicy Lyrics");
  await expect(
    page.locator(".lyrics-page .lyric-source.expanded"),
  ).toContainText("Uploaded by @Uploader");
  await expect(
    page.locator(".lyrics-page .lyric-source.expanded"),
  ).toContainText("Made by @Maker");
  await page.route("https://spicylyrics.org/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Profile</h1>" }),
  );
  await page.getByRole("button", { name: "@Uploader", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__clientTest.commands.find(
            (call: any) => call.command === "open_creator_profile",
          )?.args,
      ),
    )
    .toEqual({ username: "Uploader", userId: "123456789012345678" });
  await expect(page.locator(".lyrics-album-name")).toHaveCount(0);
  expect(
    await page
      .locator(".lyrics-title")
      .evaluate((element) => getComputedStyle(element).textAlign),
  ).toBe("center");
});

test("lyrics wrap at narrow widths; countdown and unsung syllables follow song time", async ({
  page,
}) => {
  await startClient(page);
  await page.getByTitle("Lyrics", { exact: true }).click();
  await page.evaluate((uri) => {
    const line = (
      text: string,
      start_ms: number,
      end_ms: number,
      words: any[] = [],
    ) => ({
      text,
      start_ms,
      end_ms,
      words,
      background: false,
      opposite: false,
      translation: "",
      romanization: "",
    });
    const words = [
      { text: "Long", start_ms: 10000, end_ms: 11000 },
      {
        text: " multi-part-word-with-many-parts-and-a-long-ending",
        start_ms: 11000,
        end_ms: 12000,
      },
      {
        text: " and a whole phrase with spaces that must wrap when the panel is small",
        start_ms: 12000,
        end_ms: 14000,
      },
    ];
    (window as any).__clientTest.emit({
      type: "lyrics",
      uri,
      lyrics: {
        source: "Local TTML",
        synced: true,
        instrumental: false,
        lines: [
          line("Before", 0, 3000),
          line(words.map((word) => word.text).join(""), 10000, 14000, words),
        ],
      },
    });
    (window as any).__clientTest.emit({
      type: "native_position",
      uri,
      position_ms: 5000,
      observed_at: Date.now(),
      playing: false,
    });
  }, track.uri);
  const dots = page.locator(".lyric-wait i");
  await expect(dots).toHaveCount(3);
  const initial = await dots
    .first()
    .evaluate((element) => Number(getComputedStyle(element).opacity));
  await page.evaluate(
    (uri) =>
      (window as any).__clientTest.emit({
        type: "native_position",
        uri,
        position_ms: 7500,
        observed_at: Date.now(),
        playing: false,
      }),
    track.uri,
  );
  await expect
    .poll(() =>
      dots
        .first()
        .evaluate((element) => Number(getComputedStyle(element).opacity)),
    )
    .toBeGreaterThan(initial);
  for (const width of [1000, 1440, 2560]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page
          .locator(".lyric-line")
          .last()
          .evaluate((element) => element.scrollWidth - element.clientWidth),
      )
      .toBeLessThanOrEqual(2);
  }
  await page.evaluate(
    (uri) =>
      (window as any).__clientTest.emit({
        type: "native_position",
        uri,
        position_ms: 10001,
        observed_at: Date.now(),
        playing: false,
      }),
    track.uri,
  );
  // Unsung syllables carry no sung fill.
  expect(["", "-20%"]).toContain(
    await page
      .locator(".lyric-syllable")
      .last()
      .evaluate((element) =>
        element.style.getPropertyValue("--gradient-position"),
      ),
  );
  expect(
    await page
      .locator(".lyric-line.active")
      .evaluate((element) => getComputedStyle(element).transform),
  ).toBe("none");
});

test("seek drag released outside slider resumes the audio clock", async ({
  page,
}) => {
  await startClient(page);
  const slider = page.getByLabel("Seek position"),
    box = await slider.boundingBox();
  if (!box) throw Error("Missing seek slider");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y - 100);
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__clientTest.commands.filter(
            (call: any) =>
              call.command === "player" && call.args.request.command === "seek",
          ).length,
      ),
    )
    .toBeGreaterThan(0);
  await page.evaluate(
    (uri) =>
      (window as any).__clientTest.emit({
        type: "native_position",
        uri,
        position_ms: 62000,
        playing: false,
        observed_at: Date.now(),
        seeked: true,
      }),
    track.uri,
  );
  await expect(slider).toHaveValue("62000");
});
test("fullscreen moves lyrics right and Escape restores normal layout", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await startClient(page);
  await page.evaluate(
    (uri) =>
      (window as any).__clientTest.emit({
        type: "lyrics",
        uri,
        lyrics: {
          source: "Test",
          synced: true,
          instrumental: false,
          lines: [
            {
              text: "Main vocal",
              start_ms: 0,
              end_ms: 2000,
              words: [],
              background: false,
              opposite: false,
            },
            {
              text: "Duet vocal",
              start_ms: 2000,
              end_ms: 4000,
              words: [],
              background: false,
              opposite: true,
            },
          ],
        },
      }),
    track.uri,
  );
  await page.getByTitle("Lyrics", { exact: true }).click();
  await expect(page.locator(".lyrics-page .lyric-line.opposite")).toHaveCSS(
    "text-align",
    "right",
  );
  const flow = page.locator(".lyrics-page .lyric-scroll"),
    before = (await flow.boundingBox())!.x;
  await page
    .getByTitle(/screen/i)
    .first()
    .click();
  await expect(page.locator(".application")).toHaveClass(/immersive/);
  await expect
    .poll(() =>
      flow.evaluate((element) => {
        const root = element.closest(".lyrics-page")!.getBoundingClientRect();
        return (element.getBoundingClientRect().left - root.left) / root.width;
      }),
    )
    .toBeGreaterThan(0.5);
  await page.keyboard.press("Escape");
  await expect(page.locator(".application")).not.toHaveClass(/immersive/);
  await expect
    .poll(async () => Math.abs((await flow.boundingBox())!.x - before))
    .toBeLessThan(2);
});

test("song title resolves native album metadata before navigating", async ({
  page,
}) => {
  await startClient(page);
  await page.evaluate((track) => {
    const item = {
      ...track,
      album: { ...track.album, id: undefined, uri: undefined },
    };
    (window as any).__clientTest.emit({
      type: "playback",
      playback: {
        item,
        is_playing: false,
        progress_ms: 0,
        shuffle_state: false,
        repeat_state: "off",
        device: { name: "SpotiFlex", is_active: true },
      },
      observed_at: Date.now(),
      changed: true,
    });
  }, track);
  await page
    .locator("footer")
    .getByRole("button", { name: track.name, exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__clientTest.commands.find(
            (call: any) => call.command === "resolve_album",
          )?.args.uri,
      ),
    )
    .toBe(track.uri);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__clientTest.commands.some(
          (call: any) =>
            call.command === "browse" &&
            call.args.key === "album:abcdefghijklmnopqrstuv",
        ),
      ),
    )
    .toBe(true);
});

// Explicit track with 30 synced lines; the first line starts at 10 s.
async function playLyricTrack(page: Page, playing = true) {
  await page.evaluate((playing) => {
    const host = (window as any).__clientTest;
    host.emit({
      type: "library",
      playlists: Array.from({ length: 12 }, (_, index) => ({
        id: `${index}123456789abcdefghijk`.slice(0, 22),
        name: [
          "Certified Jammers",
          "Songs to be synced",
          "MY FAV GD SONGS",
          "The Scientist",
          "PARANOID",
          "CHING CHONG",
        ][index % 6],
        images: [{ url: "https://artwork.example.test/cover.svg" }],
        owner: { id: "x", display_name: "Stormanzani" },
        collaborative: false,
      })),
    });
    host.emit({
      type: "playback",
      changed: false,
      observed_at: Date.now(),
      playback: {
        is_playing: playing,
        progress_ms: 3000,
        shuffle_state: false,
        repeat_state: "off",
        device: {
          name: "SpotiFlex (test)",
          id: "local-device",
          is_active: true,
        },
        item: {
          id: "0123456789abcdefghijkl",
          uri: "spotify:track:0123456789abcdefghijkl",
          name: "Come & Go (with Marshmello)",
          explicit: true,
          artists: [
            { id: "a", name: "Juice WRLD" },
            { id: "b", name: "Marshmello" },
          ],
          album: {
            id: "0123456789abcdefghijkl",
            name: "Album",
            images: [{ url: "https://artwork.example.test/cover.svg" }],
          },
          duration_ms: 180000,
          is_local: false,
        },
      },
    });
    host.emit({
      type: "lyrics",
      uri: "spotify:track:0123456789abcdefghijkl",
      lyrics: {
        source: "Imported TTML",
        synced: true,
        instrumental: false,
        lines: Array.from({ length: 30 }, (_, index) => ({
          text: `I am just a lyric line number ${index + 1}`,
          start_ms: 10000 + index * 3000,
          end_ms: 13000 + index * 3000,
          translation: "",
          romanization: "",
          background: false,
          opposite: false,
          words: [],
        })),
      },
    });
  }, playing);
}
test("stacked lyrics centre the active line in the lyric view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 760 });
  await startClient(page);
  await playLyricTrack(page);
  await page.evaluate(() =>
    (window as any).__clientTest.emit({
      type: "native_position",
      uri: "spotify:track:0123456789abcdefghijkl",
      position_ms: 31_500,
      playing: true,
      observed_at: Date.now(),
    }),
  );
  await page.getByTitle("Lyrics", { exact: true }).click();
  const offset = () =>
    page.evaluate(() => {
      const view = document
        .querySelector(".lyrics-page .lyric-scroll")!
        .getBoundingClientRect();
      const line = document
        .querySelector(".lyrics-page .lyric-line.active")!
        .getBoundingClientRect();
      return Math.abs(
        line.top + line.height / 2 - (view.top + view.height / 2),
      );
    });
  await expect.poll(offset, { timeout: 5_000 }).toBeLessThan(4);
});

test("explicit badges centre on the capitals beside them", async ({ page }) => {
  await startClient(page);
  await playLyricTrack(page);
  const offsets = await page.evaluate(() =>
    [...document.querySelectorAll(".explicit-badge")].map((badge) => {
      const link = badge.parentElement!.querySelector(".artist-link")!;
      const marker = document.createElement("span");
      marker.style.cssText =
        "display:inline-block;width:0;height:0;vertical-align:baseline";
      link.after(marker);
      const baseline = marker.getBoundingClientRect().top;
      marker.remove();
      const context = document.createElement("canvas").getContext("2d")!;
      context.font = getComputedStyle(link).font;
      const cap = context.measureText("H").actualBoundingBoxAscent;
      const box = badge.getBoundingClientRect();
      return Math.abs((box.top + box.bottom) / 2 - baseline + cap / 2);
    }),
  );
  expect(offsets.length).toBeGreaterThan(1);
  for (const offset of offsets) expect(offset).toBeLessThan(1);
});

test("DJ lyrics show the DJ cover and explain missing lyrics", async ({
  page,
}) => {
  await startClient(page);
  await page.evaluate(() =>
    (window as any).__clientTest.emit({ type: "narration", active: true }),
  );
  await page.getByTitle("Lyrics", { exact: true }).click();
  const lyrics = page.locator(".lyrics-page.dj-view");
  await expect(lyrics.locator(".lyrics-album .dj-art img")).toBeVisible();
  await expect(lyrics.locator(".ambience")).toHaveCount(1);
  await expect(lyrics).toContainText(
    "Lyrics aren't available while the DJ talks",
  );
  await expect(page.locator(".now-playing.dj-view .dj-art img")).toBeVisible();
});

test("Now playing lyric dots stay inside the lyrics card", async ({ page }) => {
  await startClient(page);
  await playLyricTrack(page);
  const card = await page.locator(".lyric-preview").boundingBox();
  const dots = page.locator(
    ".lyric-preview .lyric-wait:not([aria-hidden=true]) i",
  );
  await expect(dots).toHaveCount(3);
  for (const dot of await dots.all()) {
    const box = (await dot.boundingBox())!;
    expect(box.x).toBeGreaterThan(card!.x + 8);
    expect(box.y).toBeGreaterThan(card!.y + 40);
  }
  expect(
    await page
      .locator(".lyric-preview .lyric-wait:not([aria-hidden=true])")
      .evaluate((row) => getComputedStyle(row).overflow),
  ).toBe("visible");
});

test("Now playing retains the lyrics ambience with Liquid Glass enabled", async ({
  page,
}) => {
  await startClient(page);
  await playLyricTrack(page);
  await openSettings(page);
  await page.getByLabel("Canvas in lyrics").uncheck();
  await page.getByRole("switch", { name: "Liquid Glass" }).check();
  await page.getByTitle("Lyrics", { exact: true }).click();
  await expect(
    page.locator(".lyrics-page > .ambience .ambient-layer"),
  ).toHaveCount(1);
  await expect(
    page.locator(".now-playing > .ambience .ambient-layer"),
  ).toHaveCount(1);
  await expect(
    page.locator(".now-playing > .ambience .ambient-layer"),
  ).toBeVisible();
  await openSettings(page);
  await page.getByRole("switch", { name: "Liquid Glass" }).uncheck();
  await page.getByTitle("Lyrics", { exact: true }).click();
  await expect(
    page.locator(".now-playing > .ambience .ambient-layer"),
  ).toHaveCount(1);
});

test("narrow Canvas lyrics stack the title above the lyrics", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1300, height: 820 });
  await startClient(page);
  await page.getByTitle("Lyrics", { exact: true }).click();
  await page.locator(".file-input").setInputFiles({
    name: "timing.ttml",
    mimeType: "application/xml",
    buffer: Buffer.from("<tt/>"),
  });
  await emitCanvas(page);
  await expect(page.locator(".lyrics-page.narrow.canvas-lyrics")).toBeVisible();
  await expect(page.locator(".lyrics-canvas-cover video")).toBeVisible();
  const cover = (await page.locator(".lyrics-canvas-cover").boundingBox())!;
  expect(cover.width).toBeCloseTo(56, 0);
  const artists = (await page
    .locator(".lyrics-page .lyrics-artists")
    .boundingBox())!;
  const lyrics = (await page
    .locator(".lyrics-page .lyric-scroll")
    .boundingBox())!;
  expect(artists.y + artists.height).toBeLessThanOrEqual(lyrics.y + 1);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const view = document
            .querySelector(".lyrics-page .lyric-scroll")!
            .getBoundingClientRect();
          const line = document
            .querySelector(".lyrics-page .lyric-line.active")!
            .getBoundingClientRect();
          return Math.abs(
            line.top + line.height / 2 - (view.top + view.height / 2),
          );
        }),
      { timeout: 5_000 },
    )
    .toBeLessThan(4);
  await page.screenshot({ path: "target/diagnostics/canvas-narrow.png" });
});

test("compact lyrics centre the title and artists against cover and Canvas thumbnails", async ({
  page,
}) => {
  await startClient(page);
  await page.getByTitle("Lyrics", { exact: true }).click();
  await page
    .getByRole("toolbar", { name: "Lyrics" })
    .getByTitle("Compact lyrics", { exact: true })
    .click();
  const alignment = () =>
    page.evaluate(() => {
      const root = document.querySelector(".lyrics-page")!;
      const cover = root
        .querySelector(".lyrics-album > .cover")!
        .getBoundingClientRect();
      const title = root
        .querySelector(".lyrics-title")!
        .getBoundingClientRect();
      const artists = root
        .querySelector(".lyrics-artists")!
        .getBoundingClientRect();
      return Math.abs(
        (title.top + artists.bottom) / 2 - (cover.top + cover.bottom) / 2,
      );
    });
  await expect.poll(alignment).toBeLessThan(1);
  await emitCanvas(page);
  await expect(page.locator(".lyrics-canvas-cover video")).toBeVisible();
  await expect.poll(alignment).toBeLessThan(1);
});

test("unsung split words keep their syllables together", async ({ page }) => {
  await startClient(page);
  await page.getByTitle("Lyrics", { exact: true }).click();
  await page.evaluate((uri) => {
    const line = (start: number, words: [string, number, number][]) => ({
      text: words.map(([text]) => text).join(""),
      start_ms: start,
      end_ms: words.at(-1)![2],
      translation: "",
      romanization: "",
      background: false,
      opposite: false,
      words: words.map(([text, start_ms, end_ms]) => ({
        text,
        start_ms,
        end_ms,
      })),
    });
    const host = (window as any).__clientTest;
    host.emit({
      type: "lyrics",
      uri,
      lyrics: {
        source: "Imported TTML",
        synced: true,
        instrumental: false,
        lines: [
          line(1000, [["Ladies", 1000, 1600]]),
          line(5000, [
            ["gen", 5000, 5300],
            ["tle", 5300, 5600],
            ["men", 5600, 6600],
          ]),
        ],
      },
    });
    host.emit({
      type: "native_position",
      uri,
      position_ms: 1200,
      playing: false,
      observed_at: Date.now(),
    });
  }, track.uri);
  const pieces = page.locator(".lyrics-page .lyric-line").nth(1);
  await expect(pieces.locator(".lyric-syllable")).toHaveCount(3);
  const boxes = await pieces
    .locator(".lyric-syllable")
    .evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().toJSON()),
    );
  for (let index = 1; index < boxes.length; index++)
    expect(Math.abs(boxes[index].left - boxes[index - 1].right)).toBeLessThan(
      0.5,
    );
  // Lines not yet reached rest at full size, so they share the left margin.
  const lefts = await page
    .locator(".lyrics-page .lyric-line .lyric-main")
    .evaluateAll((elements) =>
      elements.map(
        (element) =>
          element.querySelector(".lyric-syllable")!.getBoundingClientRect()
            .left,
      ),
    );
  expect(Math.abs(lefts[0] - lefts[1])).toBeLessThan(0.5);
  // While the word is sung, one piece pops as the next rests small; no seam
  // opens between them.
  await page.evaluate(
    (uri) =>
      (window as any).__clientTest.emit({
        type: "native_position",
        uri,
        position_ms: 5150,
        playing: false,
        observed_at: Date.now(),
      }),
    track.uri,
  );
  await expect(pieces).toHaveClass(/active/);
  await page.waitForTimeout(400);
  const sung = await pieces
    .locator(".lyric-syllable")
    .evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().toJSON()),
    );
  for (let index = 1; index < sung.length; index++)
    expect(Math.abs(sung[index].left - sung[index - 1].right)).toBeLessThan(
      0.5,
    );
});

test("restarting a song slides lyrics back to the start instead of crawling", async ({
  page,
}) => {
  await startClient(page);
  await page.getByTitle("Lyrics", { exact: true }).click();
  await page.locator(".file-input").setInputFiles({
    name: "timing.ttml",
    mimeType: "application/xml",
    buffer: Buffer.from(
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0s" end="2s">Test</p></div></body></tt>',
    ),
  });
  await expect(page.locator(".lyrics-page .lyric-line")).toHaveCount(80);
  const seek = (position: number) =>
    page.evaluate(
      ({ uri, position }) =>
        (window as any).__clientTest.emit({
          type: "native_position",
          uri,
          position_ms: position,
          playing: false,
          seeked: true,
          observed_at: Date.now(),
        }),
      { uri: track.uri, position },
    );
  const scrollTop = () =>
    page
      .locator(".lyrics-page .lyric-scroll")
      .evaluate((element) => element.scrollTop);
  await seek(150_500);
  await expect.poll(scrollTop).toBeGreaterThan(1000);
  await page.waitForTimeout(1500);
  await seek(500);
  await expect(page.locator(".lyrics-page .lyric-line.active")).toHaveText(
    "Test lyric line 1",
  );
  // It slides rather than snapping, and arrives within the short glide.
  const before = await scrollTop();
  await page.waitForTimeout(250);
  const midway = await scrollTop();
  expect(midway).toBeGreaterThan(50);
  expect(midway).toBeLessThan(before);
  await expect.poll(scrollTop, { timeout: 900 }).toBeLessThan(50);
});

test("clicking a lyric seeks once and leaves Space for play and pause", async ({
  page,
}) => {
  await startClient(page);
  await page.getByTitle("Lyrics", { exact: true }).click();
  await page.locator(".file-input").setInputFiles({
    name: "timing.ttml",
    mimeType: "application/xml",
    buffer: Buffer.from(
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0s" end="2s">Test</p></div></body></tt>',
    ),
  });
  const requests = () =>
    page.evaluate((): string[] =>
      (window as any).__clientTest.commands
        .filter((call: any) => call.command === "player")
        .map((call: any) => call.args.request.command),
    );
  await page.locator(".lyrics-page .lyric-line").nth(3).click();
  await expect.poll(requests).toContain("seek");
  const seeks = (await requests()).filter((name) => name === "seek").length;
  expect(
    await page.evaluate(() =>
      document.activeElement?.classList.contains("lyric-line"),
    ),
  ).toBe(false);
  await page.keyboard.press("Space");
  await expect
    .poll(async () => (await requests()).at(-1))
    .toMatch(/^(play|pause)$/);
  expect((await requests()).filter((name) => name === "seek")).toHaveLength(
    seeks,
  );
});

test("taskbar and media keys drive playback and see what is playing", async ({
  page,
}) => {
  await startClient(page);
  const commands = () =>
    page.evaluate((): { command: string; args: any }[] =>
      (window as any).__clientTest.commands.map((call: any) => ({
        command: call.command,
        args: call.args,
      })),
    );
  await expect
    .poll(async () =>
      (await commands())
        .filter((call) => call.command === "media_state")
        .map((call) => call.args.state.title),
    )
    .toContain("Timing test");
  const press = (action: string, position_ms?: number) =>
    page.evaluate(
      ({ action, position_ms }) =>
        (window as any).__clientTest.emit({
          type: "media_control",
          action,
          position_ms,
        }),
      { action, position_ms },
    );
  const requests = async () =>
    (await commands())
      .filter((call) => call.command === "player")
      .map((call) => call.args.request);
  await press("next");
  await expect
    .poll(async () => (await requests()).at(-1)?.command)
    .toBe("next");
  await press("toggle");
  await expect
    .poll(async () => (await requests()).at(-1)?.command)
    .toMatch(/^(play|pause)$/);
  await press("seek", 42_000);
  await expect
    .poll(async () => (await requests()).at(-1))
    .toMatchObject({
      command: "seek",
      positionMs: 42_000,
    });
});

test("home quick tiles keep small square covers with a centred heart", async ({
  page,
}) => {
  await startClient(page, "home");
  const layout = await page.locator(".home-quick-links").evaluate((root) => {
    const box = (selector: string) =>
      root.querySelector(selector)!.getBoundingClientRect();
    const tiles = [...root.querySelectorAll(".quick-tile")].map(
      (tile) => tile.getBoundingClientRect().height,
    );
    const cover = box(".liked-cover"),
      heart = box(".liked-cover svg"),
      dj = box(".dj-cover");
    return {
      tiles,
      dj: [dj.width, dj.height],
      offset: [
        heart.left + heart.width / 2 - (cover.left + cover.width / 2),
        heart.top + heart.height / 2 - (cover.top + cover.height / 2),
      ],
    };
  });
  for (const height of layout.tiles) expect(height).toBeCloseTo(72, 0);
  expect(layout.dj).toEqual([72, 72]);
  for (const offset of layout.offset) expect(Math.abs(offset)).toBeLessThan(1);
});

test("the queue opens in the right panel in place of Now playing", async ({
  page,
}) => {
  await startClient(page);
  await page.evaluate((track) => {
    (window as any).__clientTest.emit({
      type: "playing_details",
      uri: track.uri,
      details: {
        artists: track.artists,
        queue: [
          { ...track, uri: "spotify:track:upnext", name: "Up next song" },
        ],
      },
    });
  }, track);
  const rows = await page.locator(".track-row").count();
  await page
    .locator(".player-bar")
    .getByRole("button", { name: "Queue", exact: true })
    .click();
  const panel = page.locator(".queue-panel");
  await expect(panel).toBeVisible();
  await expect(page.locator(".now-playing:not(.queue-panel)")).toHaveCount(0);
  await expect(panel).toContainText("Up next song");
  await expect(panel).toContainText("Timing test");
  // The main area keeps its page.
  await expect(page.locator(".track-row")).toHaveCount(rows);
  await panel.getByText("Up next song").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__clientTest.commands
            .filter((call: any) => call.command === "player")
            .at(-1)?.args.request.uri,
      ),
    )
    .toBe("spotify:track:upnext");
  await page
    .locator(".player-bar")
    .getByRole("button", { name: "Queue", exact: true })
    .click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator(".now-playing")).toBeVisible();
});

test("the app dims while a creator profile sheet is open", async ({ page }) => {
  await startClient(page);
  const emit = (open: boolean) =>
    page.evaluate(
      (open) =>
        (window as any).__clientTest.emit({ type: "creator_profile", open }),
      open,
    );
  await emit(true);
  await expect(page.locator(".creator-profile-dim")).toBeVisible();
  await emit(false);
  await expect(page.locator(".creator-profile-dim")).toHaveCount(0);
});

test("a left click anywhere outside the song menu closes it", async ({
  page,
}) => {
  await startClient(page);
  for (const outside of [".player-bar", ".track-row >> nth=5"]) {
    await page
      .locator(".track-row .track-name")
      .first()
      .click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    const box = (await page.locator(outside).boundingBox())!;
    await page.mouse.click(box.x + 8, box.y + box.height / 2);
    await expect(page.getByRole("menu")).toHaveCount(0);
  }
});

test("the avatar menu opens settings, profile and grouped recents", async ({
  page,
}) => {
  await startClient(page);
  const menu = () =>
    page.getByRole("button", { name: "Account menu", exact: true });
  await menu().click();
  await expect(page.getByRole("menu", { name: "Account" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Account" })).toHaveCount(0);

  await menu().click();
  await page.getByRole("menuitem", { name: "Profile" }).click();
  await expect(page.locator(".profile-hero .eyebrow")).toHaveText("Profile");

  await menu().click();
  await page.getByRole("menuitem", { name: "Recents" }).click();
  const request = await page.evaluate(() =>
    (window as any).__clientTest.commands
      .filter((entry: any) => entry.command === "browse")
      .at(-1),
  );
  expect(request.args.key).toBe("recent");
  await page.evaluate((generation) => {
    const now = Date.now();
    const base = {
      artists: [{ id: "artistartistartistarti", name: "Artist" }],
      album: { name: "Record", images: [] },
      duration_ms: 1000,
      is_local: false,
    };
    (window as any).__clientTest.emit({
      type: "tracks",
      key: "recent",
      generation,
      offset: 0,
      more: false,
      tracks: [
        {
          ...base,
          uri: "spotify:track:one",
          name: "One",
          added_at: new Date(now - 60_000).toISOString(),
          played_context: "spotify:album:abcdefghijklmnopqrstuv",
        },
        {
          ...base,
          uri: "spotify:track:two",
          name: "Two",
          added_at: new Date(now - 120_000).toISOString(),
          played_context: "spotify:album:abcdefghijklmnopqrstuv",
        },
      ],
    });
  }, request.args.generation);
  await expect(page.locator(".recents-day h2").first()).toHaveText("Today");
  await expect(page.locator(".recents-group")).toHaveCount(1);
  await expect(page.locator(".recents-group")).toContainText("2 songs played");
  await page.getByTitle("Show songs").click();
  await expect(page.locator(".recents-tracks li")).toHaveCount(2);
});

test("Liquid Glass is off by default and toggles from Settings", async ({
  page,
}) => {
  await startClient(page);
  await expect(page.locator(".application")).not.toHaveClass(/liquid-glass/);
  await openSettings(page);
  await page.getByRole("switch", { name: "Liquid Glass" }).check();
  await expect(page.locator(".application")).toHaveClass(/liquid-glass/);
  await expect(page.locator(".glass-backdrop")).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__clientTest.commands
            .filter((entry: any) => entry.command === "save_settings")
            .at(-1)?.args.settings.liquid_glass,
      ),
    )
    .toBe(true);
  await page.getByTitle("Search settings", { exact: true }).click();
  await page.getByLabel("Search settings").fill("glass");
  await expect(page.locator(".setting-row")).toHaveCount(1);
  await page.getByLabel("Search settings").fill("zzzz");
  await expect(page.locator(".settings-empty")).toBeVisible();
});

test("Space Gravity waiting dots share the normal countdown and drift with words", async ({
  page,
}) => {
  await startClient(page);
  await page.getByTitle("Lyrics", { exact: true }).click();
  await page.evaluate((uri) => {
    const line = (text: string, start_ms: number, end_ms: number) => ({
      text,
      start_ms,
      end_ms,
      words: [{ text, start_ms, end_ms }],
      background: false,
      opposite: false,
      translation: "",
      romanization: "",
    });
    (window as any).__clientTest.emit({
      type: "lyrics",
      uri,
      lyrics: {
        source: "Imported TTML",
        synced: true,
        instrumental: false,
        lines: [line("Before", 0, 1000), line("After", 10000, 12000)],
      },
    });
  }, track.uri);
  const position = async (position_ms: number, playing = false) =>
    page.evaluate(
      async ({ uri, position_ms, playing }) => {
        (window as any).__clientTest.emit({
          type: "native_position",
          uri,
          position_ms,
          playing,
          observed_at: Date.now(),
        });
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      },
      { uri: track.uri, position_ms, playing },
    );
  const dots = () =>
    page
      .locator(".lyrics-page .lyric-wait:not([aria-hidden=true]) i")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          opacity: getComputedStyle(node).opacity,
          transform: getComputedStyle(node).transform,
        })),
      );
  const normal = new Map<number, Awaited<ReturnType<typeof dots>>>();
  for (const time of [2000, 6500, 9500]) {
    await position(time);
    normal.set(time, await dots());
  }
  await openSettings(page);
  await page.getByLabel("Canvas in lyrics").uncheck();
  await page.getByLabel("Space Gravity").check();
  await page.getByTitle("Lyrics", { exact: true }).click();
  const waiting = page.locator(".gravity-wait");
  await expect(waiting.locator("i")).toHaveCount(3);
  for (const [time, expected] of normal) {
    await position(time);
    await expect.poll(dots).toEqual(expected);
  }
  await position(6500, true);
  const sample = () =>
    waiting.evaluate((node) => (node as HTMLElement).style.transform);
  await expect.poll(sample).toContain("translate3d");
  const samples = [await sample()];
  for (let index = 0; index < 3; index += 1) {
    await page.waitForTimeout(250);
    samples.push(await sample());
  }
  expect(new Set(samples).size).toBeGreaterThan(2);
  await position(10000);
  await expect(waiting).toHaveCount(0);
  await position(6500);
  await expect(waiting.locator("i")).toHaveCount(3);
  await expect.poll(dots).toEqual(normal.get(6500));
  await expect.poll(sample).toContain("translate3d");
});

test("Space Gravity shares normal syllable joins and held-letter timing", async ({
  page,
}) => {
  await startClient(page);
  await page.getByTitle("Lyrics", { exact: true }).click();
  await page.evaluate((uri) => {
    const host = (window as any).__clientTest;
    host.emit({
      type: "lyrics",
      uri,
      lyrics: {
        source: "Imported TTML",
        synced: true,
        instrumental: false,
        lines: [
          {
            text: "Hello na-na-na",
            start_ms: 1000,
            end_ms: 5700,
            translation: "",
            romanization: "",
            background: false,
            opposite: false,
            words: [
              { text: "Hel", start_ms: 1000, end_ms: 1300 },
              { text: "lo", start_ms: 1300, end_ms: 3300 },
              { text: " na-na-na", start_ms: 3300, end_ms: 5700 },
            ],
          },
        ],
      },
    });
    host.emit({
      type: "native_position",
      uri,
      position_ms: 3500,
      playing: false,
      observed_at: Date.now(),
    });
  }, track.uri);
  const letters = page.locator(".lyrics-page .lyric-letter");
  await expect(letters).toHaveCount(10);
  const fills = () =>
    letters.evaluateAll((nodes) =>
      nodes.map((node) =>
        (node as HTMLElement).style.getPropertyValue("--gradient-position"),
      ),
    );
  await expect.poll(async () => (await fills()).every(Boolean)).toBe(true);
  const position = async (position_ms: number) =>
    page.evaluate(
      async ({ uri, position_ms }) => {
        (window as any).__clientTest.emit({
          type: "native_position",
          uri,
          position_ms,
          playing: false,
          observed_at: Date.now(),
        });
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      },
      { uri: track.uri, position_ms },
    );
  const normalFills = new Map<number, string[]>();
  for (const time of [1200, 3500, 4900]) {
    await position(time);
    normalFills.set(time, await fills());
  }
  await openSettings(page);
  await page.getByLabel("Canvas in lyrics").uncheck();
  await page.getByLabel("Space Gravity").check();
  await page.getByTitle("Lyrics", { exact: true }).click();
  await expect(page.locator(".gravity-word")).toHaveCount(4);
  await expect(letters).toHaveCount(10);
  for (const [time, expected] of normalFills) {
    await position(time);
    await expect.poll(fills).toEqual(expected);
  }
  await expect(page.locator(".gravity-word.singing")).toHaveCount(1);
  await expect
    .poll(() =>
      page
        .locator(".gravity-word.current:not(.singing)")
        .first()
        .evaluate((node) => Number(getComputedStyle(node).opacity)),
    )
    .toBeCloseTo(0.55, 2);
  await expect(page.locator(".gravity-word .joined-start")).toHaveText("Hel");
  await expect(page.locator(".gravity-word .joined-end")).toHaveText("lo");
  await expect
    .poll(() =>
      letters
        .nth(2)
        .evaluate((node) =>
          (node as HTMLElement).style.getPropertyValue("--glow"),
        ),
    )
    .not.toBe("");
});

test("Space Gravity words keep drifting while the song plays", async ({
  page,
}) => {
  await startClient(page);
  await openSettings(page);
  await page.getByLabel("Canvas in lyrics").uncheck();
  await page.getByLabel("Space Gravity").check();
  await page.getByTitle("Lyrics", { exact: true }).click();
  await page.locator(".file-input").setInputFiles({
    name: "timing.ttml",
    mimeType: "application/xml",
    buffer: Buffer.from("<tt/>"),
  });
  await page.evaluate(
    ({ track, base }) => {
      (window as any).__clientTest.emit({
        type: "playback",
        playback: {
          ...base,
          item: track,
          is_playing: true,
          progress_ms: 40_000,
          device: { name: "SpotiFlex", is_active: true },
        },
        observed_at: Date.now(),
        changed: false,
      });
    },
    { track, base: emptyState.playback },
  );
  const word = page.locator(".gravity-word:not(.exiting)").first();
  await expect(word).toBeVisible();
  const key = await word.textContent();
  const sample = () =>
    page
      .locator(".gravity-word:not(.exiting)", { hasText: key! })
      .first()
      .evaluate((element) => (element as HTMLElement).style.transform);
  await page.waitForTimeout(300);
  const samples = [await sample()];
  for (let index = 0; index < 3; index += 1) {
    await page.waitForTimeout(250);
    samples.push(await sample());
  }
  // Re-rendering every frame must not respawn words at their start point.
  expect(new Set(samples).size).toBeGreaterThan(2);
  // Exactly one word is marked as being sung.
  await expect(page.locator(".gravity-word.singing")).toHaveCount(1);
  // Its fill sweeps smoothly like the normal lyrics view.
  const fill = () =>
    page
      .locator(".gravity-word.singing .lyric-syllable")
      .first()
      .evaluate((element) =>
        parseFloat(
          (element as HTMLElement).style.getPropertyValue(
            "--gradient-position",
          ),
        ),
      );
  const first = await fill();
  await page.waitForTimeout(250);
  expect(await fill()).toBeGreaterThan(first);
});

test("Space plays and pauses after clicking any button, but not while searching", async ({
  page,
}) => {
  await startClient(page);
  const requests = () =>
    page.evaluate((): string[] =>
      (window as any).__clientTest.commands
        .filter((call: any) => call.command === "player")
        .map((call: any) => call.args.request.command),
    );
  for (const title of ["Lyrics", "Queue", "Lyrics"]) {
    await page.locator("footer").getByTitle(title, { exact: true }).click();
    const before = (await requests()).length;
    await page.keyboard.press("Space");
    await expect.poll(async () => (await requests()).length).toBe(before + 1);
    expect((await requests()).at(-1)).toMatch(/^(play|pause)$/);
  }
  // Space on a focused button must not also press that button.
  const lyricsOpen = await page.locator(".lyrics-page").count();
  await page.locator("footer").getByTitle("Lyrics", { exact: true }).focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(100);
  expect(await page.locator(".lyrics-page").count()).toBe(lyricsOpen);
  const before = (await requests()).length;
  await page.getByPlaceholder("What do you want to play?").click();
  await page.keyboard.press("Space");
  await page.waitForTimeout(100);
  expect((await requests()).length).toBe(before);
});

test("clicking outside the device popup closes it", async ({ page }) => {
  await startClient(page);
  const devices = page.locator("footer").getByTitle("Devices", { exact: true });
  await devices.click();
  await expect(page.locator(".device-menu")).toBeVisible();
  await page.locator(".device-menu h3").click();
  await expect(page.locator(".device-menu")).toBeVisible();
  await page.locator(".center-panel").click({ position: { x: 40, y: 200 } });
  await expect(page.locator(".device-menu")).toHaveCount(0);
  await devices.click();
  await devices.click();
  await expect(page.locator(".device-menu")).toHaveCount(0);
});

test("romanization replaces non-Latin lyrics in normal, floating and preview views", async ({
  page,
}) => {
  await startClient(page);
  await page.getByTitle("Lyrics", { exact: true }).click();
  const romanization = page
    .getByRole("toolbar", { name: "Lyrics" })
    .getByTitle("Romanization", { exact: true });
  await romanization.click();
  const samples = [
    ["안녕하세요", "", "annyeonghaseyo"],
    ["Привет", "", "Privet"],
    ["مرحبا", "", "mrHb"],
    ["你好", "", "Ni Hao"],
    ["東京", "Tokyo", "Tokyo"],
  ];
  const emit = async (text: string, reading: string) => {
    await page.evaluate(
      ({ uri, text, reading }) => {
        (window as any).__clientTest.emit({
          type: "lyrics",
          uri,
          lyrics: {
            source: "Test",
            synced: true,
            instrumental: false,
            lines: [
              {
                text,
                romanization: reading,
                translation: "",
                start_ms: 1000,
                end_ms: 3000,
                words: [{ text, start_ms: 1000, end_ms: 3000 }],
                background: false,
                opposite: false,
              },
            ],
          },
        });
        (window as any).__clientTest.emit({
          type: "native_position",
          uri,
          position_ms: 1500,
          playing: false,
          observed_at: Date.now(),
        });
      },
      { uri: track.uri, text, reading },
    );
  };
  for (const [text, reading, expected] of samples) {
    await emit(text, reading);
    await expect(page.locator(".lyrics-page .lyric-main")).toHaveText(expected);
  }
  await romanization.click();
  await expect(page.locator(".lyrics-page .lyric-main")).toHaveText("東京");
  await romanization.click();
  await openSettings(page);
  await page.getByLabel("Space Gravity").check();
  await page.getByTitle("Lyrics", { exact: true }).click();
  for (const [text, reading, expected] of samples) {
    await emit(text, reading);
    await expect(page.locator(".gravity-word:not(.exiting)")).toHaveText([
      expected,
    ]);
  }
  await page.locator("footer").getByTitle("Lyrics", { exact: true }).click();
  await expect(page.locator(".lyric-preview .lyric-main")).toHaveText("Tokyo");
});

test("lyrics toolbar toggles romanization, word sync and layout", async ({
  page,
}) => {
  await startClient(page);
  await page.getByTitle("Lyrics", { exact: true }).click();
  const toolbar = page.getByRole("toolbar", { name: "Lyrics" });
  await expect(toolbar.getByTitle("Close lyrics")).toHaveCount(0);
  const saved = (key: string) =>
    page.evaluate(
      (key) =>
        (window as any).__clientTest.commands
          .filter((entry: any) => entry.command === "save_settings")
          .at(-1)?.args.settings[key],
      key,
    );
  for (const [title, key] of [
    ["Romanization", "romanized"],
    ["Experimental word sync", "experimental_word_sync"],
  ]) {
    const button = toolbar.getByTitle(title, { exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => saved(key)).toBe(true);
  }
  await toolbar.getByTitle("Hide artwork", { exact: true }).click();
  await expect(page.locator(".lyrics-page")).toHaveClass(/no-artwork/);
  await expect(page.locator(".lyrics-album")).toBeHidden();
  await toolbar.getByTitle("Hide artwork", { exact: true }).click();
  await toolbar.getByTitle("Artwork on the right", { exact: true }).click();
  // Side-by-side layouts put the artwork after the lyrics.
  await expect(page.locator(".lyrics-page")).toHaveClass(/artwork-right/);
  await toolbar.getByTitle("Compact lyrics", { exact: true }).click();
  await expect(page.locator(".lyrics-page")).toHaveClass(/narrow/);
  await toolbar.getByTitle("Lyrics settings", { exact: true }).click();
  await expect(page.locator(".settings-page")).toBeVisible();
});

test("flat paragraph lyrics gain estimated word timing and revert when disabled", async ({
  page,
}) => {
  await startClient(page);
  await page.getByTitle("Lyrics", { exact: true }).click();
  const text = "Hello there. Come back tonight! Stay with me.";
  await page.evaluate(
    ({ uri, text }) => {
      (window as any).__clientTest.emit({
        type: "lyrics",
        uri,
        lyrics: {
          source: "test",
          synced: false,
          instrumental: false,
          lines: [
            {
              text,
              start_ms: 0,
              end_ms: 180000,
              words: [],
              translation: "",
              romanization: "",
              background: false,
              opposite: false,
            },
          ],
        },
      });
    },
    { uri: track.uri, text },
  );
  await expect(page.locator(".lyrics-page .lyrics-display")).toHaveClass(
    /static-lyrics/,
  );
  const button = page
    .getByRole("toolbar", { name: "Lyrics" })
    .getByTitle("Experimental word sync", { exact: true });
  await button.click();
  await expect(page.locator(".lyrics-page .lyrics-display")).not.toHaveClass(
    /static-lyrics/,
  );
  await expect(page.locator(".lyrics-page .lyric-main")).toHaveCount(3);
  await expect(page.locator(".lyrics-page .lyric-source")).toContainText(
    "estimated line and word timing",
  );
  await expect(page.locator(".lyrics-page .lyric-word").first()).toBeVisible();
  await button.click();
  await expect(page.locator(".lyrics-page .lyrics-display")).toHaveClass(
    /static-lyrics/,
  );
  await expect(page.locator(".lyrics-page .lyric-main")).toHaveText(text);
});

test("Spotify search shows public and curated playlist cards with open and play actions", async ({
  page,
}) => {
  await startClient(page);
  const search = page.getByRole("textbox", {
    name: "Search Spotify",
    exact: true,
  });
  await search.fill("workout");
  await search.press("Enter");
  await page.waitForFunction(() =>
    (window as any).__clientTest.commands.some(
      (entry: any) =>
        entry.command === "browse" && entry.args.key === "search:workout",
    ),
  );
  await page.evaluate(() => {
    const host = (window as any).__clientTest;
    const request = host.commands
      .filter(
        (entry: any) =>
          entry.command === "browse" && entry.args.key === "search:workout",
      )
      .at(-1).args;
    host.emit({
      type: "search_playlists",
      account: "test-user",
      key: request.key,
      generation: request.generation,
      message: "",
      playlists: [
        {
          id: "0123456789abcdefghijkl",
          name: "Public Workout",
          images: [],
          owner: { id: "listener", display_name: "Playlist creator" },
          collaborative: false,
        },
        {
          id: "1123456789abcdefghijkl",
          name: "Curated Workout",
          images: [],
          owner: { id: "spotify", display_name: "Spotify" },
          collaborative: false,
        },
      ],
    });
  });
  const shelf = page.getByRole("region", { name: "Playlists", exact: true });
  await expect(
    shelf.getByRole("button", { name: "Open Public Workout", exact: true }),
  ).toBeVisible();
  await expect(shelf).toContainText("By Spotify");
  await expect(
    page.getByRole("heading", { name: "Songs", exact: true }),
  ).toBeVisible();
  await shelf
    .getByRole("button", { name: "Play Curated Workout", exact: true })
    .click();
  const playback = await page.evaluate(
    () =>
      (window as any).__clientTest.commands
        .filter((entry: any) => entry.command === "player")
        .at(-1).args.request,
  );
  expect(playback).toMatchObject({
    command: "play_home",
    context: "spotify:playlist:1123456789abcdefghijkl",
  });
  await shelf
    .getByRole("button", { name: "Open Public Workout", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__clientTest.commands
            .filter((entry: any) => entry.command === "browse")
            .at(-1).args.key,
      ),
    )
    .toBe("playlist:0123456789abcdefghijkl");
  await expect(page.locator(".search-playlists")).toHaveCount(0);
});

test("playlist-only search results stay visible when songs are empty or playlists need retry", async ({
  page,
}) => {
  await startClient(page);
  const search = page.getByRole("textbox", {
    name: "Search Spotify",
    exact: true,
  });
  await search.fill("chill");
  await search.press("Enter");
  await expect(
    page.getByRole("tablist", { name: "Search categories" }),
  ).toBeVisible();
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const host = (window as any).__clientTest;
    const request = host.commands
      .filter(
        (entry: any) =>
          entry.command === "browse" && entry.args.key === "search:chill",
      )
      .at(-1).args;
    host.emit({
      type: "tracks",
      ...request,
      offset: 0,
      tracks: [],
      more: false,
    });
    host.emit({
      type: "search_playlists",
      account: "test-user",
      key: request.key,
      generation: request.generation,
      message: "Some Spotify-curated playlists may be unavailable.",
      playlists: [
        {
          id: "0123456789abcdefghijkl",
          name: "Chill playlist",
          images: [],
          owner: { id: "listener" },
          collaborative: false,
        },
      ],
    });
  });
  await expect(
    page.getByRole("button", { name: "Open Chill playlist", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No songs found" }),
  ).toHaveCount(0);
  await expect(page.locator(".search-page")).toContainText(
    "Some Spotify-curated playlists may be unavailable.",
  );
});

test("search matches compact Spotify layout and music category filters stay functional", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await startClient(page);
  const search = page.getByRole("textbox", {
    name: "Search Spotify",
    exact: true,
  });
  await search.fill("arianna");
  await search.press("Enter");
  const results = page.getByRole("region", {
    name: "Search results for arianna",
    exact: true,
  });
  await expect(results.locator(".search-top-result")).toBeVisible();
  await expect(results.getByRole("tab")).toHaveText([
    "All",
    "Songs",
    "Artists",
    "Playlists",
    "Albums",
  ]);
  await expect(page.locator(".page-hero")).toHaveCount(0);
  expect(
    await results
      .locator(".search-top-result")
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBeLessThan(110);
  await page.screenshot({ path: "test-results/search-wide.png" });
  await results.getByRole("tab", { name: "Songs", exact: true }).click();
  await expect(results.locator(".search-result-row")).toHaveCount(20);
  await expect(results.locator(".home-shelf")).toHaveCount(0);
  await results
    .getByRole("button", { name: "Save Song 1 to Liked Songs", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__clientTest.commands
            .filter((entry: any) => entry.command === "save_item")
            .at(-1)?.args,
      ),
    )
    .toMatchObject({
      uri: "spotify:track:0000000000000000000001",
      saved: true,
    });
  await results
    .locator(".search-result-row")
    .first()
    .click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Song actions" })).toBeVisible();
  await page.keyboard.press("Escape");
  await results.getByRole("tab", { name: "Artists", exact: true }).click();
  await expect(
    results.getByRole("region", { name: "Artists", exact: true }),
  ).toBeVisible();
  await expect(results.locator(".home-shelf-items")).toHaveClass(/expanded/);
  await results.getByRole("tab", { name: "Playlists", exact: true }).click();
  await expect(
    results.getByRole("heading", { name: "No playlists found", exact: true }),
  ).toBeVisible();
  await results.getByRole("tab", { name: "Albums", exact: true }).click();
  await expect(
    results.getByRole("region", { name: "Albums", exact: true }),
  ).toBeVisible();
  await results
    .getByRole("button", { name: "Open Test album", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Test album",
  );
});

test("compact search fits narrow panels, supports keyboard filters and resets for another query", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await startClient(page);
  const search = page.getByRole("textbox", {
    name: "Search Spotify",
    exact: true,
  });
  await search.fill("first");
  await search.press("Enter");
  await expect(page.locator(".search-top-result")).toBeVisible();
  const all = page.getByRole("tab", { name: "All", exact: true });
  await all.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Songs", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const fits = await page.locator(".search-page").evaluate((element) => {
    const box = element.getBoundingClientRect();
    return Array.from(element.querySelectorAll(".search-result-row")).every(
      (row) => row.getBoundingClientRect().right <= box.right + 1,
    );
  });
  expect(fits).toBe(true);
  await page.screenshot({ path: "test-results/search-narrow.png" });
  await search.fill("second");
  await search.press("Enter");
  await expect(
    page.getByRole("tab", { name: "All", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("region", {
      name: "Search results for second",
      exact: true,
    }),
  ).toBeVisible();
});

test("custom lyric fonts keep italic glyph overhang inside gradient paint bounds", async ({
  page,
}) => {
  await startClient(page);
  await page.getByTitle("Lyrics", { exact: true }).click();
  await page.evaluate(
    ({ uri, settings }) => {
      const host = (window as any).__clientTest;
      host.emit({
        type: "settings",
        settings: {
          ...settings,
          lyric_font: "Arial",
          lyric_size: 72,
          reduce_motion: true,
        },
      });
      host.emit({
        type: "lyrics",
        uri,
        lyrics: {
          source: "test",
          synced: true,
          instrumental: false,
          lines: [
            {
              text: "f",
              start_ms: 1000,
              end_ms: 3000,
              translation: "",
              romanization: "",
              background: false,
              opposite: false,
              words: [{ text: "f", start_ms: 1000, end_ms: 3000 }],
            },
            {
              text: "jiffy",
              start_ms: 4000,
              end_ms: 4500,
              translation: "",
              romanization: "",
              background: false,
              opposite: false,
              words: [{ text: "jiffy", start_ms: 4000, end_ms: 4500 }],
            },
          ],
        },
      });
      host.emit({
        type: "native_position",
        uri,
        position_ms: 1500,
        playing: false,
        observed_at: Date.now(),
      });
    },
    { uri: track.uri, settings: emptyState.settings },
  );
  await page.addStyleTag({ content: ".lyric-line { font-style: italic; }" });
  await expect(page.locator(".lyrics-page .lyric-letter")).toHaveCount(1);
  const ink = await page
    .locator(
      ".lyrics-page .lyric-letter, .lyrics-page .lyric-syllable:not(.emphasis)",
    )
    .evaluateAll((elements) => {
      const context = document.createElement("canvas").getContext("2d")!;
      return elements.map((element) => {
        const style = getComputedStyle(
          element.querySelector(".lyric-paint") ?? element,
        );
        context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const metrics = context.measureText(element.textContent ?? "");
        return {
          left: Math.max(0, metrics.actualBoundingBoxLeft),
          right: Math.max(0, metrics.actualBoundingBoxRight - metrics.width),
          paintLeft: parseFloat(style.paddingLeft),
          paintRight: parseFloat(style.paddingRight),
          background: style.backgroundImage,
          width: element.getBoundingClientRect().width,
          advance: metrics.width,
        };
      });
    });
  await page.screenshot({ path: "test-results/lyric-font-overhang.png" });
  expect(ink.some((item) => item.left > 0.5 || item.right > 0.5)).toBe(true);
  for (const item of ink) {
    expect(item.paintLeft + 0.5).toBeGreaterThanOrEqual(item.left);
    expect(item.paintRight + 0.5).toBeGreaterThanOrEqual(item.right);
    expect(item.background).toContain("linear-gradient");
    expect(Math.abs(item.width - item.advance)).toBeLessThan(1);
  }
});

test("curated playlist descriptions display link labels and open Spotify playlists", async ({
  page,
}) => {
  await startClient(page, "home");
  await page
    .getByRole("button", { name: "Open Daily Mix 1", exact: true })
    .click();
  await page.evaluate(() => {
    const host = (window as any).__clientTest;
    const request = host.commands
      .filter((entry: any) => entry.command === "browse")
      .at(-1);
    host.emit({
      type: "browse_info",
      generation: request.args.generation,
      info: {
        key: request.args.key,
        title: "Curated test",
        albums: [],
        images: [],
        subtitle:
          'Here\'s some <a href="spotify:playlist:1123456789abcdefghijkl">happy</a>, <a href="https://open.spotify.com/playlist/2123456789abcdefghijkl?si=test">dystopian</a> &amp; gentle music.',
        playlist: { owner: "spotify", format: "", total_tracks: 50 },
      },
    });
  });
  const description = page.locator(".hero-description");
  await expect(description).toHaveText(
    "Here's some happy, dystopian & gentle music.",
  );
  await description.getByRole("link", { name: "happy", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__clientTest.commands
            .filter((entry: any) => entry.command === "browse")
            .at(-1)?.args.key,
      ),
    )
    .toBe("playlist:1123456789abcdefghijkl");
});

test("playlist descriptions preserve formatting without executing or loading provider markup", async ({
  page,
}) => {
  const resourceRequests: string[] = [];
  await page.route("https://markup.example.test/**", async (route) => {
    resourceRequests.push(route.request().url());
    await route.fulfill({ status: 200, body: "" });
  });
  await startClient(page, "home");
  await page
    .getByRole("button", { name: "Open Daily Mix 1", exact: true })
    .click();
  await page.evaluate(() => {
    const host = (window as any).__clientTest;
    const request = host.commands
      .filter((entry: any) => entry.command === "browse")
      .at(-1);
    host.emit({
      type: "browse_info",
      generation: request.args.generation,
      info: {
        key: request.args.key,
        title: "Curated test",
        albums: [],
        images: [],
        subtitle:
          '<strong>Safe</strong><br>Music &#x266b; <a href="javascript:window.__descriptionExecuted=1">blocked</a> <a href="https://open.spotify.com.evil.test/playlist/1123456789abcdefghijkl">spoof</a><script>window.__descriptionExecuted=1</script><img src="https://markup.example.test/image" onerror="window.__descriptionExecuted=1"><iframe src="https://markup.example.test/frame"></iframe><style>body { display:none; }</style>',
        playlist: { owner: "spotify", format: "", total_tracks: 50 },
      },
    });
  });
  const description = page.locator(".hero-description");
  await expect(description.locator("strong")).toHaveText("Safe");
  await expect(description.locator("br")).toHaveCount(1);
  await expect(description).toContainText("Music ♫ blocked spoof");
  await expect(description.locator("script,img,iframe,style")).toHaveCount(0);
  await expect(description.getByRole("link")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).__descriptionExecuted),
  ).toBeUndefined();
  expect(resourceRequests).toEqual([]);
});

test("Space after clicking a player button only plays or pauses", async ({
  page,
}) => {
  await startClient(page);
  await page.evaluate(
    ({ track, base }) => {
      (window as any).__clientTest.emit({
        type: "playback",
        playback: { ...base, item: track, is_playing: true },
        observed_at: Date.now(),
        changed: false,
      });
    },
    { track, base: emptyState.playback },
  );
  const player = () =>
    page.evaluate(() =>
      (window as any).__clientTest.commands
        .filter((entry: any) => entry.command === "player")
        .map((entry: any) => entry.args.request.command),
    );
  await page.getByTitle("Shuffle", { exact: true }).click();
  await page.getByTitle("Next song", { exact: true }).click();
  await expect.poll(player).toEqual(["shuffle", "next"]);
  await page.keyboard.press("Space");
  await page.keyboard.press("Enter");
  await expect.poll(player).toEqual(["shuffle", "next", "pause"]);
});

test("owners edit playlist name and description", async ({
  page,
}) => {
  await startClient(page);
  const id = "4123456789abcdefghijkl";
  await page.evaluate(
    (id) =>
      (window as any).__clientTest.emit({
        type: "library",
        playlists: [
          {
            id,
            name: "Road trip",
            images: [],
            owner: { id: "test-user" },
            collaborative: false,
          },
        ],
      }),
    id,
  );
  await page.locator(".library-item", { hasText: "Road trip" }).first().click();
  const rows = page.locator(".track-row");
  await expect(rows).toHaveCount(150);
  const last = (command: string) =>
    page.evaluate(
      (command) =>
        (window as any).__clientTest.commands
          .filter((entry: any) => entry.command === command)
          .at(-1)?.args,
      command,
    );

  await page.locator(".editable-title").click();
  const dialog = page.locator("form.edit-playlist");
  await expect(dialog.getByLabel("Name")).toHaveValue("Road trip");
  await dialog.getByLabel("Name").fill("Night drive");
  await dialog.getByLabel("Description").fill("Late roads");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await last("edit_playlist")).toMatchObject({
    name: "Night drive",
    description: "Late roads",
    playlist: { id },
  });
});

test("songs drag into place in an editable playlist", async ({
  page,
}) => {
  await startClient(page);
  const id = "4123456789abcdefghijkl";
  await page.evaluate(
    (id) =>
      (window as any).__clientTest.emit({
        type: "library",
        playlists: [
          {
            id,
            name: "Road trip",
            images: [],
            owner: { id: "test-user" },
            collaborative: false,
          },
        ],
      }),
    id,
  );
  await page.locator(".library-item", { hasText: "Road trip" }).first().click();
  const rows = page.locator(".track-row");
  await expect(rows).toHaveCount(150);
  const last = (command: string) =>
    page.evaluate(
      (command) =>
        (window as any).__clientTest.commands
          .filter((entry: any) => entry.command === command)
          .at(-1)?.args,
      command,
    );

  // Drop on the lower half of the third row: the first song lands third.
  const third = await rows.nth(2).boundingBox();
  await rows
    .nth(0)
    .dragTo(rows.nth(2), {
      targetPosition: { x: 40, y: third!.height - 4 },
    });
  await expect.poll(() => last("move_playlist_song")).toMatchObject({
    from: 0,
    to: 2,
    uri: "spotify:track:item0",
  });
  await expect(rows.nth(0)).toContainText("Song 2");
  await expect(rows.nth(2)).toContainText("Song 1");
});

test("Spotify folders group the sidebar and open in place", async ({
  page,
}) => {
  await startClient(page);
  const road = { id: "road", name: "Road & Rain" };
  const night = { id: "night", name: "Night" };
  const playlist = (index: number, folders: object[] = []) => ({
    id: `${index}123456789abcdefghijkl`.slice(0, 22),
    name: `List ${index}`,
    images: [],
    owner: { id: "test-user" },
    collaborative: false,
    folders,
  });
  await page.evaluate(
    (playlists) =>
      (window as any).__clientTest.emit({ type: "library", playlists }),
    [
      playlist(1, [road]),
      playlist(2, [road, night]),
      playlist(3),
    ],
  );
  const sidebar = page.locator(".library-list");
  const folder = sidebar.locator(".spotify-folder").first();
  await expect(folder.locator(":scope > summary")).toContainText("Road & Rain");
  await expect(folder.locator(":scope > summary")).toContainText("Folder · 2 playlists");
  await expect(sidebar.getByText("List 1")).toBeHidden();
  await folder.locator(":scope > summary").click();
  await expect(sidebar.getByText("List 1")).toBeVisible();
  const inner = folder.locator(".spotify-folder");
  await expect(inner.locator(":scope > summary")).toContainText("Night");
  await inner.locator(":scope > summary").click();
  await expect(sidebar.getByText("List 2")).toBeVisible();
  await sidebar.getByText("List 2").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("List 2");
  // Searching the library lists matching playlists without folders.
  await page.getByLabel("Search library").fill("List 2");
  await expect(sidebar.locator(".spotify-folder")).toHaveCount(0);
  await expect(sidebar.getByText("List 2")).toBeVisible();
});

test("Create folder adds a Spotify folder that shows while empty", async ({
  page,
}) => {
  await startClient(page);
  await page.getByTitle("Create folder", { exact: true }).click();
  await page.getByPlaceholder("Folder name").fill("Workouts");
  await page
    .locator(".dialog")
    .getByRole("button", { name: "Create folder", exact: true })
    .click();
  expect(
    await page.evaluate(() =>
      (window as any).__clientTest.commands
        .filter((entry: any) => entry.command === "create_folder")
        .at(-1)?.args,
    ),
  ).toEqual({ name: "Workouts" });
  await page.evaluate(() =>
    (window as any).__clientTest.emit({
      type: "library_folders",
      folders: [{ id: "workouts", name: "Workouts", parents: [] }],
    }),
  );
  const folder = page.locator(".library-list .spotify-folder");
  await expect(folder.locator(":scope > summary")).toContainText(
    "Folder · 0 playlists",
  );
});

test("folders rename from their right-click menu", async ({ page }) => {
  await startClient(page);
  await page.evaluate(() =>
    (window as any).__clientTest.emit({
      type: "library_folders",
      folders: [{ id: "workouts", name: "Workouts", parents: [] }],
    }),
  );
  await page
    .locator(".library-list .spotify-folder > summary")
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const dialog = page.locator("form.edit-playlist");
  await expect(dialog.getByLabel("Name")).toHaveValue("Workouts");
  await dialog.getByLabel("Name").fill("Gym");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      (window as any).__clientTest.commands
        .filter((entry: any) => entry.command === "rename_folder")
        .at(-1)?.args,
    ),
  ).toEqual({ id: "workouts", name: "Gym" });
});

test("playlists move into and out of folders from their menu", async ({
  page,
}) => {
  await startClient(page);
  const id = "5123456789abcdefghijkl";
  await page.evaluate((id) => {
    const test = (window as any).__clientTest;
    test.emit({
      type: "library",
      playlists: [
        {
          id,
          name: "Road trip",
          images: [],
          owner: { id: "test-user" },
          collaborative: false,
        },
      ],
    });
    test.emit({
      type: "library_folders",
      folders: [
        { id: "gym", name: "Gym", parents: [] },
        { id: "legs", name: "Legs", parents: ["gym"] },
      ],
    });
  }, id);
  const last = () =>
    page.evaluate(
      () =>
        (window as any).__clientTest.commands
          .filter((entry: any) => entry.command === "move_to_folder")
          .at(-1)?.args,
    );
  await page
    .locator(".library-row", { hasText: "Road trip" })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to folder" }).click();
  const picker = page.getByRole("menu", { name: "Move to folder" });
  await expect(picker.getByRole("menuitem")).toHaveText(["Gym", "Legs"]);
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  expect(await last()).toBeUndefined();
  await page
    .locator(".library-row", { hasText: "Road trip" })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to folder" }).click();
  await picker.getByRole("menuitem", { name: "Legs" }).click();
  expect(await last()).toEqual({ playlist: id, folder: "legs" });

  // Once inside a folder, the picker also offers to take it out.
  await page.evaluate(
    (id) =>
      (window as any).__clientTest.emit({
        type: "library",
        playlists: [
          {
            id,
            name: "Road trip",
            images: [],
            owner: { id: "test-user" },
            collaborative: false,
            folders: [
              { id: "gym", name: "Gym" },
              { id: "legs", name: "Legs" },
            ],
          },
        ],
      }),
    id,
  );
  await page.locator(".spotify-folder > summary").first().click();
  await page.locator(".spotify-folder .spotify-folder > summary").click();
  await page
    .locator(".library-row", { hasText: "Road trip" })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to folder" }).click();
  await expect(picker.getByRole("menuitem", { name: "Legs" })).toBeDisabled();
  await picker.getByRole("menuitem", { name: "Remove from folder" }).click();
  expect(await last()).toEqual({ playlist: id, folder: null });
});

test("folder picker follows library updates and closes on sign-out", async ({
  page,
}) => {
  await startClient(page);
  const playlist = {
    id: "5123456789abcdefghijkl",
    name: "Shared road trip",
    images: [],
    owner: { id: "friend" },
    collaborative: false,
  };
  await page.evaluate((playlist) => {
    const emit = (window as any).__clientTest.emit;
    emit({ type: "library", playlists: [playlist] });
    emit({
      type: "library_folders",
      folders: [{ id: "gym", name: "Gym", parents: [] }],
    });
  }, playlist);
  await page
    .locator(".library-row", { hasText: playlist.name })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to folder" }).click();
  const picker = page.getByRole("menu", { name: "Move to folder" });
  await expect(picker.getByRole("menuitem", { name: "Gym" })).toBeEnabled();
  await expect(
    picker.getByRole("menuitem", { name: "Remove from folder" }),
  ).toHaveCount(0);
  await page.evaluate((playlist) => {
    (window as any).__clientTest.emit({
      type: "library",
      playlists: [{ ...playlist, folders: [{ id: "gym", name: "Gym" }] }],
    });
  }, playlist);
  await expect(picker.getByRole("menuitem", { name: "Gym" })).toBeDisabled();
  await expect(
    picker.getByRole("menuitem", { name: "Remove from folder" }),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as any).__clientTest.emit({ type: "signed_out" }),
  );
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole("dialog")).toContainText(
    "Spotify Premium required",
  );
  await page.evaluate((playlist) => {
    const emit = (window as any).__clientTest.emit;
    emit({ type: "session", profile: { id: "another-user" } });
    emit({ type: "library", playlists: [playlist] });
    emit({
      type: "library_folders",
      folders: [{ id: "gym", name: "Gym", parents: [] }],
    });
  }, playlist);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(picker).toHaveCount(0);
  await expect(
    page.locator(".library-row", { hasText: playlist.name }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).__clientTest.commands.filter(
        (entry: any) => entry.command === "move_to_folder",
      ),
    ),
  ).toEqual([]);
});

async function startFolderDeletionClient(page: Page) {
  await startClient(page);
  const folders = [
    { id: "road", name: "Road", parents: [] as string[] },
    { id: "night", name: "Night", parents: ["road"] },
  ];
  const playlists = [
    {
      id: "5123456789abcdefghijkl",
      name: "Road trip",
      images: [],
      owner: { id: "test-user" },
      collaborative: false,
      folders: [{ id: "road", name: "Road" }],
    },
    {
      id: "6123456789abcdefghijkl",
      name: "Shared nights",
      images: [],
      owner: { id: "friend" },
      collaborative: true,
      folders: [
        { id: "road", name: "Road" },
        { id: "night", name: "Night" },
      ],
    },
  ];
  await page.evaluate(
    ({ playlists, folders }) => {
      const emit = (window as any).__clientTest.emit;
      emit({ type: "library", playlists });
      emit({ type: "library_folders", folders });
    },
    { playlists, folders },
  );
  return { playlists, folders };
}

test("Liquid Glass combines shading without changing backdrop pixels", async ({
  page,
}) => {
  await startClient(page, "home");
  await page.evaluate(
    ({ settings, playback, track }) => {
      const emit = (window as any).__clientTest.emit;
      emit({
        type: "playback",
        playback: { ...playback, item: track, is_playing: false },
        observed_at: Date.now(),
        changed: false,
      });
      emit({ type: "settings", settings: { ...settings, liquid_glass: true } });
    },
    { settings: emptyState.settings, playback: emptyState.playback, track },
  );
  const backdrop = page.locator(".glass-backdrop");
  await expect(backdrop.locator(".ambient-layer")).toBeVisible();
  await expect(backdrop.locator(".ambient-shade")).toHaveCount(0);
  await expect(page.locator(".now-playing .ambient-shade")).toHaveCount(1);
  // Finish the existing 500 ms artwork transition before comparing paint.
  await page.waitForTimeout(700);
  const mask = [page.locator(".marquee")];
  const optimized = await backdrop.screenshot({ animations: "disabled", mask });
  await backdrop.locator(".ambience").evaluate((element) => {
    const shade = document.createElement("div");
    shade.className = "ambient-shade";
    element.append(shade);
  });
  await page.addStyleTag({
    content:
      ".glass-backdrop-shade { background: radial-gradient(ellipse at 50% 0%, transparent, #00000059 70%), linear-gradient(#0000002e, #00000066); }",
  });
  const original = await backdrop.screenshot({ animations: "disabled", mask });
  const difference = await page.evaluate(
    async ({ original, optimized }) => {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      const pixels = async (base64: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        canvas.width = image.width;
        canvas.height = image.height;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      };
      const before = await pixels(original),
        after = await pixels(optimized);
      let changed = 0;
      for (let index = 0; index < before.length; index += 4) {
        if (
          [0, 1, 2].some(
            (channel) =>
              Math.abs(before[index + channel] - after[index + channel]) > 2,
          )
        )
          changed++;
      }
      return changed / (before.length / 4);
    },
    {
      original: original.toString("base64"),
      optimized: optimized.toString("base64"),
    },
  );
  expect(difference).toBeLessThan(0.001);
});

test("playlist artwork loads near the viewport and still loads after scrolling", async ({
  page,
}) => {
  await startClient(page);
  await expect(page.locator(".track-row")).toHaveCount(150);
  const requests = new Set<number>();
  await page.route("https://artwork.example.test/memory/**", (route) => {
    const index = Number(
      new URL(route.request().url()).pathname.split("/").at(-1)?.split(".")[0],
    );
    requests.add(index);
    return route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="640" height="640" fill="#9670a7"/></svg>',
    });
  });
  const count = 300;
  await page.evaluate(
    ({ track, count }) => {
      const host = (window as any).__clientTest;
      const browse = host.commands
        .filter((entry: any) => entry.command === "browse")
        .at(-1).args;
      host.emit({
        type: "tracks",
        key: browse.key,
        generation: browse.generation,
        offset: 0,
        more: false,
        tracks: Array.from({ length: count }, (_, index) => ({
          ...track,
          id: `memory${index}`,
          uri: `spotify:track:memory${index}`,
          name: `Memory song ${index + 1}`,
          album: {
            ...track.album,
            images: [
              { url: `https://artwork.example.test/memory/${index}.svg` },
            ],
          },
        })),
      });
    },
    { track, count },
  );
  const rows = page.locator(".track-row");
  await expect(rows).toHaveCount(count);
  await expect
    .poll(() =>
      rows
        .first()
        .locator("img")
        .evaluate(
          (image) =>
            image instanceof HTMLImageElement &&
            image.complete &&
            image.naturalWidth > 0,
        ),
    )
    .toBe(true);
  expect(requests.has(count - 1)).toBe(false);
  expect(requests.size).toBeLessThan(count / 3);
  await rows.last().scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      rows
        .last()
        .locator("img")
        .evaluate(
          (image) =>
            image instanceof HTMLImageElement &&
            image.complete &&
            image.naturalWidth > 0,
        ),
    )
    .toBe(true);
  expect(requests.has(count - 1)).toBe(true);
  await expect(rows.last().locator(".track-number > span")).toHaveText(
    String(count),
  );
});

test("lyric clock frames reuse click handlers and keep seeking functional", async ({
  page,
}) => {
  await startClient(page);
  await page.getByTitle("Lyrics", { exact: true }).click();
  await page.evaluate(
    ({ track, playback }) => {
      const { emit } = (window as any).__clientTest;
      emit({
        type: "playback",
        playback: {
          ...playback,
          item: track,
          is_playing: true,
          progress_ms: 1000,
        },
        observed_at: Date.now(),
        changed: false,
      });
      emit({
        type: "lyrics",
        uri: track.uri,
        lyrics: {
          synced: true,
          instrumental: false,
          source: "spicy_lyrics",
          lines: Array.from({ length: 20 }, (_, index) => ({
            start_ms: index * 20_000,
            end_ms: (index + 1) * 20_000,
            text: `Line ${index + 1}`,
            words: [
              {
                start_ms: index * 20_000,
                end_ms: (index + 1) * 20_000,
                text: `Line ${index + 1}`,
              },
            ],
          })),
        },
      });
    },
    { track, playback: emptyState.playback },
  );
  const lines = page.locator(".lyrics-page .lyric-line");
  await expect(lines).toHaveCount(20);
  const assignments = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const descriptor = Object.getOwnPropertyDescriptor(
          HTMLElement.prototype,
          "onclick",
        )!;
        let count = 0,
          frames = 0;
        Object.defineProperty(HTMLElement.prototype, "onclick", {
          ...descriptor,
          set(value) {
            if (this.closest(".lyrics-page")) count++;
            descriptor.set!.call(this, value);
          },
        });
        const tick = () => {
          if (++frames < 15) requestAnimationFrame(tick);
          else {
            Object.defineProperty(HTMLElement.prototype, "onclick", descriptor);
            resolve(count);
          }
        };
        requestAnimationFrame(tick);
      }),
  );
  expect(assignments).toBeLessThan(40);
  await lines.nth(1).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__clientTest.commands
            .filter((entry: any) => entry.command === "player")
            .at(-1)?.args.request,
      ),
    )
    .toMatchObject({ command: "seek", positionMs: 20_000 });
});

async function openFolderDeletion(page: Page) {
  await page
    .locator(".library-list .spotify-folder > summary")
    .filter({ hasText: "Road" })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Delete folder", exact: true })
    .click();
  return page.getByRole("alertdialog", { name: "Delete folder?" });
}

test("folder deletion confirms, cancels and preserves playlists through refresh", async ({
  page,
}) => {
  const { playlists } = await startFolderDeletionClient(page);
  const dialog = await openFolderDeletion(page);
  await expect(dialog).toContainText('Delete "Road" from your Spotify library?');
  await expect(dialog).toContainText(
    "Playlists and subfolders inside will move up one level",
  );
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Delete folder" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await openFolderDeletion(page);
  await page.locator(".modal-backdrop").click({ position: { x: 2, y: 2 } });
  await expect(dialog).toHaveCount(0);
  await openFolderDeletion(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  const commands = () =>
    page.evaluate(() =>
      (window as any).__clientTest.commands.filter(
        (entry: any) => entry.command === "delete_folder",
      ),
    );
  expect(await commands()).toEqual([]);

  await openFolderDeletion(page);
  await dialog.getByRole("button", { name: "Delete folder" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await commands()).toEqual([
    { command: "delete_folder", args: { id: "road" } },
  ]);
  // Keep the current tree until the backend has confirmed and refreshed it.
  const summaries = page.locator(".library-list .spotify-folder > summary");
  await expect(summaries.filter({ hasText: "Road" })).toContainText(
    "2 playlists",
  );
  await page.evaluate((playlists) => {
    const emit = (window as any).__clientTest.emit;
    emit({
      type: "library",
      playlists: playlists.map((playlist) => ({
        ...playlist,
        folders: playlist.folders.slice(1),
      })),
    });
    emit({
      type: "library_folders",
      folders: [{ id: "night", name: "Night", parents: [] }],
    });
  }, playlists);
  await expect(summaries.filter({ hasText: "Road" })).toHaveCount(0);
  await expect(
    page.locator(".library-row", { hasText: "Road trip" }),
  ).toBeVisible();
  await summaries.filter({ hasText: "Night" }).click();
  await expect(
    page.locator(".library-row", { hasText: "Shared nights" }),
  ).toBeVisible();
});

test("failed folder deletion reports the backend error and keeps the library", async ({
  page,
}) => {
  await startFolderDeletionClient(page);
  const dialog = await openFolderDeletion(page);
  await dialog.getByRole("button", { name: "Delete folder" }).click();
  await page.evaluate(() =>
    (window as any).__clientTest.emit({
      type: "notice",
      error: true,
      message: "Spotify did not confirm the folder removal",
    }),
  );
  await expect(page.locator(".toast.error")).toContainText(
    "Spotify did not confirm the folder removal",
  );
  await expect(
    page
      .locator(".library-list .spotify-folder > summary")
      .filter({ hasText: "Road" }),
  ).toContainText("2 playlists");
  await expect(
    page.locator(".library-row", { hasText: "Road trip" }),
  ).toHaveCount(1);
  await expect(
    page.locator(".library-row", { hasText: "Shared nights" }),
  ).toHaveCount(1);
  expect(
    await page.evaluate(() =>
      (window as any).__clientTest.commands.filter((entry: any) =>
        ["remove_playlist", "remove_from_playlist"].includes(entry.command),
      ),
    ),
  ).toEqual([]);
});

test("folder deletion closes on sign-out and cannot carry into another account", async ({
  page,
}) => {
  const library = await startFolderDeletionClient(page);
  const dialog = await openFolderDeletion(page);
  await page.evaluate(() =>
    (window as any).__clientTest.emit({ type: "signed_out" }),
  );
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("dialog")).toContainText(
    "Spotify Premium required",
  );
  await page.evaluate(({ playlists, folders }) => {
    const emit = (window as any).__clientTest.emit;
    emit({ type: "session", profile: { id: "another-user" } });
    emit({ type: "library", playlists });
    emit({ type: "library_folders", folders });
  }, library);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      (window as any).__clientTest.commands.filter(
        (entry: any) => entry.command === "delete_folder",
      ),
    ),
  ).toEqual([]);
});
