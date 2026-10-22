# SpotiFlex

Standalone Rust Spotify client with a Tauri desktop interface and native librespot/Rodio audio. Spicetify and the installed Spotify desktop client are not dependencies.

This is an initial implementation of the core client. Full parity with both reference extensions is still in progress. UI is functional and intentionally leaves visual polish for a later pass. See [feature status](docs/FEATURES.md).

## Run

Download [SpotiFlex 0.1.0 for Windows](https://updates.clypdat.xyz/releases/0.1.0/windows-x86_64/spotiflex.exe) and sign in with your own Spotify Premium account. Future releases are checked automatically at startup; an update prompt offers installation and restart after verification.

To build from source:

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

Voice recognition loads a verified 190 MB English model when microphone input is requested and releases it when Ask DJ closes. Missing weights download once and remain on disk. Recognition runs locally. The UI waits for preparation before opening Windows Default microphone and shows when it starts listening. Microphone audio stays in memory and is never uploaded; the recognized request is sent to Spotify automatically after speech ends.

### macOS

macOS 12 or later is supported on Apple Silicon and Intel. Install Xcode Command Line Tools, Rust 1.98 or later, Node.js 24, and CMake (`brew install cmake`). Build on a Mac:

```sh
npm ci
npm run desktop:build -- -- --locked
```

macOS app credentials use AES-256-GCM encrypted local files under `~/Library/Application Support/SpotiFlex/credentials/`. The directory is restricted to your OS account (`0700`), and the encryption key and credential files are private (`0600`). Each write uses a new cryptographic nonce and atomic replacement. Account and service identities are authenticated with the ciphertext. The app does not read or migrate existing Keychain credentials; sign in with Spotify once after switching to this storage. Keep `device.key` with the encrypted files when backing up this directory.

Local builds reuse a self-signed certificate for code signing and native macOS permission continuity. Signing material stays outside the repository, separate from app credentials. An explicit `APPLE_SIGNING_IDENTITY` or `APPLE_CERTIFICATE` takes precedence. `SPOTIFLEX_ADHOC_SIGNING=1` opts out for disposable builds.

Local builds produce only an app bundle, verify its signature, quit existing installed/build instances, replace `/Applications/SpotiFlex.app`, and open it. The generated duplicate app and old disk images are removed after installation. CI keeps `target/release/bundle/macos/SpotiFlex.app` for archiving.

macOS builds use system WebKit, native window controls integrated into the navigation toolbar, standard application menus in the macOS menu bar, and Command shortcuts. Credentials are encrypted locally without Keychain access. Media keys and Now Playing controls are supported. Ask DJ voice recognition runs locally; macOS requests microphone permission the first time you use it.

The **Build macOS app** GitHub Actions workflow builds separate Apple Silicon and Intel `.app.zip` artifacts only when manually dispatched. Pushes and pull requests do not start builds. CI builds use ad-hoc signatures and are not notarized for public distribution. Public distribution should use a consistent Developer ID signing identity. If Gatekeeper blocks a downloaded build, use **System Settings > Privacy & Security > Open Anyway**. Automatic updates currently serve Windows executables only, so macOS builds must be updated manually.

## First sign-in

Spotify Premium is required. First launch presents a mandatory setup modal. It has no skip or close button, and ignores Escape and outside clicks. The client unlocks after Spotify sign-in succeeds. Normal application exit remains available.

1. Choose **Sign in with Spotify**. Your browser opens Spotify's authorization page.
2. Sign in with your Premium account and approve the connection.
3. Return to SpotiFlex. The client unlocks only after Spotify authenticates the account.

No developer app or Client ID is required for the default connection. Browser authorization uses PKCE with a state-checked loopback callback. Reusable native credentials and the selected account stay in Windows Credential Manager or encrypted local storage on macOS. Later launches authenticate the saved session before unlocking; network failures keep the saved login and allow retry. Existing installations can migrate their saved native audio login without opening another browser window. Sign-out removes the selected account and its saved native credentials.

**Developer connection (optional)** retains the previous Web API login. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), register `http://127.0.0.1:43821/callback`, then enter its Client ID in that optional setup section. Spotify's development-mode allowlist and quotas still apply to that connection. No client secret is needed. `SPOTIFY_CLIENT_ID` supplies this optional field only.

Native mode uses the existing librespot session for browsing, library changes, audio and Connect controls. It does not silently retry through the public Web API. Spotify's internal services are undocumented and can change; this implementation is not an approved Spotify SDK integration. A new account outside the developer app's allowlist still needs end-to-end sign-in verification. Remote controls have protocol and state tests; live verification on other devices remains outstanding. **Settings > Reconnect native audio** retries audio connection without changing the sign-in method.

## Lyrics

All standard builds include SpotiFlex's publishable Spicy Lyrics client key. Users do not need a separate Spicy Lyrics account or API key. Requests contain the Spotify track ID; Spotify access tokens, refresh tokens, and client secrets are not sent to Spicy Lyrics.

The public client key in `config/spicy-lyrics-client-key.txt` is the default for local and release builds. Maintainers can override it with `SPOTIFLEX_SPICY_LYRICS_KEY`; the release workflow uses the repository variable when set. Only publishable `sl_pk_` keys are accepted, and build validation rejects secret `sl_sk_` keys. Signing out preserves this application-wide provider configuration, so Settings does not ask for a lyrics key after another sign-in.

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

Native migration validation: 172 Rust tests, 132 frontend unit tests, 105 browser tests and 16 Connect tests pass, together with formatting and Clippy. A read-only live check verified saved native login, library, likes, search, Home and album browsing without developer Web API access. Fresh browser login on an account outside the developer allowlist and remote-device command acceptance remain unverified. Audible playback quality on other computers still needs manual verification. See [feature status](docs/FEATURES.md) and [attribution](NOTICE.md).

## App updates

Native signed updates use R2 through `updates.clypdat.xyz`. New versions download automatically and open a prompt with signed release notes. **Install and restart** applies the verified executable; **Not now** defers that version until the next launch. Manual checks and installation remain under **Settings > About SpotiFlex**. Ed25519 signatures and SHA-256 hashes are verified before installation. The release workflow and maintainer instructions are in [UPDATES.md](docs/UPDATES.md).
