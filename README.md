# SpotiFlex

Standalone Rust Spotify client. Native UI uses eframe/egui; native audio uses librespot and Rodio. Spicetify and the installed Spotify desktop client are not dependencies.

This is an initial implementation of the core client. Full parity with both reference extensions is still in progress. UI is functional and intentionally leaves visual polish for a later pass. See [feature status](docs/FEATURES.md).

## Run

On Windows, install Rust and the Visual Studio C++ build tools, then run:

```powershell
cargo run --locked
```

For an optimized executable:

```powershell
cargo build --release --locked
.\target\release\spotiflex.exe
```

## First sign-in

Spotify Premium is required. First launch presents a mandatory setup modal. It has no skip or close button, and ignores Escape and outside clicks. The client unlocks after Spotify sign-in succeeds. Normal application exit remains available.

1. Open [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and create an app with Web API enabled.
2. Register this exact Redirect URI: `http://127.0.0.1:43821/callback`.
3. Paste the app's Client ID into SpotiFlex, then choose **Sign in with Spotify**.
4. Complete the browser authorization. SpotiFlex loads every page of your playlists, including private and collaborative playlists accessible to your account.

The developer app owner needs Premium. Additional users must meet Spotify's development-mode access rules. See [Spotify quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).

The app uses [Authorization Code with PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow). No client secret is needed. Access and refresh tokens stay in the operating system credential store. The optional `SPOTIFY_CLIENT_ID` environment variable can supply the Client ID; `.env.example` contains the template.

## Lyrics

Configure a private HTTPS provider in **Settings > Lyrics provider**. The host is masked in the editor and stored in the operating system credential store, outside the repository. Provider requests require explicit consent to share the Spotify access token. Refresh tokens and client secrets are never sent to the provider. HTTPS certificate validation stays enabled; redirects are disabled.

For local provisioning, the host can also be passed through standard input:

```powershell
Read-Host 'HTTPS lyrics host' | .\target\debug\spotiflex.exe --set-lyrics-host --allow-spotify-access-token
```

The host is deployment configuration. Keeping it outside source prevents committing it; desktop DNS and network traffic still reveal the destination. A different machine must configure its own provider.

Import `.lrc`, `.ttml`, or `.xml` from the lyrics panel to associate a local lyric file with the current track. Local imports take priority. Remote lyrics cache for three days, separately for each provider.

## Development

```powershell
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

`Cargo.lock` pins `vergen` to 9.0.6 because librespot 0.8's build script is incompatible with the `vergen-lib` dependency split in vergen 9.1.0. Keep the lockfile when updating dependencies.

Current validation: 16 local tests, Clippy, formatting, build, and Windows startup smoke check pass. Live Spotify login, native streaming, and private-provider responses still need account-based verification after developer setup. See [architecture](docs/ARCHITECTURE.md) and [attribution](NOTICE.md).
