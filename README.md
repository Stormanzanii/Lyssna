![SpotiFlex playing a song, with its Spotify Canvas behind word-synced lyrics](.github/assets/app.avif)

<div align="center">

# SpotiFlex

**Spotify on your desktop, with Spicy Lyrics built in.**

[![Release](https://img.shields.io/badge/release-0.1.1-1ed760?style=for-the-badge)](#get-started)
[![Windows · macOS](https://img.shields.io/badge/Windows%20%C2%B7%20macOS-2b2b2b?style=for-the-badge)](#build-from-source)
[![Built with Rust](https://img.shields.io/badge/built%20with-Rust-dea584?style=for-the-badge&logo=rust&logoColor=white)](Cargo.toml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue?style=for-the-badge)](LICENSE)

[Download](https://updates.clypdat.xyz/releases/0.1.1/windows-x86_64/spotiflex.exe) · [Features](docs/FEATURES.md) · [Build from source](#build-from-source) · [Credits](#credits)

</div>

> [!IMPORTANT]
> **Spotify Premium is required.** librespot, which SpotiFlex streams through, cannot play on free accounts.

## What it is

A Spotify client written in Rust. It streams through [librespot](https://github.com/librespot-org/librespot) and draws its own interface in Spotify's layout, so it needs neither the Spotify app nor Spicetify.

| Feature | What you get |
| --- | --- |
| **Lyrics** | Word- and syllable-synced lyrics from six sources (Spicy Lyrics, Musixmatch, Apple Music, Spotify, LRCLIB, Netease), the Spicy Lyrics animator, Space Gravity, full screen (F11), your own LRC and TTML files, and community credits |
| **Canvas** | The song's Spotify Canvas beside the lyrics, tinting the background and the Now Playing panel |
| **Listening** | Gapless playback, crossfade from 1 to 12 seconds, media keys, Spotify Connect, and optional playback from the tray after closing the window |
| **Library** | Every playlist and Spotify folder, plus saved albums and followed artists, in Spotify's Recents order |
| **Updates** | Signed automatic updates on Windows, checked against an Ed25519 signature and SHA-256 hash before installing |

> [!NOTE]
> **Early development.** Some of Spotify's and Spicy Lyrics' features are still missing. [docs/FEATURES.md](docs/FEATURES.md) lists what works and what does not.

## Get started

1. **Install.** On Windows 10 or 11 (x64), download [SpotiFlex 0.1.1](https://updates.clypdat.xyz/releases/0.1.1/windows-x86_64/spotiflex.exe). On macOS 12 or later, [build from source](#build-from-source).
2. **Sign in.** Choose **Sign in with Spotify** and approve the connection in your browser. The setup window stays up until Spotify confirms the account.
3. **Play something.** Your playlists, albums and artists load into the library on the left.
4. **Make it yours.** Open **Settings** from the account menu for lyrics sources, the animator, crossfade and tray behaviour.

Sign-in uses OAuth with PKCE through a state-checked loopback callback. No Spotify developer app is needed, and later launches reuse the saved session.

## Privacy

Spotify credentials stay on your computer: Windows Credential Manager on Windows, AES-256-GCM encrypted files on macOS. Lyrics requests carry the Spotify track ID, and Spotify tokens are never sent to Spicy Lyrics.

<details>
<summary>Lyrics lookups: who receives what</summary>

Every build includes SpotiFlex's publishable Spicy Lyrics client key, so you do not need a Spicy Lyrics account. Lyric sources receive the track ID, title and artist they need to find a match. Answers are cached on disk for three days, separately for each source; **Settings > Storage** clears them.

Community credits show the maker's Discord username by looking up their public spicylyrics.org profile. **Settings > Display** turns this off.

Self-hosted lyrics deployments can still be provisioned through standard input. That legacy mode asks for explicit consent before it sends a short-lived Spotify access token to the configured host, and it never sends refresh tokens or client secrets:

```powershell
Read-Host 'HTTPS lyrics host' | .\target\debug\spotiflex.exe --set-lyrics-host --allow-spotify-access-token
```

The host is kept in the credential store, not in source. Your DNS and network traffic still reveal where requests go.

</details>

<details>
<summary>Spotify services and the optional developer connection</summary>

Browsing, library changes, audio and Connect control go through the librespot session, using the same internal services as Spotify's desktop client. Those services are undocumented and can change; this is not an approved Spotify SDK integration.

An optional developer connection keeps the older Web API login. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), register `http://127.0.0.1:43821/callback`, and enter its Client ID in setup. Spotify's development-mode allowlist and quotas apply to it. No client secret is needed.

</details>

## Build from source

Windows needs Rust, Node.js 24, WebView2, the Visual Studio C++ build tools, CMake and LLVM (for libclang). Then:

```powershell
.\build.ps1          # build and install the latest main
.\build.ps1 local    # build the current checkout, uncommitted changes included
```

On macOS, install the Xcode Command Line Tools, Rustup, Node.js 24 and CMake (`brew install cmake`), then run `./build.sh` or `./build.sh local`.

<details>
<summary>What the build scripts do</summary>

By default each script requires a clean worktree, switches to `main`, fast-forwards from `origin/main`, restores npm dependencies, and builds a release. It installs the Rust version that `Cargo.toml` requires unless `RUSTUP_TOOLCHAIN` is set, and restores your original branch afterwards, including on failure. Nothing is pushed, and credentials and app data are left alone.

- **Windows** installs to `%LOCALAPPDATA%\Programs\SpotiFlex\spotiflex.exe`, closes a running copy first, and starts the new one. `-NoLaunch` installs without starting it. Builds from this script turn automatic updates off; run it again to update. If PowerShell blocks the script, use `powershell -ExecutionPolicy Bypass -File .\build.ps1`. The script finds Visual Studio's bundled CMake and LLVM's default folder; otherwise put CMake on `PATH` and set `LIBCLANG_PATH` to the folder that contains `libclang.dll`.
- **macOS** signs the bundle with a reusable self-signed certificate (an explicit `APPLE_SIGNING_IDENTITY` or `APPLE_CERTIFICATE` takes precedence, and `SPOTIFLEX_ADHOC_SIGNING=1` opts out), replaces `/Applications/SpotiFlex.app` and opens it. Credentials live encrypted under `~/Library/Application Support/SpotiFlex/credentials/`; keep `device.key` with them when backing up.
- `.\build.ps1 <branch>` or `./build.sh <branch>` builds another branch; a commit hash builds that commit.

To build by hand:

```powershell
npm ci
npm run build
cargo build --release --locked
.\target\release\spotiflex.exe
```

</details>

<details>
<summary>Releases and CI</summary>

The release workflow builds and tests the client, signs the update manifest, uploads the executable and source archive to the `spotiflex-releases` bucket, and activates the stable channel last. [docs/UPDATES.md](docs/UPDATES.md) has the maintainer steps. The **Build macOS app** workflow produces ad-hoc signed Apple Silicon and Intel `.app.zip` files when dispatched by hand; they are not notarized, and macOS builds do not update automatically.

</details>

## Development

```powershell
npm test                 # frontend unit tests (Vitest)
npm run test:e2e         # browser tests against a mocked desktop bridge (Playwright)
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

At the time of writing, 234 Rust tests, 185 frontend unit tests and 183 browser tests pass. The browser tests use a mocked bridge, so they do not prove live Spotify behaviour. Keep `Cargo.lock` when updating dependencies: it pins `vergen` to 9.0.6 because librespot 0.8's build script breaks with vergen 9.1.0.

<details>
<summary>Current limits</summary>

- Remote-device commands and audio quality on other computers have not been verified by hand.
- Sign-in has not been tested end to end on an account outside the developer app's allowlist.
- Library ordering uses the last 50 played contexts from Spotify's play history; older items are ordered by when they were added.
- Spotify's public API does not expose folder metadata, so folders are read from Spotify's rootlist service.

The full list is in [docs/FEATURES.md](docs/FEATURES.md).

</details>

## Credits

<table>
  <tr>
    <td align="center" width="160"><a href="https://github.com/Stormanzanii"><img src="https://github.com/Stormanzanii.png?size=160" width="80" alt=""><br><b>Arashii</b></a><br><sub>Creator of SpotiFlex</sub></td>
    <td align="center" width="160"><a href="https://github.com/iPixelGalaxy"><img src="https://github.com/iPixelGalaxy.png?size=160" width="80" alt=""><br><b>iPixelGalaxy</b></a><br><sub>Spotify+ and the Spicy Lyrics fork</sub></td>
    <td align="center" width="160"><a href="https://github.com/Spikerko"><img src="https://github.com/Spikerko.png?size=160" width="80" alt=""><br><b>Spikerko</b></a><br><sub>Creator of Spicy Lyrics</sub></td>
  </tr>
</table>

SpotiFlex is built on:

| Project | By | Licence | Used for |
| --- | --- | --- | --- |
| [Spotify+](https://github.com/iPixelGalaxy/spotify-plus) | iPixelGalaxy | None declared | The Add to playlist folders menu, reimplemented from its feature descriptions |
| [Spicy Lyrics](https://github.com/iPixelGalaxy/spicy-lyrics) | Spikerko, fork by iPixelGalaxy | AGPL-3.0 | Lyrics display, Space Gravity, word sync and the TTML tools |
| [librespot](https://github.com/librespot-org/librespot) | librespot contributors | MIT | Spotify playback and Connect |
| [spr](https://github.com/Fraktality/spr) | Fraktality | MIT | The spring that animates lyrics |
| [Kawarp](https://github.com/better-lyrics/kawarp) | Better Lyrics | MIT | The warped artwork and Canvas ambience |

No upstream source or assets are copied from Spotify+ or Spicy Lyrics; SpotiFlex reimplements their behaviour.

## License

SpotiFlex is free software under the [GNU AGPL v3](LICENSE). [NOTICE.md](NOTICE.md) records each upstream project SpotiFlex references, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) holds the licences of bundled dependencies. Spotify is a trademark of Spotify AB; SpotiFlex is not affiliated with Spotify.
