# Architecture

`main.rs` starts the Tauri desktop app or performs protected provider provisioning from standard input. `desktop.rs` exposes narrow commands and sanitized snapshots to the React interface in `frontend`. The optional `legacy-ui` feature keeps the previous egui interface in `app.rs`. Both interfaces require authenticated sign-in and use the same Rust audio, catalogue, lyric, and update services. Native sign-in is the default; developer Web API setup is optional.

| Module | Responsibility |
| --- | --- |
| `auth.rs` | PKCE generation, loopback listener, callback validation, token exchange, refresh, OS credential storage |
| `native_login.rs` | Browser native PKCE login, authenticated profile, credential migration and verified restore |
| `spotify.rs` | Account-scoped native/developer adapters; native mode has no public Web API fallback |
| `native_remote.rs` | Native Connect remote commands, cluster playback state and queue |
| `api.rs` | Authenticated Spotify calls, origin validation, 401 refresh, rate-limit cooldown, pagination, playlist writes |
| `model.rs` | Spotify data and ordered duplicate-free playlist additions |
| `native.rs` | Separate Tokio runtime, librespot session, Connect registration, Rodio player, timestamped player events, shutdown |
| `audio.rs`, `audio_output.rs`, `playback_intent.rs` | Bounded audio buffering, versioned output-device selection, seek acknowledgments, and latest-intent play/pause transitions |
| `catalogue.rs`, `artist.rs`, `album.rs`, `canvas.rs` | Read-only desktop catalogue queries, bounded public-page fallback, banner and play-count parsing, validated Canvas media URLs |
| `lyrics.rs` | Independent lyric model, LRC/TTML parsing, imports, per-provider disk cache |
| `provider.rs` | Credential-store host configuration, HTTPS validation, query protocol, bounded packed-data decoding |
| `worker.rs` | Spotify command worker and separate lyric worker; no HTTP or audio work on the UI thread |
| `config.rs` | Nonsecret appearance, Client ID, local folders, and view settings |
| `updater.rs` | Independent signed update checks, bounded download, hash validation, native replacement, and restart |

`src/bin/spotiflex-release.rs` is a maintainer tool for signing and publishing versioned artifacts. It uses separate credentials from Spotify. `infra/updates` contains the R2 download and authenticated publishing Worker. See [update operations](UPDATES.md).

Spotify Web API commands execute on a background worker. Browser authorization runs independently so an unfinished permission request cannot block that worker. Local audio play/pause reaches the native player independently of Spotify Connect HTTP notifications; a coalescer keeps the latest requested state until acknowledgement. View and connection generations discard stale results. Lyrics, Canvas, and artist sidebar statistics apply only to the matching current track URI.

Explicit local track changes invalidate buffered samples before the command enters Spotify Connect. Each decoder identifies its track at the sink boundary; queued packets retain their output generation, so old or superseded selections remain silent while the requested track loads. Automatic transitions preserve their generation for gapless output. Connect state uploads are polled alongside transport commands, with one active upload and one latest pending snapshot. Disconnect drains pending snapshots before marking the device inactive.

Artist banners and album play counts use read-only Spotify desktop catalogue queries authenticated inside Rust. Their persisted query identifiers were checked against Spotify's desktop web client; these internal interfaces can change. The public-page fallback retains available data, and missing counts remain unavailable. Canvas uses the native session's Canvas endpoint. The webview receives only a validated Spotify CDN URL and plays it muted; hidden, paused, or reduced-motion views stop the video.

Creator profile dialogs frame only `https://spicylyrics.org`. Remote frames receive no Tauri capabilities. The service currently limits embedding to Spotify's origin, so the dialog explains the restriction and provides an external-browser link.

Native login runs outside the command worker. It uses librespot's public audio client with PKCE and `http://127.0.0.1:8898/login`, authenticates a native session, and obtains the canonical account identity before returning a result. Cached profile data alone never unlocks the client. The command worker accepts only uncancelled results before storing reusable credentials under `SpotiFlex/SpotifyAudio` and the selected account under `SpotiFlex/Account` in Windows Credential Manager. Writes and sign-out deletion share the credential lock. Cancelled results cannot persist a login. Existing Web API profiles supply only the expected identity when migrating already-saved audio credentials; no developer token refresh is required.

The `spotify.rs` adapter preserves shared browsing and playlist code. Native mode contains no Web API credentials or Web API fallback. Its background handles capture the original account connection and share revocation with the foreground handle, so switching accounts cannot redirect an old job. Retiring a player closes its connection before another account can use the client. Optional developer mode retains its own token refresh, cooldown and public Web API handling.

The vendor Connect patch retains the current cluster alongside device discovery. Native mode polls that local snapshot for remote playback state; resolved remote track metadata has an account-keyed 128-entry cache. Remote command destinations must be in the current native session's device list. Playback commands use the Connect player command endpoint; volume uses its dedicated protobuf endpoint. Native transfers retain their existing validation. Protocol tests check outgoing command payloads against librespot's dealer command types. They do not establish live remote command acceptance.

The optional developer connection still authorizes Web API and audio separately. Its session account must match the native audio account. Sign-out cancels pending login and removes the active native login and the developer token for that connection. Network failures preserve saved credentials; explicit credential rejection offers a fresh sign-in. Native audio reauthorization preserves the selected account marker.

The legacy provider receives a short-lived Spotify access token only after consent, through an HTTPS header. Native mode obtains that token from the native session; optional developer mode can use its Web API token. The publishable-key lyrics provider does not receive Spotify tokens. Legacy-provider acceptance of native tokens still needs live verification. Spotify tokens are never included in query URLs. Refresh tokens remain in the credential store. Provider URLs, response bodies, and request headers are excluded from user-facing network errors. No log sink is configured for third-party libraries.

Application settings, lyric imports, and cache live under the platform's SpotiFlex configuration directory. On Windows, secrets use Windows Credential Manager. The existing Spotify installation is read-only and is not used as a token source or playback dependency.

Core tests cover the RFC PKCE vector, the real loopback callback server, rejected callbacks, full playlist pagination, duplicate selection handling, 2026 playlist fields, LRC timing and seeks, TTML word/translation separation, overlapping vocals, HTTPS host validation, and bounded packed-response decoding. Tests do not use Spotify accounts or provider credentials.
