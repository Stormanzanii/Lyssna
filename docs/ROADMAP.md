# Implementation batches

Work through the feature-status gaps in these batches. Each completed batch gets relevant checks, an updated feature record, a Git commit and a push. Live verification stays distinct from implementation.

1. **Playback startup:** measure selection and skip latency, reuse startup data, preload upcoming tracks, prepare audio output during connection.
2. **Playback reliability:** automatic reconnect, clearer sign-in recovery, audio-output device selection.
3. **Playlist tools:** create playlists, edit details and track order, remove tracks, handle concurrent playlist changes.
4. **Lyrics:** source selection and retries, broader TTML handling, simple mode, animator settings, transliteration, separate lyric windows.
5. **Browsing:** Home section pagination, podcast and audiobook pages, complete artist saved-song counts where supported.
6. **Controls and appearance:** track crossfade, share dialogs, remaining settings and shortcuts, light theme.
7. **Release verification:** real signed-update replacement across two versions, DJ restore/skip/fade and text/voice checks, third-party media controls, platform-specific integration.

Spotify folder metadata and offline playback need a supported implementation path before they can be promised. Public API folder metadata is unavailable. Release publishing and live third-party checks remain explicit verification steps.

## Progress

- Playback startup implemented and measured on Windows: 486 ms first selection, 104 ms median subsequent selection; skip median 58 ms. Network conditions still affect uncached starts.
- Automatic connection recovery implemented; deliberate live disconnection recovered without a new browser login. Repeated Play requests reuse active or connecting sessions. Audio-device selection next.
- Quota reduction: local song details and playback polling use native/cache data; cached libraries restore quietly during an existing Web API cooldown. Server cooldowns remain enforced.
- Other batches pending.
