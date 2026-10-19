# Third-party notices

## Spotify mobile protocol investigation

DJ request research uses read-only inspection of the user's installed Spotify Android package (`com.spotify.music`, version code `147346334`, APK SHA-256 `C26E20A8CE9DB36FD0B6021542C75ABCAF4E923557B8A21058B502E295D62928`). The Spotify application is proprietary. Inspection is limited to app code and package metadata; private app data and credentials are not read. The APK and analysis output remain local ignored artifacts. No Spotify implementation code or assets are included in SpotiFlex from this inspection. Any integration must be independently written and its observed behavior verified.

The matching public ARM64 APK split and Windows Spotify 1.3.3.264 protocol schemas were also inspected locally. The DJ prompt encoder is an independent Rust implementation of observed field numbers and input values; no Spotify implementation code or assets were copied. [go-librespot](https://github.com/devgianlu/go-librespot/tree/bd3fa74), licensed under GPL-3.0, was consulted for playlist signal interoperability; its implementation was not copied.

## Kawarp

Album-cover ambience uses @kawarp/core 1.3.1 (https://github.com/better-lyrics/kawarp), the renderer used by the Spicy Lyrics reference. Its license follows.

MIT License

Copyright (c) 2026 Better Lyrics

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## librespot DJ implementation

The Playback and Connect crates are vendored at the pinned revision below. Local changes mark narration packets and reconcile local resume events with published Connect state. Their MIT licenses are preserved in both vendor directories.

Native playback uses the MIT-licensed librespot libraries, with experimental DJ session paging, mono narration and speech sequencing from [upstream pull request 1797](https://github.com/librespot-org/librespot/pull/1797), pinned to [School-User/librespot revision b199674d7c241eb82abce494f3f17a9d373b8d23](https://github.com/School-User/librespot/tree/b199674d7c241eb82abce494f3f17a9d373b8d23). The patch follows devgianlu/go-librespot's DJ implementation. Its license follows.
The MIT License (MIT)

Copyright (c) 2015 Paul Lietar

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
