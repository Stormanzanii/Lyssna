<div align="center">

<img src="assets/spotiflex.png" alt="SpotiFlex icon" width="96">

# SpotiFlex

**A native Spotify desktop client with Spicy Lyrics built in.**

Rust and Tauri, with its own audio engine. No embedded Spotify web player, no Spicetify.

[Download](#install) · [Features](docs/FEATURES.md) · [Build from source](#build-from-source) · [Attribution](NOTICE.md)

[![Release](https://img.shields.io/badge/release-0.1.1-1ed760)](#install)
[![Rust](https://img.shields.io/badge/Rust-1.98-orange?logo=rust)](Cargo.toml)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS-lightgrey)](#build-from-source)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

</div>

SpotiFlex plays Spotify through [librespot](https://github.com/librespot-org/librespot) and draws its own interface in the familiar layout: library on the left, browsing in the middle, player along the bottom, lyrics on the right. Word-synced lyrics, the Spicy Lyrics animator, Space Gravity and Spotify Canvas backdrops are part of the client rather than an extension injected into Spotify.

**Spotify Premium is required.** Free accounts cannot stream through librespot.

> [!NOTE]
> SpotiFlex is in early development. It does not yet match every feature of Spotify or of the Spicy Lyrics and Spotify Plus extensions it reimplements. [docs/FEATURES.md](docs/FEATURES.md) tracks what works and what is missing.

## What it does

| Feature | What you get |
| --- | --- |
| Lyrics | Word- and syllable-synced lyrics from six sources (Spicy Lyrics, Musixmatch, Apple Music, Spotify, LRCLIB, Netease), the Spicy Lyrics animator with adjustable presets, Space Gravity, fullscreen mode, local LRC and TTML imports, and community credits with Discord usernames |
| Playback | Native audio with gapless playback, optional crossfade (1 to 12 seconds), Spotify Connect control of other devices, and media keys |
| Library | Playlists, Spotify folders, saved albums and followed artists in Spotify's Recents order, with Playlists, By you, Collaborative, Albums and Artists filters |
| Now playing | Album or Canvas ambience, a lyrics card that expands to fill the panel, artist and credits cards |
| Home and browsing | Spotify's Home feed, artist and album pages, search, Recents and the What's New feed behind the bell |
| Window | Optional tray mode that keeps music playing after the window closes, and opening at sign-in (normal or minimized) |
| Updates | Signed automatic updates for Windows; each executable is checked against an Ed25519 signature and a SHA-256 hash before it replaces the old one |

## Install

| Platform | How |
| --- | --- |
| Windows 10 and 11 (x64) | Download [SpotiFlex 0.1.1](https://updates.clypdat.xyz/releases/0.1.1/windows-x86_64/spotiflex.exe). Later versions install from the in-app update prompt. |
| macOS 12 or later (Apple Silicon and Intel) | [Build from source](#build-from-source). Releases are Windows-only for now. |

## Get started

1. Open SpotiFlex. A setup window appears and stays until you sign in; it has no skip button.
2. Choose **Sign in with Spotify** and approve the connection in your browser with a Premium account.
3. Return to SpotiFlex. The client unlocks once Spotify has authenticated the account, and loads every playlist in your library.
4. Open **Settings** from the account menu to set up lyrics, crossfade, tray mode and the rest.

No Spotify developer app or Client ID is needed. Sign-in uses OAuth with PKCE and a state-checked loopback callback, and later launches reuse the saved session.

## Privacy

Spotify credentials stay on your computer: Windows Credential Manager on Windows, AES-256-GCM encrypted files on macOS. Lyrics requests carry the Spotify track ID, and Spotify tokens are never sent to Spicy Lyrics.

<details>
<summary>Lyrics lookups: who receives what</summary>

Every build includes SpotiFlex's publishable Spicy Lyrics client key, so you do not need a Spicy Lyrics account. Lyric sources receive the track ID, title and artist they need to find a match. Answers are cached on disk for three days, separately for each source; **Settings > Storage** clears them.

Community credits show the maker's Discord username by looking up their public spicylyrics.org profile, as EeveeSpotifyReincarnated does. **Settings > Display** turns this off.

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

---

SpotiFlex is licensed under the [GNU AGPL v3](LICENSE). The lyrics features reimplement behaviour from [iPixelGalaxy/spicy-lyrics](https://github.com/iPixelGalaxy/spicy-lyrics) and the pixels-spicy-lyrics fork (both AGPL-3.0), community usernames follow [EeveeSpotifyReincarnated](https://github.com/iPixelGalaxy/EeveeSpotifyReincarnated) (GPL-3.0), and interface ideas come from [iPixelGalaxy/spotify-plus](https://github.com/iPixelGalaxy/spotify-plus); no upstream source or assets are copied. Playback uses librespot (MIT). [NOTICE.md](NOTICE.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) list every source and license. Spotify is a trademark of Spotify AB; SpotiFlex is an independent client and is not affiliated with Spotify AB.
