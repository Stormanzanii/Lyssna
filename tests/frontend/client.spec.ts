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

async function startClient(page: Page) {
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
          if (command === "plugin:event|listen") {
            handlers.set(++serial, args.handler);
            return serial;
          }
          if (command === "plugin:event|unlisten") {
            handlers.delete(args.eventId);
            return;
          }
          if (command === "bootstrap") return structuredClone(snapshot);
          if (command === "browse") {
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
  await expect(page.locator(".setup-backdrop")).toHaveCount(0);
  await expect(page.locator(".track-row")).toHaveCount(50);
}

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
      page.evaluate(() =>
        Math.abs(
          document
            .querySelector(".lyrics-page .lyric-line")!
            .getBoundingClientRect().top -
            document
              .querySelector(".lyrics-album>.cover")!
              .getBoundingClientRect().top,
        ),
      ),
    )
    .toBeLessThan(35);
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
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".creator-panel iframe")).toHaveAttribute(
    "src",
    "https://spicylyrics.org/embed/123456789012345678",
  );
  await page.getByRole("button", { name: "Close creator profile" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
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
