# Lyrics source reference

Reviewed the local `pixels-spicy-lyrics` checkout on 2026-10-20. These are reference behaviors, not a claim that SpotiFlex implements every provider. The reference project is [Spicy Lyrics](https://github.com/iPixelGalaxy/spicy-lyrics), licensed under AGPL-3.0. No source files, assets or provider credentials were copied.

`src/utils/Lyrics/LyricsSourcePreferences.ts` defines the order: Spicy, Musixmatch, Apple Music, Spotify, LRCLIB, Netease. The source manager saves ordering, disabled providers, Musixmatch word-sync preferences and an Apple quality preference. LRCLIB and Netease default to disabled.

| Source          | Reference adapter       | Retrieval and timing                                                                                                                                                                                                                                  |
| --------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spicy/community | `Sources/Spicy.ts`      | Shared backend `lyrics` query by Spotify track ID. Decodes packed or ordinary data. Community adapter accepts source `spl`.                                                                                                                           |
| Apple Music     | `Sources/Spicy.ts`      | Reuses that same backend request and accepts source `aml`. The client does not contact Apple Music directly.                                                                                                                                          |
| Musixmatch      | `Sources/Musixmatch.ts` | Matches track metadata through `macro.subtitles.get`; tries `track.richsync.get` for word timing, then line subtitles, then plain lyrics. Validates the match, rejects restricted/instrumental responses and retries with a refreshed provider token. |
| Spotify         | `Sources/Spotify.ts`    | Uses Spotify's `color-lyrics/v2/track` service. Converts line-synced or static lyrics; retains provider attribution, including Musixmatch. The reference uses `Spicetify.CosmosAsync`; SpotiFlex would need a Rust adapter.                           |
| LRCLIB          | `Sources/Lrclib.ts`     | Matches title, artist, album and duration through `/api/get`; parses LRC timestamps or plain lyrics.                                                                                                                                                  |
| Netease         | `Sources/Netease.ts`    | Uses an external Netease proxy to search metadata and retrieve lyrics. Chooses by album, duration or title; parses timestamps and removes credit lines.                                                                                               |

Paths in the table are relative to `src/utils/Lyrics/` in the reference checkout.

`ExternalSources.ts` starts enabled providers concurrently, sharing one backend promise between Spicy, Apple and songwriter-credit lookup. It consumes results in configured order, preferring syllable timing over line timing over static text. Apple can win a tie when it has genuine line-ending gaps. LRCLIB and Netease have four-second fallback deadlines. A queued backend response only blocks display when no provider has usable lyrics. The module offers an early-result callback; the reviewed `fetchLyrics.ts` caller does not supply it.

`fetchLyrics.ts` checks the current track before and after fetching and attaches source-preference metadata to cached lyrics. `LyricsSourcesManager.tsx` exposes source ordering, enabling, provider options and token refresh.

The reference `ExperimentalWordSync.ts` has separate line and static converters. Its static converter requires audio analysis even though its timing-window helper accepts a duration fallback. SpotiFlex instead estimates static phrase boundaries from text and track duration, then estimates word timing. This can animate plain lyrics but cannot establish where vocals or instrumental sections occur. Estimates are labelled in lyric credits and do not overwrite cached source lyrics.

SpotiFlex still lacks configurable multi-provider ordering and independent Musixmatch, Spotify, LRCLIB and Netease adapters. Any future credential handling belongs in Rust and the OS credential store. Spotify refresh tokens and client secrets must never be sent to lyric providers; changing the configured backend host still requires fresh in-app consent.
