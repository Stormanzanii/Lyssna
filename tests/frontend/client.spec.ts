import { test, expect, type Page } from "@playwright/test";
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
      const handlers = new Map<number, number>();
      const commands: { command: string; args: any }[] = [];
      let serial = 0;
      const emit = (payload: any) =>
        handlers.forEach((handler) =>
          callbacks.get(handler)?.({ event: "spotiflex", payload }),
        );
      host.__clientTest = { commands, emit };
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
          if (command === "resolve_album")
            return {
              ...track.album,
              id: "abcdefghijklmnopqrstuv",
              uri: "spotify:album:abcdefghijklmnopqrstuv",
            };
          if (command === "plugin:event|listen") {
            handlers.set(++serial, args.handler);
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
            if (args.key === "home") return;
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
  await page.locator(".track-row").first().click({ button: "right" });
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
test("player DJ button requests a fresh DJ selection on every click", async ({
  page,
}) => {
  await startClient(page);
  const button = page.getByRole("button", { name: "Refresh DJ", exact: true });
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

test("holding DJ explains request availability without refreshing", async ({
  page,
}) => {
  await startClient(page);
  await page.clock.install();
  const button = page.getByRole("button", { name: "Refresh DJ", exact: true });
  await button.hover();
  await page.mouse.down();
  await page.clock.runFor(600);
  await expect(
    page.getByText(
      "DJ text and voice requests aren't available yet. Click DJ for a new selection.",
      { exact: true },
    ),
  ).toBeVisible({ timeout: 1000 });
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
  const shelf = page.locator(".home-shelf-items");
  await page
    .getByRole("button", { name: "Scroll Daily Mixes right", exact: true })
    .click();
  await expect
    .poll(() => shelf.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "Expand", exact: true }).click();
  await expect(shelf).toHaveClass(/expanded/);
  const width = await shelf.evaluate((element) => ({
    scroll: element.scrollWidth,
    client: element.clientWidth,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
  const footer = await page.locator(".player-bar").boundingBox();
  expect(footer!.y + footer!.height).toBeLessThanOrEqual(601);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole("button", { name: "Collapse", exact: true }).click();
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
  await page.getByTitle("Close lyrics", { exact: true }).click();
  const cards = page.locator(".now-playing .now-card");
  await expect(cards.first()).toHaveClass(/lyric-preview/);
  await expect(cards.nth(1)).toHaveClass(/artist-card/);
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

test("Canvas defaults on, floating lyrics are optional, with sharp video left and metadata bottom-left", async ({
  page,
}) => {
  await startClient(page);
  await page.getByTitle("Lyrics", { exact: true }).click();
  await page.locator(".file-input").setInputFiles({
    name: "timing.ttml",
    mimeType: "application/xml",
    buffer: Buffer.from("<tt/>"),
  });
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
  await page.getByTitle("Settings", { exact: true }).click();
  await expect(page.getByLabel("Lyrics API key")).toHaveCount(0);
  await expect(page.getByLabel("Canvas in lyrics")).toBeChecked();
  await expect(page.getByLabel("Floating lyrics")).not.toBeChecked();
  await page.getByLabel("Canvas in lyrics").check();
  await page.getByLabel("Floating lyrics").check();
  await page.getByTitle("Lyrics", { exact: true }).click();
  await expect(page.locator(".canvas-lyrics video")).toBeVisible();
  await expect(page.locator(".floating-stage")).toBeVisible();
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
  await page.getByTitle("Settings", { exact: true }).click();
  await page.getByLabel("Reduce motion").check();
  await page.getByTitle("Lyrics", { exact: true }).click();
  await expect(page.locator(".floating-stage")).toHaveCount(0);
  await expect(page.locator(".lyrics-canvas-cover")).toHaveCount(0);
  await expect(page.locator(".lyrics-page .lyric-line")).toHaveCount(80);
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
  const transforms = await page
    .locator(".lyrics-page .lyric-syllable")
    .evaluateAll((elements) =>
      elements.map(
        (element) => new DOMMatrix(getComputedStyle(element).transform).m42,
      ),
    );
  expect(transforms[0]).toBeLessThan(-1);
  expect(transforms[1]).toBe(0);
  await page.evaluate(
    (uri) =>
      (window as any).__clientTest.emit({
        type: "native_position",
        uri,
        position_ms: 2100,
        playing: false,
        observed_at: Date.now(),
      }),
    track.uri,
  );
  expect(
    await page
      .locator(".lyrics-page .lyric-syllable")
      .nth(1)
      .evaluate(
        (element) => new DOMMatrix(getComputedStyle(element).transform).m42,
      ),
  ).toBeLessThan(-1);
  await page.getByTitle("Settings", { exact: true }).click();
  await page.getByLabel("App font", { exact: true }).selectOption("Georgia");
  await page
    .getByLabel("Lyrics font", { exact: true })
    .selectOption("Consolas");
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

test("playlist search spans unloaded pages and play counts drive sorting", async ({
  page,
}) => {
  await startClient(page);
  await page
    .locator(".library-item")
    .filter({ hasText: "Liked Songs" })
    .click();
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
  await expect(page.locator(".track-streams")).toHaveText("123,456");
  await page.getByLabel("Search songs in this playlist").clear();
  await page.getByLabel("Sort songs").selectOption("popular");
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
  expect(
    await page
      .locator(".lyric-syllable")
      .last()
      .evaluate((element) => element.style.getPropertyValue("--word-progress")),
  ).toBe("-20%");
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
