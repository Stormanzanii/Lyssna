# Feature status

The reference projects are [Spicy Lyrics](https://github.com/iPixelGalaxy/spicy-lyrics/tree/dev) and [Spotify Plus](https://github.com/iPixelGalaxy/spotify-plus). Their JavaScript extensions are not loaded into SpotiFlex. Implemented behavior runs in Rust.

| Area | Implemented | Remaining |
| --- | --- | --- |
| Login | Mandatory setup modal; Premium notice; Client ID; PKCE; browser callback; state validation; cancellation; refresh; OS credential storage; sign-out | Account-based end-to-end verification; broader sign-in recovery UX |
| Spotify library | Automatic playlist loading after login and session restore; all pages; private and collaborative scopes; library search; refresh | Album and artist browsing; live account verification |
| Playback | librespot Connect device; Rodio output; device picker; transport controls; seeking; volume; shuffle; repeat; queue; local position events; connection-generation guards | Account-based audio verification; automatic reconnect/backoff; output-device selection; media keys; crossfade; offline playback |
| Playlist tools | Editable-playlist picker; full existing-track scan; duplicate skipping; 100-item write batches; multi-select; copy IDs; clean links; local playlist folders | Spotify folder import; richer playlist editing; playlist creation; server-concurrent duplicate protection |
| Lyrics data | Protected provider configuration; consented access-token header; native query protocol; packed JSON decoder with limits; static/line/syllable data; local LRC and TTML; three-day provider-isolated cache | Live provider verification; source ordering; provider queue retries; full TTML dialect coverage; complete source metadata and credits |
| Lyrics display | Line and syllable highlighting; click to seek; follow scrolling; timing offset; supplied translations and romanization; background vocals; expanded cinema panel; reduced motion | Automatic transliteration; custom animator presets; gravity effects; popout/Picture-in-Picture windows; font coverage detection; full fork animation parity |
| Spotify Plus interface | Compact library option; compact device popup; last-view restore; F5 refresh; copy actions; clean share links | Update prompts; embed/share dialogs; remaining relevant settings and shortcuts |
| UI | Spotify-style left library, center content, bottom player, right lyrics | Visual polish is reserved for a later pass |

Spotify's public API does not expose playlist folders. Local folders are maintained by SpotiFlex and do not change the user's Spotify folders. The [2026 development-mode changes](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) also restrict reading playlist contents to playlists the user owns or collaborates on. Other playlist names can still appear in the library even when their contents cannot be fetched through this API.

Controls for modifying Spotify's own web menus, Spicetify developer tools, and injected experimental-feature dialogs do not apply to this standalone client.
