# Architecture

`main.rs` starts the Tauri desktop app or performs protected provider provisioning from standard input. `desktop.rs` exposes narrow commands and sanitized snapshots to the React interface in `frontend`. The optional `legacy-ui` feature keeps the previous egui interface in `app.rs`. Both interfaces require authenticated setup and use the same Rust audio, catalogue, lyric, and update services.

| Module | Responsibility |
| --- | --- |
| `auth.rs` | PKCE generation, loopback listener, callback validation, token exchange, refresh, OS credential storage |
| `api.rs` | Authenticated Spotify calls, origin validation, 401 refresh, rate-limit cooldown, pagination, playlist writes |
| `model.rs` | Spotify data and ordered duplicate-free playlist additions |
| `native.rs` | Separate Tokio runtime, librespot session, Connect registration, Rodio player, timestamped player events, shutdown |
| `audio.rs`, `playback_intent.rs` | Bounded audio buffering, seek acknowledgments, and latest-intent play/pause transitions |
| `catalogue.rs`, `artist.rs`, `album.rs`, `canvas.rs` | Read-only desktop catalogue queries, bounded public-page fallback, banner and play-count parsing, validated Canvas media URLs |
| `lyrics.rs` | Independent lyric model, LRC/TTML parsing, imports, per-provider disk cache |
| `provider.rs` | Credential-store host configuration, HTTPS validation, query protocol, bounded packed-data decoding |
| `worker.rs` | Spotify command worker and separate lyric worker; no HTTP or audio work on the UI thread |
| `config.rs` | Nonsecret appearance, Client ID, local folders, and view settings |
| `updater.rs` | Independent signed update checks, bounded download, hash validation, native replacement, and restart |

`src/bin/spotiflex-release.rs` is a maintainer tool for signing and publishing versioned artifacts. It uses separate credentials from Spotify. `infra/updates` contains the R2 download and authenticated publishing Worker. See [update operations](UPDATES.md).

Spotify Web API commands execute on a background worker. Browser authorization runs independently so an unfinished permission request cannot block that worker. Local audio play/pause reaches the native player independently of Spotify Connect HTTP notifications; a coalescer keeps the latest requested state until acknowledgement. View and connection generations discard stale results. Lyrics, Canvas, and artist sidebar statistics apply only to the matching current track URI.

Artist banners and album play counts use read-only Spotify desktop catalogue queries authenticated inside Rust. Their persisted query identifiers were checked against Spotify's desktop web client; these internal interfaces can change. The public-page fallback retains available data, and missing counts remain unavailable. Canvas uses the native session's Canvas endpoint. The webview receives only a validated Spotify CDN URL and plays it muted; hidden, paused, or reduced-motion views stop the video.

Creator profile dialogs frame only `https://spicylyrics.org`. Remote frames receive no Tauri capabilities. The service currently limits embedding to Spotify's origin, so the dialog explains the restriction and provides an external-browser link.

Audio authorization is separate from the developer app's Web API authorization. Both use PKCE with state-checked loopback callbacks. The audio flow matches librespot's public client and uses `http://127.0.0.1:8898/login`; no developer-dashboard change is needed for that redirect. After connecting, the session account must match the Web API profile. Reusable audio credentials are saved per account under `SpotiFlex/SpotifyAudio` in the OS credential store. Network failures preserve them; explicit rejection permits one browser reauthorization. Sign-out cancels pending audio authorization and removes both logins. Credential writes and deletion are serialized to prevent a retiring player from restoring a signed-out login.

Player commands resolve the Web API device ID from Spotify's device list. A native session ID can differ from the listed device ID, so the local player is also matched by its computer-specific name. An explicitly requested native device that is not listed yet cannot silently transfer playback to an unrelated active device.

The provider receives only the current Spotify access token, only after consent, through an HTTPS header. Spotify tokens are never included in query URLs. Refresh tokens remain in the credential store. Provider URLs, response bodies, and request headers are excluded from user-facing network errors. No log sink is configured for third-party libraries.

Application settings, lyric imports, and cache live under the platform's SpotiFlex configuration directory. On Windows, secrets use Windows Credential Manager. The existing Spotify installation is read-only and is not used as a token source or playback dependency.

Core tests cover the RFC PKCE vector, the real loopback callback server, rejected callbacks, full playlist pagination, duplicate selection handling, 2026 playlist fields, LRC timing and seeks, TTML word/translation separation, overlapping vocals, HTTPS host validation, and bounded packed-response decoding. Tests do not use Spotify accounts or provider credentials.
