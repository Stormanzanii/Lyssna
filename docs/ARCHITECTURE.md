# Architecture

`main.rs` starts the desktop app or performs protected provider provisioning from standard input. `app.rs` owns the current view and displays a mandatory setup modal until an authenticated profile is available. There is no Tauri or WebView frontend.

| Module | Responsibility |
| --- | --- |
| `auth.rs` | PKCE generation, loopback listener, callback validation, token exchange, refresh, OS credential storage |
| `api.rs` | Authenticated Spotify calls, origin validation, 401 refresh, rate-limit cooldown, pagination, playlist writes |
| `model.rs` | Spotify data and ordered duplicate-free playlist additions |
| `native.rs` | Separate Tokio runtime, librespot session, Connect registration, Rodio player, timestamped player events, shutdown |
| `lyrics.rs` | Independent lyric model, LRC/TTML parsing, imports, per-provider disk cache |
| `provider.rs` | Credential-store host configuration, HTTPS validation, query protocol, bounded packed-data decoding |
| `worker.rs` | Spotify command worker and separate lyric worker; no HTTP or audio work on the UI thread |
| `config.rs` | Nonsecret appearance, Client ID, local folders, and view settings |

Spotify commands execute in order on a background worker. View changes carry a generation number so old results and errors cannot overwrite a newer search or playlist. Native audio runs on its own runtime; connection generations discard messages from retired players. Lyric results are applied only to the matching current track URI.

The provider receives only the current Spotify access token, only after consent, through an HTTPS header. Spotify tokens are never included in query URLs. Refresh tokens remain in the credential store. Provider URLs, response bodies, and request headers are excluded from user-facing network errors. No log sink is configured for third-party libraries.

Application settings, lyric imports, and cache live under the platform's SpotiFlex configuration directory. On Windows, secrets use Windows Credential Manager. The existing Spotify installation is read-only and is not used as a token source or playback dependency.

Core tests cover the RFC PKCE vector, the real loopback callback server, rejected callbacks, full playlist pagination, duplicate selection handling, 2026 playlist fields, LRC timing and seeks, TTML word/translation separation, overlapping vocals, HTTPS host validation, and bounded packed-response decoding. Tests do not use Spotify accounts or provider credentials.
