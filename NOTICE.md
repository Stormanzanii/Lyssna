# Attribution

SpotiFlex is distributed under GNU AGPL version 3. See [LICENSE](LICENSE).

The native lyrics implementation references behavior and the provider wire format from [iPixelGalaxy/spicy-lyrics](https://github.com/iPixelGalaxy/spicy-lyrics), the Spicy Lyrics fork maintained by iPixelGalaxy and its upstream contributors. That project is published under AGPL-3.0. No upstream JavaScript runtime, logos, fonts, or artwork are bundled. The current wire compatibility version is 100.10.50; this does not imply full feature parity.

Playlist and interface behavior is informed by the feature descriptions of [iPixelGalaxy/spotify-plus](https://github.com/iPixelGalaxy/spotify-plus). Its repository does not declare a license in the metadata reviewed during setup. SpotiFlex does not copy or bundle its source or assets.

Playback uses [librespot](https://github.com/librespot-org/librespot), published under MIT. UI uses [egui/eframe](https://github.com/emilk/egui), published under MIT or Apache-2.0. Other Rust dependencies retain their own licenses; the exact dependency graph is recorded in `Cargo.lock`.

Spotify is a trademark of Spotify AB. SpotiFlex is an independent client and is not affiliated with Spotify AB.
