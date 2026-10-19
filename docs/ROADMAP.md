# Implementation roadmap

Resume with **Section 3: Playlist tools**. Each implementation batch gets relevant checks, an updated feature record, a Git commit and a push. Implementation and live listening remain separate claims.

## 1. Playback speed: implemented and measured

Startup metadata and audio-key reuse, early preparation, upcoming-track preloading and parallel audio-output setup are implemented. One Windows run measured 486 ms for the first selection, 104 ms median for later selections and 58 ms median for skips. A later warm-start run measured 116 ms median. Network conditions still affect uncached starts; these measurements exclude physical speaker latency.

## 2. Playback reliability: implemented and checked

- Automatic reconnect and queued Play recovery are implemented and live-tested without a fresh browser login.
- Sign-in failures remain visible in setup. Temporary restore failures offer **Retry saved sign-in**; rejected or damaged credentials require fresh sign-in. Cancelling browser sign-in releases the pending state while keeping the client locked. Controlled Rust and browser checks cover recovery and the login boundary.
- Audio-output selection persists, opens off the UI thread and falls back to the default when a saved device disappears. **Settings > Playback > Test output** sends two quiet tones to the selected output without changing the preference. Live checks verified native output opening, missing-device fallback and test-tone consumption. The user confirmed both separated tones through headphones.
- Native queue additions and Spotify Connect discovery avoid the Web API. Live checks discovered this computer and four registered speakers, added the selected song to its queue and resolved queued metadata. Regression checks assert zero Web API requests for local queue writes and device refreshes. Start playback on this computer once before adding to its queue; paused loaded playback remains supported.
- Spotify Connect keeps registered Alexa speakers visible even when flagged offline or omitted by later updates. Native handoff and explicit return avoid the Web API. The user confirmed music on Gameroom and its return to headphones. Only one Windows audio endpoint was available for a physical listening check; switching between two Windows endpoints remains unverified.

The existing Spotify Web API cooldown still applies to operations using that API, including remote transport controls and playlist writes. Device discovery and transfers use native Connect. Registered speakers can still be unreachable; their presence does not guarantee activation.

## 3. Playlist tools: next

- Create playlists.
- Edit names, descriptions and visibility.
- Reorder and remove tracks.
- Handle concurrent playlist changes and duplicates within Spotify's API limits.

## 4. Lyrics

- Provider ordering and retries.
- Broader TTML handling and timed romanization.
- Simple Lyrics mode, custom animator presets and line-synced vertical wipe.
- Automatic transliteration.
- Separate lyric and Picture-in-Picture windows.

## 5. Browsing

- Home section pagination beyond the initial items.
- Podcast and audiobook pages.
- Complete artist saved-song counts where supported.

## 6. Controls and appearance

- Full track crossfade.
- Share and embed dialogs.
- Native remote transport controls and remote playback-state reflection.
- Remaining relevant settings and shortcuts.
- Light theme.
- Claude visual polish after core functionality.

## 7. Release and live verification

- Publish the first signed release; verify executable replacement and restart between two published versions.
- Complete DJ close/reopen, skip, multi-set, fade and text/voice-request listening checks. Text and voice requests already have implementations and controlled tests; the spoken hold-button prompt remains a gap.
- Verify taskbar buttons, media keys and third-party software such as Stream Deck.
- Extend remote-device checks beyond the verified Alexa and headphone handoff.
- Complete integration and installation checks for other targeted platforms.
- Verify switching between two Windows audio endpoints when both are available.

## Needs a supported implementation path

Spotify folder import and offline playback remain research items. Spotify's public API does not provide folder metadata. Neither feature is promised without a supported approach.
