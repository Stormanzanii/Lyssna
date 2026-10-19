# SpotiFlex

Standalone Rust Spotify client with a Tauri desktop interface and native librespot/Rodio audio. Spicetify and the installed Spotify desktop client are not dependencies.

This is an initial implementation of the core client. Full parity with both reference extensions is still in progress. UI is functional and intentionally leaves visual polish for a later pass. See [feature status](docs/FEATURES.md).

## Run

On Windows, install Rust, Node.js 24, WebView2, Visual Studio C++ build tools, CMake and LLVM (including libclang). Put CMake on PATH and set `LIBCLANG_PATH` to the directory containing `libclang.dll` if LLVM is not discoverable. Then run:

```powershell
npm ci
npm run build
cargo run --locked
```

For an optimized executable:

```powershell
npm run build
cargo build --release --locked
.\target\release\spotiflex.exe
```

Voice recognition preloads a verified 190 MB English model once at app startup, downloading missing weights in the background. Recognition runs locally. The UI waits for preparation before opening Windows Default microphone and shows when it starts listening. Microphone audio stays in memory and is never uploaded; the recognized request is sent to Spotify automatically after speech ends.

## First sign-in

Spotify Premium is required. First launch presents a mandatory setup modal. It has no skip or close button, and ignores Escape and outside clicks. The client unlocks after Spotify sign-in succeeds. Normal application exit remains available.

1. Open [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and create an app with Web API enabled.
2. Register this exact Redirect URI: `http://127.0.0.1:43821/callback`.
3. Paste the app's Client ID into SpotiFlex, then choose **Sign in with Spotify**.
4. Complete the browser authorization. SpotiFlex loads every page of your playlists, including private and collaborative playlists accessible to your account.

The developer app owner needs Premium. Additional users must meet Spotify's development-mode access rules. See [Spotify quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).

The app uses [Authorization Code with PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow). No client secret is needed. Access and refresh tokens stay in the operating system credential store. The optional `SPOTIFY_CLIENT_ID` environment variable can supply the Client ID; `.env.example` contains the template.

Native audio has a separate, one-time browser sign-in using librespot's public audio client. Use the same Spotify account as the developer-app sign-in. SpotiFlex stores the resulting reusable audio credentials in Windows Credential Manager; later launches use them silently. Network timeouts preserve the saved login. An explicit credential rejection triggers one fresh authorization attempt. **Settings > Reconnect native audio** retries the connection.

## Lyrics

Release builds include SpotiFlex's publishable Spicy Lyrics client key. Users do not need a separate Spicy Lyrics account or API key. Requests contain the Spotify track ID; Spotify access tokens, refresh tokens, and client secrets are not sent to Spicy Lyrics.

Maintainers set the `SPOTIFLEX_SPICY_LYRICS_KEY` repository variable for release builds, or the environment variable before a local build. Only publishable `sl_pk_` keys are accepted. Build validation rejects secret keys before compilation. Development builds without a bundled key can save a publishable key in Settings using Windows Credential Manager.

Existing self-hosted deployments can still provision their protected HTTPS host through standard input. This legacy mode requires explicit consent before sharing a short-lived Spotify access token:

```powershell
Read-Host 'HTTPS lyrics host' | .\target\debug\spotiflex.exe --set-lyrics-host --allow-spotify-access-token
```

Self-hosted deployments provision their host on each machine. The credential store keeps it outside source; desktop DNS and network traffic still reveal the destination.

Import `.lrc`, `.ttml`, or `.xml` from the lyrics panel to associate a local lyric file with the current track. Local imports take priority. Remote lyrics cache for three days, separately for each provider.

## Development

```powershell
npm run build
npm test
npm run test:e2e
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

The previous egui interface remains available with `cargo run --locked --no-default-features --features legacy-ui`.

`Cargo.lock` pins `vergen` to 9.0.6 because librespot 0.8's build script is incompatible with the `vergen-lib` dependency split in vergen 9.1.0. Keep the lockfile when updating dependencies.

Current validation: 48 Rust tests, Clippy, formatting, and build pass. Live Web API session restore, browser audio authorization, silent reuse of saved audio credentials, and Web API visibility of the native device have been verified. Audible playback and private-provider responses still need manual verification. The update service has 3 tests. See [architecture](docs/ARCHITECTURE.md) and [attribution](NOTICE.md).

## App updates

Native signed updates use R2 through `updates.clypdat.xyz`. New versions download automatically; **Settings > App updates > Install update and restart** applies them. Ed25519 signatures and SHA-256 hashes are verified before installation. The release workflow and maintainer instructions are in [UPDATES.md](docs/UPDATES.md).
